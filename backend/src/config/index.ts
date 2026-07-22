import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyRequest } from 'fastify';

export { loadEnv, getEnv } from './env.js';
export type { Env } from './env.js';

export interface TenantContextStore {
  tenantId: string;
  request?: FastifyRequest;
}

export const asyncLocalStorage = new AsyncLocalStorage<TenantContextStore>();

let currentRequest: FastifyRequest | undefined;

export function setCurrentTenantRequest(request: FastifyRequest | undefined): void {
  currentRequest = request;
}

export function clearCurrentTenantRequest(request?: FastifyRequest): void {
  if (request === undefined || currentRequest === request) {
    currentRequest = undefined;
  }
}

function tenantIdFromRequest(request: FastifyRequest | undefined): string | undefined {
  const requestTenantId = request?.tenantId;
  if (requestTenantId !== undefined) {
    return requestTenantId;
  }

  const rawHeader = request?.headers['x-tenant-id'];
  if (typeof rawHeader === 'string' && rawHeader.trim().length > 0) {
    return rawHeader.trim();
  }

  return undefined;
}

export function tenantContext(): string | undefined {
  return asyncLocalStorage.getStore()?.tenantId ?? tenantIdFromRequest(currentRequest);
}

export function assertTenantContextAvailable(): void {
  if (process.env['NODE_ENV'] === 'development') {
    assert.notEqual(tenantContext(), undefined, 'ALS context lost');
  }
}

export function runWithTenantContext<T>(
  tenantId: string,
  fn: () => T,
  request?: FastifyRequest,
): T {
  return asyncLocalStorage.run({ tenantId, request }, fn);
}

export function enterTenantContext(tenantId: string, request?: FastifyRequest): void {
  asyncLocalStorage.enterWith({ tenantId, request });
}

// --- Versioned configuration registry, two-phase commit, and Redis watcher ---
import crypto from 'node:crypto';
import { z } from 'zod';
import type { Redis } from 'ioredis';
import {
  incrementConfigReloadTotal,
  incrementConfigValidationFailures,
  recordRuntimeConfigAuditEvent,
  setRuntimeConfigIntegrityState,
} from '../api/metrics/prometheus.js';
import {
  RuntimeConfigurationAuditor,
  RuntimeConfigurationIntegrityError,
  type SignedRuntimeConfiguration,
} from './runtime_audit.js';

let lastTimestamp = 0;
let sequence = 0;

export function generateMonotonicUUID(): string {
  const now = Date.now();
  if (now === lastTimestamp) {
    sequence++;
  } else {
    lastTimestamp = now;
    sequence = 0;
  }

  const timeHex = now.toString(16).padStart(12, '0');
  const seqHex = (sequence & 0xfff).toString(16).padStart(3, '0');
  const randHex = crypto.randomBytes(8).toString('hex');

  const part1 = timeHex.slice(0, 8);
  const part2 = timeHex.slice(8, 12);
  const part3 = '7' + seqHex;
  const part4 = '8' + randHex.slice(0, 3);
  const part5 = randHex.slice(3, 15);
  return `${part1}-${part2}-${part3}-${part4}-${part5}`;
}

export interface BillingTier {
  min: number;
  max: number;
}

export interface MetricRangesConfig {
  version_id: string;
  tiers: Record<string, BillingTier>;
}

// ---------------------------------------------------------------------------
// Schema validation (issue #74)
// ---------------------------------------------------------------------------

/**
 * Zod schema for a single billing tier.
 * - Both bounds must be finite numbers except `max` which may be Infinity.
 * - `min` must be >= 0 and strictly less than `max`.
 */
const billingTierSchema = z.object({
  min: z.number().nonnegative('Tier min must be >= 0'),
  max: z
    .number()
    .refine((v) => v > 0, { message: 'Tier max must be > 0' })
    .refine((v) => v !== -Infinity, { message: 'Tier max must not be -Infinity' }),
});

/**
 * Zod schema for the full {@link MetricRangesConfig} as stored in Redis.
 *
 * Rules:
 * - `version_id` must be a non-empty string.
 * - `tiers` must have at least one entry.
 * - Each tier value must satisfy {@link billingTierSchema}.
 * - Within each tier `min < max`.
 */
export const metricRangesConfigSchema = z
  .object({
    version_id: z.string().min(1, 'version_id must not be empty'),
    tiers: z.record(billingTierSchema).refine((t) => Object.keys(t).length > 0, {
      message: 'tiers must contain at least one entry',
    }),
  })
  .superRefine((cfg, ctx) => {
    for (const [name, tier] of Object.entries(cfg.tiers)) {
      if (tier.min >= tier.max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tiers', name],
          message: `Tier "${name}": min (${String(tier.min)}) must be < max (${String(tier.max)})`,
        });
      }
    }
  });

/**
 * Validate a raw {@link MetricRangesConfig}-shaped object.
 *
 * Returns `{ success: true, data }` on success or `{ success: false, errors }`
 * with one human-readable string per failing field on failure.
 */
export function validateMetricRangesConfig(
  raw: unknown,
): { success: true; data: MetricRangesConfig } | { success: false; errors: string[] } {
  const result = metricRangesConfigSchema.safeParse(raw);
  if (!result.success) {
    const errors = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    return { success: false, errors };
  }
  return { success: true, data: result.data };
}

// ---------------------------------------------------------------------------
// Config state
// ---------------------------------------------------------------------------

const configRegistry = new Map<string, MetricRangesConfig>();
let currentConfigVersionId = '';

/** Tracks hot-reload observability state (issue #74). */
interface ConfigStatus {
  /** Version currently active. */
  currentVersionId: string;
  /** ISO timestamp of the last successful reload, or null if never reloaded. */
  lastReloadAt: string | null;
  /** Number of successful reloads since startup. */
  reloadCount: number;
  /** Validation error messages from the last failed reload attempt, or null. */
  lastValidationError: string[] | null;
}

const configStatus: ConfigStatus = {
  currentVersionId: '',
  lastReloadAt: null,
  reloadCount: 0,
  lastValidationError: null,
};

/** Return a snapshot of the current config reload/validation status. */
export function getConfigStatus(): Readonly<ConfigStatus> {
  return { ...configStatus };
}

const fallbackVersionId = '00000000-0000-7000-8000-000000000000';
const fallbackConfig: MetricRangesConfig = {
  version_id: fallbackVersionId,
  tiers: {
    TIER_1: { min: 0, max: 1000 },
    TIER_2: { min: 1001, max: 10000 },
    TIER_3: { min: 10001, max: Infinity },
  },
};
configRegistry.set(fallbackVersionId, fallbackConfig);
currentConfigVersionId = fallbackVersionId;
configStatus.currentVersionId = fallbackVersionId;

interface SerializedBillingTier {
  min: number;
  max: number | null;
}

interface SerializedConfig {
  version_id: string;
  tiers: Record<string, SerializedBillingTier>;
}

function serializeForAudit(config: MetricRangesConfig): SerializedConfig {
  return {
    version_id: config.version_id,
    tiers: Object.fromEntries(
      Object.entries(config.tiers).map(
        ([name, tier]: [string, BillingTier]): [string, SerializedBillingTier] => [
          name,
          { min: tier.min, max: Number.isFinite(tier.max) ? tier.max : null },
        ],
      ),
    ),
  };
}

let runtimeConfigurationAuditor: RuntimeConfigurationAuditor<SerializedConfig> | null = null;

/**
 * Configure the integrity gate once during bootstrap. A caller must activate a
 * signed configuration before billing is allowed. Keeping this dependency
 * explicit prevents a development fallback from silently becoming production
 * trust.
 */
export function configureRuntimeConfigurationAudit(
  authorizedKeys: ReadonlyMap<string, string | Buffer | crypto.KeyObject>,
): RuntimeConfigurationAuditor<SerializedConfig> {
  runtimeConfigurationAuditor = new RuntimeConfigurationAuditor({
    readActiveConfiguration: (): SerializedConfig => serializeForAudit(getConfig()),
    authorizedKeys,
    auditSink: (event): void => {
      recordRuntimeConfigAuditEvent(event.event);
      console.info(JSON.stringify({ ...event, component: 'runtime_configuration_audit' }));
    },
  });
  setRuntimeConfigIntegrityState('unverified');
  return runtimeConfigurationAuditor;
}

export function activateSignedRuntimeConfiguration(
  envelope: SignedRuntimeConfiguration<SerializedConfig>,
): void {
  const validation = parseAndValidateSerializedConfig(envelope.payload);
  if (validation === null) {
    throw new RuntimeConfigurationIntegrityError('Configuration rejected: invalid payload');
  }
  if (validation.version_id !== envelope.versionId) {
    throw new RuntimeConfigurationIntegrityError(
      'Configuration rejected: version id does not match payload',
    );
  }
  if (runtimeConfigurationAuditor === null) {
    throw new RuntimeConfigurationIntegrityError('Configuration audit has not been configured');
  }
  // Verify before changing the active object. A rejected update cannot affect
  // billing, even briefly.
  runtimeConfigurationAuditor.activate(envelope);
  setConfig(validation);
}

/** Synchronous fail-closed gate used by billing operations. */
export function assertBillingConfigurationTrusted(): void {
  if (runtimeConfigurationAuditor === null) {
    throw new RuntimeConfigurationIntegrityError(
      'Billing blocked: configuration audit is not configured',
    );
  }
  try {
    runtimeConfigurationAuditor.assertTrusted();
    setRuntimeConfigIntegrityState('healthy');
  } catch (error) {
    setRuntimeConfigIntegrityState(runtimeConfigurationAuditor.getStatus().status);
    throw error;
  }
}

export function getRuntimeConfigurationAuditStatus(): ReturnType<
  RuntimeConfigurationAuditor<SerializedConfig>['getStatus']
> {
  const status = runtimeConfigurationAuditor?.getStatus() ?? {
    status: 'unverified' as const,
    versionId: null,
  };
  setRuntimeConfigIntegrityState(status.status);
  return status;
}

export function getConfig(versionId?: string): MetricRangesConfig {
  if (versionId !== undefined) {
    const cached = configRegistry.get(versionId);
    if (cached !== undefined) {
      return cached;
    }
  }
  const current = configRegistry.get(currentConfigVersionId);
  return current ?? fallbackConfig;
}

export function setConfig(config: MetricRangesConfig): void {
  configRegistry.set(config.version_id, config);
  currentConfigVersionId = config.version_id;
  configStatus.currentVersionId = config.version_id;
  configStatus.lastReloadAt = new Date().toISOString();
  configStatus.reloadCount += 1;
  configStatus.lastValidationError = null;
  incrementConfigReloadTotal();
}

export async function commitConfig(
  redis: Redis,
  tiers: Record<string, BillingTier>,
  commitDelayMs = 1000,
): Promise<string> {
  const version_id = generateMonotonicUUID();
  const configJson = JSON.stringify({ version_id, tiers });

  // Phase 1: SET config:staging
  await redis.set('config:staging', configJson);

  // Wait COMMIT_DELAY_MS
  if (commitDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, commitDelayMs));
  }

  // Phase 2: RENAME config:staging config:active
  await redis.rename('config:staging', 'config:active');

  return version_id;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Deserialise the raw Redis JSON into a {@link MetricRangesConfig}, substituting
 * `null` for `Infinity` in the serialised form.  Returns `null` if parsing or
 * schema validation fails — the caller retains the previous config (rollback).
 */
function parseAndValidateRedisConfig(raw: string): MetricRangesConfig | null {
  let parsed: SerializedConfig;
  try {
    parsed = JSON.parse(raw) as SerializedConfig;
  } catch {
    configStatus.lastValidationError = ['Failed to parse config JSON'];
    return null;
  }

  // Re-hydrate Infinity (stored as null in JSON)
  const hydrated: MetricRangesConfig = {
    version_id: parsed.version_id,
    tiers: {},
  };
  for (const [key, tier] of Object.entries(parsed.tiers)) {
    hydrated.tiers[key] = {
      min: tier.min,
      max: tier.max ?? Infinity,
    };
  }

  const validation = validateMetricRangesConfig(hydrated);
  if (!validation.success) {
    configStatus.lastValidationError = validation.errors;
    incrementConfigValidationFailures();
    console.error('Config validation failed (retaining previous config):', validation.errors);
    return null;
  }

  configStatus.lastValidationError = null;
  return validation.data;
}

function parseAndValidateSerializedConfig(raw: SerializedConfig): MetricRangesConfig | null {
  const hydrated: MetricRangesConfig = { version_id: raw.version_id, tiers: {} };
  for (const [key, tier] of Object.entries(raw.tiers)) {
    hydrated.tiers[key] = { min: tier.min, max: tier.max ?? Infinity };
  }
  const validation = validateMetricRangesConfig(hydrated);
  return validation.success ? validation.data : null;
}

let activeWatcherInterval: ReturnType<typeof setInterval> | null = null;

export async function initializeConfigWatcher(redis: Redis, intervalMs = 50): Promise<void> {
  // Check if active key exists
  const activeExists = await redis.exists('config:active');
  if (activeExists === 0) {
    // Write the fallback/default config to Redis
    const defaultTiers = {
      TIER_1: { min: 0, max: 1000 },
      TIER_2: { min: 1001, max: 10000 },
      TIER_3: { min: 10001, max: Infinity },
    };
    const version_id = generateMonotonicUUID();
    const config: MetricRangesConfig = { version_id, tiers: defaultTiers };
    await redis.set('config:active', JSON.stringify(config));
    setConfig(config);
  } else {
    const activeVal = await redis.get('config:active');
    if (activeVal !== null) {
      applyRedisConfiguration(activeVal);
      // If validation fails at startup we keep the in-memory fallback but do
      // NOT throw — the watcher will retry on the next poll cycle.
    }
  }

  // Clear any existing watcher first
  if (activeWatcherInterval !== null) {
    clearInterval(activeWatcherInterval);
  }

  // Start polling Redis every intervalMs
  activeWatcherInterval = setInterval((): void => {
    void (async (): Promise<void> => {
      try {
        const activeVal = await redis.get('config:active');
        if (activeVal !== null) {
          // Quick version-id check before full parse to avoid redundant work
          let candidateVersionId: string | undefined;
          try {
            const quick = JSON.parse(activeVal) as {
              version_id?: unknown;
              payload?: { version_id?: unknown };
            };
            candidateVersionId =
              typeof quick.version_id === 'string'
                ? quick.version_id
                : typeof quick.payload?.version_id === 'string'
                  ? quick.payload.version_id
                  : undefined;
          } catch {
            // Will be caught by parseAndValidateRedisConfig below
          }

          if (candidateVersionId === currentConfigVersionId) {
            // No change — skip parse and validation
            return;
          }

          applyRedisConfiguration(activeVal);
          // If config is null, validation failed; previous config retained (rollback).
        }
      } catch (err) {
        console.error('Error polling Redis config:', err);
      }
    })();
  }, intervalMs);

  activeWatcherInterval.unref();
}

/**
 * Accept either the legacy unsigned representation (development migration
 * only) or the signed envelope required by the configured audit gate. An
 * invalid signature is never applied to the in-memory billing configuration.
 */
function applyRedisConfiguration(raw: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parseAndValidateRedisConfig(raw);
    return;
  }

  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'signature' in parsed &&
    'payload' in parsed &&
    'keyId' in parsed
  ) {
    activateSignedRuntimeConfiguration(parsed as SignedRuntimeConfiguration<SerializedConfig>);
    return;
  }

  const config = parseAndValidateRedisConfig(raw);
  if (config !== null) setConfig(config);
}

export function stopConfigWatcher(): void {
  if (activeWatcherInterval !== null) {
    clearInterval(activeWatcherInterval);
    activeWatcherInterval = null;
  }
}
