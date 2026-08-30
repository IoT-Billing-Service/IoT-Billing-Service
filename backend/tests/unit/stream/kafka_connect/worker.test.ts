import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { KafkaConnectSinkWorker } from '../../../../src/stream/kafka_connect_worker.js';
import type {
  LedgerEvent,
  LedgerSinkTarget,
  SinkRecord,
} from '../../../../src/stream/kafka_connect/types.js';

const metrics = vi.hoisted(() => ({ setBacklog: vi.fn() }));
vi.mock('../../../../src/api/metrics/prometheus.js', () => ({
  setKafkaConnectBacklog: metrics.setBacklog,
  // The sink task also imports these; keep them available.
  incKafkaConnectEventsReceived: vi.fn(),
  incKafkaConnectEventsSunk: vi.fn(),
  incKafkaConnectEventsFailed: vi.fn(),
  observeKafkaConnectSinkDurationMs: vi.fn(),
}));

vi.mock('../../../../src/config/env.js', () => ({
  getEnv: () => ({
    KAFKA_BROKERS: 'localhost:9092',
    KAFKA_CLIENT_ID: 'test-client',
    KAFKA_GROUP_ID: 'test-group',
    KAFKA_BLOCKCHAIN_EVENTS_TOPIC: 'blockchain.events',
    KAFKA_CONNECT_SINK_ENABLED: false,
    KAFKA_CONNECT_SINK_TASK_ID: 'test-sink',
    KAFKA_CONNECT_VERIFY_PUBLIC_KEY: '',
    KAFKA_SSL: false,
    KAFKA_SASL_USERNAME: undefined,
    KAFKA_SASL_PASSWORD: undefined,
  }),
}));

class InMemoryTarget implements LedgerSinkTarget {
  readonly published: LedgerEvent[] = [];
  async publish(event: LedgerEvent): Promise<string> {
    this.published.push(event);
    return 'stream-id';
  }
}

type BatchHandler = (payload: {
  batch: any;
  resolveOffset: (offset: string) => void;
  heartbeat: () => Promise<void>;
}) => Promise<void>;

interface FakeConsumer {
  connect: Mock;
  subscribe: Mock;
  run: Mock;
  commitOffsets: Mock;
  disconnect: Mock;
  eachBatch?: BatchHandler;
}

function makeConsumer(): FakeConsumer {
  const consumer: FakeConsumer = {
    connect: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    run: vi.fn((opts: { eachBatch: BatchHandler }) => {
      consumer.eachBatch = opts.eachBatch;
      return Promise.resolve();
    }),
    commitOffsets: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  return consumer;
}

function message(offset: string, sequence: number) {
  return {
    key: Buffer.from('k'),
    value: Buffer.from(JSON.stringify({ v: 1, sequence, event: { type: 'PaymentFinalized' } })),
    headers: {},
    timestamp: '1700000000000',
    offset,
  };
}

describe('KafkaConnectSinkWorker', () => {
  let consumer: FakeConsumer;
  let sink: InMemoryTarget;

  beforeEach(() => {
    vi.clearAllMocks();
    consumer = makeConsumer();
    sink = new InMemoryTarget();
  });
  afterEach(() => void new KafkaConnectSinkWorker().stop().catch(() => undefined));

  it('exposes the sink task id and topic', () => {
    const worker = new KafkaConnectSinkWorker({ consumer: consumer as any, sink });
    expect(worker.taskId).toBe('test-sink');
    expect(worker.topicKey).toBe('blockchain.events');
  });

  it('connects, subscribes, and registers an eachBatch handler', async () => {
    const worker = new KafkaConnectSinkWorker({ consumer: consumer as any, sink });
    await worker.start();
    expect(consumer.connect).toHaveBeenCalled();
    expect(consumer.subscribe).toHaveBeenCalledWith({
      topic: 'blockchain.events',
      fromBeginning: false,
    });
    expect(consumer.run).toHaveBeenCalled();
    expect(consumer.eachBatch).toBeDefined();
    await worker.stop();
  });

  it('sinks a batch and commits the high-water offset', async () => {
    const worker = new KafkaConnectSinkWorker({ consumer: consumer as any, sink });
    await worker.start();

    const resolveOffset = vi.fn();
    const heartbeat = vi.fn().mockResolvedValue(undefined);
    await consumer.eachBatch?.({
      batch: {
        topic: 'blockchain.events',
        partition: 0,
        messages: [message('5', 1), message('6', 2)],
      },
      resolveOffset: resolveOffset as any,
      heartbeat,
    });

    expect(sink.published).toHaveLength(2);
    expect(resolveOffset).toHaveBeenCalledTimes(2);
    expect(consumer.commitOffsets).toHaveBeenCalledWith([
      { topic: 'blockchain.events', partition: 0, offset: '6' },
    ]);
    expect(heartbeat).toHaveBeenCalled();
    await worker.stop();
  });

  it('flushes and disconnects cleanly on stop', async () => {
    const worker = new KafkaConnectSinkWorker({ consumer: consumer as any, sink });
    await worker.start();
    await worker.stop();
    expect(consumer.disconnect).toHaveBeenCalled();
  });

  it('stop is idempotent', async () => {
    const worker = new KafkaConnectSinkWorker({ consumer: consumer as any, sink });
    await worker.start();
    await worker.stop();
    await worker.stop();
    expect(consumer.disconnect).toHaveBeenCalledTimes(1);
  });
});
