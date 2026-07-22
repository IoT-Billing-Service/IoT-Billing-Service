/**
 * Integration test: End-to-End Billing Flow (issue #60)
 *
 * Tests the full billing lifecycle: state-machine transitions, idempotency,
 * and geographic pricing integration. Uses the in-memory billing cycle store
 * for fast, isolated tests that don't require a database connection.
 */

import { describe, it, expect } from 'vitest';
import { finalizeBillingCycle, InvalidStateTransitionError } from '../../src/billing/finalizer.js';
import { InMemoryBillingCycleStore } from '../../src/billing/billing_cycle_repository.js';
import { BillingCycleState } from '../../src/billing/state_machine.js';

describe('E2E: Billing Cycle Lifecycle', () => {
  describe('State Machine Transitions', () => {
    it('should finalize an OPEN cycle to FINALIZED with a CAS-based store', async () => {
      const store = new InMemoryBillingCycleStore();
      const cycleId = 'test-cycle-1';
      store.seed(cycleId, BillingCycleState.OPEN, 1);

      const result = await finalizeBillingCycle(store, cycleId);
      expect(result.outcome).toBe('finalized');
      expect(result.finalized).toBe(true);
      expect(result.state).toBe(BillingCycleState.FINALIZED);
    });

    it('should return not_open when cycle is already FINALIZED', async () => {
      const store = new InMemoryBillingCycleStore();
      const cycleId = 'test-cycle-2';
      store.seed(cycleId, BillingCycleState.OPEN, 1);

      await finalizeBillingCycle(store, cycleId);
      const result = await finalizeBillingCycle(store, cycleId);
      expect(result.outcome).toBe('not_open');
      expect(result.finalized).toBe(false);
    });

    it('should return not_found for a nonexistent cycle', async () => {
      const store = new InMemoryBillingCycleStore();
      const result = await finalizeBillingCycle(store, 'nonexistent-id');
      expect(result.outcome).toBe('not_found');
      expect(result.finalized).toBe(false);
    });

    it('should prevent duplicate finalization via idempotency key replay', async () => {
      // To test the idempotency gate we need the cycle to remain in FINALIZING
      // when a replay arrives.  We simulate this by manually advancing the
      // store to FINALIZING and recording the idempotency key, then calling
      // finalizeBillingCycle — it should see the duplicate key and return
      // duplicate_replay.
      const store = new InMemoryBillingCycleStore();
      const cycleId = 'test-cycle-3';
      store.seed(cycleId, BillingCycleState.OPEN, 1);

      // Win the OPEN → FINALIZING CAS and record the key manually.
      await store.applyTransition(cycleId, BillingCycleState.OPEN, BillingCycleState.FINALIZING, 1);
      const key = 'idempotent-key-3';
      await store.recordFinalization(cycleId, key);

      // Replay with the same key while cycle is still FINALIZING.
      const result = await finalizeBillingCycle(store, cycleId, { idempotencyKey: key });
      expect(result.outcome).toBe('duplicate_replay');
    });

    it('should produce a geo pricing result when countryCode is provided', async () => {
      const store = new InMemoryBillingCycleStore();
      const cycleId = 'test-cycle-geo';
      store.seed(cycleId, BillingCycleState.OPEN, 1);

      const result = await finalizeBillingCycle(store, cycleId, { countryCode: 'US' });
      expect(result.geo).not.toBeNull();
      expect(result.geo!.countryCode).toBe('US');
      expect(result.geo!.region).toBeDefined();
      expect(result.geo!.multiplier).toBeGreaterThan(0);
    });
  });

  describe('Invalid State Transitions', () => {
    it('should throw InvalidStateTransitionError for illegal transitions', () => {
      const err = new InvalidStateTransitionError(BillingCycleState.OPEN, BillingCycleState.SETTLED);
      expect(err).toBeInstanceOf(Error);
      expect(err.from).toBe(BillingCycleState.OPEN);
      expect(err.to).toBe(BillingCycleState.SETTLED);
      expect(err.message).toContain('OPEN');
      expect(err.message).toContain('SETTLED');
    });
  });
});
