/**
 * BillingWorkloadDriver — drives concurrent billing-cycle finalization
 * for chaos experiments.
 *
 * Uses the same `InMemoryBillingCycleStore` that the concurrency tests
 * use (issue #42), so experiments are fully in-process with no database
 * dependency. This lets the unit-test chaos suite run in CI without
 * staging infrastructure.
 *
 * A `PgBillingCycleStore`-backed driver for live staging runs is wired
 * in the integration-test layer (`tests/chaos/staging_experiment.test.ts`).
 */

import {
  InMemoryBillingCycleStore,
  type BillingCycleStore,
} from '../billing/billing_cycle_repository.js';
import { finalizeBillingCycle } from '../billing/finalizer.js';
import { BillingCycleState } from '../billing/state_machine.js';
import { getActiveLatencyMs, isFaultActive } from './fault_injector.js';
import type { WorkloadDriver, WorkloadSample } from './experiment_runner.js';

export interface BillingWorkloadOptions {
  /**
   * Number of concurrent "clients" (simulated API pods / scheduler ticks)
   * each racing to finalize cycles simultaneously.
   * Default: 10.
   */
  concurrency?: number;
  /**
   * Number of billing cycles to create per driver invocation.
   * Default: 50.
   */
  cyclesPerRun?: number;
  /** Override the backing store (pass a PgBillingCycleStore for staging). */
  store?: BillingCycleStore;
}

/**
 * Returns a {@link WorkloadDriver} that seeds fresh OPEN cycles, then
 * hammers them with `concurrency` concurrent finalizers, collecting one
 * {@link WorkloadSample} per finalization attempt.
 *
 * The driver repeats until `durationMs` elapses so the experiment runner
 * gets representative samples across the full phase window.
 */
export function createBillingWorkloadDriver(
  options: BillingWorkloadOptions = {},
): WorkloadDriver {
  const concurrency = options.concurrency ?? 10;
  const cyclesPerRun = options.cyclesPerRun ?? 50;

  return async (durationMs: number): Promise<WorkloadSample[]> => {
    const store: BillingCycleStore =
      options.store ?? new InMemoryBillingCycleStore();

    // Track compute calls per cycle to detect double-finalization.
    const computeCallsPerCycle = new Map<string, number>();

    const allSamples: WorkloadSample[] = [];
    const deadline = Date.now() + durationMs;
    let batchIdx = 0;

    while (Date.now() < deadline) {
      // Seed a fresh batch of OPEN cycles.
      const cycleIds: string[] = [];
      for (let i = 0; i < cyclesPerRun; i++) {
        const id = `chaos-cycle-b${String(batchIdx)}-${String(i)}`;
        cycleIds.push(id);
        computeCallsPerCycle.set(id, 0);
        if (store instanceof InMemoryBillingCycleStore) {
          store.seed(id, BillingCycleState.OPEN);
        }
      }
      batchIdx++;

      // `concurrency` workers each attempt to finalize every cycle once.
      const batchSamples = await Promise.all(
        Array.from({ length: concurrency }, async (): Promise<WorkloadSample[]> => {
          const workerSamples: WorkloadSample[] = [];
          for (const cycleId of cycleIds) {
            const t0 = performance.now();
            let completed = false;
            let spuriousComputation = false;
            let error: string | undefined;

            try {
              const result = await finalizeBillingCycle(store, cycleId, {
                computeFinalization: async () => {
                  // Apply billing_compute_delay fault if active.
                  const delayMs = getActiveLatencyMs('billing_compute_delay');
                  if (delayMs > 0) {
                    await new Promise<void>((r) => setTimeout(r, delayMs));
                  }
                  computeCallsPerCycle.set(
                    cycleId,
                    (computeCallsPerCycle.get(cycleId) ?? 0) + 1,
                  );
                },
              });
              completed = result.finalized;

              // If we "won" the finalization but this is not the first compute
              // call for this cycle, that is a spurious computation.
              if (result.outcome === 'finalized') {
                const calls = computeCallsPerCycle.get(cycleId) ?? 0;
                if (calls > 1) spuriousComputation = true;
              }
            } catch (err) {
              error = err instanceof Error ? err.message : String(err);
              // redis_unavailable fault: treat as a transient error, not a billing bug.
              if (isFaultActive('redis_unavailable')) {
                // Expected — rate limiter / session layer may throw. Not a billing bug.
              }
            }

            const latencyMs = performance.now() - t0;
            workerSamples.push({
              latencyMs,
              completed,
              spuriousComputation,
              doubleFinalization: false, // resolved below after all workers finish
              error,
            });
          }
          return workerSamples;
        }),
      );

      // Detect double-finalization: any cycle whose compute ran > 1 time.
      const doubleFinalized = new Set<string>();
      for (const [id, count] of computeCallsPerCycle) {
        if (count > 1) doubleFinalized.add(id);
      }

      // Flatten and annotate samples.
      for (const sample of batchSamples.flat()) {
        allSamples.push(sample);
      }

      // If any double-finalization detected, annotate the last sample for
      // visibility (the runner counts these across all samples).
      if (doubleFinalized.size > 0) {
        const last = allSamples[allSamples.length - 1];
        if (last !== undefined) {
          // Re-assign (samples are value objects here).
          allSamples[allSamples.length - 1] = {
            ...last,
            doubleFinalization: true,
          };
        }
      }

      // Yield to the event loop between batches to avoid starving other tasks.
      await new Promise<void>((r) => setTimeout(r, 0));
    }

    return allSamples;
  };
}
