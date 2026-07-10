/**
 * Physical boundary restrictions for device metrics.
 *
 * Every incoming telemetry value is checked against this matrix before any
 * database write. Values outside the defined ranges are rejected with an
 * explicit `PRIVACY_VIOLATION` error code — the system MUST NOT persist data
 * that violates the advertised privacy / safety guarantees.
 *
 * ## Adding a new metric
 *
 * 1. Add its name to the {@link MetricName} union type.
 * 2. Add an entry in {@link MetricRangeMap} with sensible lower/upper bounds.
 * 3. (Optional) Add a human-readable description for debugging.
 */

// ── Error codes ────────────────────────────────────────────────────────────────

/**
 * The error code returned when a metric value falls outside the configured range.
 *
 * The literal string `PRIVACY_VIOLATION` is chosen so monitoring / alerting can
 * match on it unambiguously.  This is deliberately NOT an HTTP status — it is
 * the logical error code that the ingestion layer returns, and the HTTP layer
 * maps to 422 Unprocessable Entity.
 */
export const PRIVACY_VIOLATION_ERROR_CODE = 'PRIVACY_VIOLATION' as const;

/**
 * Returned when the metric name is not present in {@link MetricRangeMap}.
 * This indicates a misconfiguration or an unknown device metric.
 */
export const UNKNOWN_METRIC_ERROR_CODE = 'UNKNOWN_METRIC' as const;

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * Union of known metric names.  Adding a new metric here ensures type-safe
 * access to the range map below.
 */
export type MetricName = keyof typeof MetricRangeMap;

/**
 * One entry in the boundary matrix: inclusive lower and upper bounds.
 */
export interface MetricBoundary {
  /** Human-readable label for the metric (e.g. "Temperature in °C"). */
  label: string;
  /** Inclusive lower bound. */
  lowerBound: bigint;
  /** Inclusive upper bound. */
  upperBound: bigint;
}

/**
 * Result of an enforcement check.
 *
 * - `allowed === true`  — the value is within range, proceed with ingestion.
 * - `allowed === false` — the value is out of range.  The caller MUST drop the
 *   payload entirely and return {@link PRIVACY_VIOLATION_ERROR_CODE} as the
 *   error code.  The `reason` field explains which bound was violated.
 */
export interface EnforceResult {
  allowed: boolean;
  errorCode?: typeof PRIVACY_VIOLATION_ERROR_CODE | typeof UNKNOWN_METRIC_ERROR_CODE;
  reason?: string;
  metricValue?: number;
  metricName?: string;
  boundary?: MetricBoundary;
}

// ── Metric Range Map ───────────────────────────────────────────────────────────

/**
 * Physical boundary matrix.
 *
 * Every key must be a literal string that matches a real device metric
 * emitted by the hardware.
 *
 * **Current boundaries:**
 *
 * | Metric        | Lower  | Upper      | Rationale                                    |
 * |---------------|--------|------------|----------------------------------------------|
 * | `temperature` | -50    | 150        | °C – industrial IoT range                    |
 * | `humidity`    | 0      | 100        | %RH – physical limit                         |
 * | `voltage`     | 0      | 500        | V – safe operating range for common hardware |
 * | `energy_kwh`  | 0      | 1,000,000  | kWh – impossible single-increment value      |
 */
export const MetricRangeMap: Record<string, MetricBoundary> = {
  temperature: {
    label: 'Temperature (°C)',
    lowerBound: -50n,
    upperBound: 150n,
  },
  humidity: {
    label: 'Relative Humidity (%RH)',
    lowerBound: 0n,
    upperBound: 100n,
  },
  voltage: {
    label: 'Voltage (V)',
    lowerBound: 0n,
    upperBound: 500n,
  },
  energy_kwh: {
    label: 'Energy (kWh)',
    lowerBound: 0n,
    upperBound: 1_000_000n,
  },
} as const;

// ── Billing Tiers ──────────────────────────────────────────────────────────────

export interface BillingTier {
  min: number;
  max: number;
}

export const DEFAULT_BILLING_TIERS: Record<string, BillingTier> = {
  TIER_1: { min: 0, max: 1000 },
  TIER_2: { min: 1001, max: 10000 },
  TIER_3: { min: 10001, max: Infinity },
};

// ── Bounds Enforcer ────────────────────────────────────────────────────────────

/**
 * Synchronous enforcer that checks every metric value against the physical
 * boundary matrix before the database write path is entered.
 *
 * **Usage:**
 *
 * ```ts
 * const enforcer = new MetricBoundsEnforcer();
 * const result = enforcer.enforce('voltage', 250);
 * if (!result.allowed) {
 *   // Short-circuit: drop payload, return errorCode
 *   return { error: PRIVACY_VIOLATION_ERROR_CODE, ... };
 * }
 * ```
 *
 * All methods are synchronous (no I/O) and execute in < 1 µs.
 */
export class MetricBoundsEnforcer {
  /**
   * Check a single metric value against the configured bounds.
   *
   * @param metricName — the metric identifier (must be a key in {@link MetricRangeMap})
   * @param value      — the raw numeric value from the device payload
   * @returns {@link EnforceResult}
   */
  enforce(metricName: string, value: number): EnforceResult {
    const boundary = MetricRangeMap[metricName];
    if (boundary === undefined) {
      return {
        allowed: false,
        errorCode: UNKNOWN_METRIC_ERROR_CODE,
        reason: `Unknown metric "${metricName}": not found in MetricRangeMap`,
        metricName,
        metricValue: value,
      };
    }

    const bigValue = BigInt(Math.round(value));

    if (bigValue < boundary.lowerBound) {
      return {
        allowed: false,
        errorCode: PRIVACY_VIOLATION_ERROR_CODE,
        reason: `Value ${value} for metric "${metricName}" is below the lower bound ${boundary.lowerBound.toString()}`,
        metricName,
        metricValue: value,
        boundary,
      };
    }

    if (bigValue > boundary.upperBound) {
      return {
        allowed: false,
        errorCode: PRIVACY_VIOLATION_ERROR_CODE,
        reason: `Value ${value} for metric "${metricName}" exceeds the upper bound ${boundary.upperBound.toString()}`,
        metricName,
        metricValue: value,
        boundary,
      };
    }

    return { allowed: true };
  }

  /**
   * Batch-check an entire metrics record.  If **any** metric violates its
   * bounds the entire call returns `allowed: false` — the caller MUST short-
   * circuit the database write and drop the whole payload.
   *
   * This is critical for privacy: partial writes could leak information about
   * which metric triggered the violation.
   */
  enforceBatch(metrics: Record<string, number>): EnforceResult {
    for (const [metricName, value] of Object.entries(metrics)) {
      const result = this.enforce(metricName, value);
      if (!result.allowed) {
        return result;
      }
    }
    return { allowed: true };
  }

  /**
   * Return the boundary definition for a metric, or `undefined` if unknown.
   */
  getBoundary(metricName: string): MetricBoundary | undefined {
    return MetricRangeMap[metricName];
  }

  /**
   * List all known metric names.
   */
  knownMetrics(): string[] {
    return Object.keys(MetricRangeMap);
  }
}
