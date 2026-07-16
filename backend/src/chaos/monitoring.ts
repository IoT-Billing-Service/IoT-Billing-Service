/**
 * Chaos Monitoring — Prometheus metrics for chaos experiment observability.
 *
 * Tracks experiment phases, fault activations, and SLO adherence so that
 * Grafana dashboards and alerts can observe chaos activity without
 * conflating it with real production anomalies.
 *
 * All metrics are prefixed with `chaos_` and are registered lazily
 * (no-op when prom-client is not initialised in unit-test mode).
 */

import promClient from 'prom-client';

// ---------------------------------------------------------------------------
// Guard — skip registration if prom-client registry is not yet set up,
// which is the normal state during unit tests.
// ---------------------------------------------------------------------------

function tryRegister<T extends promClient.Metric>(factory: () => T): T | null {
  try {
    return factory();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export const chaosExperimentsTotal = tryRegister(
  () =>
    new promClient.Counter({
      name: 'chaos_experiments_total',
      help: 'Total chaos experiments executed, by result',
      labelNames: ['experiment', 'result'] as const,
    }),
);

export const chaosFaultActivationsTotal = tryRegister(
  () =>
    new promClient.Counter({
      name: 'chaos_fault_activations_total',
      help: 'Number of times each fault type has been activated',
      labelNames: ['fault_type'] as const,
    }),
);

export const chaosPhaseActive = tryRegister(
  () =>
    new promClient.Gauge({
      name: 'chaos_phase_active',
      help: 'Current chaos experiment phase (0=none, 1=baseline, 2=fault_injection, 3=recovery)',
    }),
);

export const chaosP99BillingLatencyMs = tryRegister(
  () =>
    new promClient.Gauge({
      name: 'chaos_p99_billing_latency_ms',
      help: 'P99 billing operation latency (ms) as observed during last experiment phase',
      labelNames: ['phase'] as const,
    }),
);

export const chaosDoubleFinalizationTotal = tryRegister(
  () =>
    new promClient.Counter({
      name: 'chaos_double_finalization_total',
      help: 'Double-finalization events detected during chaos experiments (MUST stay 0)',
    }),
);

export const chaosSurplusComputationsTotal = tryRegister(
  () =>
    new promClient.Counter({
      name: 'chaos_spurious_computations_total',
      help: 'Billing computations that ran despite a lost CAS race (MUST stay 0)',
    }),
);

// ---------------------------------------------------------------------------
// Setters called by the experiment runner
// ---------------------------------------------------------------------------

export function recordExperimentResult(
  experimentName: string,
  passed: boolean,
): void {
  chaosExperimentsTotal?.inc({
    experiment: experimentName,
    result: passed ? 'passed' : 'failed',
  });
}

export function recordFaultActivation(faultType: string): void {
  chaosFaultActivationsTotal?.inc({ fault_type: faultType });
}

export function setPhase(phase: 'none' | 'baseline' | 'fault_injection' | 'recovery'): void {
  const val = { none: 0, baseline: 1, fault_injection: 2, recovery: 3 }[phase];
  chaosPhaseActive?.set(val);
}

export function recordPhaseLatencies(
  phase: string,
  p99Ms: number,
): void {
  chaosP99BillingLatencyMs?.set({ phase }, p99Ms);
}

export function recordDoubleFinalization(count: number): void {
  if (count > 0) chaosDoubleFinalizationTotal?.inc(count);
}

export function recordSpuriousComputations(count: number): void {
  if (count > 0) chaosSurplusComputationsTotal?.inc(count);
}
