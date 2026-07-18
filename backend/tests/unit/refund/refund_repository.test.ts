import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryRefundStore } from '../../../src/refund/refund_repository.js';
import { RefundState } from '../../../src/refund/state_machine.js';

describe('InMemoryRefundStore', () => {
  let store: InMemoryRefundStore;

  beforeEach(() => {
    store = new InMemoryRefundStore();
  });

  describe('create', () => {
    it('should create a refund record with REQUESTED state', async () => {
      const record = await store.create({
        billingRecordId: 'br-001',
        accountId: 'acc-001',
        amount: 5000n,
        idempotencyKey: 'idem-001',
      });

      expect(record.id).toBeDefined();
      expect(record.billingRecordId).toBe('br-001');
      expect(record.accountId).toBe('acc-001');
      expect(record.amount).toBe(5000n);
      expect(record.state).toBe(RefundState.REQUESTED);
      expect(record.lockVersion).toBe(1);
      expect(record.txHash).toBeNull();
      expect(record.retryCount).toBe(0);
      expect(record.idempotencyKey).toBe('idem-001');
    });

    it('should create a record with reason', async () => {
      const record = await store.create({
        billingRecordId: 'br-001',
        accountId: 'acc-001',
        amount: 5000n,
        reason: 'Overcharged',
        idempotencyKey: 'idem-002',
      });

      expect(record.reason).toBe('Overcharged');
    });

    it('should create a record with null reason', async () => {
      const record = await store.create({
        billingRecordId: 'br-001',
        accountId: 'acc-001',
        amount: 5000n,
        idempotencyKey: 'idem-003',
      });

      expect(record.reason).toBeNull();
    });
  });

  describe('findById', () => {
    it('should find a record by id', async () => {
      const created = await store.create({
        billingRecordId: 'br-001',
        accountId: 'acc-001',
        amount: 5000n,
        idempotencyKey: 'idem-004',
      });

      const found = await store.findById(created.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
    });

    it('should return null for non-existent id', async () => {
      const found = await store.findById('non-existent');
      expect(found).toBeNull();
    });
  });

  describe('findByIdempotencyKey', () => {
    it('should find a record by idempotency key', async () => {
      const created = await store.create({
        billingRecordId: 'br-001',
        accountId: 'acc-001',
        amount: 5000n,
        idempotencyKey: 'idem-005',
      });

      const found = await store.findByIdempotencyKey('idem-005');
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
    });

    it('should return null for non-existent key', async () => {
      const found = await store.findByIdempotencyKey('non-existent');
      expect(found).toBeNull();
    });
  });

  describe('applyTransition', () => {
    it('should apply a valid transition', async () => {
      const record = await store.create({
        billingRecordId: 'br-001',
        accountId: 'acc-001',
        amount: 5000n,
        idempotencyKey: 'idem-006',
      });

      const won = await store.applyTransition(
        record.id,
        RefundState.REQUESTED,
        RefundState.ON_CHAIN_SUBMITTED,
        1,
      );

      expect(won).toBe(true);
      const updated = await store.findById(record.id);
      expect(updated!.state).toBe(RefundState.ON_CHAIN_SUBMITTED);
      expect(updated!.lockVersion).toBe(2);
    });

    it('should reject transition from wrong state', async () => {
      const record = await store.create({
        billingRecordId: 'br-001',
        accountId: 'acc-001',
        amount: 5000n,
        idempotencyKey: 'idem-007',
      });

      const won = await store.applyTransition(
        record.id,
        RefundState.COMPLETED, // wrong state
        RefundState.FAILED,
        1,
      );

      expect(won).toBe(false);
    });

    it('should reject transition with wrong lock version', async () => {
      const record = await store.create({
        billingRecordId: 'br-001',
        accountId: 'acc-001',
        amount: 5000n,
        idempotencyKey: 'idem-008',
      });

      const won = await store.applyTransition(
        record.id,
        RefundState.REQUESTED,
        RefundState.ON_CHAIN_SUBMITTED,
        999, // wrong version
      );

      expect(won).toBe(false);
    });

    it('should reject transition for non-existent id', async () => {
      const won = await store.applyTransition(
        'non-existent',
        RefundState.REQUESTED,
        RefundState.ON_CHAIN_SUBMITTED,
        1,
      );

      expect(won).toBe(false);
    });
  });

  describe('updateTxHash', () => {
    it('should update the transaction hash', async () => {
      const record = await store.create({
        billingRecordId: 'br-001',
        accountId: 'acc-001',
        amount: 5000n,
        idempotencyKey: 'idem-009',
      });

      await store.updateTxHash(record.id, 'abc123');
      const updated = await store.findById(record.id);
      expect(updated!.txHash).toBe('abc123');
    });
  });

  describe('incrementRetryCount', () => {
    it('should increment retry count', async () => {
      const record = await store.create({
        billingRecordId: 'br-001',
        accountId: 'acc-001',
        amount: 5000n,
        idempotencyKey: 'idem-010',
      });

      expect(record.retryCount).toBe(0);
      await store.incrementRetryCount(record.id);
      const updated = await store.findById(record.id);
      expect(updated!.retryCount).toBe(1);
      await store.incrementRetryCount(record.id);
      const updated2 = await store.findById(record.id);
      expect(updated2!.retryCount).toBe(2);
    });
  });

  describe('findPendingVerification', () => {
    it('should find records in ON_CHAIN_SUBMITTED state', async () => {
      const record = await store.create({
        billingRecordId: 'br-001',
        accountId: 'acc-001',
        amount: 5000n,
        idempotencyKey: 'idem-011',
      });

      // Not in submitted state yet
      let pending = await store.findPendingVerification();
      expect(pending).toHaveLength(0);

      // Move to submitted state
      await store.applyTransition(
        record.id,
        RefundState.REQUESTED,
        RefundState.ON_CHAIN_SUBMITTED,
        1,
      );

      pending = await store.findPendingVerification();
      expect(pending).toHaveLength(1);
      expect(pending[0]!.id).toBe(record.id);
    });
  });

  describe('findByAccountId', () => {
    it('should find all refunds for an account', async () => {
      await store.create({
        billingRecordId: 'br-001',
        accountId: 'acc-001',
        amount: 5000n,
        idempotencyKey: 'idem-012',
      });
      await store.create({
        billingRecordId: 'br-002',
        accountId: 'acc-001',
        amount: 3000n,
        idempotencyKey: 'idem-013',
      });
      await store.create({
        billingRecordId: 'br-003',
        accountId: 'acc-002',
        amount: 7000n,
        idempotencyKey: 'idem-014',
      });

      const results = await store.findByAccountId('acc-001');
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.accountId === 'acc-001')).toBe(true);
    });

    it('should return empty array for unknown account', async () => {
      const results = await store.findByAccountId('unknown');
      expect(results).toHaveLength(0);
    });
  });

  describe('findByBillingRecordId', () => {
    it('should find all refunds for a billing record', async () => {
      await store.create({
        billingRecordId: 'br-001',
        accountId: 'acc-001',
        amount: 5000n,
        idempotencyKey: 'idem-015',
      });

      const results = await store.findByBillingRecordId('br-001');
      expect(results).toHaveLength(1);
      expect(results[0]!.billingRecordId).toBe('br-001');
    });
  });

  describe('concurrent transitions', () => {
    it('should only allow one winner for concurrent transitions', async () => {
      const record = await store.create({
        billingRecordId: 'br-001',
        accountId: 'acc-001',
        amount: 5000n,
        idempotencyKey: 'idem-016',
      });

      // Simulate 10 concurrent attempts at the same transition
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          store.applyTransition(
            record.id,
            RefundState.REQUESTED,
            RefundState.ON_CHAIN_SUBMITTED,
            1,
          ),
        ),
      );

      const winners = results.filter((r) => r);
      expect(winners).toHaveLength(1);
    });
  });
});
