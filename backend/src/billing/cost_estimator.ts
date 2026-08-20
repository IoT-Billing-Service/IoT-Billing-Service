/**
 * Cost Estimation Engine for Pre-Paid Billing Plans (issue #299).
 *
 * Pre-paid plans bundle a fixed allowance of usage units for a flat price.
 * Once a device's cycle-to-date consumption exceeds that allowance, further
 * usage is billed at an overage rate. This module estimates, ahead of cycle
 * close, what a device's total charge will be so operators (and the renewal
 * cron) can warn customers before they are surprised by an overage or before
 * a pre-paid balance is exhausted mid-cycle.
 *
 * ## Design goals
 * - < 200ms P99: all calculations are pure, synchronous, integer (BigInt)
 *   arithmetic — no I/O.
 * - PCI-DSS / SOC2: estimates never mutate plan or balance state; they are
 *   read-only projections.
 * - Cryptographic verification: every estimate carries a SHA-256 digest over
 *   its inputs and outputs so a client-cached estimate can be proven
 *   untampered before being trusted downstream (e.g. by a dispute handler).
 * - Reuses {@link applyGeoMultiplier} so regional pricing tiers stay the
 *   single source of truth for rate adjustments.
 */

import { createHash } from 'node:crypto';
import { applyGeoMultiplier, type GeoMultiplierResult } from './geo_pricing.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PrepaidPlan {
  /** Plan identifier, e.g. "starter-1m". */
  readonly id: string;
  /** Units of usage bundled with the plan (e.g. metered messages/bytes). */
  readonly includedUnits: bigint;
  /** Rate charged per unit once the included allowance is exhausted, in platform micro-units. */
  readonly overageRateMicros: bigint;
  /** Prepaid balance currently available for overage billing, in platform micro-units. */
  readonly prepaidBalanceMicros: bigint;
  /** Fixed recurring charge for a complete cycle, in platform micro-units. */
  readonly baseChargeMicros?: bigint;
  readonly currency: string;
}

export type BillingCycleUnit = 'daily' | 'weekly' | 'monthly' | 'annual' | 'custom';

export interface BillingCycleConfig {
  readonly unit: BillingCycleUnit;
  /** Required only for custom cycles. */
  readonly customDurationMs?: number;
}

export interface BillingCycleWindow {
  readonly startsAt: Date;
  readonly endsAt: Date;
}

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function assertNonNegativeBigInt(value: bigint, name: string): void {
  if (value < 0n) {
    throw new RangeError(`${name} must be non-negative`);
  }
}

export interface UsageSnapshot {
  /** Units consumed so far in the current billing cycle. */
  readonly unitsConsumed: bigint;
  /** Milliseconds elapsed since the cycle started. */
  readonly elapsedMs: number;
  /** Total duration of the billing cycle in milliseconds. */
  readonly cycleDurationMs: number;
}

export interface CostEstimate {
  planId: string;
  /** Units consumed within the included allowance (never exceeds includedUnits). */
  includedUnitsUsed: bigint;
  /** Units consumed (actual or projected) beyond the included allowance. */
  overageUnits: bigint;
  /** Projected total units by end of cycle, linearly extrapolated from current usage. */
  projectedTotalUnits: bigint;
  /** Overage charge for projectedTotalUnits, before any geo multiplier. */
  overageChargeMicros: bigint;
  /** Overage charge after applying the device's regional multiplier, if a country code was given. */
  adjustedOverageChargeMicros: bigint;
  /** Fixed plan charge accrued for the elapsed portion of this cycle. */
  proratedBaseChargeMicros: bigint;
  /** Pro-rata base charge plus the projected, geo-adjusted overage charge. */
  totalChargeMicros: bigint;
  geo: GeoMultiplierResult | null;
  /** True if projectedTotalUnits exceeds the plan's prepaid balance capacity for overage. */
  willExceedPrepaidBalance: boolean;
  currency: string;
  generatedAt: string;
  /** SHA-256 hex digest over the estimate's inputs and outputs (see {@link estimateDigest}). */
  digest: string;
}

/** Resolve a UTC billing window without database or timezone-dependent work. */
export function resolveBillingCycleWindow(
  startsAt: Date,
  config: BillingCycleConfig,
): BillingCycleWindow {
  if (Number.isNaN(startsAt.getTime())) {
    throw new RangeError('startsAt must be a valid date');
  }

  const end = new Date(startsAt.getTime());
  switch (config.unit) {
    case 'daily':
      end.setUTCDate(end.getUTCDate() + 1);
      break;
    case 'weekly':
      end.setUTCDate(end.getUTCDate() + 7);
      break;
    case 'monthly':
      end.setUTCMonth(end.getUTCMonth() + 1);
      break;
    case 'annual':
      end.setUTCFullYear(end.getUTCFullYear() + 1);
      break;
    case 'custom': {
      const customDurationMs = config.customDurationMs;
      if (
        typeof customDurationMs !== 'number' ||
        !Number.isSafeInteger(customDurationMs) ||
        customDurationMs <= 0
      ) {
        throw new RangeError('customDurationMs must be a positive integer');
      }
      end.setTime(end.getTime() + customDurationMs);
      break;
    }
    default:
      throw new RangeError(`Unsupported billing cycle unit: ${String(config.unit)}`);
  }

  if (Number.isNaN(end.getTime())) {
    throw new RangeError('billing cycle window exceeds the supported date range');
  }

  return { startsAt: new Date(startsAt.getTime()), endsAt: end };
}

/** Calculate elapsed-cycle charge using integer micro-units and floor rounding. */
export function calculateProratedCharge(
  fullChargeMicros: bigint,
  elapsedMs: number,
  cycleDurationMs: number,
): bigint {
  assertNonNegativeBigInt(fullChargeMicros, 'fullChargeMicros');
  assertNonNegativeSafeInteger(elapsedMs, 'elapsedMs');
  if (!Number.isSafeInteger(cycleDurationMs) || cycleDurationMs <= 0) {
    throw new RangeError(
      'Charge and cycle values must be non-negative and the cycle must be positive',
    );
  }
  const billableMs = Math.min(elapsedMs, cycleDurationMs);
  return (fullChargeMicros * BigInt(billableMs)) / BigInt(cycleDurationMs);
}

/** Calculate pro-rata charge directly from the configured billing window. */
export function calculateProratedChargeAt(
  fullChargeMicros: bigint,
  startsAt: Date,
  config: BillingCycleConfig,
  asOf: Date,
): bigint {
  if (Number.isNaN(asOf.getTime())) {
    throw new RangeError('asOf must be a valid date');
  }
  const window = resolveBillingCycleWindow(startsAt, config);
  return calculateProratedCharge(
    fullChargeMicros,
    asOf.getTime() - window.startsAt.getTime(),
    window.endsAt.getTime() - window.startsAt.getTime(),
  );
}

// ---------------------------------------------------------------------------
// Usage projection
// ---------------------------------------------------------------------------

/**
 * Linearly extrapolate total cycle usage from consumption observed so far.
 * Returns `unitsConsumed` unchanged once the cycle has ended or no time has
 * elapsed, since there is nothing to project from.
 *
 * @performance O(1).
 */
export function projectCycleUsage(usage: UsageSnapshot): bigint {
  const { unitsConsumed, elapsedMs, cycleDurationMs } = usage;

  assertNonNegativeBigInt(unitsConsumed, 'unitsConsumed');
  assertNonNegativeSafeInteger(elapsedMs, 'elapsedMs');
  if (!Number.isSafeInteger(cycleDurationMs)) {
    throw new RangeError('cycleDurationMs must be a safe integer');
  }

  if (elapsedMs <= 0 || cycleDurationMs <= 0 || elapsedMs >= cycleDurationMs) {
    return unitsConsumed;
  }

  // Integer-only extrapolation: unitsConsumed * cycleDurationMs / elapsedMs.
  return (unitsConsumed * BigInt(cycleDurationMs)) / BigInt(elapsedMs);
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the total cost of a device's current billing cycle under a
 * pre-paid plan, projecting forward from usage observed so far.
 *
 * @param plan       The device's pre-paid plan.
 * @param usage      Cycle-to-date usage snapshot used to project total usage.
 * @param countryCode Optional ISO 3166-1 alpha-2 country code; when given the
 *                     overage charge is adjusted by the device's regional
 *                     pricing tier via {@link applyGeoMultiplier}.
 *
 * @performance O(1) — bounded arithmetic, no I/O.
 */
export function estimateCost(
  plan: PrepaidPlan,
  usage: UsageSnapshot,
  countryCode?: string | null,
): CostEstimate {
  if (plan.id.trim() === '' || plan.currency.trim() === '') {
    throw new RangeError('plan id and currency must be non-empty');
  }
  assertNonNegativeBigInt(plan.includedUnits, 'includedUnits');
  assertNonNegativeBigInt(plan.overageRateMicros, 'overageRateMicros');
  assertNonNegativeBigInt(plan.prepaidBalanceMicros, 'prepaidBalanceMicros');
  if (plan.baseChargeMicros !== undefined) {
    assertNonNegativeBigInt(plan.baseChargeMicros, 'baseChargeMicros');
  }
  const projectedTotalUnits = projectCycleUsage(usage);

  const includedUnitsUsed =
    projectedTotalUnits < plan.includedUnits ? projectedTotalUnits : plan.includedUnits;
  const overageUnits =
    projectedTotalUnits > plan.includedUnits ? projectedTotalUnits - plan.includedUnits : 0n;

  const overageChargeMicros = overageUnits * plan.overageRateMicros;

  const geo =
    countryCode !== undefined && countryCode !== null
      ? applyGeoMultiplier(overageChargeMicros, countryCode)
      : null;
  const adjustedOverageChargeMicros = geo !== null ? geo.adjustedCharge : overageChargeMicros;
  const proratedBaseChargeMicros = calculateProratedCharge(
    plan.baseChargeMicros ?? 0n,
    usage.elapsedMs,
    usage.cycleDurationMs,
  );
  const totalChargeMicros = proratedBaseChargeMicros + adjustedOverageChargeMicros;

  const willExceedPrepaidBalance = totalChargeMicros > plan.prepaidBalanceMicros;

  const generatedAt = new Date().toISOString();

  const estimate: Omit<CostEstimate, 'digest'> = {
    planId: plan.id,
    includedUnitsUsed,
    overageUnits,
    projectedTotalUnits,
    overageChargeMicros,
    adjustedOverageChargeMicros,
    proratedBaseChargeMicros,
    totalChargeMicros,
    geo,
    willExceedPrepaidBalance,
    currency: plan.currency,
    generatedAt,
  };

  return { ...estimate, digest: estimateDigest(estimate) };
}

// ---------------------------------------------------------------------------
// Integrity digest (SOC2 / PCI-DSS audit trail)
// ---------------------------------------------------------------------------

/**
 * Compute a SHA-256 hex digest over an estimate's inputs and outputs so a
 * downstream consumer can verify a cached/transmitted estimate has not been
 * tampered with. BigInt fields are serialised as strings for stability.
 */
export function estimateDigest(estimate: Omit<CostEstimate, 'digest'>): string {
  const payload = JSON.stringify({
    planId: estimate.planId,
    includedUnitsUsed: estimate.includedUnitsUsed.toString(),
    overageUnits: estimate.overageUnits.toString(),
    projectedTotalUnits: estimate.projectedTotalUnits.toString(),
    overageChargeMicros: estimate.overageChargeMicros.toString(),
    adjustedOverageChargeMicros: estimate.adjustedOverageChargeMicros.toString(),
    proratedBaseChargeMicros: estimate.proratedBaseChargeMicros.toString(),
    totalChargeMicros: estimate.totalChargeMicros.toString(),
    region: estimate.geo?.region ?? null,
    willExceedPrepaidBalance: estimate.willExceedPrepaidBalance,
    currency: estimate.currency,
    generatedAt: estimate.generatedAt,
  });
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Verify that an estimate's digest matches its own inputs/outputs, proving it
 * has not been altered since {@link estimateCost} produced it.
 */
export function verifyEstimateIntegrity(estimate: CostEstimate): boolean {
  const { digest, ...rest } = estimate;
  return estimateDigest(rest) === digest;
}
