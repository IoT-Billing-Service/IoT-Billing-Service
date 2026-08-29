/**
 * Tests for the durable telemetry ingestion retry queue (issue #292).
 *
 * Coverage:
 *  - enqueue persists a verified request as a pending job
 *  - claimDue atomically claims only due pending jobs (UPDATE … RETURNING)
 *  - claimDue maps raw snake_case rows back to IngestionRetryJob
 *  - complete / fail / requeue state transitions
 *  - requeue schedules exponential backoff and increments retryCount
 *  - getStats aggregates counts by status
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  IngestionRetryQueue,
  computeRetryDelayMs,
  type StoredIngestRequest,
} from '../../../src/core/ingestion/retry_queue.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeStoredRequest(overrides: Partial<StoredIngestRequest> = {}): StoredIngestRequest {
  return {
    payload: {
      deviceId: 'MTR-001',
      timestamp: Date.now(),
      nonce: 'nonce-1',
      metrics: { voltage: 220, temperature: 25 },
      signature: 'ab'.repeat(64),
    },
    publicKey: 'ab'.repeat(32),
    proof: 'proof-buffer',
    powSolution: { nonce: '00000001', difficulty: 4 },
    metrics: { voltage: 220, temperature: 25 },
    signedMessage: '{"deviceId":"MTR-001"}',
    verifiedAt: Date.now(),
    payloadDigest: 'digest',
    ...overrides,
  };
}

function rawRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'job-1',
    device_id: 'MTR-001',
    status: 'pending',
    retry_count: 0,
    next_attempt_at: new Date().toISOString(),
    last_error: null,
    state_data: JSON.stringify(makeStoredRequest()),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function createQueuePrisma(): {
  prisma: PrismaClient;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  findUnique: ReturnType<typeof vi.fn>;
  groupBy: ReturnType<typeof vi.fn>;
  queryRaw: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn().mockResolvedValue({ id: 'job-1' });
  const update = vi.fn().mockResolvedValue({});
  const findUnique = vi.fn();
  const groupBy = vi.fn().mockResolvedValue([]);
  const queryRaw = vi.fn().mockResolvedValue([]);

  const prisma = {
    ingestionJob: { create, update, findUnique, groupBy },
    $queryRaw: queryRaw,
  } as unknown as PrismaClient;

  return { prisma, create, update, findUnique, groupBy, queryRaw };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('IngestionRetryQueue', () => {
  let mocks: ReturnType<typeof createQueuePrisma>;
  let queue: IngestionRetryQueue;
  let randomSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mocks = createQueuePrisma();
    queue = new IngestionRetryQueue(mocks.prisma, { maxRetries: 3 });
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    randomSpy.mockRestore();
  });

  describe('enqueue', () => {
    it('persists a verified request as a pending job with the full state', async () => {
      const request = makeStoredRequest();

      const jobId = await queue.enqueue(request);

      expect(jobId).toBe('job-1');
      expect(mocks.create).toHaveBeenCalledWith({
        data: {
          deviceId: 'MTR-001',
          status: 'pending',
          retryCount: 0,
          nextAttemptAt: expect.any(Date),
          stateData: request,
        },
      });
    });
  });

  describe('claimDue', () => {
    it('issues an UPDATE … RETURNING restricted to due pending jobs', async () => {
      mocks.queryRaw.mockResolvedValue([rawRow()]);

      const jobs = await queue.claimDue(20);

      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        id: 'job-1',
        deviceId: 'MTR-001',
        status: 'pending',
        retryCount: 0,
      });

      const [strings, ...values] = mocks.queryRaw.mock.calls[0] as unknown as [
        TemplateStringsArray,
        ...unknown[],
      ];
      const sql = strings.join('?');
      expect(sql).toContain('UPDATE ingestion_jobs');
      expect(sql).toContain("status = 'processing'");
      expect(sql).toContain('next_attempt_at');
      expect(sql).toContain('RETURNING');
      expect(values[0]).toBeInstanceOf(Date);
      expect(values).toContain(20);
    });

    it('maps a JSONB-parsed state_data back to a StoredIngestRequest', async () => {
      const request = makeStoredRequest();
      mocks.queryRaw.mockResolvedValue([
        rawRow({ status: 'processing', state_data: JSON.stringify(request) }),
      ]);

      const jobs = await queue.claimDue(5);
      expect(jobs[0]?.stateData).toEqual(request);
    });

    it('returns an empty array when nothing is due', async () => {
      const jobs = await queue.claimDue(5);
      expect(jobs).toEqual([]);
    });

    it('throws when a claimed row has no state_data', async () => {
      mocks.queryRaw.mockResolvedValue([rawRow({ state_data: null })]);

      await expect(queue.claimDue(5)).rejects.toThrow(/no valid state_data/);
    });
  });

  describe('complete / fail', () => {
    it('marks a job completed', async () => {
      await queue.complete('job-1');
      expect(mocks.update).toHaveBeenCalledWith({
        where: { id: 'job-1' },
        data: expect.objectContaining({ status: 'completed' }),
      });
    });

    it('marks a job failed with the error reason', async () => {
      await queue.fail('job-1', 'device not found');
      expect(mocks.update).toHaveBeenCalledWith({
        where: { id: 'job-1' },
        data: expect.objectContaining({ status: 'failed', lastError: 'device not found' }),
      });
    });
  });

  describe('requeue', () => {
    it('increments retryCount and schedules a backoff in the future', async () => {
      mocks.findUnique.mockResolvedValue({ retryCount: 1 });

      await queue.requeue('job-1', 'db blip');

      const [arg] = mocks.update.mock.calls[0] as unknown as [
        {
          data: {
            status: string;
            retryCount: { increment: number };
            nextAttemptAt: Date;
            lastError: string;
          };
        },
      ];
      expect(arg.data.status).toBe('pending');
      expect(arg.data.retryCount).toEqual({ increment: 1 });
      expect(arg.data.lastError).toBe('db blip');
      expect(arg.data.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('getStats', () => {
    it('aggregates counts by status, defaulting missing statuses to zero', async () => {
      mocks.groupBy.mockResolvedValue([
        { status: 'pending', _count: { _all: 3 } },
        { status: 'failed', _count: { _all: 1 } },
      ]);

      const stats = await queue.getStats();
      expect(stats).toEqual({ pending: 3, processing: 0, completed: 0, failed: 1 });
    });
  });

  describe('computeRetryDelayMs', () => {
    it('grows exponentially with the attempt number', () => {
      const opts = { baseBackoffMs: 1000, maxBackoffMs: 10_000, jitterFactor: 0 };

      // With Math.random() fixed at 0.5 the delay is capped * 0.5.
      expect(computeRetryDelayMs(0, opts)).toBe(500);
      expect(computeRetryDelayMs(1, opts)).toBe(1000);
      expect(computeRetryDelayMs(2, opts)).toBe(2000);
    });

    it('caps the delay at maxBackoffMs for large attempt counts', () => {
      const opts = { baseBackoffMs: 1000, maxBackoffMs: 5000, jitterFactor: 0 };
      expect(computeRetryDelayMs(10, opts)).toBe(2500);
    });

    it('stays within [0, capped) under jitter', () => {
      randomSpy.mockReturnValue(0.999);
      const opts = { baseBackoffMs: 1000, maxBackoffMs: 5000, jitterFactor: 0 };
      const delay = computeRetryDelayMs(0, opts);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(1000);
    });
  });
});
