import { describe, it, expect, beforeEach } from 'vitest';
import { RefundService, REFUND_ERROR_CODES } from '../../../src/refund/refund_service.js';
import { InMemoryRefundStore } from '../../../src/refund/refund_repository.js';
import { RefundState } from '../../../src/refund/state_machine.js';

// ── Mock Prisma Client ──────────────────────────────────────────────────────────
// Only the methods used by RefundService are mocked.

function createMockPrisma(billingRecords: Map<string, { id: string; status: string; usageAmount: bigint }>) {
  return {
    billingRecord: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        return billingRecords.get(where.id) ?? null;
      },
    },
  } as never;
}

describe('RefundService', () => {
  let store: InMemoryRefundStore;
  let service: RefundService;

  function setupService(billingRecords: Map<string, { id: string; status: string; usageAmount: bigint }>) {
    store = new InMemoryRefundStore();
    service = new RefundService(store, createMockPrisma(billingRecords), {
      contractId: undefined, // Use simulated mode
      sorobanRpcUrl: undefined,
      networkPassphrase: undefined,
    });
  }

  describe('requestRefund', () => {
    beforeEach(() => {
      const billingRecords = new Map([
        ['br-001', { id: 'br-001', status: 'settled', usageAmount: 10000n }],
        ['br-002', { id: 'br-002', status: 'pending', usageAmount: 5000n }],
        ['br-003', { id: 'br-003', status: 'settled', usageAmount: 100n }],
      ]);
      setupService(billingRecords);
    });

    it('should create a refund for a settled billing record', async () => {
      const result = await service.requestRefund({
        billingRecordId: 'br-001',
        accountId: 'acc-001',
        amount: 5000n,
        idempotencyKey: 'idem-001',
      });

      expect(result.success).toBe(true);
      expect(result.refund).toBeDefined();
      expect(result.refund!.state).toBe(RefundState.REQUESTED);
      expect(result.refund!.amount).toBe(5000n);
      expect(result.refund!.accountId).toBe('acc-001');
      expect(result.refund!.idempotencyKey).toBe('idem-001');
    });

    it('should be idempotent', async () => {
      const first = await service.requestRefund({
        billingRecordId: 'br-001',
        accountId: 'acc-001',
        amount: 5000n,
        idempotencyKey: 'idem-002',
      });
      const second = await service.requestRefund({
        billingRecordId: 'br-001',
        accountId: 'acc-001',
        amount: 5000n,
        idempotencyKey: 'idem-002',
      });

      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      expect(first.refund!.id).toBe(second.refund!.id);
    });

    it('should reject if billing record not found', async () => {
      const result = await service.requestRefund({
        billingRecordId: 'non-existent',
        accountId: 'acc-001',
        amount: 5000n,
        idempotencyKey: 'idem-003',
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(REFUND_ERROR_CODES.BILLING_RECORD_NOT_FOUND);
    });

    it('should reject if billing record is not settled', async () => {
      const result = await service.requestRefund({
        billingRecordId: 'br-002',
        accountId: 'acc-001',
        amount: 5000n,
        idempotencyKey: 'idem-004',
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(REFUND_ERROR_CODES.BILLING_RECORD_NOT_SETTLED);
    });

    it('should reject if amount is zero', async () => {
      const result = await service.requestRefund({
        billingRecordId: 'br-001',
        accountId: 'acc-001',
        amount: 0n,
        idempotencyKey: 'idem-005',
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(REFUND_ERROR_CODES.INVALID_STATE);
    });

    it('should reject if amount exceeds billing amount', async () => {
      const result = await service.requestRefund({
        billingRecordId: 'br-001',
        accountId: 'acc-001',
        amount: 20000n,
        idempotencyKey: 'idem-006',
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(REFUND_ERROR_CODES.INVALID_STATE);
    });

    it('should reject if amount is negative', async () => {
      const result = await service.requestRefund({
        billingRecordId: 'br-001',
        accountId: 'acc-001',
        amount: -100n,
        idempotencyKey: 'idem-007',
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(REFUND_ERROR_CODES.INVALID_STATE);
    });

    it('should allow refund equal to full billing amount', async () => {
      const result = await service.requestRefund({
        billingRecordId: 'br-001',
        accountId: 'acc-001',
        amount: 10000n,
        idempotencyKey: 'idem-008',
      });

      expect(result.success).toBe(true);
    });

    it('should include reason when provided', async () => {
      const result = await service.requestRefund({
        billingRecordId: 'br-001',
        accountId: 'acc-001',
        amount: 5000n,
        reason: 'Overcharged due to sensor malfunction',
        idempotencyKey: 'idem-009',
      });

      expect(result.success).toBe(true);
      expect(result.refund!.reason).toBe('Overcharged due to sensor malfunction');
    });

    it('should reject if active refund already exists for billing record', async () => {
      // Create an active refund first
      await service.requestRefund({
        billingRecordId: 'br-003',
        accountId: 'acc-001',
        amount: 50n,
        idempotencyKey: 'idem-010',
      });

      // Try to create another for the same billing record
      const result = await service.requestRefund({
        billingRecordId: 'br-003',
        accountId: 'acc-002',
        amount: 100n,
        idempotencyKey: 'idem-011',
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(REFUND_ERROR_CODES.BILLING_RECORD_ALREADY_REFUNDED);
    });
  });

  describe('processRefund', () => {
    beforeEach(() => {
      const billingRecords = new Map([
        ['br-001', { id: 'br-001', status: 'settled', usageAmount: 10000n }],
      ]);
      setupService(billingRecords);
    });

    it('should process a REQUESTED refund to COMPLETED', async () => {
      const request = await service.requestRefund({
        billingRecordId: 'br-001',
        accountId: 'acc-001',
        amount: 5000n,
        idempotencyKey: 'idem-proc-001',
      });
      expect(request.success).toBe(true);
      const refundId = request.refund!.id;

      const result = await service.processRefund(refundId);

      expect(result.success).toBe(true);
      expect(result.refund).toBeDefined();
      expect(result.refund!.state).toBe(RefundState.COMPLETED);
      expect(result.refund!.txHash).toBeDefined();
    });

    it('should set txHash on completion', async () => {
      const request = await service.requestRefund({
        billingRecordId: 'br-001',
        accountId: 'acc-001',
        amount: 3000n,
        idempotencyKey: 'idem-proc-002',
      });
      const result = await service.processRefund(request.refund!.id);

      expect(result.success).toBe(true);
      expect(result.refund!.txHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should reject processing a non-existent refund', async () => {
      const result = await service.processRefund('non-existent');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(REFUND_ERROR_CODES.NOT_FOUND);
    });

    it('should reject processing a COMPLETED refund', async () => {
      const request = await service.requestRefund({
        billingRecordId: 'br-001',
        accountId: 'acc-001',
        amount: 5000n,
        idempotencyKey: 'idem-proc-003',
      });
      await service.processRefund(request.refund!.id);

      // Try to process again
      const result = await service.processRefund(request.refund!.id);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(REFUND_ERROR_CODES.INVALID_STATE);
    });
  });

  describe('getRefundStatus', () => {
    beforeEach(() => {
      const billingRecords = new Map([
        ['br-001', { id: 'br-001', status: 'settled', usageAmount: 10000n }],
      ]);
      setupService(billingRecords);
    });

    it('should return refund with on-chain status when txHash exists', async () => {
      const request = await service.requestRefund({
        billingRecordId: 'br-001',
        accountId: 'acc-001',
        amount: 5000n,
        idempotencyKey: 'idem-status-001',
      });
      await service.processRefund(request.refund!.id);

      const status = await service.getRefundStatus(request.refund!.id);

      expect(status).not.toBeNull();
      expect(status!.refund.state).toBe(RefundState.COMPLETED);
      expect(status!.onChainStatus).toBeDefined();
      expect(status!.onChainStatus!.confirmed).toBe(true);
    });

    it('should return null for non-existent refund', async () => {
      const status = await service.getRefundStatus('non-existent');
      expect(status).toBeNull();
    });

    it('should return refund without on-chain status when no txHash', async () => {
      const request = await service.requestRefund({
        billingRecordId: 'br-001',
        accountId: 'acc-001',
        amount: 5000n,
        idempotencyKey: 'idem-status-002',
      });

      const status = await service.getRefundStatus(request.refund!.id);

      expect(status).not.toBeNull();
      expect(status!.refund.state).toBe(RefundState.REQUESTED);
      expect(status!.onChainStatus).toBeUndefined();
    });
  });

  describe('getAccountRefunds', () => {
    beforeEach(() => {
      const billingRecords = new Map([
        ['br-001', { id: 'br-001', status: 'settled', usageAmount: 10000n }],
        ['br-002', { id: 'br-002', status: 'settled', usageAmount: 10000n }],
      ]);
      setupService(billingRecords);
    });

    it('should return refunds for an account', async () => {
      await service.requestRefund({
        billingRecordId: 'br-001',
        accountId: 'acc-001',
        amount: 5000n,
        idempotencyKey: 'idem-acct-001',
      });
      await service.requestRefund({
        billingRecordId: 'br-002',
        accountId: 'acc-001',
        amount: 3000n,
        idempotencyKey: 'idem-acct-002',
      });

      const results = await service.getAccountRefunds('acc-001');
      expect(results).toHaveLength(2);
    });

    it('should return empty array for unknown account', async () => {
      const results = await service.getAccountRefunds('unknown');
      expect(results).toHaveLength(0);
    });
  });

  describe('full lifecycle', () => {
    it('should complete REQUESTED -> COMPLETED in one call', async () => {
      const billingRecords = new Map([
        ['br-001', { id: 'br-001', status: 'settled', usageAmount: 10000n }],
      ]);
      setupService(billingRecords);

      const request = await service.requestRefund({
        billingRecordId: 'br-001',
        accountId: 'acc-001',
        amount: 5000n,
        reason: 'Sensor misread',
        idempotencyKey: 'idem-lifecycle-001',
      });

      expect(request.success).toBe(true);
      expect(request.refund!.state).toBe(RefundState.REQUESTED);

      const processed = await service.processRefund(request.refund!.id);

      expect(processed.success).toBe(true);
      expect(processed.refund!.state).toBe(RefundState.COMPLETED);
      expect(processed.refund!.txHash).toBeDefined();
      expect(processed.refund!.reason).toBe('Sensor misread');
    });
  });

  describe('error codes', () => {
    it('should export all expected error codes', () => {
      expect(REFUND_ERROR_CODES.ALREADY_EXISTS).toBe('ERR_REFUND_ALREADY_EXISTS');
      expect(REFUND_ERROR_CODES.BILLING_RECORD_NOT_FOUND).toBe('ERR_BILLING_RECORD_NOT_FOUND');
      expect(REFUND_ERROR_CODES.BILLING_RECORD_NOT_SETTLED).toBe('ERR_BILLING_RECORD_NOT_SETTLED');
      expect(REFUND_ERROR_CODES.BILLING_RECORD_ALREADY_REFUNDED).toBe('ERR_BILLING_RECORD_ALREADY_REFUNDED');
      expect(REFUND_ERROR_CODES.NOT_FOUND).toBe('ERR_REFUND_NOT_FOUND');
      expect(REFUND_ERROR_CODES.INVALID_STATE).toBe('ERR_REFUND_INVALID_STATE');
      expect(REFUND_ERROR_CODES.ON_CHAIN_SUBMISSION_FAILED).toBe('ERR_ON_CHAIN_SUBMISSION_FAILED');
      expect(REFUND_ERROR_CODES.ON_CHAIN_VERIFICATION_FAILED).toBe('ERR_ON_CHAIN_VERIFICATION_FAILED');
      expect(REFUND_ERROR_CODES.MAX_RETRIES_EXCEEDED).toBe('ERR_MAX_RETRIES_EXCEEDED');
      expect(REFUND_ERROR_CODES.INTERNAL_ERROR).toBe('ERR_INTERNAL');
    });
  });
});
