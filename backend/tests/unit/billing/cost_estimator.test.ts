import { describe, it, expect } from 'vitest';
import {
  calculateProratedCharge,
  calculateProratedChargeAt,
  estimateCost,
  projectCycleUsage,
  resolveBillingCycleWindow,
  verifyEstimateIntegrity,
  type BillingCycleConfig,
  type PrepaidPlan,
  type UsageSnapshot,
} from '../../../src/billing/cost_estimator.js';

describe('billing cycle configuration', () => {
  it.each([
    ['daily', 24 * 60 * 60 * 1000],
    ['weekly', 7 * 24 * 60 * 60 * 1000],
  ] as const)('resolves a %s UTC window', (unit: 'daily' | 'weekly', durationMs: number) => {
    const startsAt = new Date('2026-08-20T12:00:00.000Z');
    const window = resolveBillingCycleWindow(startsAt, { unit });

    expect(window.startsAt).toEqual(startsAt);
    expect(window.endsAt.getTime() - startsAt.getTime()).toBe(durationMs);
  });

  it('resolves calendar months rather than assuming 30 days', () => {
    const window = resolveBillingCycleWindow(new Date('2026-01-31T00:00:00.000Z'), {
      unit: 'monthly',
    });

    expect(window.endsAt.toISOString()).toBe('2026-03-03T00:00:00.000Z');
  });

  it('supports custom cycle duration and config-driven pro-rata billing', () => {
    const config: BillingCycleConfig = { unit: 'custom', customDurationMs: 10_000 };
    const startsAt = new Date('2026-08-20T00:00:00.000Z');

    expect(
      calculateProratedChargeAt(1001n, startsAt, config, new Date('2026-08-20T00:00:05.000Z')),
    ).toBe(500n);
  });

  it('rejects invalid custom cycles and dates', () => {
    expect(() => resolveBillingCycleWindow(new Date('invalid'), { unit: 'daily' })).toThrow(
      'valid date',
    );
    expect(() =>
      resolveBillingCycleWindow(new Date(), { unit: 'custom', customDurationMs: 0 }),
    ).toThrow('positive integer');
  });
});

describe('pro-rata charge', () => {
  it('floors fractional micro-units and caps elapsed time at cycle end', () => {
    expect(calculateProratedCharge(1001n, 1, 3)).toBe(333n);
    expect(calculateProratedCharge(1001n, 4, 3)).toBe(1001n);
  });

  it('rejects non-finite or negative time values', () => {
    expect(() => calculateProratedCharge(1n, Number.NaN, 1)).toThrow(RangeError);
    expect(() => calculateProratedCharge(1n, -1, 1)).toThrow(RangeError);
  });
});

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

  it('rejects negative plan and usage values before calculating a charge', () => {
    expect(() =>
      estimateCost(
        { ...plan, overageRateMicros: -1n },
        {
          unitsConsumed: 0n,
          elapsedMs: 0,
          cycleDurationMs: 1,
        },
      ),
    ).toThrow(RangeError);
    expect(() =>
      estimateCost(plan, {
        unitsConsumed: -1n,
        elapsedMs: 0,
        cycleDurationMs: 1,
      }),
    ).toThrow(RangeError);
  });
});
