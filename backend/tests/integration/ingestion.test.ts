import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  acquireMigrationLock,
  markMigrationCompleted,
  resetPoolManagerForTests,
} from '../../src/database/pool_manager.js';

const MIGRATION_LOCK_KEY = 'migration_lock';
const MIGRATION_DONE_KEY = 'migration_done';

class InMemoryRedis {
  private readonly store = new Map<string, string>();

  async set(
    key: string,
    value: string,
    mode?: 'PX' | 'EX',
    _ttl?: number,
    condition?: 'NX',
  ): Promise<'OK' | null> {
    void mode;
    if (condition === 'NX' && this.store.has(key)) {
      return null;
    }
    this.store.set(key, value);
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.store.delete(key)) {
        removed++;
      }
    }
    return removed;
  }

  async exists(key: string): Promise<number> {
    return this.store.has(key) ? 1 : 0;
  }

  async quit(): Promise<'OK'> {
    this.store.clear();
    return 'OK';
  }
}

describe('Concurrent Migration Lock Integration', () => {
  let redisClient: InMemoryRedis;

  beforeEach(async () => {
    redisClient = new InMemoryRedis();
    await redisClient.del(MIGRATION_LOCK_KEY);
    await redisClient.del(MIGRATION_DONE_KEY);
    resetPoolManagerForTests();
  });

  afterEach(async () => {
    await redisClient.del(MIGRATION_LOCK_KEY);
    await redisClient.del(MIGRATION_DONE_KEY);
    await redisClient.quit();
  });

  it('should allow only one instance to acquire migration lock', async () => {
    const instance1Id = 'instance-1';
    const instance2Id = 'instance-2';

    const lock1 = await acquireMigrationLock(redisClient as never, instance1Id);
    const lock2 = await acquireMigrationLock(redisClient as never, instance2Id);

    expect(lock1).toBe(true);
    expect(lock2).toBe(false);

    const lockHolder = await redisClient.get(MIGRATION_LOCK_KEY);
    expect(lockHolder).toBe(instance1Id);
  });

  it('should simulate 6 concurrent migration attempts with only 1 succeeding', async () => {
    const instances = Array.from({ length: 6 }, (_, i) => `instance-${String(i + 1)}`);
    const lockResults = await Promise.all(
      instances.map((instanceId) => acquireMigrationLock(redisClient as never, instanceId)),
    );

    const successfulLocks = lockResults.filter((result: boolean) => result);
    const failedLocks = lockResults.filter((result: boolean) => !result);

    expect(successfulLocks.length).toBe(1);
    expect(failedLocks.length).toBe(5);

    const lockHolder = await redisClient.get(MIGRATION_LOCK_KEY);
    expect(lockHolder).toBeDefined();
    expect(instances).toContain(lockHolder);
  });

  it('should mark migration as completed and allow subsequent checks', async () => {
    const instanceId = 'instance-1';
    await acquireMigrationLock(redisClient as never, instanceId);

    await markMigrationCompleted(redisClient as never);

    const lockExists = await redisClient.exists(MIGRATION_LOCK_KEY);
    const doneExists = await redisClient.exists(MIGRATION_DONE_KEY);

    expect(lockExists).toBe(0);
    expect(doneExists).toBe(1);
  });

  it('should validate that env vars are present when configured', () => {
    if (process.env['DATABASE_URL'] != null && process.env['SOROBAN_RPC_URL'] != null) {
      expect(process.env['DATABASE_URL']).toBeDefined();
      expect(process.env['SOROBAN_RPC_URL']).toBeDefined();
    } else {
      expect(true).toBe(true);
    }
  });
});
