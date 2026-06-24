import { describe, it, expect } from 'vitest';
import {
  BillingCycleState,
  validateTransition,
  assertTransition,
  nextState,
  isTerminal,
  isBillingCycleState,
  InvalidStateTransitionError,
} from '../../../src/billing/state_machine.js';

const { OPEN, FINALIZING, FINALIZED, SETTLED } = BillingCycleState;

describe('validateTransition', () => {
  it('allows each step of the canonical DAG', () => {
    expect(validateTransition(OPEN, FINALIZING)).toBe(true);
    expect(validateTransition(FINALIZING, FINALIZED)).toBe(true);
    expect(validateTransition(FINALIZED, SETTLED)).toBe(true);
  });

  it('rejects skips and backward transitions', () => {
    expect(validateTransition(OPEN, FINALIZED)).toBe(false);
    expect(validateTransition(OPEN, SETTLED)).toBe(false);
    expect(validateTransition(FINALIZED, FINALIZING)).toBe(false);
    expect(validateTransition(FINALIZING, OPEN)).toBe(false);
  });

  it('rejects self-transitions', () => {
    for (const s of [OPEN, FINALIZING, FINALIZED, SETTLED]) {
      expect(validateTransition(s, s)).toBe(false);
    }
  });

  it('treats SETTLED as terminal', () => {
    expect(isTerminal(SETTLED)).toBe(true);
    expect(validateTransition(SETTLED, OPEN)).toBe(false);
    expect(nextState(SETTLED)).toBeNull();
  });
});

describe('assertTransition', () => {
  it('passes silently on a legal transition', () => {
    expect(() => {
      assertTransition(OPEN, FINALIZING);
    }).not.toThrow();
  });

  it('throws InvalidStateTransitionError with a clear message on illegal transitions', () => {
    let caught: unknown;
    try {
      assertTransition(OPEN, FINALIZED);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidStateTransitionError);
    const error = caught as InvalidStateTransitionError;
    expect(error.from).toBe(OPEN);
    expect(error.to).toBe(FINALIZED);
    expect(error.message).toContain('OPEN -> FINALIZED');
    expect(error.message).toContain('FINALIZING'); // lists the allowed successor
  });
});

describe('nextState', () => {
  it('returns the single legal successor', () => {
    expect(nextState(OPEN)).toBe(FINALIZING);
    expect(nextState(FINALIZING)).toBe(FINALIZED);
    expect(nextState(FINALIZED)).toBe(SETTLED);
  });
});

describe('isBillingCycleState', () => {
  it('accepts known states and rejects unknown', () => {
    expect(isBillingCycleState('OPEN')).toBe(true);
    expect(isBillingCycleState('SETTLED')).toBe(true);
    expect(isBillingCycleState('CLOSED')).toBe(false);
    expect(isBillingCycleState('')).toBe(false);
  });
});
