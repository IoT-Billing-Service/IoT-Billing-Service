/**
 * Refund-processing state machine.
 *
 * A refund moves through a strict lifecycle that mirrors the on-chain
 * settlement verification flow:
 *
 * ```
 * REQUESTED → ON_CHAIN_SUBMITTED → ON_CHAIN_CONFIRMED → COMPLETED
 *                                                         ↗
 *                              ON_CHAIN_FAILED → RETRYING
 *                                                         ↘
 *                                                    FAILED (terminal)
 * ```
 *
 * This module is the single source of truth for which transitions are legal.
 * The persistence layer enforces *who wins* a concurrent transition via
 * optimistic locking, while this validator enforces *which* transitions are
 * allowed at all.
 */

export enum RefundState {
  /** Refund has been requested but not yet submitted on-chain. */
  REQUESTED = 'REQUESTED',
  /** On-chain refund transaction has been submitted to Soroban. */
  ON_CHAIN_SUBMITTED = 'ON_CHAIN_SUBMITTED',
  /** On-chain transaction has been confirmed (included in a ledger). */
  ON_CHAIN_CONFIRMED = 'ON_CHAIN_CONFIRMED',
  /** Refund fully completed: funds returned to the user. */
  COMPLETED = 'COMPLETED',
  /** On-chain transaction failed (contract rejected, insufficient funds, etc.). */
  ON_CHAIN_FAILED = 'ON_CHAIN_FAILED',
  /** A failed refund is being retried. */
  RETRYING = 'RETRYING',
  /** Refund permanently failed (terminal). */
  FAILED = 'FAILED',
}

/** Legal successor states. Terminal states map to an empty list. */
const VALID_TRANSITIONS: Record<RefundState, readonly RefundState[]> = {
  [RefundState.REQUESTED]: [RefundState.ON_CHAIN_SUBMITTED, RefundState.FAILED],
  [RefundState.ON_CHAIN_SUBMITTED]: [
    RefundState.ON_CHAIN_CONFIRMED,
    RefundState.ON_CHAIN_FAILED,
    RefundState.FAILED,
  ],
  [RefundState.ON_CHAIN_CONFIRMED]: [RefundState.COMPLETED, RefundState.FAILED],
  [RefundState.COMPLETED]: [],
  [RefundState.ON_CHAIN_FAILED]: [RefundState.RETRYING, RefundState.FAILED],
  [RefundState.RETRYING]: [RefundState.ON_CHAIN_SUBMITTED, RefundState.FAILED],
  [RefundState.FAILED]: [],
};

/** Thrown when a caller attempts a transition not permitted by the DAG. */
export class InvalidRefundTransitionError extends Error {
  readonly from: RefundState;
  readonly to: RefundState;

  constructor(from: RefundState, to: RefundState) {
    super(
      `Illegal refund transition ${from} -> ${to}. ` +
        `Allowed from ${from}: [${VALID_TRANSITIONS[from].join(', ') || '(none, terminal)'}].`,
    );
    this.name = 'InvalidRefundTransitionError';
    this.from = from;
    this.to = to;
  }
}

/** Type guard: is `value` a known refund state? */
export function isRefundState(value: string): value is RefundState {
  return Object.values(RefundState).includes(value as RefundState);
}

/** Returns true iff `current -> next` is a legal transition. */
export function validateRefundTransition(current: RefundState, next: RefundState): boolean {
  return VALID_TRANSITIONS[current].includes(next);
}

/** Like {@link validateRefundTransition} but throws {@link InvalidRefundTransitionError}. */
export function assertRefundTransition(current: RefundState, next: RefundState): void {
  if (!validateRefundTransition(current, next)) {
    throw new InvalidRefundTransitionError(current, next);
  }
}

/** True if no further transitions are possible from `state`. */
export function isRefundTerminal(state: RefundState): boolean {
  return VALID_TRANSITIONS[state].length === 0;
}

/** Maximum number of retries allowed before the refund enters FAILED. */
export const MAX_REFUND_RETRIES = 3;

/**
 * Determine the next state for a failed refund based on retry count.
 * Returns `RETRYING` if retries remain, `FAILED` otherwise.
 */
export function nextRetryState(retryCount: number): RefundState {
  return retryCount < MAX_REFUND_RETRIES ? RefundState.RETRYING : RefundState.FAILED;
}
