import {
  BillingCycleState,
  assertTransition,
  InvalidStateTransitionError,
} from './state_machine.js';
import type { BillingCycleStore } from './billing_cycle_repository.js';
import { uuidv7 } from './uuidv7.js';

/**
 * Concurrency-safe billing-cycle finalization (issue #42).
 *
 * Both the event pipeline and the cron scheduler may call this for the same
 * cycle at a ledger boundary. Safety comes from two layers:
 *
 *   1. The OPEN -> FINALIZING transition is an optimistic compare-and-set
 *      ({@link BillingCycleStore.applyTransition}). Exactly one racing caller
 *      wins; everyone else sees 0 rows updated and bails out BEFORE running any
 *      billing computation — so a cycle is never finalized twice.
 *   2. An idempotency key recorded under a unique constraint makes a *replay*
 *      of the same logical finalization a no-op.
 *
 * The expensive computation runs strictly between FINALIZING and FINALIZED, so
 * it executes at most once per cycle.
 */

export type FinalizationOutcome =
  | 'finalized'
  | 'not_found'
  | 'not_open'
  | 'lost_race'
  | 'duplicate_replay';

export interface FinalizationResult {
  cycleId: string;
  outcome: FinalizationOutcome;
  finalized: boolean;
  state: BillingCycleState | null;
  idempotencyKey: string | null;
}

export interface FinalizeOptions {
  /**
   * Idempotency key for this finalization attempt. Supply a stable key when
   * retrying the SAME logical call so the retry is deduplicated; omit to mint a
   * fresh time-ordered UUIDv7.
   */
  idempotencyKey?: string;
  /**
   * The actual billing computation, invoked at most once per cycle, strictly
   * after this caller has won the OPEN -> FINALIZING transition. Default: no-op.
   */
  computeFinalization?: (cycleId: string) => Promise<void> | void;
}

/**
 * Finalize a single billing cycle. Idempotent and race-safe: concurrent or
 * repeated invocations resolve to a non-`finalized` outcome rather than
 * double-charging.
 */
export async function finalizeBillingCycle(
  store: BillingCycleStore,
  cycleId: string,
  options: FinalizeOptions = {},
): Promise<FinalizationResult> {
  const cycle = await store.getCycle(cycleId);
  if (cycle === null) {
    return result(cycleId, 'not_found', null, null);
  }
  if (cycle.state !== BillingCycleState.OPEN) {
    // Already being / been finalized by another path.
    return result(cycleId, 'not_open', cycle.state, null);
  }

  // Validate the DAG up front so an illegal target is a programming error, not
  // a silent no-op.
  assertTransition(BillingCycleState.OPEN, BillingCycleState.FINALIZING);

  // Optimistic CAS: only one racing caller flips OPEN -> FINALIZING.
  const won = await store.applyTransition(
    cycleId,
    BillingCycleState.OPEN,
    BillingCycleState.FINALIZING,
    cycle.lockVersion,
  );
  if (!won) {
    const latest = await store.getCycle(cycleId);
    return result(cycleId, 'lost_race', latest?.state ?? null, null);
  }

  // Idempotency gate for replays of this same logical attempt.
  const idempotencyKey = options.idempotencyKey ?? uuidv7();
  const fresh = await store.recordFinalization(cycleId, idempotencyKey);
  if (!fresh) {
    return result(cycleId, 'duplicate_replay', BillingCycleState.FINALIZING, idempotencyKey);
  }

  // The single, exactly-once billing computation.
  if (options.computeFinalization !== undefined) {
    await options.computeFinalization(cycleId);
  }

  // FINALIZING -> FINALIZED. We won the CAS above, so lockVersion advanced by 1.
  assertTransition(BillingCycleState.FINALIZING, BillingCycleState.FINALIZED);
  await store.applyTransition(
    cycleId,
    BillingCycleState.FINALIZING,
    BillingCycleState.FINALIZED,
    cycle.lockVersion + 1,
  );

  return result(cycleId, 'finalized', BillingCycleState.FINALIZED, idempotencyKey);
}

function result(
  cycleId: string,
  outcome: FinalizationOutcome,
  state: BillingCycleState | null,
  idempotencyKey: string | null,
): FinalizationResult {
  return { cycleId, outcome, finalized: outcome === 'finalized', state, idempotencyKey };
}

export { InvalidStateTransitionError };
