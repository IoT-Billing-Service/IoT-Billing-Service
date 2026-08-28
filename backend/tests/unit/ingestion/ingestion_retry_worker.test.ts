/**
 * Tests for the background ingestion retry worker (issue #292).
 *
 * Coverage:
 *  - success path: complete + onCompleted hook + no DLQ
 *  - transient failure with retries left: requeue, no DLQ
 *  - transient failure exhausting the budget: fail + DLQ
 *  - permanent failure: fail + DLQ immediately, never requeued
 *  - pollOnce returns the number of processed jobs
 *  - start() is idempotent and kicks an immediate poll
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  IngestionRetryQueue,
  type IngestionRetryJob,
} from '../../../src/core/ingestion/retry_queue.js';
import { IngestionRetryWorker } from '../../../src/core/ingestion/retry_worker.js';
import { DeviceNotFoundError } from '../../../src/core/ingestion/errors.js';
import type { DlqManager } from '../../../src/core/dlq_manager.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeRawRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'job-1',
    device_id: 'MTR-001',
    status: 'processing',
    retry_count: 0,
    next_attempt_at: new Date(Date.now() - 1000).toISOString(),
    last_error: null,
    state_data: JSON.stringify({
      payload: {
        deviceId: 'MTR-001',
        timestamp: Date.now(),
        nonce: 'nonce-1',
        metrics: { voltage: 220 },
        signature: 'ab'.repeat(64),
      },
      publicKey: 'ab'.repeat(32),
      proof: 'proof',
      powSolution: { nonce: '00000001', difficulty: 4 },
      metrics: { voltage: 220 },
      signedMessage: '{}',
      verifiedAt: Date.now(),
      payloadDigest: 'digest',
    }),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/** Build the mapped job shape expected by worker internals. */
function makeJob(overrides: Partial<IngestionRetryJob> = {}): IngestionRetryJob {
  return {
    id: 'job-1',
    deviceId: 'MTR-001',
    status: 'processing',
    retryCount: 0,
    nextAttemptAt: new Date(Date.now() - 1000),
    lastError: null,
    stateData: {
      payload: {
        deviceId: 'MTR-001',
        timestamp: Date.now(),
        nonce: 'nonce-1',
        metrics: { voltage: 220 },
        signature: 'ab'.repeat(64),
      },
      publicKey: 'ab'.repeat(32),
      proof: 'proof',
      powSolution: { nonce: '00000001', difficulty: 4 },
      metrics: { voltage: 220 },
      signedMessage: '{}',
      verifiedAt: Date.now(),
      payloadDigest: 'digest',
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createPrismaMock(rows: Record<string, unknown>[] = []) {
  const calls = {
    claim: vi.fn(),
    update: vi.fn().mockResolvedValue({}),
    findUnique: vi.fn().mockResolvedValue({ retryCount: 0 }),
    groupBy: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({ id: 'job-1' }),
  };

  calls.claim.mockResolvedValue(rows);

  const prisma = {
    ingestionJob: {
      create: calls.create,
      update: calls.update,
      findUnique: calls.findUnique,
      groupBy: calls.groupBy,
    },
    $queryRaw: calls.claim,
  } as unknown as PrismaClient;

  return { prisma, calls };
}

function makeDlqMock() {
  return {
    push: vi.fn().mockResolvedValue('dlq-id'),
    registerHandler: vi.fn(),
  } as unknown as DlqManager;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('IngestionRetryWorker', () => {
  let queue: IngestionRetryQueue;
  let prismaMock: ReturnType<typeof createPrismaMock>;
  let dlq: ReturnType<typeof makeDlqMock>;
  let persistFn: ReturnType<typeof vi.fn>;
  let onCompleted: ReturnType<typeof vi.fn>;
  let onError: ReturnType<typeof vi.fn>;
  let worker: IngestionRetryWorker;

  beforeEach(() => {
    prismaMock = createPrismaMock([]);
    queue = new IngestionRetryQueue(prismaMock.prisma, { maxRetries: 2 });
    dlq = makeDlqMock();
    persistFn = vi.fn();
    onCompleted = vi.fn();
    onError = vi.fn();
  });

  afterEach(() => {
    worker?.stop();
  });

  function buildWorker(): IngestionRetryWorker {
    worker = new IngestionRetryWorker(queue, persistFn, {
      batchSize: 10,
      dlq,
      onCompleted,
      onError,
    });
    return worker;
  }

  it('completes a job when persistence succeeds and fires onCompleted', async () => {
    prismaMock.calls.claim.mockResolvedValue([makeRawRow()]);
    persistFn.mockResolvedValue(2);
    buildWorker();

    const processed = await worker.pollOnce();

    expect(processed).toBe(1);
    expect(persistFn).toHaveBeenCalledTimes(1);
    expect(prismaMock.calls.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: expect.objectContaining({ status: 'completed' }),
    });
    expect(onCompleted).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-1' }), 2);
    expect(dlq.push).not.toHaveBeenCalled();
  });

  it('requeues a transient failure while retries remain (no DLQ)', async () => {
    prismaMock.calls.claim.mockResolvedValue([makeRawRow()]);
    persistFn.mockRejectedValue(new Error('connection reset'));
    buildWorker();

    await worker.pollOnce();

    expect(prismaMock.calls.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: expect.objectContaining({
        status: 'pending',
        retryCount: { increment: 1 },
        lastError: 'connection reset',
      }),
    });
    expect(dlq.push).not.toHaveBeenCalled();
  });

  it('dead-letters a transient failure once the retry budget is exhausted', async () => {
    prismaMock.calls.claim.mockResolvedValue([makeRawRow({ retry_count: 2 })]);
    persistFn.mockRejectedValue(new Error('connection reset'));
    buildWorker();

    await worker.pollOnce();

    expect(prismaMock.calls.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: expect.objectContaining({ status: 'failed', lastError: 'connection reset' }),
    });
    expect(dlq.push).toHaveBeenCalledWith(
      'telemetry_ingestion',
      expect.objectContaining({ jobId: 'job-1', deviceId: 'MTR-001' }),
      'connection reset',
    );
  });

  it('dead-letters a permanent error immediately without requeueing', async () => {
    prismaMock.calls.claim.mockResolvedValue([makeRawRow()]);
    persistFn.mockRejectedValue(new DeviceNotFoundError('MTR-001'));
    buildWorker();

    await worker.pollOnce();

    expect(prismaMock.calls.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: expect.objectContaining({ status: 'failed', lastError: 'Device not found: MTR-001' }),
    });
    expect(dlq.push).toHaveBeenCalledTimes(1);
    // The job had retries left but the error is permanent — never requeue.
    expect(
      prismaMock.calls.update.mock.calls.some(
        (call: unknown[]) => (call[0] as { data?: { status?: string } }).data?.status === 'pending',
      ),
    ).toBe(false);
  });

  it('processes up to the batch size and reports the count', async () => {
    prismaMock.calls.claim.mockResolvedValue([
      makeRawRow({ id: 'job-1' }),
      makeRawRow({ id: 'job-2' }),
    ]);
    persistFn.mockResolvedValue(1);
    buildWorker();

    const processed = await worker.pollOnce();
    expect(processed).toBe(2);
    expect(persistFn).toHaveBeenCalledTimes(2);
  });

  it('returns 0 when nothing is due', async () => {
    buildWorker();
    const processed = await worker.pollOnce();
    expect(processed).toBe(0);
    expect(persistFn).not.toHaveBeenCalled();
  });

  it('start() kicks an immediate poll and is idempotent', async () => {
    prismaMock.calls.claim.mockResolvedValue([]);
    buildWorker();

    worker.start();
    worker.start(); // second call must not double-schedule

    // Wait for the immediate poll to settle.
    await vi.waitFor(() => {
      expect(prismaMock.calls.claim).toHaveBeenCalled();
    });
  });

  it('surfaces job errors via onError when even marking failed throws', async () => {
    prismaMock.calls.claim.mockResolvedValue([makeRawRow({ retry_count: 2 })]);
    persistFn.mockRejectedValue(new Error('transient'));
    prismaMock.calls.update.mockRejectedValue(new Error('db down'));
    buildWorker();

    await expect(worker.pollOnce()).rejects.toThrow('db down');
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'job-1');
  });

  it('keeps the queue-depth gauge updated after each poll', async () => {
    prismaMock.calls.claim.mockResolvedValue([]);
    prismaMock.calls.groupBy.mockResolvedValue([
      { status: 'pending', _count: { _all: 4 } },
      { status: 'processing', _count: { _all: 1 } },
    ]);
    buildWorker();

    await worker.pollOnce();
    expect(prismaMock.calls.groupBy).toHaveBeenCalled();
  });
});
