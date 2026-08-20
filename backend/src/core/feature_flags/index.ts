import { z } from 'zod';
import type { Redis } from 'ioredis';
import {
  incrementFeatureFlagEvaluations,
  setFeatureFlagOverride,
} from '../../api/metrics/prometheus.js';

export enum FeatureFlag {
  BATCH_BILLING = 'batch_billing',
  REAL_TIME_ANALYTICS = 'real_time_analytics',
  TELEMETRY_COMPRESSION = 'telemetry_compression',
  CIRCUIT_BREAKER_AUTO_RECOVERY = 'circuit_breaker_auto_recovery',
  CROSS_REGION_REPLICATION = 'cross_region_replication',
  ADVANCED_RATE_LIMITING = 'advanced_rate_limiting',
  WEBHOOK_RETRY_QUEUE = 'webhook_retry_queue',
  CHAOS_ENGINEERING = 'chaos_engineering',
  BLOCKCHAIN_SYNC = 'blockchain_sync',
  METERED_USAGE = 'metered_usage',
}

export enum FlagPriority {
  CRITICAL = 'critical',
  HIGH = 'high',
  MEDIUM = 'medium',
  LOW = 'low',
}

export interface FlagDefinition {
  key: FeatureFlag;
  defaultEnabled: boolean;
  priority: FlagPriority;
  description: string;
  degradationBehavior: DegradationBehavior;
}

export enum DegradationBehavior {
  FAIL_OPEN = 'fail_open',
  FAIL_CLOSED = 'fail_closed',
  FALLBACK_CACHED = 'fallback_cached',
  THROTTLE = 'throttle',
}

const DEFAULT_PRIORITY_ORDER: FlagPriority[] = [
  FlagPriority.CRITICAL,
  FlagPriority.HIGH,
  FlagPriority.MEDIUM,
  FlagPriority.LOW,
];

const FLAG_DEFINITIONS: Record<FeatureFlag, FlagDefinition> = {
  [FeatureFlag.BATCH_BILLING]: {
    key: FeatureFlag.BATCH_BILLING,
    defaultEnabled: true,
    priority: FlagPriority.HIGH,
    description: 'Enables batch billing processing for cost efficiency',
    degradationBehavior: DegradationBehavior.FAIL_CLOSED,
  },
  [FeatureFlag.REAL_TIME_ANALYTICS]: {
    key: FeatureFlag.REAL_TIME_ANALYTICS,
    defaultEnabled: true,
    priority: FlagPriority.MEDIUM,
    description: 'Enables real-time analytics data pipeline',
    degradationBehavior: DegradationBehavior.FALLBACK_CACHED,
  },
  [FeatureFlag.TELEMETRY_COMPRESSION]: {
    key: FeatureFlag.TELEMETRY_COMPRESSION,
    defaultEnabled: true,
    priority: FlagPriority.MEDIUM,
    description: 'Compresses telemetry data in transit',
    degradationBehavior: DegradationBehavior.FAIL_OPEN,
  },
  [FeatureFlag.CIRCUIT_BREAKER_AUTO_RECOVERY]: {
    key: FeatureFlag.CIRCUIT_BREAKER_AUTO_RECOVERY,
    defaultEnabled: true,
    priority: FlagPriority.CRITICAL,
    description: 'Enables automatic circuit breaker recovery',
    degradationBehavior: DegradationBehavior.FAIL_CLOSED,
  },
  [FeatureFlag.CROSS_REGION_REPLICATION]: {
    key: FeatureFlag.CROSS_REGION_REPLICATION,
    defaultEnabled: false,
    priority: FlagPriority.LOW,
    description: 'Enables cross-region data replication',
    degradationBehavior: DegradationBehavior.FAIL_OPEN,
  },
  [FeatureFlag.ADVANCED_RATE_LIMITING]: {
    key: FeatureFlag.ADVANCED_RATE_LIMITING,
    defaultEnabled: true,
    priority: FlagPriority.HIGH,
    description: 'Enables advanced rate limiting with tenant awareness',
    degradationBehavior: DegradationBehavior.THROTTLE,
  },
  [FeatureFlag.WEBHOOK_RETRY_QUEUE]: {
    key: FeatureFlag.WEBHOOK_RETRY_QUEUE,
    defaultEnabled: true,
    priority: FlagPriority.MEDIUM,
    description: 'Enables webhook retry with exponential backoff',
    degradationBehavior: DegradationBehavior.FALLBACK_CACHED,
  },
  [FeatureFlag.CHAOS_ENGINEERING]: {
    key: FeatureFlag.CHAOS_ENGINEERING,
    defaultEnabled: false,
    priority: FlagPriority.LOW,
    description: 'Enables chaos engineering fault injection',
    degradationBehavior: DegradationBehavior.FAIL_CLOSED,
  },
  [FeatureFlag.BLOCKCHAIN_SYNC]: {
    key: FeatureFlag.BLOCKCHAIN_SYNC,
    defaultEnabled: true,
    priority: FlagPriority.CRITICAL,
    description: 'Enables blockchain ledger synchronization',
    degradationBehavior: DegradationBehavior.FAIL_CLOSED,
  },
  [FeatureFlag.METERED_USAGE]: {
    key: FeatureFlag.METERED_USAGE,
    defaultEnabled: true,
    priority: FlagPriority.HIGH,
    description: 'Enables metered usage tracking and billing',
    degradationBehavior: DegradationBehavior.FAIL_CLOSED,
  },
};

interface CachedFlagState {
  enabled: boolean;
  timestamp: number;
}

const REDIS_KEY_PREFIX = 'feature_flags:';
const REDIS_OVERRIDE_KEY = `${REDIS_KEY_PREFIX}overrides`;
const CACHE_TTL_MS = 5000;
const WATCH_INTERVAL_MS = 10000;

const flagOverrides = new Map<FeatureFlag, boolean | null>();
const flagCache = new Map<FeatureFlag, CachedFlagState>();
let lastOverrideSync = 0;
let activeWatcherIntervalId: ReturnType<typeof setInterval> | null = null;

export function getFlagDefinition(flag: FeatureFlag): FlagDefinition {
  return FLAG_DEFINITIONS[flag];
}

export function getAllFlagDefinitions(): FlagDefinition[] {
  return Object.values(FLAG_DEFINITIONS);
}

function isFlagEnabledLocally(flag: FeatureFlag): boolean {
  const override = flagOverrides.get(flag);
  if (override !== undefined && override !== null) {
    return override;
  }
  return FLAG_DEFINITIONS[flag].defaultEnabled;
}

async function syncOverridesFromRedis(redis: Redis): Promise<void> {
  try {
    const raw = await redis.hgetall(REDIS_OVERRIDE_KEY);
    for (const flag of Object.values(FeatureFlag)) {
      const val = raw[flag];
      if (val === undefined) {
        flagOverrides.set(flag, null);
      } else if (val === 'true' || val === '1') {
        flagOverrides.set(flag, true);
      } else if (val === 'false' || val === '0') {
        flagOverrides.set(flag, false);
      } else {
        flagOverrides.set(flag, null);
      }
    }
    lastOverrideSync = Date.now();
  } catch {
    const cached = flagCache.size > 0;
    if (!cached) {
      for (const flag of Object.values(FeatureFlag)) {
        flagOverrides.set(flag, null);
      }
    }
  }
}

export async function isFlagEnabled(flag: FeatureFlag, redis?: Redis): Promise<boolean> {
  incrementFeatureFlagEvaluations(flag);

  const cached = flagCache.get(flag);
  if (cached !== undefined && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.enabled;
  }

  if (redis !== undefined && Date.now() - lastOverrideSync > CACHE_TTL_MS) {
    await syncOverridesFromRedis(redis);
  }

  const enabled = isFlagEnabledLocally(flag);
  flagCache.set(flag, { enabled, timestamp: Date.now() });
  return enabled;
}

export function isFlagEnabledSync(flag: FeatureFlag): boolean {
  incrementFeatureFlagEvaluations(flag);
  return isFlagEnabledLocally(flag);
}

export async function setFlagOverride(
  redis: Redis,
  flag: FeatureFlag,
  enabled: boolean,
): Promise<void> {
  await redis.hset(REDIS_OVERRIDE_KEY, flag, enabled ? 'true' : 'false');
  flagOverrides.set(flag, enabled);
  flagCache.delete(flag);
  setFeatureFlagOverride(flag, enabled);
}

export async function clearFlagOverride(redis: Redis, flag: FeatureFlag): Promise<void> {
  await redis.hdel(REDIS_OVERRIDE_KEY, flag);
  flagOverrides.set(flag, null);
  flagCache.delete(flag);
}

export async function clearAllOverrides(redis: Redis): Promise<void> {
  await redis.del(REDIS_OVERRIDE_KEY);
  flagOverrides.clear();
  flagCache.clear();
}

export interface DegradationProfile {
  shedNonCritical: boolean;
  disabledFlags: FeatureFlag[];
  activePriority: FlagPriority;
}

export function computeDegradationProfile(
  cpuLoadPercent: number,
  memoryPressure: boolean,
  queueDepth: number,
  maxQueueDepth: number,
): DegradationProfile {
  const loadFactor = cpuLoadPercent / 100;
  const queueFactor = queueDepth / Math.max(maxQueueDepth, 1);
  const stressLevel = Math.max(loadFactor, queueFactor) + (memoryPressure ? 0.2 : 0);

  if (stressLevel >= 0.9) {
    const activePriority = FlagPriority.CRITICAL;
    const disabledFlags = getAllFlagDefinitions()
      .filter(
        (def) =>
          def.priority !== FlagPriority.CRITICAL &&
          def.degradationBehavior !== DegradationBehavior.FAIL_CLOSED,
      )
      .map((def) => def.key);
    return { shedNonCritical: true, disabledFlags, activePriority };
  }

  if (stressLevel >= 0.7) {
    const activePriority = FlagPriority.HIGH;
    const disabledFlags = getAllFlagDefinitions()
      .filter(
        (def) =>
          (def.priority === FlagPriority.LOW || def.priority === FlagPriority.MEDIUM) &&
          def.degradationBehavior !== DegradationBehavior.FAIL_CLOSED,
      )
      .map((def) => def.key);
    return { shedNonCritical: false, disabledFlags, activePriority };
  }

  if (stressLevel >= 0.5) {
    const activePriority = FlagPriority.MEDIUM;
    const disabledFlags = getAllFlagDefinitions()
      .filter(
        (def) =>
          def.priority === FlagPriority.LOW &&
          def.degradationBehavior !== DegradationBehavior.FAIL_CLOSED,
      )
      .map((def) => def.key);
    return { shedNonCritical: false, disabledFlags, activePriority };
  }

  return { shedNonCritical: false, disabledFlags: [], activePriority: FlagPriority.LOW };
}

export async function initializeFeatureFlagWatcher(redis: Redis): Promise<void> {
  await syncOverridesFromRedis(redis);

  if (activeWatcherIntervalId !== null) {
    clearInterval(activeWatcherIntervalId);
  }

  activeWatcherIntervalId = setInterval(() => {
    void (async () => {
      try {
        await syncOverridesFromRedis(redis);
        flagCache.clear();
      } catch (err) {
        console.error('Error polling feature flag overrides:', err);
      }
    })();
  }, WATCH_INTERVAL_MS);

  activeWatcherIntervalId.unref();
}

export function stopFeatureFlagWatcher(): void {
  if (activeWatcherIntervalId !== null) {
    clearInterval(activeWatcherIntervalId);
    activeWatcherIntervalId = null;
  }
}

export async function resetFeatureFlagsForTesting(): Promise<void> {
  flagOverrides.clear();
  flagCache.clear();
  lastOverrideSync = 0;
  if (activeWatcherIntervalId !== null) {
    clearInterval(activeWatcherIntervalId);
    activeWatcherIntervalId = null;
  }
}
