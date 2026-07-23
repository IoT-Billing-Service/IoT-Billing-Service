import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { DistributedScheduler } from '../../../src/scheduler/distributed_scheduler.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockRedis {
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  pexpire: ReturnType<typeof vi.fn>;
  exists: ReturnType<typeof vi.fn>;
}

interface MockPool {
  query: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
}

function createMockRedis(): MockRedis {
  const storage = new Map<string, { value: string; ttl?: number }>();
  return {
    set: vi.fn().mockImplementation(
      (key: string, value: string, ...args: string[]) => {
        const pxIdx = args.indexOf('PX');
        const ttl = pxIdx >= 0 ? Number(args[pxIdx + 1]) : undefined;
        if (args.includes('NX') && storage.has(key)) {
          return Promise.resolve(null);
        }
        storage.set(key, { value, ttl });
        return Promise.resolve('OK');
      },
    ),
    del: vi.fn().mockImplementation((_key: string) => {
      storage.delete(_key);
      return Promise.resolve(1);
    }),
    pexpire: vi.fn().mockImplementation((_key: string, _ms: number) => {
      return Promise.resolve(storage.has(_key) ? 1 : 0);
    }),
    exists: vi.fn().mockImplementation((key: string) => {
      return Promise.resolve(storage.has(key) ? 1 : 0);
    }),
  };
}

function createMockPool(): MockPool {
  const queryFn = vi.fn();
  return { query: queryFn, connect: vi.fn() };
}

describe('DistributedScheduler', () => {
  let mockRedis: MockRedis;
  let mockPool: MockPool;
  let scheduler: DistributedScheduler;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockRedis = createMockRedis();
    mockPool = createMockPool();
    scheduler = new DistributedScheduler(mockRedis as unknown as Redis, mockPool as unknown as pg.Pool, {
      pollIntervalMs: 100,
      leaseMs: 500,
      concurrency: 2,
    });
  });

  describe('constructor', () => {
    it('should create a scheduler with default options', () => {
      const s = new DistributedScheduler(mockRedis as unknown as Redis, mockPool as unknown as pg.Pool);
      expect(s).toBeDefined();
    });
  });

  describe('registerHandler / unregisterHandler', () => {
    it('should register and unregister handlers by type', () => {
      const handler = vi.fn();
      scheduler.registerHandler('test-type', handler);
      scheduler.unregisterHandler('test-type');
    });
  });

  describe('enqueue', () => {
    it('should insert a job into the database', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });
      await scheduler.enqueue('test-type', { key: 'value' });
      expect(mockPool.query).toHaveBeenCalled();
    });

    it('should return a hex job id', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });
      const id = await scheduler.enqueue('test-type', { key: 'value' });
      expect(id).toMatch(/^[0-9a-f]{32}$/);
    });

    it('should accept priority and maxRetries options', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });
      const id = await scheduler.enqueue('test-type', { key: 'value' }, { priority: 5, maxRetries: 10 });
      expect(id).toBeDefined();
    });
  });

  describe('getStats', () => {
    it('should return zero counts when no jobs exist', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });
      const stats = await scheduler.getStats();
      expect(stats.pending).toBe(0);
      expect(stats.active).toBe(0);
      expect(stats.completed).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.dlq).toBe(0);
    });

    it('should return correct counts from DB', async () => {
      mockPool.query.mockResolvedValue({
        rows: [
          { status: 'PENDING', count: 3 },
          { status: 'COMPLETED', count: 2 },
        ],
      });
      const stats = await scheduler.getStats();
      expect(stats.pending).toBe(3);
      expect(stats.completed).toBe(2);
      expect(stats.active).toBe(0);
    });
  });

  describe('start / stop', () => {
    it('should start without error', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });
      await scheduler.start();
      scheduler.stop();
    });

    it('should be idempotent to start twice', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });
      await scheduler.start();
      await scheduler.start();
      scheduler.stop();
    });
  });

  describe('recoverAbandonedJobs', () => {
    it('should recover abandoned jobs where Redis lease does not exist', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'job-1' }] });
      mockRedis.exists.mockResolvedValueOnce(0);
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const recovered = await scheduler.recoverAbandonedJobs();
      expect(recovered).toBe(1);
    });

    it('should skip jobs where Redis lease still exists', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'job-1' }] });
      mockRedis.exists.mockResolvedValueOnce(1);

      const recovered = await scheduler.recoverAbandonedJobs();
      expect(recovered).toBe(0);
    });
  });
});
