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
  readonly currency: string;
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
  geo: GeoMultiplierResult | null;
  /** True if projectedTotalUnits exceeds the plan's prepaid balance capacity for overage. */
  willExceedPrepaidBalance: boolean;
  currency: string;
  generatedAt: string;
  /** SHA-256 hex digest over the estimate's inputs and outputs (see {@link estimateDigest}). */
  digest: string;
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
  const projectedTotalUnits = projectCycleUsage(usage);

  const includedUnitsUsed =
    projectedTotalUnits < plan.includedUnits ? projectedTotalUnits : plan.includedUnits;
  const overageUnits =
    projectedTotalUnits > plan.includedUnits ? projectedTotalUnits - plan.includedUnits : 0n;

  const overageChargeMicros = overageUnits * plan.overageRateMicros;

  const geo = countryCode !== undefined && countryCode !== null
    ? applyGeoMultiplier(overageChargeMicros, countryCode)
    : null;
  const adjustedOverageChargeMicros = geo !== null ? geo.adjustedCharge : overageChargeMicros;

  const willExceedPrepaidBalance = adjustedOverageChargeMicros > plan.prepaidBalanceMicros;

  const generatedAt = new Date().toISOString();

  const estimate: Omit<CostEstimate, 'digest'> = {
    planId: plan.id,
    includedUnitsUsed,
    overageUnits,
    projectedTotalUnits,
    overageChargeMicros,
    adjustedOverageChargeMicros,
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
