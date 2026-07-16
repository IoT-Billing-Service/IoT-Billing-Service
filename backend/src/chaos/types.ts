/**
 * Chaos Engineering Types — IoT Billing Platform
 *
 * Defines the contract for fault injection probes used during staging
 * chaos experiments. All experiments target the billing pipeline
 * (OPEN → FINALIZING → FINALIZED → SETTLED) and must not touch
 * production data.
 *
 * Design constraints:
 *  - P99 billing operations < 200 ms (issue performance target)
 *  - All transactions cryptographically verified (security invariant)
 *  - PCI-DSS / SOC2: no experiment may double-charge or drop a charge
 */

// ---------------------------------------------------------------------------
// Fault categories
// ---------------------------------------------------------------------------

export type FaultType =
  | 'network_latency'        // inject artificial RTT on a dependency call
  | 'network_partition'      // block all traffic to a dependency for N ms
  | 'db_connection_exhaust'  // hold all pool connections so callers queue
  | 'db_slow_query'          // delay every query response by N ms
  | 'redis_latency'          // inject latency into every Redis command
  | 'redis_unavailable'      // make every Redis call throw ECONNREFUSED
  | 'process_cpu_spike'      // busy-loop to saturate one CPU for N ms
  | 'billing_compute_delay'  // delay the computeFinalization callback
  | 'billing_state_flip'     // force an unexpected state on a cycle row
  | 'payload_corruption';    // corrupt a fraction of inbound telemetry bytes

export type ExperimentPhase = 'baseline' | 'fault_injection' | 'recovery';

// ---------------------------------------------------------------------------
// Fault descriptor
// ---------------------------------------------------------------------------

export interface FaultConfig {
  /** Which fault to activate. */
  type: FaultType;
  /** How long the fault stays active, in milliseconds. */
  durationMs: number;
  /**
   * Fault-specific parameters.
   *
   * network_latency       → { addedLatencyMs: number }
   * db_slow_query         → { delayMs: number }
   * redis_latency         → { delayMs: number }
   * billing_compute_delay → { delayMs: number }
   * billing_state_flip    → { targetState: BillingCycleState }
   * payload_corruption    → { corruptionRate: number (0-1) }
   * all others            → {}
   */
  params: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Experiment definition
// ---------------------------------------------------------------------------

export interface ChaosExperiment {
  /** Human-readable name, used in reports and CI annotations. */
  name: string;
  /** Faults to inject in parallel during the injection phase. */
  faults: FaultConfig[];
  /**
   * Steady-state hypothesis: a predicate run after recovery.
   * Must return `true` for the experiment to pass.
   */
  steadyStateHypothesis: (metrics: ExperimentMetrics) => boolean;
  /** How long to observe baseline behaviour before faults fire, in ms. */
  baselineDurationMs?: number;
  /** How long to wait after faults clear before asserting recovery, in ms. */
  recoveryDurationMs?: number;
}

// ---------------------------------------------------------------------------
// Metrics collected during an experiment
// ---------------------------------------------------------------------------

export interface ExperimentMetrics {
  phase: ExperimentPhase;
  /** Wall-clock timestamps (ISO 8601). */
  startedAt: string;
  finishedAt: string;
  /** Billing finalization latency histogram, milliseconds. */
  billingLatency: LatencyStats;
  /** Number of cycles that were finalized more than once (MUST be zero). */
  doubleFinalizationCount: number;
  /** Number of billing computations that ran despite a lost CAS race (MUST be zero). */
  spuriousComputations: number;
  /** Fraction of cycles that reached FINALIZED within durationMs. */
  completionRate: number;
  /** Errors thrown during the experiment phase. */
  errors: ErrorSummary[];
  /** Raw fault configs active during this phase. */
  activeFaults: FaultConfig[];
}

export interface LatencyStats {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  sampleCount: number;
}

export interface ErrorSummary {
  message: string;
  count: number;
}

// ---------------------------------------------------------------------------
// Experiment result
// ---------------------------------------------------------------------------

export interface ExperimentResult {
  experiment: string;
  passed: boolean;
  /** Reason the hypothesis failed, if applicable. */
  failureReason?: string;
  baseline: ExperimentMetrics;
  faultInjection: ExperimentMetrics;
  recovery: ExperimentMetrics;
}
