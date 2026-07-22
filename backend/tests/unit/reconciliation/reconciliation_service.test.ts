import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  ReconciliationService,
  DiscrepancySeverity,
} from '../../../src/reconciliation/reconciliation_service.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockPrisma() {
  return {
    billingRecord: {
      findMany: vi.fn(),
    },
    account: {
      findUnique: vi.fn(),
    },
    $executeRaw: vi.fn(),
  } as unknown as PrismaClient;
}

function createMockBillingRecords(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `record-${i + 1}`,
    cycleId: `cycle-${i + 1}`,
    accountId: `account-${i + 1}`,
    usageAmount: BigInt(1000 + i * 100),
    status: 'settled',
    txHash: i % 2 === 0 ? `tx-hash-${i + 1}` : null,
    createdAt: new Date(Date.now() - 3600_000),
    updatedAt: new Date(Date.now() - 1000),
  }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ReconciliationService', () => {
  let mockPrisma: ReturnType<typeof createMockPrisma>;
  let service: ReconciliationService;

  beforeEach(() => {
    mockPrisma = createMockPrisma();
    service = new ReconciliationService(mockPrisma, {
      intervalMs: 1000,
      windowMs: 86_400_000,
      batchSize: 50,
      autoCorrectThreshold: 1000n,
    });
    vi.clearAllMocks();
  });

  describe('start / stop', () => {
    it('starts and stops without errors', () => {
      service.start();
      service.stop();
      // Should not throw
    });

    it('does not start a second timer if already running', () => {
      service.start();
      service.start(); // Should be a no-op
      service.stop();
    });

    it('stop is safe to call when not started', () => {
      expect(() => service.stop()).not.toThrow();
    });
  });

  describe('runReconciliation', () => {
    it('reconciles records and returns a report', async () => {
      const records = createMockBillingRecords(5);
      (mockPrisma.billingRecord.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        records,
      );

      const report = await service.runReconciliation();

      expect(report).toBeDefined();
      expect(report.reportId).toMatch(/^recon_/);
      expect(report.totalChecked).toBe(5);
      expect(report.entries).toHaveLength(5);
      expect(report.auditHash).toHaveLength(64); // SHA-256 hex
    });

    it('throws if reconciliation is already running', async () => {
      // Make findMany hang so running stays true
      (mockPrisma.billingRecord.findMany as ReturnType<typeof vi.fn>).mockImplementationOnce(
        () => new Promise(() => {}),
      );

      // Start reconciliation (don't await — it will hang)
      const promise = service.runReconciliation();

      // Second call should throw
      await expect(service.runReconciliation()).rejects.toThrow(
        'Reconciliation is already in progress',
      );

      // Clean up
      service.stop();
    });

    it('returns empty report when no records found', async () => {
      (mockPrisma.billingRecord.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      const report = await service.runReconciliation();

      expect(report.totalChecked).toBe(0);
      expect(report.entries).toHaveLength(0);
      expect(report.discrepanciesFound).toBe(0);
    });

    it('calls onReconciliationComplete after each batch', async () => {
      const onComplete = vi.fn();
      const svc = new ReconciliationService(mockPrisma, {
        onReconciliationComplete: onComplete,
      });

      const records = createMockBillingRecords(2);
      (mockPrisma.billingRecord.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        records,
      );

      await svc.runReconciliation();

      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(onComplete.mock.calls[0]![0]!.totalChecked).toBe(2);
    });

    it('calls onCriticalDiscrepancy for critical entries', async () => {
      const onCritical = vi.fn();

      // Inject a mock on-chain lookup that returns a very different amount
      const mockFetchOnChainTx = vi.fn().mockResolvedValue({
        hash: 'tx-fake',
        amount: 500n, // On-chain has only 500 stroops — huge discrepancy
      });

      const records = [
        {
          id: 'record-critical',
          cycleId: 'cycle-1',
          accountId: 'account-1',
          usageAmount: 1_000_000_000n,
          status: 'settled',
          txHash: 'tx-hash-critical',
          createdAt: new Date(Date.now() - 3600_000),
          updatedAt: new Date(Date.now() - 1000),
        },
      ];

      const svc = new ReconciliationService(mockPrisma, {
        onCriticalDiscrepancy: onCritical,
        autoCorrectThreshold: 1000n,
        fetchOnChainTx: mockFetchOnChainTx,
      });

      (mockPrisma.billingRecord.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        records,
      );

      await svc.runReconciliation();

      expect(onCritical).toHaveBeenCalled();
      const calledEntry = onCritical.mock.calls[0]![0]!;
      expect(calledEntry.severity).toBe(DiscrepancySeverity.CRITICAL);
    });

    it('generates an audit hash that changes with data', async () => {
      const records1 = createMockBillingRecords(2);
      (mockPrisma.billingRecord.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        records1,
      );

      const report1 = await service.runReconciliation();

      const records2 = createMockBillingRecords(2);
      // Change one record's amount
      records2[0]!.usageAmount = 9999n;
      (mockPrisma.billingRecord.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        records2,
      );

      const report2 = await service.runReconciliation();

      expect(report1.auditHash).not.toBe(report2.auditHash);
    });

    it('classifies and auto-corrects minor discrepancies via mock on-chain lookup', async () => {
      // Inject a mock on-chain lookup that returns a slightly different amount
      const mockFetchOnChainTx = vi.fn().mockResolvedValue({
        hash: 'tx-hash-minor',
        amount: 600n, // On-chain has 600, off-chain has 500
      });

      const records = [
        {
          id: 'record-minor',
          cycleId: 'cycle-1',
          accountId: 'account-1',
          usageAmount: 500n,
          status: 'settled',
          txHash: 'tx-hash-minor',
          createdAt: new Date(Date.now() - 3600_000),
          updatedAt: new Date(Date.now() - 1000),
        },
      ];

      const svc = new ReconciliationService(mockPrisma, {
        autoCorrectThreshold: 1000n,
        fetchOnChainTx: mockFetchOnChainTx,
      });

      (mockPrisma.billingRecord.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        records,
      );

      const report = await svc.runReconciliation();

      expect(report.entries[0]!.severity).toBe(DiscrepancySeverity.MINOR);
      expect(report.entries[0]!.autoCorrected).toBe(true);
      expect(report.entries[0]!.discrepancy).toBe(-100n); // 500 - 600 = -100
    });
  });

  describe('getLastReport', () => {
    it('returns null before any reconciliation', () => {
      expect(service.getLastReport()).toBeNull();
    });

    it('returns the last report after reconciliation', async () => {
      (mockPrisma.billingRecord.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      await service.runReconciliation();

      const report = service.getLastReport();
      expect(report).not.toBeNull();
      expect(report!.totalChecked).toBe(0);
    });
  });

  describe('getTotalReconciled', () => {
    it('tracks total reconciled count', async () => {
      (mockPrisma.billingRecord.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        createMockBillingRecords(3),
      );
      (mockPrisma.billingRecord.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        createMockBillingRecords(2),
      );

      await service.runReconciliation();
      expect(service.getTotalReconciled()).toBe(3);

      await service.runReconciliation();
      expect(service.getTotalReconciled()).toBe(5);
    });
  });

  describe('isRunning', () => {
    it('returns false when idle', () => {
      expect(service.isRunning()).toBe(false);
    });
  });
});

describe('DiscrepancySeverity helpers', () => {
  describe('ReconciliationService.classifyDiscrepancy', () => {
    it('classifies zero as NONE', () => {
      expect(ReconciliationService.classifyDiscrepancy(0n, 1000n)).toBe(
        DiscrepancySeverity.NONE,
      );
    });

    it('classifies within threshold as MINOR', () => {
      expect(ReconciliationService.classifyDiscrepancy(500n, 1000n)).toBe(
        DiscrepancySeverity.MINOR,
      );
      expect(ReconciliationService.classifyDiscrepancy(-500n, 1000n)).toBe(
        DiscrepancySeverity.MINOR,
      );
      expect(ReconciliationService.classifyDiscrepancy(1000n, 1000n)).toBe(
        DiscrepancySeverity.MINOR,
      );
    });

    it('classifies up to 10x threshold as MAJOR', () => {
      expect(ReconciliationService.classifyDiscrepancy(2000n, 1000n)).toBe(
        DiscrepancySeverity.MAJOR,
      );
      expect(ReconciliationService.classifyDiscrepancy(10000n, 1000n)).toBe(
        DiscrepancySeverity.MAJOR,
      );
    });

    it('classifies above 10x threshold as CRITICAL', () => {
      expect(ReconciliationService.classifyDiscrepancy(10001n, 1000n)).toBe(
        DiscrepancySeverity.CRITICAL,
      );
      expect(ReconciliationService.classifyDiscrepancy(-50000n, 1000n)).toBe(
        DiscrepancySeverity.CRITICAL,
      );
    });
  });

  describe('ReconciliationService.computeAuditHash', () => {
    it('returns a 64-character hex hash', () => {
      const entries = [
        {
          recordId: 'r1',
          accountId: 'a1',
          stellarAddress: 'addr1',
          offChainAmount: 1000n,
          onChainAmount: 1000n,
          discrepancy: 0n,
          severity: DiscrepancySeverity.NONE,
          autoCorrected: false,
          outcome: 'matched',
          reconciledAt: new Date().toISOString(),
          onChainTxHash: null,
        },
      ];

      const hash = ReconciliationService.computeAuditHash(entries);
      expect(hash).toHaveLength(64);
      expect(/^[a-f0-9]{64}$/.test(hash)).toBe(true);
    });

    it('returns a consistent hash for the same entries', () => {
      const entries = [
        {
          recordId: 'r1',
          accountId: 'a1',
          stellarAddress: 'addr1',
          offChainAmount: 100n,
          onChainAmount: 100n,
          discrepancy: 0n,
          severity: DiscrepancySeverity.NONE,
          autoCorrected: false,
          outcome: 'matched',
          reconciledAt: '2026-07-22T00:00:00Z',
          onChainTxHash: null,
        },
      ];

      const hash1 = ReconciliationService.computeAuditHash(entries);
      const hash2 = ReconciliationService.computeAuditHash(entries);
      expect(hash1).toBe(hash2);
    });

    it('returns different hashes for different entries', () => {
      const hash1 = ReconciliationService.computeAuditHash([
        {
          recordId: 'r1',
          accountId: 'a1',
          stellarAddress: 'addr1',
          offChainAmount: 100n,
          onChainAmount: 100n,
          discrepancy: 0n,
          severity: DiscrepancySeverity.NONE,
          autoCorrected: false,
          outcome: 'matched',
          reconciledAt: '2026-07-22T00:00:00Z',
          onChainTxHash: null,
        },
      ]);

      const hash2 = ReconciliationService.computeAuditHash([
        {
          recordId: 'r2',
          accountId: 'a2',
          stellarAddress: 'addr2',
          offChainAmount: 200n,
          onChainAmount: 200n,
          discrepancy: 0n,
          severity: DiscrepancySeverity.NONE,
          autoCorrected: false,
          outcome: 'matched',
          reconciledAt: '2026-07-22T00:00:00Z',
          onChainTxHash: null,
        },
      ]);

      expect(hash1).not.toBe(hash2);
    });
  });
});
