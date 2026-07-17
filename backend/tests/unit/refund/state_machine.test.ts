import { describe, it, expect } from 'vitest';
import {
  RefundState,
  isRefundState,
  validateRefundTransition,
  assertRefundTransition,
  isRefundTerminal,
  nextRetryState,
  MAX_REFUND_RETRIES,
  InvalidRefundTransitionError,
} from '../../../src/refund/state_machine.js';

describe('RefundState', () => {
  it('should have all expected states', () => {
    expect(Object.values(RefundState)).toEqual([
      'REQUESTED',
      'ON_CHAIN_SUBMITTED',
      'ON_CHAIN_CONFIRMED',
      'COMPLETED',
      'ON_CHAIN_FAILED',
      'RETRYING',
      'FAILED',
    ]);
  });

  it('should have 7 states total', () => {
    expect(Object.values(RefundState)).toHaveLength(7);
  });
});

describe('isRefundState', () => {
  it('should return true for valid states', () => {
    expect(isRefundState('REQUESTED')).toBe(true);
    expect(isRefundState('COMPLETED')).toBe(true);
    expect(isRefundState('FAILED')).toBe(true);
  });

  it('should return false for invalid values', () => {
    expect(isRefundState('invalid')).toBe(false);
    expect(isRefundState('')).toBe(false);
    expect(isRefundState('SETTLED')).toBe(false);
  });
});

describe('validateRefundTransition', () => {
  describe('happy path transitions', () => {
    it('should allow REQUESTED -> ON_CHAIN_SUBMITTED', () => {
      expect(validateRefundTransition(RefundState.REQUESTED, RefundState.ON_CHAIN_SUBMITTED)).toBe(true);
    });

    it('should allow REQUESTED -> FAILED', () => {
      expect(validateRefundTransition(RefundState.REQUESTED, RefundState.FAILED)).toBe(true);
    });

    it('should allow ON_CHAIN_SUBMITTED -> ON_CHAIN_CONFIRMED', () => {
      expect(validateRefundTransition(RefundState.ON_CHAIN_SUBMITTED, RefundState.ON_CHAIN_CONFIRMED)).toBe(true);
    });

    it('should allow ON_CHAIN_SUBMITTED -> ON_CHAIN_FAILED', () => {
      expect(validateRefundTransition(RefundState.ON_CHAIN_SUBMITTED, RefundState.ON_CHAIN_FAILED)).toBe(true);
    });

    it('should allow ON_CHAIN_SUBMITTED -> FAILED', () => {
      expect(validateRefundTransition(RefundState.ON_CHAIN_SUBMITTED, RefundState.FAILED)).toBe(true);
    });

    it('should allow ON_CHAIN_CONFIRMED -> COMPLETED', () => {
      expect(validateRefundTransition(RefundState.ON_CHAIN_CONFIRMED, RefundState.COMPLETED)).toBe(true);
    });

    it('should allow ON_CHAIN_CONFIRMED -> FAILED', () => {
      expect(validateRefundTransition(RefundState.ON_CHAIN_CONFIRMED, RefundState.FAILED)).toBe(true);
    });

    it('should allow ON_CHAIN_FAILED -> RETRYING', () => {
      expect(validateRefundTransition(RefundState.ON_CHAIN_FAILED, RefundState.RETRYING)).toBe(true);
    });

    it('should allow ON_CHAIN_FAILED -> FAILED', () => {
      expect(validateRefundTransition(RefundState.ON_CHAIN_FAILED, RefundState.FAILED)).toBe(true);
    });

    it('should allow RETRYING -> ON_CHAIN_SUBMITTED', () => {
      expect(validateRefundTransition(RefundState.RETRYING, RefundState.ON_CHAIN_SUBMITTED)).toBe(true);
    });

    it('should allow RETRYING -> FAILED', () => {
      expect(validateRefundTransition(RefundState.RETRYING, RefundState.FAILED)).toBe(true);
    });
  });

  describe('invalid transitions', () => {
    it('should reject REQUESTED -> COMPLETED', () => {
      expect(validateRefundTransition(RefundState.REQUESTED, RefundState.COMPLETED)).toBe(false);
    });

    it('should reject REQUESTED -> ON_CHAIN_CONFIRMED', () => {
      expect(validateRefundTransition(RefundState.REQUESTED, RefundState.ON_CHAIN_CONFIRMED)).toBe(false);
    });

    it('should reject COMPLETED -> anything', () => {
      expect(validateRefundTransition(RefundState.COMPLETED, RefundState.REQUESTED)).toBe(false);
      expect(validateRefundTransition(RefundState.COMPLETED, RefundState.FAILED)).toBe(false);
    });

    it('should reject FAILED -> anything', () => {
      expect(validateRefundTransition(RefundState.FAILED, RefundState.REQUESTED)).toBe(false);
      expect(validateRefundTransition(RefundState.FAILED, RefundState.RETRYING)).toBe(false);
    });

    it('should reject backward transitions', () => {
      expect(validateRefundTransition(RefundState.ON_CHAIN_CONFIRMED, RefundState.ON_CHAIN_SUBMITTED)).toBe(false);
      expect(validateRefundTransition(RefundState.ON_CHAIN_SUBMITTED, RefundState.REQUESTED)).toBe(false);
      expect(validateRefundTransition(RefundState.RETRYING, RefundState.ON_CHAIN_FAILED)).toBe(false);
    });

    it('should reject self-transitions', () => {
      expect(validateRefundTransition(RefundState.REQUESTED, RefundState.REQUESTED)).toBe(false);
      expect(validateRefundTransition(RefundState.COMPLETED, RefundState.COMPLETED)).toBe(false);
    });

    it('should reject ON_CHAIN_FAILED -> ON_CHAIN_CONFIRMED', () => {
      expect(validateRefundTransition(RefundState.ON_CHAIN_FAILED, RefundState.ON_CHAIN_CONFIRMED)).toBe(false);
    });
  });
});

describe('assertRefundTransition', () => {
  it('should not throw for valid transitions', () => {
    expect(() => assertRefundTransition(RefundState.REQUESTED, RefundState.ON_CHAIN_SUBMITTED)).not.toThrow();
  });

  it('should throw InvalidRefundTransitionError for invalid transitions', () => {
    expect(() => assertRefundTransition(RefundState.COMPLETED, RefundState.REQUESTED)).toThrow(
      InvalidRefundTransitionError,
    );
  });

  it('should include from/to in error', () => {
    try {
      assertRefundTransition(RefundState.COMPLETED, RefundState.REQUESTED);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidRefundTransitionError);
      if (e instanceof InvalidRefundTransitionError) {
        expect(e.from).toBe(RefundState.COMPLETED);
        expect(e.to).toBe(RefundState.REQUESTED);
        expect(e.message).toContain('COMPLETED -> REQUESTED');
      }
    }
  });
});

describe('isRefundTerminal', () => {
  it('should return true for COMPLETED', () => {
    expect(isRefundTerminal(RefundState.COMPLETED)).toBe(true);
  });

  it('should return true for FAILED', () => {
    expect(isRefundTerminal(RefundState.FAILED)).toBe(true);
  });

  it('should return false for non-terminal states', () => {
    expect(isRefundTerminal(RefundState.REQUESTED)).toBe(false);
    expect(isRefundTerminal(RefundState.ON_CHAIN_SUBMITTED)).toBe(false);
    expect(isRefundTerminal(RefundState.ON_CHAIN_CONFIRMED)).toBe(false);
    expect(isRefundTerminal(RefundState.ON_CHAIN_FAILED)).toBe(false);
    expect(isRefundTerminal(RefundState.RETRYING)).toBe(false);
  });
});

describe('nextRetryState', () => {
  it('should return RETRYING when retries remain', () => {
    expect(nextRetryState(0)).toBe(RefundState.RETRYING);
    expect(nextRetryState(1)).toBe(RefundState.RETRYING);
    expect(nextRetryState(2)).toBe(RefundState.RETRYING);
  });

  it('should return FAILED when max retries exceeded', () => {
    expect(nextRetryState(MAX_REFUND_RETRIES)).toBe(RefundState.FAILED);
    expect(nextRetryState(MAX_REFUND_RETRIES + 1)).toBe(RefundState.FAILED);
  });

  it('should have MAX_REFUND_RETRIES = 3', () => {
    expect(MAX_REFUND_RETRIES).toBe(3);
  });
});

describe('Full lifecycle path', () => {
  it('should allow REQUESTED -> ON_CHAIN_SUBMITTED -> ON_CHAIN_CONFIRMED -> COMPLETED', () => {
    const path = [
      RefundState.REQUESTED,
      RefundState.ON_CHAIN_SUBMITTED,
      RefundState.ON_CHAIN_CONFIRMED,
      RefundState.COMPLETED,
    ];

    for (let i = 0; i < path.length - 1; i++) {
      const from = path[i]!;
      const to = path[i + 1]!;
      expect(validateRefundTransition(from, to)).toBe(true);
    }
  });

  it('should allow REQUESTED -> ON_CHAIN_SUBMITTED -> ON_CHAIN_FAILED -> RETRYING -> ON_CHAIN_SUBMITTED -> ON_CHAIN_CONFIRMED -> COMPLETED', () => {
    const path = [
      RefundState.REQUESTED,
      RefundState.ON_CHAIN_SUBMITTED,
      RefundState.ON_CHAIN_FAILED,
      RefundState.RETRYING,
      RefundState.ON_CHAIN_SUBMITTED,
      RefundState.ON_CHAIN_CONFIRMED,
      RefundState.COMPLETED,
    ];

    for (let i = 0; i < path.length - 1; i++) {
      const from = path[i]!;
      const to = path[i + 1]!;
      expect(validateRefundTransition(from, to)).toBe(true);
    }
  });

  it('should allow REQUESTED -> FAILED (early termination)', () => {
    expect(validateRefundTransition(RefundState.REQUESTED, RefundState.FAILED)).toBe(true);
  });

  it('should allow max retry exhaustion path', () => {
    // Simulate 3 retries then failure
    let state = RefundState.REQUESTED;
    for (let i = 0; i < MAX_REFUND_RETRIES; i++) {
      expect(validateRefundTransition(state, RefundState.ON_CHAIN_SUBMITTED)).toBe(true);
      state = RefundState.ON_CHAIN_SUBMITTED;
      expect(validateRefundTransition(state, RefundState.ON_CHAIN_FAILED)).toBe(true);
      state = RefundState.ON_CHAIN_FAILED;
      expect(validateRefundTransition(state, RefundState.RETRYING)).toBe(true);
      state = RefundState.RETRYING;
    }
    // After max retries, should go to FAILED
    expect(validateRefundTransition(state, RefundState.ON_CHAIN_SUBMITTED)).toBe(true);
    state = RefundState.ON_CHAIN_SUBMITTED;
    expect(validateRefundTransition(state, RefundState.FAILED)).toBe(true);
  });
});
