import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/api/metrics/prometheus.js', () => ({
  incrementFeatureFlagEvaluations: vi.fn(),
  setFeatureFlagOverride: vi.fn(),
  observeSheddedRequests: vi.fn(),
  setCapacitySheddingLevel: vi.fn(),
}));

import {
  FeatureFlag,
  FlagPriority,
  DegradationBehavior,
  isFlagEnabledSync,
  isFlagEnabled,
  setFlagOverride,
  clearFlagOverride,
  clearAllOverrides,
  resetFeatureFlagsForTesting,
  getFlagDefinition,
  getAllFlagDefinitions,
  computeDegradationProfile,
  initializeFeatureFlagWatcher,
  stopFeatureFlagWatcher,
} from '../../../src/core/feature_flags/index.js';

const mockRedis = {
  hgetall: vi.fn(),
  hset: vi.fn(),
  hdel: vi.fn(),
  del: vi.fn(),
} as any;

describe('FeatureFlag definitions', () => {
  it('all flags have valid definitions', () => {
    const defs = getAllFlagDefinitions();
    expect(defs.length).toBe(Object.keys(FeatureFlag).length);
    for (const def of defs) {
      expect(def.key).toBeDefined();
      expect(typeof def.defaultEnabled).toBe('boolean');
      expect(Object.values(FlagPriority)).toContain(def.priority);
      expect(Object.values(DegradationBehavior)).toContain(def.degradationBehavior);
    }
  });

  it('CRITICAL flags use FAIL_CLOSED degradation', () => {
    const defs = getAllFlagDefinitions().filter((d) => d.priority === FlagPriority.CRITICAL);
    for (const def of defs) {
      expect(def.degradationBehavior).toBe(DegradationBehavior.FAIL_CLOSED);
    }
  });
});

describe('isFlagEnabledSync', () => {
  beforeEach(async () => {
    await resetFeatureFlagsForTesting();
  });

  it('returns default value when no override set', () => {
    expect(isFlagEnabledSync(FeatureFlag.BATCH_BILLING)).toBe(true);
    expect(isFlagEnabledSync(FeatureFlag.CROSS_REGION_REPLICATION)).toBe(false);
  });

  it('reflects in-memory overrides', async () => {
    await setFlagOverride(mockRedis as any, FeatureFlag.BATCH_BILLING, false);
    expect(isFlagEnabledSync(FeatureFlag.BATCH_BILLING)).toBe(false);
  });
});

describe('isFlagEnabled with Redis', () => {
  beforeEach(async () => {
    await resetFeatureFlagsForTesting();
    vi.clearAllMocks();
  });

  it('uses default when no Redis override exists', async () => {
    mockRedis.hgetall.mockResolvedValue({});
    const result = await isFlagEnabled(FeatureFlag.BATCH_BILLING, mockRedis as any);
    expect(result).toBe(true);
  });

  it('reads override from Redis', async () => {
    mockRedis.hgetall.mockResolvedValue({ batch_billing: 'false' });
    const result = await isFlagEnabled(FeatureFlag.BATCH_BILLING, mockRedis as any);
    expect(result).toBe(false);
  });

  it('caches results for CACHE_TTL_MS', async () => {
    mockRedis.hgetall.mockResolvedValue({});
    await isFlagEnabled(FeatureFlag.BATCH_BILLING, mockRedis as any);
    const callCount = mockRedis.hgetall.mock.calls.length;
    await isFlagEnabled(FeatureFlag.BATCH_BILLING, mockRedis as any);
    expect(mockRedis.hgetall.mock.calls.length).toBe(callCount);
  });
});

describe('setFlagOverride / clearFlagOverride', () => {
  beforeEach(async () => {
    await resetFeatureFlagsForTesting();
    vi.clearAllMocks();
  });

  it('sets override and clears cache', async () => {
    mockRedis.hset.mockResolvedValue(1);
    await setFlagOverride(mockRedis as any, FeatureFlag.BATCH_BILLING, false);
    expect(mockRedis.hset).toHaveBeenCalledWith(
      'feature_flags:overrides',
      'batch_billing',
      'false',
    );
    expect(isFlagEnabledSync(FeatureFlag.BATCH_BILLING)).toBe(false);
  });

  it('clears override and reverts to default', async () => {
    mockRedis.hset.mockResolvedValue(1);
    mockRedis.hdel.mockResolvedValue(1);
    await setFlagOverride(mockRedis as any, FeatureFlag.BATCH_BILLING, false);
    expect(isFlagEnabledSync(FeatureFlag.BATCH_BILLING)).toBe(false);
    await clearFlagOverride(mockRedis as any, FeatureFlag.BATCH_BILLING);
    expect(mockRedis.hdel).toHaveBeenCalledWith('feature_flags:overrides', 'batch_billing');
    expect(isFlagEnabledSync(FeatureFlag.BATCH_BILLING)).toBe(true);
  });

  it('clearAllOverrides removes all overrides', async () => {
    mockRedis.del.mockResolvedValue(1);
    await clearAllOverrides(mockRedis as any);
    expect(mockRedis.del).toHaveBeenCalledWith('feature_flags:overrides');
  });
});

describe('computeDegradationProfile', () => {
  it('returns normal profile at low load', () => {
    const profile = computeDegradationProfile(20, false, 10, 10000);
    expect(profile.shedNonCritical).toBe(false);
    expect(profile.disabledFlags).toHaveLength(0);
    expect(profile.activePriority).toBe(FlagPriority.LOW);
  });

  it('disables LOW flags at medium load', () => {
    const profile = computeDegradationProfile(55, false, 100, 10000);
    expect(profile.shedNonCritical).toBe(false);
    expect(profile.disabledFlags.length).toBeGreaterThan(0);
    expect(profile.activePriority).toBe(FlagPriority.MEDIUM);
  });

  it('disables LOW and MEDIUM flags at high load', () => {
    const profile = computeDegradationProfile(75, false, 100, 10000);
    expect(profile.shedNonCritical).toBe(false);
    expect(profile.activePriority).toBe(FlagPriority.HIGH);
  });

  it('sheds non-critical at critical load', () => {
    const profile = computeDegradationProfile(95, true, 9000, 10000);
    expect(profile.shedNonCritical).toBe(true);
    expect(profile.activePriority).toBe(FlagPriority.CRITICAL);
  });

  it('memory pressure increases stress level', () => {
    const lowCpu = computeDegradationProfile(30, true, 10, 10000);
    const normal = computeDegradationProfile(30, false, 10, 10000);
    expect(lowCpu.shedNonCritical).toBe(normal.shedNonCritical);
    expect(lowCpu.disabledFlags.length).toBeGreaterThanOrEqual(normal.disabledFlags.length);
  });
});

describe('initializeFeatureFlagWatcher', () => {
  afterEach(async () => {
    stopFeatureFlagWatcher();
    await resetFeatureFlagsForTesting();
  });

  it('syncs overrides on init', async () => {
    mockRedis.hgetall.mockResolvedValue({});
    await initializeFeatureFlagWatcher(mockRedis as any);
    expect(mockRedis.hgetall).toHaveBeenCalledWith('feature_flags:overrides');
  });
});
