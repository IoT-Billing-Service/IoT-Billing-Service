/**
 * Tests for MetricRangesConfig hot-reload watcher (issue #74).
 *
 * Covers:
 * - initializeConfigWatcher bootstraps from Redis when key exists
 * - initializeConfigWatcher writes fallback when key is absent
 * - Watcher picks up a new version from Redis on subsequent polls
 * - Watcher retains the previous config (rollback) when Redis holds invalid JSON
 * - Watcher retains the previous config when schema validation fails
 * - Watcher skips a re-parse when version_id has not changed
 * - stopConfigWatcher cancels the polling interval
 * - Prometheus counters are incremented correctly on reload and validation failure
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock Prometheus BEFORE importing any config module
// ---------------------------------------------------------------------------
vi.mock('../../../src/api/metrics/prometheus.js', () => ({
  incrementConfigReloadTotal: vi.fn(),
  incrementConfigValidationFailures: vi.fn(),
  configReloadTotal: { inc: vi.fn() },
  configValidationFailuresTotal: { inc: vi.fn() },
}));

import {
  initializeConfigWatcher,
  stopConfigWatcher,
  getConfig,
  getConfigStatus,
  setConfig,
} from '../../../src/config/index.js';
import * as prometheus from '../../../src/api/metrics/prometheus.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid MetricRangesConfig as a plain object (for JSON serialisation). */
function makeConfig(versionId: string, extraTiers: Record<string, { min: number; max: number | null }> = {}): object {
  return {
    version_id: versionId,
    tiers: {
      TIER_1: { min: 0, max: 1000 },
      TIER_2: { min: 1001, max: 10000 },
      TIER_3: { min: 10001, max: null }, // null serialises as Infinity
      ...extraTiers,
    },
  };
}

/** Build a minimal mock Redis client. */
function buildMockRedis(options: {
  existsResult?: number;
  getResult?: string | null;
  setFn?: (key: string, value: string) => Promise<'OK'>;
  renameFn?: (from: string, to: string) => Promise<'OK'>;
}) {
  return {
    exists: vi.fn().mockResolvedValue(options.existsResult ?? 0),
    get: vi.fn().mockResolvedValue(options.getResult ?? null),
    set: options.setFn ? vi.fn(options.setFn) : vi.fn().mockResolvedValue('OK'),
    rename: options.renameFn ? vi.fn(options.renameFn) : vi.fn().mockResolvedValue('OK'),
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  stopConfigWatcher(); // ensure clean state between tests
});

afterEach(() => {
  stopConfigWatcher();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Bootstrap behaviour
// ---------------------------------------------------------------------------

describe('initializeConfigWatcher – bootstrap', () => {
  it('writes fallback config to Redis when config:active key does not exist', async () => {
    const redis = buildMockRedis({ existsResult: 0 });

    await initializeConfigWatcher(redis as never, 50);

    expect(redis.set).toHaveBeenCalledWith(
      'config:active',
      expect.stringContaining('"TIER_1"'),
    );
  });

  it('loads config from Redis when config:active already exists', async () => {
    const stored = JSON.stringify(makeConfig('bootstrap-v1'));
    const redis = buildMockRedis({ existsResult: 1, getResult: stored });

    await initializeConfigWatcher(redis as never, 50);

    expect(getConfig().version_id).toBe('bootstrap-v1');
  });

  it('keeps in-memory fallback when config:active holds invalid JSON', async () => {
    const redis = buildMockRedis({ existsResult: 1, getResult: 'not-valid-json' });

    const before = getConfigStatus().reloadCount;
    await initializeConfigWatcher(redis as never, 50);
    // reloadCount must NOT have incremented because validation failed
    expect(getConfigStatus().reloadCount).toBe(before);
  });

  it('keeps in-memory fallback when config:active fails schema validation', async () => {
    const invalid = JSON.stringify({ version_id: '', tiers: {} });
    const redis = buildMockRedis({ existsResult: 1, getResult: invalid });

    const before = getConfigStatus().reloadCount;
    await initializeConfigWatcher(redis as never, 50);
    expect(getConfigStatus().reloadCount).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Polling / hot-reload behaviour
// ---------------------------------------------------------------------------

describe('initializeConfigWatcher – hot-reload polling', () => {
  it('reloads config when Redis returns a new version_id', async () => {
    // Start with version v1 already in Redis
    const v1 = JSON.stringify(makeConfig('poll-v1'));
    const v2 = JSON.stringify(makeConfig('poll-v2'));

    const redis = buildMockRedis({ existsResult: 1, getResult: v1 });
    await initializeConfigWatcher(redis as never, 50);
    expect(getConfig().version_id).toBe('poll-v1');

    // Switch Redis to return v2
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(v2);

    // Advance the fake clock past one polling interval
    await vi.advanceTimersByTimeAsync(100);

    expect(getConfig().version_id).toBe('poll-v2');
  });

  it('does NOT re-parse when version_id is unchanged between polls', async () => {
    const v1 = JSON.stringify(makeConfig('stable-v1'));
    const redis = buildMockRedis({ existsResult: 1, getResult: v1 });

    await initializeConfigWatcher(redis as never, 50);
    const countBefore = getConfigStatus().reloadCount;

    // Multiple poll cycles with the same version
    await vi.advanceTimersByTimeAsync(200);

    expect(getConfigStatus().reloadCount).toBe(countBefore);
  });

  it('retains previous config (rollback) when Redis returns invalid JSON', async () => {
    const v1 = JSON.stringify(makeConfig('rollback-v1'));
    const redis = buildMockRedis({ existsResult: 1, getResult: v1 });

    await initializeConfigWatcher(redis as never, 50);
    expect(getConfig().version_id).toBe('rollback-v1');

    // Simulate a corrupt write to Redis
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue('{{corrupt}}');
    await vi.advanceTimersByTimeAsync(100);

    // Previous config retained
    expect(getConfig().version_id).toBe('rollback-v1');
  });

  it('retains previous config (rollback) when new config fails schema validation', async () => {
    const v1 = JSON.stringify(makeConfig('schema-rollback-v1'));
    const redis = buildMockRedis({ existsResult: 1, getResult: v1 });

    await initializeConfigWatcher(redis as never, 50);
    expect(getConfig().version_id).toBe('schema-rollback-v1');

    // Push an invalid config (empty tiers, min > max)
    const invalid = JSON.stringify({
      version_id: 'bad-v1',
      tiers: { T: { min: 999, max: 1 } },
    });
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(invalid);
    await vi.advanceTimersByTimeAsync(100);

    // Rollback: original version must be retained
    expect(getConfig().version_id).toBe('schema-rollback-v1');
  });

  it('re-hydrates null tiers.max as Infinity during hot-reload', async () => {
    const cfgWithNull = JSON.stringify(makeConfig('inf-v1')); // TIER_3.max = null
    const redis = buildMockRedis({ existsResult: 1, getResult: cfgWithNull });

    await initializeConfigWatcher(redis as never, 50);

    const active = getConfig('inf-v1');
    expect(active.tiers['TIER_3']?.max).toBe(Infinity);
  });
});

// ---------------------------------------------------------------------------
// stopConfigWatcher
// ---------------------------------------------------------------------------

describe('stopConfigWatcher', () => {
  it('stops polling after being called', async () => {
    const v1 = JSON.stringify(makeConfig('stop-v1'));
    const v2 = JSON.stringify(makeConfig('stop-v2'));

    const redis = buildMockRedis({ existsResult: 1, getResult: v1 });
    await initializeConfigWatcher(redis as never, 50);
    expect(getConfig().version_id).toBe('stop-v1');

    stopConfigWatcher();

    // Even if Redis now returns a new version, no poll should happen
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(v2);
    await vi.advanceTimersByTimeAsync(300);

    // Version must NOT have changed
    expect(getConfig().version_id).toBe('stop-v1');
  });

  it('is idempotent – calling twice does not throw', () => {
    expect(() => {
      stopConfigWatcher();
      stopConfigWatcher();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Prometheus counter integration
// ---------------------------------------------------------------------------

describe('Prometheus counters', () => {
  it('increments configReloadTotal on a successful hot-reload', async () => {
    const v1 = JSON.stringify(makeConfig('prom-v1'));
    const v2 = JSON.stringify(makeConfig('prom-v2'));

    const redis = buildMockRedis({ existsResult: 1, getResult: v1 });
    await initializeConfigWatcher(redis as never, 50);

    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(v2);
    await vi.advanceTimersByTimeAsync(100);

    // incrementConfigReloadTotal is called from setConfig on every successful reload
    expect(prometheus.incrementConfigReloadTotal).toHaveBeenCalled();
  });

  it('increments configValidationFailuresTotal when a candidate config is invalid', async () => {
    const v1 = JSON.stringify(makeConfig('prom-fail-v1'));
    const invalid = JSON.stringify({ version_id: 'bad', tiers: { T: { min: 100, max: 1 } } });

    const redis = buildMockRedis({ existsResult: 1, getResult: v1 });
    await initializeConfigWatcher(redis as never, 50);

    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(invalid);
    await vi.advanceTimersByTimeAsync(100);

    expect(prometheus.incrementConfigValidationFailures).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getConfigStatus – lastValidationError set on failure
// ---------------------------------------------------------------------------

describe('getConfigStatus – validation error tracking', () => {
  it('records lastValidationError when a hot-reload candidate is rejected', async () => {
    const v1 = JSON.stringify(makeConfig('err-v1'));
    const invalid = JSON.stringify({ version_id: 'bad-err', tiers: {} });

    const redis = buildMockRedis({ existsResult: 1, getResult: v1 });
    await initializeConfigWatcher(redis as never, 50);

    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(invalid);
    await vi.advanceTimersByTimeAsync(100);

    const status = getConfigStatus();
    // lastValidationError should be non-null and describe the problem
    expect(status.lastValidationError).not.toBeNull();
    expect(Array.isArray(status.lastValidationError)).toBe(true);
    expect((status.lastValidationError as string[]).length).toBeGreaterThan(0);
  });

  it('clears lastValidationError after a subsequent successful reload', async () => {
    const v1 = JSON.stringify(makeConfig('clear-v1'));
    const invalid = JSON.stringify({ version_id: 'bad-clear', tiers: {} });
    const v2 = JSON.stringify(makeConfig('clear-v2'));

    const redis = buildMockRedis({ existsResult: 1, getResult: v1 });
    await initializeConfigWatcher(redis as never, 50);

    // First: push an invalid config to set the error
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(invalid);
    await vi.advanceTimersByTimeAsync(100);
    expect(getConfigStatus().lastValidationError).not.toBeNull();

    // Then: push a valid config to clear the error
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(v2);
    await vi.advanceTimersByTimeAsync(100);
    expect(getConfigStatus().lastValidationError).toBeNull();
  });
});
