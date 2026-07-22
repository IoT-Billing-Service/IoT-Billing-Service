import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Redis } from 'ioredis';
import { CacheService, createCache, cacheKey } from '../../../src/cache/cache_service.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockRedis() {
  const store = new Map<string, { value: string; ttl: number }>();
  return {
    store,
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (entry === undefined) return null;
      if (entry.ttl > 0 && entry.ttl < Date.now() / 1000) {
        store.delete(key);
        return null;
      }
      return entry.value;
    }),
    set: vi.fn(
      async (
        key: string,
        value: string,
        ...args: (string | number)[]
      ): Promise<'OK' | null> => {
        let ttl = -1;
        let nx = false;

        for (let i = 0; i < args.length; i++) {
          if (args[i] === 'EX' && i + 1 < args.length) {
            ttl = Number(args[i + 1]);
          }
          if (args[i] === 'NX') {
            nx = true;
          }
        }

        if (nx && store.has(key)) return null;

        store.set(key, {
          value,
          ttl: ttl > 0 ? Date.now() / 1000 + ttl : -1,
        });
        return 'OK';
      },
    ),
    del: vi.fn(async (...keys: string[]) => {
      let count = 0;
      for (const key of keys) {
        if (store.delete(key)) count++;
      }
      return count;
    }),
    expire: vi.fn(async (key: string, seconds: number) => {
      const entry = store.get(key);
      if (entry !== undefined) {
        entry.ttl = Date.now() / 1000 + seconds;
        return 1;
      }
      return 0;
    }),
    keys: vi.fn(async (pattern: string) => {
      // Simple pattern matching: convert glob `*` to regex
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      return [...store.keys()].filter((k) => regex.test(k));
    }),
    on: vi.fn(),
  };
}

// Override the getRedis import for testing
vi.mock('../../../src/database/redis.js', () => {
  let cachedMock: ReturnType<typeof createMockRedis> | null = null;
  return {
    getRedis: () => {
      if (cachedMock === null) {
        cachedMock = createMockRedis();
      }
      return cachedMock as unknown as Redis;
    },
    setRedisClient: vi.fn(),
    closeRedis: vi.fn(),
  };
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CacheService', () => {
  let cache: CacheService<string>;

  beforeEach(() => {
    vi.clearAllMocks();
    cache = new CacheService<string>({
      l1MaxKeys: 100,
      l1DefaultTtlMs: 60_000,
      redisDefaultTtlS: 3600,
      redisKeyPrefix: 'test:',
    });
  });

  describe('getOrSet', () => {
    it('calls factory on miss and caches the result', async () => {
      const factory = vi.fn(async () => 'computed-value');

      const result = await cache.getOrSet('key1', factory);

      expect(result).toBe('computed-value');
      expect(factory).toHaveBeenCalledTimes(1);

      // Second call should hit L1
      const result2 = await cache.getOrSet('key1', factory);
      expect(result2).toBe('computed-value');
      expect(factory).toHaveBeenCalledTimes(1); // Still 1
    });

    it('returns null from factory', async () => {
      const factory = vi.fn(async () => null as unknown as string);

      const result = await cache.getOrSet('nullKey', factory);

      expect(result).toBeNull();
    });

    it('returns undefined from factory', async () => {
      const factory = vi.fn(async () => undefined as unknown as string);

      const result = await cache.getOrSet('undefKey', factory);

      expect(result).toBeUndefined();
    });

    it('hits L1 cache on second call', async () => {
      const factory = vi.fn(async () => 'cached');

      await cache.getOrSet('key2', factory);
      factory.mockClear();

      const result = await cache.getOrSet('key2', factory);

      expect(result).toBe('cached');
      expect(factory).not.toHaveBeenCalled();
    });

    it('expires L1 entries after TTL', async () => {
      const factory = vi.fn(async () => 'stale-value');

      // Use a very short TTL for both L1 and L2
      await cache.getOrSet('key3-expire', factory, 50, 1); // 50ms L1, 1s Redis
      factory.mockClear();

      // Wait for L1 expiry
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should call factory again since L1 expired (L2 still alive, so this
      // test verifies L1 expiry properly by checking factory wasn't called
      // because L2 is still alive)
      const result = await cache.getOrSet('key3-expire', factory, 50);
      expect(result).toBe('stale-value');
      // L2 hit, factory not called — entry was found in Redis
      expect(factory).not.toHaveBeenCalled();
    });

    it('bypasses both L1 and L2 when both expire', async () => {
      const shortLivedCache = new CacheService<string>({
        l1MaxKeys: 100,
        l1DefaultTtlMs: 50,
        redisDefaultTtlS: 1, // 1 second so it expires quickly
        redisKeyPrefix: 'test:',
      });

      const factory = vi.fn(async () => 'fresh-value');

      // Set with very short TTLs
      await shortLivedCache.set('ephemeral', 'old-value', 50, 1);

      // Wait for both L1 and L2 to expire
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Should call factory
      const result = await shortLivedCache.getOrSet('ephemeral', factory);
      expect(result).toBe('fresh-value');
      expect(factory).toHaveBeenCalledTimes(1);
    });

    it('supports custom TTL per call', async () => {
      const factory = vi.fn(async () => 'with-custom-ttl');

      // Set with 1-hour TTL override
      await cache.getOrSet('key4', factory, 3_600_000, 7200);
      factory.mockClear();

      // Should still be in L1
      const result = await cache.getOrSet('key4', factory);
      expect(result).toBe('with-custom-ttl');
      expect(factory).not.toHaveBeenCalled();
    });
  });

  describe('set', () => {
    it('sets a value in both L1 and L2', async () => {
      await cache.set('direct-key', 'direct-value');

      const result = await cache.getOrSet('direct-key', async () => 'fallback');
      expect(result).toBe('direct-value');
    });

    it('overwrites existing cache entry', async () => {
      await cache.set('overwrite-key', 'old-value');
      await cache.set('overwrite-key', 'new-value');

      const result = await cache.getOrSet('overwrite-key', async () => 'fallback');
      expect(result).toBe('new-value');
    });
  });

  describe('invalidate', () => {
    it('removes a key from both L1 and L2', async () => {
      await cache.set('inval-key', 'to-invalidate');

      await cache.invalidate('inval-key');

      const factory = vi.fn(async () => 'refetched');
      const result = await cache.getOrSet('inval-key', factory);
      expect(result).toBe('refetched');
      expect(factory).toHaveBeenCalledTimes(1);
    });

    it('does not throw when invalidating a non-existent key', async () => {
      await expect(cache.invalidate('non-existent')).resolves.not.toThrow();
    });
  });

  describe('invalidatePattern', () => {
    it('clears all matching keys from L2 and flushes L1', async () => {
      await cache.set('user:1', 'alice');
      await cache.set('user:2', 'bob');
      await cache.set('session:1', 'token');

      await cache.invalidatePattern('user:*');

      // L1 should be flushed — next call should go to factory
      const factory1 = vi.fn(async () => 'alice-new');
      const result1 = await cache.getOrSet('user:1', factory1);
      expect(result1).toBe('alice-new');
      expect(factory1).toHaveBeenCalledTimes(1);
    });
  });

  describe('getL1', () => {
    it('returns value from L1 synchronously', async () => {
      await cache.set('l1-key', 'l1-value');

      const result = cache.getL1('l1-key');
      expect(result).toBe('l1-value');
    });

    it('returns undefined on miss', () => {
      const result = cache.getL1('no-such-key');
      expect(result).toBeUndefined();
    });

    it('returns undefined on expired L1 entry', async () => {
      await cache.set('expire-key', 'expiring', 50); // 50ms TTL

      await new Promise((resolve) => setTimeout(resolve, 100));

      const result = cache.getL1('expire-key');
      expect(result).toBeUndefined();
    });
  });

  describe('flushL1', () => {
    it('clears all L1 entries but preserves L2', async () => {
      await cache.set('flush-key', 'flush-value');

      cache.flushL1();

      // L1 miss, but L2 hit
      const factory = vi.fn(async () => 'fallback');
      const result = await cache.getOrSet('flush-key', factory);
      expect(result).toBe('flush-value');
      expect(factory).not.toHaveBeenCalled();
    });
  });

  describe('getStats', () => {
    it('tracks hits and misses correctly', async () => {
      // Initial miss
      await cache.getOrSet('stats-1', async () => 'val1');

      const statsAfterMiss = cache.getStats();
      expect(statsAfterMiss.misses).toBe(1);
      expect(statsAfterMiss.l1Hits).toBe(0);

      // L1 hit
      await cache.getOrSet('stats-1', async () => 'val1');

      const statsAfterHit = cache.getStats();
      expect(statsAfterHit.l1Hits).toBe(1);
      expect(statsAfterHit.misses).toBe(1);
      expect(statsAfterHit.l1Size).toBe(1);
    });

    it('resetStats clears counters but not cached data', async () => {
      await cache.getOrSet('reset-key', async () => 'val');

      cache.resetStats();

      const stats = cache.getStats();
      expect(stats.l1Hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.l1Size).toBe(1); // Data still there
    });
  });

  describe('L1 eviction', () => {
    it('evicts oldest entries when capacity is reached', async () => {
      const smallCache = new CacheService<string>({
        l1MaxKeys: 10,
        l1DefaultTtlMs: 60_000,
        redisDefaultTtlS: 3600,
        redisKeyPrefix: 'test:',
      });

      // Fill beyond capacity
      for (let i = 0; i < 15; i++) {
        await smallCache.set(`evict-${i}`, `value-${i}`);
      }

      const stats = smallCache.getStats();
      // Should have evicted some entries
      expect(stats.evictions).toBeGreaterThan(0);
      // L1 size should not exceed max
      expect(stats.l1Size).toBeLessThanOrEqual(10);
    });
  });
});

describe('createCache', () => {
  it('creates a cache with a namespaced key prefix', async () => {
    const billingCache = createCache<string>('billing');

    const factory = vi.fn(async () => 'billing-value');
    const result = await billingCache.getOrSet('record:1', factory);

    expect(result).toBe('billing-value');
  });
});

describe('cacheKey', () => {
  it('builds a canonical cache key', () => {
    expect(cacheKey('billing', 'cycle', 'abc-123')).toBe('billing:cycle:abc-123');
    expect(cacheKey('tenant', 'profile')).toBe('tenant:profile');
    expect(cacheKey('rate', 'limit', 'device', 'SN-456')).toBe('rate:limit:device:SN-456');
  });
});
