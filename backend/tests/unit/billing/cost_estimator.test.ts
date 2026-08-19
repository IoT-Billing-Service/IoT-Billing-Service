import { describe, it, expect } from 'vitest';
import {
  estimateCost,
  projectCycleUsage,
  verifyEstimateIntegrity,
  type PrepaidPlan,
  type UsageSnapshot,
} from '../../../src/billing/cost_estimator.js';

describe('projectCycleUsage', () => {
  it('extrapolates linearly from partial-cycle usage', () => {
    const usage: UsageSnapshot = {
      unitsConsumed: 500n,
      elapsedMs: 1000,
      cycleDurationMs: 4000,
    };
    expect(projectCycleUsage(usage)).toBe(2000n);
  });

  it('returns unitsConsumed unchanged once the cycle has ended', () => {
    const usage: UsageSnapshot = {
      unitsConsumed: 900n,
      elapsedMs: 5000,
      cycleDurationMs: 4000,
    };
    expect(projectCycleUsage(usage)).toBe(900n);
  });

  it('returns unitsConsumed unchanged when no time has elapsed', () => {
    const usage: UsageSnapshot = {
      unitsConsumed: 0n,
      elapsedMs: 0,
      cycleDurationMs: 4000,
    };
    expect(projectCycleUsage(usage)).toBe(0n);
  });
});

describe('estimateCost', () => {
  const plan: PrepaidPlan = {
    id: 'starter-1m',
    includedUnits: 1000n,
    overageRateMicros: 10n,
    prepaidBalanceMicros: 5000n,
    currency: 'USD',
  };

  it('reports no overage when projected usage stays within the included allowance', () => {
    const usage: UsageSnapshot = { unitsConsumed: 250n, elapsedMs: 1000, cycleDurationMs: 4000 };
    const estimate = estimateCost(plan, usage);

    expect(estimate.projectedTotalUnits).toBe(1000n);
    expect(estimate.overageUnits).toBe(0n);
    expect(estimate.overageChargeMicros).toBe(0n);
    expect(estimate.willExceedPrepaidBalance).toBe(false);
  });

  it('computes overage charge once projected usage exceeds the included allowance', () => {
    const usage: UsageSnapshot = { unitsConsumed: 500n, elapsedMs: 1000, cycleDurationMs: 4000 };
    const estimate = estimateCost(plan, usage);

    expect(estimate.projectedTotalUnits).toBe(2000n);
    expect(estimate.includedUnitsUsed).toBe(1000n);
    expect(estimate.overageUnits).toBe(1000n);
    expect(estimate.overageChargeMicros).toBe(10000n);
  });

  it('flags when the projected overage charge exceeds the prepaid balance', () => {
    const usage: UsageSnapshot = { unitsConsumed: 500n, elapsedMs: 1000, cycleDurationMs: 4000 };
    const estimate = estimateCost(plan, usage);

    expect(estimate.willExceedPrepaidBalance).toBe(true);
  });

  it('applies the regional multiplier when a country code is provided', () => {
    const usage: UsageSnapshot = { unitsConsumed: 500n, elapsedMs: 1000, cycleDurationMs: 4000 };
    const estimate = estimateCost(plan, usage, 'US');

    expect(estimate.geo).not.toBeNull();
    expect(estimate.geo?.region).toBe('NA');
    expect(estimate.adjustedOverageChargeMicros).toBeGreaterThan(estimate.overageChargeMicros);
  });

  it('omits geo adjustment when no country code is provided', () => {
    const usage: UsageSnapshot = { unitsConsumed: 500n, elapsedMs: 1000, cycleDurationMs: 4000 };
    const estimate = estimateCost(plan, usage);

    expect(estimate.geo).toBeNull();
    expect(estimate.adjustedOverageChargeMicros).toBe(estimate.overageChargeMicros);
  });

  it('produces a digest that verifies against the estimate', () => {
    const usage: UsageSnapshot = { unitsConsumed: 500n, elapsedMs: 1000, cycleDurationMs: 4000 };
    const estimate = estimateCost(plan, usage, 'DE');

    expect(verifyEstimateIntegrity(estimate)).toBe(true);
  });

  it('fails integrity verification if the estimate is tampered with', () => {
    const usage: UsageSnapshot = { unitsConsumed: 500n, elapsedMs: 1000, cycleDurationMs: 4000 };
    const estimate = estimateCost(plan, usage);
    const tampered = { ...estimate, overageChargeMicros: estimate.overageChargeMicros + 1n };

    expect(verifyEstimateIntegrity(tampered)).toBe(false);
  });
});
