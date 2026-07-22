/**
 * Tests for MetricRangesConfig schema validation (issue #74).
 *
 * Covers:
 * - Valid configurations accepted
 * - Invalid configurations rejected with informative errors
 * - Edge-case boundary values (zero min, Infinity max, single tier)
 * - The metricRangesConfigSchema Zod schema directly
 * - The validateMetricRangesConfig helper
 * - setConfig / getConfig in-memory registry
 * - getConfigStatus observability state
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Prometheus to avoid double-registration errors across test files
vi.mock('../../../src/api/metrics/prometheus.js', () => ({
  incrementConfigReloadTotal: vi.fn(),
  incrementConfigValidationFailures: vi.fn(),
  configReloadTotal: { inc: vi.fn() },
  configValidationFailuresTotal: { inc: vi.fn() },
}));

import {
  validateMetricRangesConfig,
  metricRangesConfigSchema,
  getConfig,
  setConfig,
  getConfigStatus,
} from '../../../src/config/index.js';
import type { MetricRangesConfig } from '../../../src/config/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validConfig(overrides: Partial<MetricRangesConfig> = {}): MetricRangesConfig {
  return {
    version_id: 'test-version-1',
    tiers: {
      TIER_1: { min: 0, max: 1000 },
      TIER_2: { min: 1001, max: 10000 },
      TIER_3: { min: 10001, max: Infinity },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validateMetricRangesConfig
// ---------------------------------------------------------------------------

describe('validateMetricRangesConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('valid configurations', () => {
    it('accepts a standard three-tier config', () => {
      const result = validateMetricRangesConfig(validConfig());
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.version_id).toBe('test-version-1');
        expect(result.data.tiers['TIER_1']).toEqual({ min: 0, max: 1000 });
      }
    });

    it('accepts a single-tier config', () => {
      const result = validateMetricRangesConfig({
        version_id: 'v1',
        tiers: { ALL: { min: 0, max: Infinity } },
      });
      expect(result.success).toBe(true);
    });

    it('accepts tiers with Infinity as max', () => {
      const result = validateMetricRangesConfig({
        version_id: 'v-inf',
        tiers: {
          TIER_1: { min: 0, max: 500 },
          TIER_2: { min: 501, max: Infinity },
        },
      });
      expect(result.success).toBe(true);
    });

    it('accepts tiers where min is 0', () => {
      const result = validateMetricRangesConfig({
        version_id: 'v-zero-min',
        tiers: { ONLY: { min: 0, max: 100 } },
      });
      expect(result.success).toBe(true);
    });

    it('returns the validated data unchanged', () => {
      const cfg = validConfig();
      const result = validateMetricRangesConfig(cfg);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toMatchObject(cfg);
      }
    });
  });

  describe('invalid configurations – version_id', () => {
    it('rejects missing version_id', () => {
      const result = validateMetricRangesConfig({
        tiers: { T: { min: 0, max: 100 } },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((e) => e.includes('version_id'))).toBe(true);
      }
    });

    it('rejects empty version_id', () => {
      const result = validateMetricRangesConfig(validConfig({ version_id: '' }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((e) => e.includes('version_id'))).toBe(true);
      }
    });
  });

  describe('invalid configurations – tiers', () => {
    it('rejects empty tiers object', () => {
      const result = validateMetricRangesConfig(validConfig({ tiers: {} }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((e) => e.includes('tiers'))).toBe(true);
      }
    });

    it('rejects missing tiers field', () => {
      const result = validateMetricRangesConfig({ version_id: 'v1' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.length).toBeGreaterThan(0);
      }
    });

    it('rejects tier where min equals max', () => {
      const result = validateMetricRangesConfig({
        version_id: 'v-bad',
        tiers: { BAD: { min: 100, max: 100 } },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((e) => e.includes('BAD') || e.includes('min'))).toBe(true);
      }
    });

    it('rejects tier where min > max', () => {
      const result = validateMetricRangesConfig({
        version_id: 'v-reversed',
        tiers: { REV: { min: 1000, max: 100 } },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((e) => e.includes('REV') || e.includes('min'))).toBe(true);
      }
    });

    it('rejects tier with negative min', () => {
      const result = validateMetricRangesConfig({
        version_id: 'v-neg',
        tiers: { NEG: { min: -1, max: 100 } },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.length).toBeGreaterThan(0);
      }
    });

    it('rejects tier with max of zero', () => {
      const result = validateMetricRangesConfig({
        version_id: 'v-zero-max',
        tiers: { Z: { min: 0, max: 0 } },
      });
      expect(result.success).toBe(false);
    });

    it('rejects tier with max of -Infinity', () => {
      const result = validateMetricRangesConfig({
        version_id: 'v-neginf',
        tiers: { INF: { min: 0, max: -Infinity } },
      });
      expect(result.success).toBe(false);
    });

    it('rejects non-numeric tier values', () => {
      const result = validateMetricRangesConfig({
        version_id: 'v-nan',
        tiers: { T: { min: 'low', max: 'high' } },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('invalid configurations – top-level shape', () => {
    it('rejects null', () => {
      expect(validateMetricRangesConfig(null).success).toBe(false);
    });

    it('rejects a plain string', () => {
      expect(validateMetricRangesConfig('not-a-config').success).toBe(false);
    });

    it('rejects an empty object', () => {
      expect(validateMetricRangesConfig({}).success).toBe(false);
    });
  });

  describe('error messages', () => {
    it('returns at least one error string per failure', () => {
      const result = validateMetricRangesConfig({ version_id: '', tiers: {} });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors.every((e) => typeof e === 'string')).toBe(true);
      }
    });

    it('includes a colon-separated path in each error message', () => {
      const result = validateMetricRangesConfig({ version_id: '', tiers: {} });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.every((e) => e.includes(':'))).toBe(true);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// metricRangesConfigSchema (Zod schema)
// ---------------------------------------------------------------------------

describe('metricRangesConfigSchema', () => {
  it('parses a valid config successfully', () => {
    const parsed = metricRangesConfigSchema.safeParse(validConfig());
    expect(parsed.success).toBe(true);
  });

  it('returns ZodError for a config with empty version_id', () => {
    const parsed = metricRangesConfigSchema.safeParse(validConfig({ version_id: '' }));
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.length).toBeGreaterThan(0);
    }
  });

  it('returns ZodError with a path including "tiers" for a min >= max violation', () => {
    const parsed = metricRangesConfigSchema.safeParse({
      version_id: 'v1',
      tiers: { BROKEN: { min: 500, max: 100 } },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((i) => i.path.join('.'));
      expect(paths.some((p) => p.includes('tiers'))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// setConfig / getConfig (in-memory registry, no Redis)
// ---------------------------------------------------------------------------

describe('setConfig / getConfig', () => {
  it('getConfig returns the config set by setConfig', () => {
    const cfg = validConfig({ version_id: 'set-get-v1' });
    setConfig(cfg);
    const retrieved = getConfig('set-get-v1');
    expect(retrieved.version_id).toBe('set-get-v1');
    expect(retrieved.tiers).toMatchObject(cfg.tiers);
  });

  it('getConfig without arguments returns the current active config', () => {
    const cfg = validConfig({ version_id: 'active-v2' });
    setConfig(cfg);
    expect(getConfig().version_id).toBe('active-v2');
  });

  it('getConfig returns a defined value for an unknown version_id (falls back to current)', () => {
    const retrieved = getConfig('definitely-does-not-exist');
    expect(retrieved).toBeDefined();
    expect(retrieved.version_id).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// getConfigStatus observability
// ---------------------------------------------------------------------------

describe('getConfigStatus', () => {
  it('currentVersionId updates after setConfig', () => {
    setConfig(validConfig({ version_id: 'status-v1' }));
    expect(getConfigStatus().currentVersionId).toBe('status-v1');
  });

  it('reloadCount increments with each setConfig call', () => {
    const before = getConfigStatus().reloadCount;
    setConfig(validConfig({ version_id: `reload-${String(before)}` }));
    expect(getConfigStatus().reloadCount).toBe(before + 1);
  });

  it('lastReloadAt is a valid ISO timestamp after setConfig', () => {
    setConfig(validConfig({ version_id: 'ts-v1' }));
    const { lastReloadAt } = getConfigStatus();
    expect(lastReloadAt).not.toBeNull();
    expect(new Date(lastReloadAt!).getTime()).toBeGreaterThan(0);
  });

  it('lastValidationError is null after a successful setConfig', () => {
    setConfig(validConfig({ version_id: 'clean-v1' }));
    expect(getConfigStatus().lastValidationError).toBeNull();
  });
});
