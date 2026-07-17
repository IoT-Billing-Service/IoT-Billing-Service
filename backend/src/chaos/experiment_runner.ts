/**
 * ExperimentRunner — orchestrates a three-phase chaos experiment:
 *
 *   1. Baseline  — observe system under normal load, capture reference metrics
 *   2. Fault     — activate faults, keep load running, capture degraded metrics
 *   3. Recovery  — clear faults, wait for the system to stabilise, assert hypothesis
 *
 * The runner is intentionally decoupled from infrastructure. It accepts a
 * `WorkloadDriver` callback that the caller provides, making it usable in
 * both unit tests (in-process InMemoryBillingCycleStore) and staging
 * integration tests (live Postgres endpoint).
 *
 * PCI-DSS / SOC2 safety: the runner enforces that
 *   - `doubleFinalizationCount` is always 0
 *   - `spuriousComputations` is always 0
 * even when faults are active. Experiments that violate these invariants
 * fail immediately rather than completing normally.
 */

import { activateFault, clearAllFaults, getActiveFaults } from './fault_injector.js';
import type {
  ChaosExperiment,
  ExperimentMetrics,
  ExperimentResult,
  FaultConfig,
  LatencyStats,
  ErrorSummary,
} from './types.js';

// ---------------------------------------------------------------------------
// Workload driver contract
// ---------------------------------------------------------------------------

export interface WorkloadSample {
  /** End-to-end latency for this billing operation, in milliseconds. */
  latencyMs: number;
  /** true → cycle reached FINALIZED within this call. */
  completed: boolean;
  /** true → the billing compute callback ran despite losing the CAS (BUG). */
  spuriousComputation: boolean;
  /** true → a cycle was finalised more than once (BUG). */
  doubleFinalization: boolean;
  /** Optional error message if the operation threw. */
  error?: string;
}

/**
 * A function that drives load against the billing pipeline for `durationMs`
 * and returns per-operation samples.
 *
 * The driver is responsible for creating / seeding cycles, calling
 * `finalizeBillingCycle`, and reporting the outcome of each call.
 */
export type WorkloadDriver = (durationMs: number) => Promise<WorkloadSample[]>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeLatencyStats(samples: readonly number[]): LatencyStats {
  if (samples.length === 0) {
    return { p50Ms: 0, p95Ms: 0, p99Ms: 0, minMs: 0, maxMs: 0, avgMs: 0, sampleCount: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const pick = (q: number): number => sorted[Math.min(n - 1, Math.floor(q * n))] ?? 0;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    p50Ms: pick(0.5),
    p95Ms: pick(0.95),
    p99Ms: pick(0.99),
    minMs: sorted[0] ?? 0,
    maxMs: sorted[n - 1] ?? 0,
    avgMs: sum / n,
    sampleCount: n,
  };
}

function aggregateErrors(samples: readonly WorkloadSample[]): ErrorSummary[] {
  const counts = new Map<string, number>();
  for (const s of samples) {
    if (s.error !== undefined) {
      counts.set(s.error, (counts.get(s.error) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries()).map(([message, count]) => ({ message, count }));
}

function buildMetrics(
  phase: ExperimentMetrics['phase'],
  samples: readonly WorkloadSample[],
  activeFaults: FaultConfig[],
  startedAt: Date,
  finishedAt: Date,
): ExperimentMetrics {
  const latencies = samples.map((s) => s.latencyMs).filter((l) => l > 0);
  const completed = samples.filter((s) => s.completed).length;
  return {
    phase,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    billingLatency: computeLatencyStats(latencies),
    doubleFinalizationCount: samples.filter((s) => s.doubleFinalization).length,
    spuriousComputations: samples.filter((s) => s.spuriousComputation).length,
    completionRate: samples.length > 0 ? completed / samples.length : 0,
    errors: aggregateErrors(samples),
    activeFaults,
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const DEFAULT_BASELINE_MS = 2_000;
const DEFAULT_RECOVERY_MS = 2_000;

/**
 * Run a single chaos experiment and return its result.
 *
 * @throws if `CHAOS_ENABLED !== 'true'` (enforced by `activateFault`)
 */
export async function runExperiment(
  experiment: ChaosExperiment,
  driver: WorkloadDriver,
): Promise<ExperimentResult> {
  const baselineDurationMs = experiment.baselineDurationMs ?? DEFAULT_BASELINE_MS;
  const recoveryDurationMs = experiment.recoveryDurationMs ?? DEFAULT_RECOVERY_MS;

  // ── Phase 1: Baseline ────────────────────────────────────────────────────
  const baselineStart = new Date();
  const baselineSamples = await driver(baselineDurationMs);
  const baselineEnd = new Date();
  const baselineMetrics = buildMetrics(
    'baseline',
    baselineSamples,
    [],
    baselineStart,
    baselineEnd,
  );

  // Safety check: even the baseline must not have billing correctness bugs.
  if (
    baselineMetrics.doubleFinalizationCount > 0 ||
    baselineMetrics.spuriousComputations > 0
  ) {
    return {
      experiment: experiment.name,
      passed: false,
      failureReason:
        `Baseline already violated billing correctness invariants: ` +
        `doubleFinalization=${String(baselineMetrics.doubleFinalizationCount)} ` +
        `spurious=${String(baselineMetrics.spuriousComputations)}`,
      baseline: baselineMetrics,
      faultInjection: baselineMetrics, // placeholder
      recovery: baselineMetrics,       // placeholder
    };
  }

  // ── Phase 2: Fault injection ─────────────────────────────────────────────
  const handles = experiment.faults.map((f) => activateFault(f));
  const faultStart = new Date();
  let faultSamples: WorkloadSample[];
  try {
    faultSamples = await driver(
      Math.max(...experiment.faults.map((f) => f.durationMs)),
    );
  } finally {
    handles.forEach((h) => { h.stop(); });
    clearAllFaults();
  }
  const faultEnd = new Date();
  const faultMetrics = buildMetrics(
    'fault_injection',
    faultSamples,
    getActiveFaults(), // empty after clear, but captured for record
    faultStart,
    faultEnd,
  );

  // Billing correctness is a hard invariant — fail fast.
  if (
    faultMetrics.doubleFinalizationCount > 0 ||
    faultMetrics.spuriousComputations > 0
  ) {
    return {
      experiment: experiment.name,
      passed: false,
      failureReason:
        `Billing correctness violated during fault injection: ` +
        `doubleFinalization=${String(faultMetrics.doubleFinalizationCount)} ` +
        `spurious=${String(faultMetrics.spuriousComputations)}`,
      baseline: baselineMetrics,
      faultInjection: faultMetrics,
      recovery: baselineMetrics, // placeholder — experiment aborted
    };
  }

  // ── Phase 3: Recovery ────────────────────────────────────────────────────
  const recoveryStart = new Date();
  const recoverySamples = await driver(recoveryDurationMs);
  const recoveryEnd = new Date();
  const recoveryMetrics = buildMetrics(
    'recovery',
    recoverySamples,
    [],
    recoveryStart,
    recoveryEnd,
  );

  // ── Steady-state hypothesis ───────────────────────────────────────────────
  const passed = experiment.steadyStateHypothesis(recoveryMetrics);

  return {
    experiment: experiment.name,
    passed,
    failureReason: passed ? undefined : 'Steady-state hypothesis not satisfied after recovery',
    baseline: baselineMetrics,
    faultInjection: faultMetrics,
    recovery: recoveryMetrics,
  };
}
