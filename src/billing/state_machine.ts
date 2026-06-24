/**
 * Billing-cycle state machine (issue #42).
 *
 * A cycle moves strictly through OPEN -> FINALIZING -> FINALIZED -> SETTLED.
 * This module is the single source of truth for which transitions are legal;
 * the persistence layer ({@link ../billing/billing_cycle_repository}) enforces
 * *who wins* a concurrent transition via optimistic locking, while this
 * validator enforces *which* transitions are allowed at all.
 */

export enum BillingCycleState {
  OPEN = 'OPEN',
  FINALIZING = 'FINALIZING',
  FINALIZED = 'FINALIZED',
  SETTLED = 'SETTLED',
}

/** Legal successor states. Terminal states map to an empty list. */
const VALID_TRANSITIONS: Record<BillingCycleState, readonly BillingCycleState[]> = {
  [BillingCycleState.OPEN]: [BillingCycleState.FINALIZING],
  [BillingCycleState.FINALIZING]: [BillingCycleState.FINALIZED],
  [BillingCycleState.FINALIZED]: [BillingCycleState.SETTLED],
  [BillingCycleState.SETTLED]: [],
};

/** Thrown when a caller attempts a transition not permitted by the DAG. */
export class InvalidStateTransitionError extends Error {
  readonly from: BillingCycleState;
  readonly to: BillingCycleState;

  constructor(from: BillingCycleState, to: BillingCycleState) {
    super(
      `Illegal billing-cycle transition ${from} -> ${to}. ` +
        `Allowed from ${from}: [${VALID_TRANSITIONS[from].join(', ') || '(none, terminal)'}].`,
    );
    this.name = 'InvalidStateTransitionError';
    this.from = from;
    this.to = to;
  }
}

/** Type guard: is `value` a known billing-cycle state? */
export function isBillingCycleState(value: string): value is BillingCycleState {
  return Object.values(BillingCycleState).includes(value as BillingCycleState);
}

/** Returns true iff `current -> next` is a legal transition. */
export function validateTransition(current: BillingCycleState, next: BillingCycleState): boolean {
  return VALID_TRANSITIONS[current].includes(next);
}

/** Like {@link validateTransition} but throws {@link InvalidStateTransitionError}. */
export function assertTransition(current: BillingCycleState, next: BillingCycleState): void {
  if (!validateTransition(current, next)) {
    throw new InvalidStateTransitionError(current, next);
  }
}

/** The single legal successor of a non-terminal state, or null if terminal. */
export function nextState(current: BillingCycleState): BillingCycleState | null {
  return VALID_TRANSITIONS[current][0] ?? null;
}

/** True if no further transitions are possible from `state`. */
export function isTerminal(state: BillingCycleState): boolean {
  return VALID_TRANSITIONS[state].length === 0;
}
