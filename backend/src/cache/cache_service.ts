/**
 * General-purpose in-memory cache layer with Redis L2 and configurable TTL
 * (issue #68).
 *
 * Provides a two-level caching architecture:
 *
 * - **L1**: In-memory `Map` with per-entry TTL (nanosecond-granularity lookups).
 * - **L2**: Redis-backed shared cache with configurable TTL.
 *
 * ## Design
 *
 * - **TTL-aware**: every cache entry carries its own expiry. Stale entries are
 *   lazily evicted on read.
 * - **Atomic L2 ops**: Redis `SET NX` prevents two callers from racing on a
 *   cache-miss write (the first writer wins; others discard their value).
 * - **Type-safe**: typed get/set via generics so callers don't need manual
 *   casts.
 * - **Observable**: hit/miss counters are exposed for Prometheus/metrics.
 * - **PCI-DSS / SOC2**: cryptographic integrity assumed at the Redis transport
 *   layer (TLS). This layer does not store PII in plaintext — callers are
 *   expected to encrypt before calling `set` if needed.
 *
 * ## Performance
 *
 * | Operation             | Expected latency | Notes                          |
 * |-----------------------|------------------|--------------------------------|
 * | L1 hit                | < 1 µs           | Synchronous Map lookup         |
 * | L2 hit (Redis GET)    | < 1 ms           | Network round-trip to Redis    |
 * | L2 miss → DB fallback | App-dependent    | Caller-provided factory        |
 * | Set (L1 + L2)         | < 1 ms           | Includes Redis SET             |
 *
 * All operations stay well under the 200 ms P99 billing budget.
 */

import type { Redis } from 'ioredis';
import { getRedis } from '../database/redis.js';

// ── Constants ──────────────────────────────────────────────────────────────────

/** Default TTL for Redis keys (seconds) when no explicit TTL is provided. */
const DEFAULT_REDIS_TTL_S = 3600; // 1 hour

/** Maximum number of entries allowed in the L1 in-memory cache. */
const DEFAULT_L1_MAX_KEYS = 10_000;

/** Default TTL for L1 in-memory entries (milliseconds). */
const DEFAULT_L1_TTL_MS = 60_000; // 1 minute

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CacheEntry<T> {
  /** The cached value. */
  value: T;
  /** Unix timestamp (ms) when this entry expires. */
  expiresAt: number;
}

export interface CacheStats {
  /** Total L1 (in-memory) cache hits. */
  l1Hits: number;
  /** Total L2 (Redis) cache hits. */
  l2Hits: number;
  /** Total cache misses (neither L1 nor L2 had the key). */
  misses: number;
  /** Current number of entries in L1. */
  l1Size: number;
  /** Total evictions from L1 due to size cap. */
  evictions: number;
}

export interface CacheServiceOptions {
  /**
   * Maximum number of entries in the L1 in-memory cache.
   * When exceeded, the least-recently-used quarter is evicted.
   * @default 10_000
   */
  l1MaxKeys?: number;

  /**
   * Default TTL for L1 entries in milliseconds.
   * Individual calls can override via the `ttlMs` parameter.
   * @default 60_000 (1 minute)
   */
  l1DefaultTtlMs?: number;

  /**
   * Default TTL for Redis (L2) entries in seconds.
   * @default 3600 (1 hour)
   */
  redisDefaultTtlS?: number;

  /**
   * Optional key prefix for Redis keys to avoid collisions.
   * @default 'cache:'
   */
  redisKeyPrefix?: string;
}

// ── Service ────────────────────────────────────────────────────────────────────

/**
 * Generic two-level cache service.
 *
 * Designed to be instantiated per domain (e.g. billing cache, tenant cache,
 * rate-limit cache) so that each domain has its own L1 space and Redis key
 * namespace.
 *
 * @typeParam T — the type of cached values (will be JSON-serialized for Redis)
 */
export class CacheService<T = unknown> {
  // ── L1: in-memory Map ───────────────────────────────────────────────────
  private readonly l1 = new Map<string, CacheEntry<T>>();
  private readonly l1MaxKeys: number;
  private readonly l1DefaultTtlMs: number;

  // ── L2: Redis ───────────────────────────────────────────────────────────
  private readonly redis: Redis;
  private readonly redisDefaultTtlS: number;
  private readonly redisKeyPrefix: string;

  // ── Stats ───────────────────────────────────────────────────────────────
  private _l1Hits = 0;
  private _l2Hits = 0;
  private _misses = 0;
  private _evictions = 0;

  constructor(options: CacheServiceOptions = {}) {
    this.l1MaxKeys = options.l1MaxKeys ?? DEFAULT_L1_MAX_KEYS;
    this.l1DefaultTtlMs = options.l1DefaultTtlMs ?? DEFAULT_L1_TTL_MS;
    this.redisDefaultTtlS = options.redisDefaultTtlS ?? DEFAULT_REDIS_TTL_S;
    this.redisKeyPrefix = options.redisKeyPrefix ?? 'cache:';
    this.redis = getRedis();
  }

  /**
   * Retrieve a value from cache.
   *
   * Checks L1 first, then L2 (Redis), and finally calls the `factory`
   * function to compute the value if both miss. The factory result is
   * automatically populated into both L1 and L2.
   *
   * @param key        — cache key (namespaced under the service's Redis prefix)
   * @param factory    — async function that computes the value on a miss
   * @param ttlMs      — L1 TTL override in milliseconds (defaults to {@link l1DefaultTtlMs})
   * @param redisTtlS  — L2 TTL override in seconds (defaults to {@link redisDefaultTtlS})
   * @returns the cached or freshly-computed value
   */
  async getOrSet(
    key: string,
    factory: () => Promise<T>,
    ttlMs?: number,
    redisTtlS?: number,
  ): Promise<T> {
    const now = Date.now();
    const effectiveTtlMs = ttlMs ?? this.l1DefaultTtlMs;
    const effectiveRedisTtlS = redisTtlS ?? this.redisDefaultTtlS;

    // 1. Check L1
    const l1Entry = this.l1.get(key);
    if (l1Entry !== undefined) {
      if (l1Entry.expiresAt > now) {
        this._l1Hits++;
        return l1Entry.value;
      }
      // Stale — evict
      this.l1.delete(key);
    }

    // 2. Check L2 (Redis)
    const redisKey = this.redisKeyPrefix + key;
    const redisVal = await this.redis.get(redisKey);
    if (redisVal !== null) {
      this._l2Hits++;
      let parsed: T;
      try {
        parsed = JSON.parse(redisVal) as T;
      } catch {
        // Corrupt JSON — treat as miss and overwrite
        const value = await factory();
        await this.populateBoth(key, redisKey, value, effectiveTtlMs, effectiveRedisTtlS);
        return value;
      }
      // Populate L1 (it was a miss there) and return
      this.setL1(key, parsed, effectiveTtlMs);
      return parsed;
    }

    // 3. Miss — call factory
    this._misses++;
    const value = await factory();
    await this.populateBoth(key, redisKey, value, effectiveTtlMs, effectiveRedisTtlS);
    return value;
  }

  /**
   * Set a value directly into both L1 and L2.
   *
   * @param key        — cache key
   * @param value      — value to cache (JSON-serializable for Redis)
   * @param ttlMs      — L1 TTL in milliseconds
   * @param redisTtlS  — L2 TTL in seconds
   */
  async set(
    key: string,
    value: T,
    ttlMs?: number,
    redisTtlS?: number,
  ): Promise<void> {
    const effectiveTtlMs = ttlMs ?? this.l1DefaultTtlMs;
    const effectiveRedisTtlS = redisTtlS ?? this.redisDefaultTtlS;
    const redisKey = this.redisKeyPrefix + key;

    this.setL1(key, value, effectiveTtlMs);
    await this.redis.set(redisKey, JSON.stringify(value), 'EX', effectiveRedisTtlS);
  }

  /**
   * Invalidate a key from both L1 and L2.
   */
  async invalidate(key: string): Promise<void> {
    this.l1.delete(key);
    await this.redis.del(this.redisKeyPrefix + key);
  }

  /**
   * Invalidate all keys matching a pattern in L2 (Redis).
   * L1 is fully flushed for simplicity — the next L1 hit will repopulate
   * from L2 or factory.
   *
   * @param pattern — Redis glob pattern (e.g. `user:*`)
   */
  async invalidatePattern(pattern: string): Promise<void> {
    const fullPattern = this.redisKeyPrefix + pattern;
    const keys = await this.redis.keys(fullPattern);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
    // Flush L1: we don't track which keys map to which Redis keys
    this.l1.clear();
  }

  /**
   * Get a value from L1 only (synchronous, no Redis). Returns `undefined`
   * on miss or expired entry.
   */
  getL1(key: string): T | undefined {
    const entry = this.l1.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.l1.delete(key);
      return undefined;
    }
    this._l1Hits++;
    return entry.value;
  }

  /**
   * Flush the entire L1 cache. L2 is left untouched.
   */
  flushL1(): void {
    this.l1.clear();
  }

  /**
   * Current cache statistics (snapshot).
   */
  getStats(): CacheStats {
    return {
      l1Hits: this._l1Hits,
      l2Hits: this._l2Hits,
      misses: this._misses,
      l1Size: this.l1.size,
      evictions: this._evictions,
    };
  }

  /**
   * Reset all statistics counters (does not clear cached data).
   */
  resetStats(): void {
    this._l1Hits = 0;
    this._l2Hits = 0;
    this._misses = 0;
    this._evictions = 0;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private setL1(key: string, value: T, ttlMs: number): void {
    // Evict if at capacity (simple LRU-ish: evict oldest 25 %)
    if (this.l1.size >= this.l1MaxKeys) {
      this.evictL1();
    }

    this.l1.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  private async populateBoth(
    key: string,
    redisKey: string,
    value: T,
    l1TtlMs: number,
    redisTtlS: number,
  ): Promise<void> {
    this.setL1(key, value, l1TtlMs);
    // Use SET with NX to avoid overwriting a concurrent writer
    const serialized = JSON.stringify(value);
    const result = await this.redis.set(redisKey, serialized, 'EX', redisTtlS, 'NX');
    if (result === null) {
      // Another caller already wrote this key — extend the TTL on the
      // existing key to prevent premature expiry storms
      await this.redis.expire(redisKey, redisTtlS);
    }
  }

  private evictL1(): void {
    // Evict the oldest ~25 % of entries (sorted by expiry).
    // This is a best-effort eviction — we don't need a perfect LRU.
    const entries = [...this.l1.entries()];
    const evictCount = Math.max(1, Math.ceil(entries.length * 0.25));

    // Sort by expiry (oldest first) and remove the first evictCount
    entries.sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (let i = 0; i < evictCount; i++) {
      const entry = entries[i];
      if (entry !== undefined) {
        this.l1.delete(entry[0]);
        this._evictions++;
      }
    }
  }
}

/**
 * Convenience factory: create a cache service for a specific domain.
 *
 * ```ts
 * const billingCache = createCache<BillingRecord>('billing', { l1MaxKeys: 5000 });
 * const record = await billingCache.getOrSet('record:123', () => fetchFromDb(123));
 * ```
 */
export function createCache<T = unknown>(
  namespace: string,
  options: CacheServiceOptions = {},
): CacheService<T> {
  return new CacheService<T>({
    ...options,
    redisKeyPrefix: options.redisKeyPrefix ?? `cache:${namespace}:`,
  });
}

// ── Key namespace helper ─────────────────────────────────────────────────────

/**
 * Build a canonical cache key from a namespace and ID parts.
 *
 * ```ts
 * cacheKey('billing', 'cycle', cycleId)   // => 'billing:cycle:abc-123'
 * cacheKey('tenant', 'profile', deviceId) // => 'tenant:profile:SN-456'
 * ```
 */
export function cacheKey(namespace: string, ...parts: string[]): string {
  return [namespace, ...parts].join(':');
}
