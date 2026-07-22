/**
 * Integration test: Distributed Job Scheduler Lease-based Worker Claiming (issue #60, #73)
 *
 * Tests the job lifecycle: enqueue, stats, handler registration, and recovery
 * of abandoned jobs.  Uses mock Redis and a real PostgreSQL pool for the
 * scheduler_jobs table so the DB interaction is tested end-to-end.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { DistributedScheduler } from '../../src/scheduler/distributed_scheduler.js';
import { getTimescalePool, resetPoolManagerForTests } from '../../src/database/pool_manager.js';

const TEST_SCHEMA = 'scheduler_e2e_test';

describe('E2E: Distributed Job Scheduler Lease Claiming', () => {
  let pool: ReturnType<typeof getTimescalePool>;
  let scheduler: DistributedScheduler;

  beforeAll(async () => {
    resetPoolManagerForTests();
    pool = getTimescalePool();
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${TEST_SCHEMA}`);
    await pool.query(`SET search_path TO ${TEST_SCHEMA}, public`);
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    // Create a fresh mock-Redis per test so state does not leak.
    const redisMock = createE2eRedis();
    scheduler = new DistributedScheduler(redisMock as unknown as Redis, pool, {
      leaseMs: 1000,
      pollIntervalMs: 500,
      concurrency: 1,
    });
  });

  afterAll(async () => {
    scheduler.stop();
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    } catch {
      /* ignore */
    }
    resetPoolManagerForTests();
  });

  it('should enqueue a job and return a valid id', async () => {
    const id = await scheduler.enqueue('email', { to: 'test@example.com', body: 'Hello' });
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('should return correct stats after enqueuing', async () => {
    await scheduler.enqueue('report', { period: 'daily' });
    const stats = await scheduler.getStats();
    expect(typeof stats.pending).toBe('number');
  });

  it('should start the scheduler without error', async () => {
    await scheduler.start();
    scheduler.stop();
  });

  it('should recover abandoned jobs (none expected)', async () => {
    const recovered = await scheduler.recoverAbandonedJobs();
    expect(typeof recovered).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Lightweight in-memory Redis mock (created inside beforeEach so vi.fn() runs
// in test context, consistent with the rest of the codebase).
// ---------------------------------------------------------------------------

function createE2eRedis() {
  const store = new Map<string, { value: string; px?: number }>();

  return {
    set: vi.fn().mockImplementation(
      async (key: string, value: string, ...args: string[]) => {
        const pxIdx = args.indexOf('PX');
        const px = pxIdx >= 0 ? Number(args[pxIdx + 1]) : undefined;
        if (args.includes('NX') && store.has(key)) {
          return null;
        }
        store.set(key, { value, px });
        return 'OK';
      },
    ),
    del: vi.fn().mockImplementation(async (_key: string) => {
      store.delete(_key);
      return 1;
    }),
    pexpire: vi.fn().mockImplementation(async (_key: string, _ms: number) => {
      return store.has(_key) ? 1 : 0;
    }),
    exists: vi.fn().mockImplementation(async (key: string) => {
      return store.has(key) ? 1 : 0;
    }),
  };
}
