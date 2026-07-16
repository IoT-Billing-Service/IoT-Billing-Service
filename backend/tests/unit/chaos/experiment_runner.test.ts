/**
 * Unit tests for the ExperimentRunner.
 *
 * All tests are fully in-process — no DB, no Redis, no Stellar.
 *
 * The billing correctness invariants tested here mirror PCI-DSS / SOC2
 * requirements:
 *   - A billing cycle must never be finalised more than once.
 *   - The billing computation must never run after a lost CAS race.
 *   - P99 billing latency must be < 200 ms under normal conditions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runExperiment } from '../../../src/chaos/experiment_runner.js';
import { clearAllFaults } from '../../../src/chaos/fault_injector.js';
import type {
  ChaosExperiment,
  ExperimentMetrics,
} from '../../../src/chaos/types.js';
import type { WorkloadDriver, WorkloadSample } from '../../../src/chaos/experiment_runner.js';

// ---------------------------------------------------------------------------
// Env + cleanup
// ---------------------------------------------------------------------------

const originalEnv = process.env['CHAOS_ENABLED'];

beforeEach(() => {
  process.env['CHAOS_ENABLED'] = 'true';
  clearAllFaults();
});

afterEach(() => {
  clearAllFaults();
  if (originalEnv === undefined) {
    delete process.env['CHAOS_ENABLED'];
  } else {
    process.env['CHAOS_ENABLED'] = originalEnv;
  }
});

// ---------------------------------------------------------------------------
// Driver factories
// ---------------------------------------------------------------------------

/** A well-behaved driver: everything completes, P99 < 200 ms, no bugs. */
function makeHealthyDriver(latencyMs = 10): WorkloadDriver {
  return async (durationMs: number): Promise<WorkloadSample[]> => {
    const samples: WorkloadSample[] = [];
    const deadline = Date.now() + durationMs;
    while (Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, latencyMs));
      samples.push({
        latencyMs,
        completed: true,
        spuriousComputation: false,
        doubleFinalization: false,
      });
    }
    return samples;
  };
}

/** A driver that injects artificial slow operations during fault phase. */
function makeSlowDriver(normalMs: number, slowMs: number): WorkloadDriver {
  let callCount = 0;
  return async (durationMs: number): Promise<WorkloadSample[]> => {
    callCount++;
    const latency = callCount === 2 ? slowMs : normalMs; // second call = fault phase
    const samples: WorkloadSample[] = [];
    const deadline = Date.now() + durationMs;
    while (Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, latency));
      samples.push({
        latencyMs: latency,
        completed: true,
        spuriousComputation: false,
        doubleFinalization: false,
      });
    }
    return samples;
  };
}

/** A driver that reports double-finalization (simulates the pre-fix bug). */
function makeDoubleFinalizeDriver(): WorkloadDriver {
  return async (_durationMs: number): Promise<WorkloadSample[]> => [
    { latencyMs: 5, completed: true, spuriousComputation: false, doubleFinalization: true },
  ];
}

/** A driver that reports spurious computations (simulates lost CAS race bug). */
function makeSpuriousComputeDriver(): WorkloadDriver {
  return async (_durationMs: number): Promise<WorkloadSample[]> => [
    { latencyMs: 5, completed: true, spuriousComputation: true, doubleFinalization: false },
  ];
}

// ---------------------------------------------------------------------------
// Experiment definitions
// ---------------------------------------------------------------------------

function makeSimpleExperiment(
  hypothesis: (m: ExperimentMetrics) => boolean,
  faultDurationMs = 200,
): ChaosExperiment {
  return {
    name: 'test-experiment',
    faults: [
      {
        type: 'billing_compute_delay',
        durationMs: faultDurationMs,
        params: { delayMs: 5 },
      },
    ],
    steadyStateHypothesis: hypothesis,
    baselineDurationMs: 100,
    recoveryDurationMs: 100,
  };
}

// ---------------------------------------------------------------------------
// Passing experiments
// ---------------------------------------------------------------------------

describe('runExperiment — passing scenarios', () => {
  it('passes when the hypothesis is satisfied after recovery', async () => {
    const experiment = makeSimpleExperiment(() => true);
    const result = await runExperiment(experiment, makeHealthyDriver());

    expect(result.passed).toBe(true);
    expect(result.experiment).toBe('test-experiment');
    expect(result.failureReason).toBeUndefined();
  }, 10_000);

  it('records non-zero samples in all three phases', async () => {
    const experiment = makeSimpleExperiment(() => true);
    const result = await runExperiment(experiment, makeHealthyDriver(10));

    expect(result.baseline.billingLatency.sampleCount).toBeGreaterThan(0);
    expect(result.faultInjection.billingLatency.sampleCount).toBeGreaterThan(0);
    expect(result.recovery.billingLatency.sampleCount).toBeGreaterThan(0);
  }, 10_000);

  it('phase timestamps are strictly ordered', async () => {
    const experiment = makeSimpleExperiment(() => true);
    const result = await runExperiment(experiment, makeHealthyDriver(5));

    const baselineEnd = new Date(result.baseline.finishedAt).getTime();
    const faultStart = new Date(result.faultInjection.startedAt).getTime();
    const faultEnd = new Date(result.faultInjection.finishedAt).getTime();
    const recoveryStart = new Date(result.recovery.startedAt).getTime();

    expect(faultStart).toBeGreaterThanOrEqual(baselineEnd - 5); // allow minor clock skew
    expect(recoveryStart).toBeGreaterThanOrEqual(faultEnd - 5);
  }, 10_000);

  it('P99 latency hypothesis: recovers below 200 ms after slow fault', async () => {
    const experiment: ChaosExperiment = {
      name: 'latency-recovery',
      faults: [
        { type: 'billing_compute_delay', durationMs: 200, params: { delayMs: 50 } },
      ],
      steadyStateHypothesis: (m) => m.billingLatency.p99Ms < 200,
      baselineDurationMs: 100,
      recoveryDurationMs: 100,
    };
    // Recovery uses normalMs=10, fault phase uses slowMs=60 → well under 200 ms
    const result = await runExperiment(experiment, makeSlowDriver(10, 60));
    expect(result.passed).toBe(true);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Failing experiments
// ---------------------------------------------------------------------------

describe('runExperiment — failing scenarios', () => {
  it('fails when hypothesis is not satisfied after recovery', async () => {
    const experiment = makeSimpleExperiment(() => false);
    const result = await runExperiment(experiment, makeHealthyDriver());

    expect(result.passed).toBe(false);
    expect(result.failureReason).toBeTruthy();
  }, 10_000);

  it('fails immediately when double-finalization detected during fault phase', async () => {
    const experiment: ChaosExperiment = {
      name: 'double-fin-fault',
      faults: [{ type: 'billing_compute_delay', durationMs: 100, params: { delayMs: 5 } }],
      steadyStateHypothesis: () => true,
      baselineDurationMs: 50,
      recoveryDurationMs: 50,
    };
    // fault phase returns double-finalization; baseline is clean
    let call = 0;
    const driver: WorkloadDriver = async () => {
      call++;
      if (call === 2) return makeDoubleFinalizeDriver()(0);
      return makeHealthyDriver(5)(50);
    };

    const result = await runExperiment(experiment, driver);
    expect(result.passed).toBe(false);
    expect(result.failureReason).toMatch(/doubleFinalization/);
  }, 10_000);

  it('fails immediately when spurious computations detected during fault phase', async () => {
    const experiment: ChaosExperiment = {
      name: 'spurious-compute-fault',
      faults: [{ type: 'billing_compute_delay', durationMs: 100, params: { delayMs: 5 } }],
      steadyStateHypothesis: () => true,
      baselineDurationMs: 50,
      recoveryDurationMs: 50,
    };
    let call = 0;
    const driver: WorkloadDriver = async () => {
      call++;
      if (call === 2) return makeSpuriousComputeDriver()(0);
      return makeHealthyDriver(5)(50);
    };

    const result = await runExperiment(experiment, driver);
    expect(result.passed).toBe(false);
    expect(result.failureReason).toMatch(/spurious/);
  }, 10_000);

  it('fails when baseline already shows double-finalization (pre-condition check)', async () => {
    const experiment = makeSimpleExperiment(() => true);
    const result = await runExperiment(experiment, makeDoubleFinalizeDriver());

    expect(result.passed).toBe(false);
    expect(result.failureReason).toMatch(/Baseline.*billing correctness/i);
  }, 10_000);

  it('P99 hypothesis fails when recovery stays slow', async () => {
    const experiment: ChaosExperiment = {
      name: 'slow-recovery',
      faults: [
        { type: 'billing_compute_delay', durationMs: 200, params: { delayMs: 500 } },
      ],
      // Hypothesis requires P99 < 200ms — but recovery driver uses slowMs=250
      steadyStateHypothesis: (m) => m.billingLatency.p99Ms < 200,
      baselineDurationMs: 100,
      recoveryDurationMs: 100,
    };
    // All three phases use 250 ms latency (simulating a stuck slow path).
    const result = await runExperiment(experiment, makeSlowDriver(250, 250));
    expect(result.passed).toBe(false);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Metrics shape
// ---------------------------------------------------------------------------

describe('ExperimentMetrics shape', () => {
  it('all three phases have valid ISO timestamps', async () => {
    const experiment = makeSimpleExperiment(() => true);
    const result = await runExperiment(experiment, makeHealthyDriver(5));

    for (const phase of [result.baseline, result.faultInjection, result.recovery]) {
      expect(() => new Date(phase.startedAt)).not.toThrow();
      expect(() => new Date(phase.finishedAt)).not.toThrow();
      expect(new Date(phase.finishedAt).getTime()).toBeGreaterThan(
        new Date(phase.startedAt).getTime(),
      );
    }
  }, 10_000);

  it('latency stats are internally consistent (min ≤ p50 ≤ p99 ≤ max)', async () => {
    const experiment = makeSimpleExperiment(() => true);
    const result = await runExperiment(experiment, makeHealthyDriver(10));

    for (const phase of [result.baseline, result.faultInjection, result.recovery]) {
      const l = phase.billingLatency;
      if (l.sampleCount > 0) {
        expect(l.minMs).toBeLessThanOrEqual(l.p50Ms);
        expect(l.p50Ms).toBeLessThanOrEqual(l.p99Ms);
        expect(l.p99Ms).toBeLessThanOrEqual(l.maxMs);
      }
    }
  }, 10_000);

  it('completionRate is between 0 and 1 inclusive', async () => {
    const experiment = makeSimpleExperiment(() => true);
    const result = await runExperiment(experiment, makeHealthyDriver(5));

    for (const phase of [result.baseline, result.faultInjection, result.recovery]) {
      expect(phase.completionRate).toBeGreaterThanOrEqual(0);
      expect(phase.completionRate).toBeLessThanOrEqual(1);
    }
  }, 10_000);
});
