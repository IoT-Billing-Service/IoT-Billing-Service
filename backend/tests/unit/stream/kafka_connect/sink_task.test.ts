import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BlockchainEventSinkTask } from '../../../../src/stream/kafka_connect/sink_task.js';
import type {
  SinkRecord,
  LedgerEvent,
  LedgerSinkTarget,
} from '../../../../src/stream/kafka_connect/types.js';

// Mock the Prometheus metrics module so tests run without a metrics registry.
const metrics = vi.hoisted(() => ({
  incReceived: vi.fn(),
  incSunk: vi.fn(),
  incFailed: vi.fn(),
  observeDuration: vi.fn(),
  setBacklog: vi.fn(),
}));

vi.mock('../../../../src/api/metrics/prometheus.js', () => ({
  incKafkaConnectEventsReceived: metrics.incReceived,
  incKafkaConnectEventsSunk: metrics.incSunk,
  incKafkaConnectEventsFailed: metrics.incFailed,
  observeKafkaConnectSinkDurationMs: metrics.observeDuration,
  setKafkaConnectBacklog: metrics.setBacklog,
}));

interface SunkEvent extends LedgerEvent {
  source_offset: string;
}

class InMemoryTarget implements LedgerSinkTarget {
  readonly published: LedgerEvent[] = [];
  failNext = false;
  async publish(event: LedgerEvent): Promise<string> {
    if (this.failNext) throw new Error('redis down');
    this.published.push(event);
    return 'fake-stream-id';
  }
}

function record(overrides: Partial<SinkRecord> = {}): SinkRecord {
  const value = JSON.stringify({
    v: 1,
    sequence: 10,
    event: { type: 'PaymentFinalized', hash: '0xabc', amount: '42' },
  });
  return {
    topic: 'blockchain.events',
    partition: 0,
    offset: 100n,
    value,
    headers: [],
    ...overrides,
  };
}

describe('BlockchainEventSinkTask', () => {
  let target: InMemoryTarget;
  let task: BlockchainEventSinkTask;

  beforeEach(() => {
    vi.clearAllMocks();
    target = new InMemoryTarget();
    task = new BlockchainEventSinkTask({ target, taskId: 'test-task' });
  });

  it('advertises a version', () => {
    expect(task.version()).toBe('1.0.0');
  });

  it('publishes a valid record to the target with enrichment fields', async () => {
    await task.start();
    await task.put([record()]);
    await task.flush();

    expect(target.published).toHaveLength(1);
    const sunk = target.published[0] as SunkEvent;
    expect(sunk.sequence).toBe(10);
    expect(sunk.payload['event_type']).toBe('PaymentFinalized');
    expect(sunk.payload['source_topic']).toBe('blockchain.events');
    expect(sunk.payload['source_offset']).toBe('100');
    expect(sunk.payload['content_hash']).toMatch(/^[0-9a-f]{64}$/);
    expect(metrics.incSunk).toHaveBeenCalledWith('blockchain.events');
  });

  it('reports the processed offset so the runtime can commit it', async () => {
    await task.start();
    await task.put([record({ offset: 7n })]);
    await task.flush();
    const offsets = task.offsets();
    expect(offsets.get('blockchain.events:0')?.offset).toBe(7n);
  });

  it('tracks the high-water offset when multiple records arrive', async () => {
    await task.start();
    await task.put([
      record({ offset: 5n }),
      record({ offset: 6n, value: JSON.stringify({ v: 1, sequence: 11, event: { type: 'X' } }) }),
    ]);
    await task.flush();
    expect(task.offsets().get('blockchain.events:0')?.offset).toBe(6n);
  });

  it('preserves partition order across put() calls', async () => {
    await task.start();
    // First put uses the real target; second put resolves immediately.
    await task.put([record({ offset: 1n })]);
    const second = task.put([
      record({ offset: 2n, value: JSON.stringify({ v: 1, sequence: 12, event: { type: 'Y' } }) }),
    ]);
    await second;
    await task.flush();
    expect(target.published).toHaveLength(2);
    expect(target.published[0].sequence).toBeLessThan(target.published[1].sequence);
  });

  it('drops a malformed record without writing to the ledger', async () => {
    await task.start();
    await task.put([record({ value: 'garbage' }), record()]);
    await task.flush();
    expect(target.published).toHaveLength(1);
    expect(metrics.incFailed).toHaveBeenCalledWith('blockchain.events', 'not-json');
  });

  it('counts publish failures and leaves the offset uncommitted', async () => {
    await task.start();
    target.failNext = true;
    await task.put([record({ offset: 9n })]);
    await task.flush();
    // The offset must NOT be advanced for a publish failure (retried later).
    expect(task.offsets().size).toBe(0);
    expect(metrics.incFailed).toHaveBeenCalled();
    expect(metrics.incSunk).not.toHaveBeenCalled();
  });

  it('does not advance the offset when the target is unconfigured (at-least-once)', async () => {
    const bare = new BlockchainEventSinkTask({ taskId: 'bare' });
    await bare.start();
    // put() resolves (the failure is counted, not thrown) so one bad target
    // cannot wedge the partition queue, but the offset stays uncommitted so the
    // runtime retries the batch.
    await bare.put([record({ offset: 3n })]);
    await bare.flush();
    expect(bare.offsets().size).toBe(0);
  });

  it('rejects put() after stop()', async () => {
    await task.stop();
    await expect(task.put([record()])).rejects.toThrow(/stopped/);
  });
});
