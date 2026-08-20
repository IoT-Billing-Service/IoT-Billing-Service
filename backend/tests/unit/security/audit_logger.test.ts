import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditLogger, getAuditLogger } from '../../../src/security/audit_logger.js';
import nacl from 'tweetnacl';
import { Buffer } from 'node:buffer';

describe('AuditLogger', () => {
  let prismaMock: any;
  let auditLogger: AuditLogger;

  beforeEach(() => {
    prismaMock = {
      $transaction: vi.fn(async (cb) => {
        return cb(prismaMock);
      }),
      auditLog: {
        findFirst: vi.fn(),
        create: vi.fn(),
      },
    };

    // Reset singleton instance if needed, but since it's module-scoped we just instantiate a new one for testing
    auditLogger = new AuditLogger(prismaMock);
  });

  it('creates genesis audit log when no previous log exists', async () => {
    prismaMock.auditLog.findFirst.mockResolvedValue(null);

    await auditLogger.logTransaction('BillingCycle', 'cycle-123', 'FINALIZE', { some: 'data' });

    expect(prismaMock.auditLog.findFirst).toHaveBeenCalledWith({
      where: { entityType: 'BillingCycle', entityId: 'cycle-123' },
      orderBy: { createdAt: 'desc' },
      select: { hash: true },
    });

    expect(prismaMock.auditLog.create).toHaveBeenCalled();
    const createCall = prismaMock.auditLog.create.mock.calls[0][0].data;

    expect(createCall.previousHash).toBe('GENESIS');
    expect(createCall.entityType).toBe('BillingCycle');
    expect(createCall.entityId).toBe('cycle-123');
    expect(createCall.action).toBe('FINALIZE');
    expect(createCall.payload).toEqual({ some: 'data' });
    expect(createCall.hash).toBeDefined();
    expect(createCall.signature).toBeDefined();
  });

  it('chains hashes correctly when previous log exists', async () => {
    prismaMock.auditLog.findFirst.mockResolvedValue({ hash: 'prev-hash-123' });

    await auditLogger.logTransaction('BillingRecord', 'record-456', 'AUTOCORRECT', {
      corrected: 100,
    });

    const createCall = prismaMock.auditLog.create.mock.calls[0][0].data;
    expect(createCall.previousHash).toBe('prev-hash-123');
    expect(createCall.entityId).toBe('record-456');
  });

  it('signs the hash successfully', async () => {
    prismaMock.auditLog.findFirst.mockResolvedValue(null);
    await auditLogger.logTransaction('Test', 'test-1', 'ACT', {});

    const createCall = prismaMock.auditLog.create.mock.calls[0][0].data;
    expect(createCall.signature).not.toBeNull();
    // length of base64 encoded ed25519 signature (64 bytes) is usually 88 chars
    expect(createCall.signature.length).toBeGreaterThan(0);
  });
});
