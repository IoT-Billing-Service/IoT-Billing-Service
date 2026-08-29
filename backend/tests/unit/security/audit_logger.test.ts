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

/**
 * In-memory fake store: `logTransaction` writes are captured into `rows`,
 * and `findFirst`/`findMany`/`groupBy` read back from it. This lets the
 * verification tests exercise the real hashing/signing code path end to
 * end (same AuditLogger instance, same keypair) rather than hand-computing
 * expected hashes, which would just re-implement the code under test.
 */
function createInMemoryPrismaMock() {
  const rows: any[] = [];
  let counter = 0;

  const prismaMock: any = {
    $transaction: vi.fn(async (cb: any) => cb(prismaMock)),
    auditLog: {
      findFirst: vi.fn(async ({ where }: any) => {
        const matches = rows
          .filter((r) => r.entityType === where.entityType && r.entityId === where.entityId)
          .sort((a, b) => b._seq - a._seq);
        return matches[0] ?? null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const row = { ...data, createdAt: new Date(Date.now() + counter), _seq: counter++ };
        rows.push(row);
        return row;
      }),
      findMany: vi.fn(async ({ where }: any) => {
        return rows
          .filter((r) => r.entityType === where.entityType && r.entityId === where.entityId)
          .sort((a, b) => a._seq - b._seq);
      }),
      groupBy: vi.fn(async () => {
        const seen = new Set<string>();
        const groups: Array<{ entityType: string; entityId: string }> = [];
        for (const r of rows) {
          const key = `${r.entityType}::${r.entityId}`;
          if (!seen.has(key)) {
            seen.add(key);
            groups.push({ entityType: r.entityType, entityId: r.entityId });
          }
        }
        return groups;
      }),
    },
  };

  return { prismaMock, rows };
}

describe('AuditLogger — chain verification', () => {
  it('verifies a valid multi-entry chain', async () => {
    const { prismaMock } = createInMemoryPrismaMock();
    const logger = new AuditLogger(prismaMock);

    await logger.logTransaction('BillingCycle', 'cycle-1', 'CREATE', { amount: 100 });
    await logger.logTransaction('BillingCycle', 'cycle-1', 'FINALIZE', { amount: 100, fee: 5 });
    await logger.logTransaction('BillingCycle', 'cycle-1', 'SETTLE', { amount: 105 });

    const result = await logger.verifyEntityChain('BillingCycle', 'cycle-1');

    expect(result.valid).toBe(true);
    expect(result.totalEntries).toBe(3);
    expect(result.verifiedEntries).toBe(3);
    expect(result.brokenAtIndex).toBeNull();
    expect(result.brokenReason).toBeNull();
  });

  it('returns valid for an entity with no audit entries', async () => {
    const { prismaMock } = createInMemoryPrismaMock();
    const logger = new AuditLogger(prismaMock);

    const result = await logger.verifyEntityChain('BillingCycle', 'nonexistent');

    expect(result.valid).toBe(true);
    expect(result.totalEntries).toBe(0);
  });

  it('detects a tampered payload (hash mismatch)', async () => {
    const { prismaMock, rows } = createInMemoryPrismaMock();
    const logger = new AuditLogger(prismaMock);

    await logger.logTransaction('BillingRecord', 'rec-1', 'CREATE', { total: 50 });
    await logger.logTransaction('BillingRecord', 'rec-1', 'AUTOCORRECT', { total: 55 });

    // Simulate a database-level tamper: mutate the first entry's payload
    // without recomputing its hash/signature.
    rows[0].payload = { total: 999 };

    const result = await logger.verifyEntityChain('BillingRecord', 'rec-1');

    expect(result.valid).toBe(false);
    expect(result.brokenAtIndex).toBe(0);
    expect(result.brokenReason).toBe('hash_mismatch');
    expect(result.verifiedEntries).toBe(0);
  });

  it('detects a broken previousHash link', async () => {
    const { prismaMock, rows } = createInMemoryPrismaMock();
    const logger = new AuditLogger(prismaMock);

    await logger.logTransaction('BillingRecord', 'rec-2', 'CREATE', { total: 50 });
    await logger.logTransaction('BillingRecord', 'rec-2', 'AUTOCORRECT', { total: 55 });

    // Simulate a deleted/replaced middle entry: second row's previousHash
    // no longer matches the first row's hash.
    rows[1].previousHash = 'some-other-hash';

    const result = await logger.verifyEntityChain('BillingRecord', 'rec-2');

    expect(result.valid).toBe(false);
    expect(result.brokenAtIndex).toBe(1);
    expect(result.brokenReason).toBe('broken_link');
  });

  it('detects an invalid signature', async () => {
    const { prismaMock, rows } = createInMemoryPrismaMock();
    const logger = new AuditLogger(prismaMock);

    await logger.logTransaction('BillingRecord', 'rec-3', 'CREATE', { total: 10 });

    rows[0].signature = Buffer.from(new Uint8Array(64)).toString('base64');

    const result = await logger.verifyEntityChain('BillingRecord', 'rec-3');

    expect(result.valid).toBe(false);
    expect(result.brokenAtIndex).toBe(0);
    expect(result.brokenReason).toBe('invalid_signature');
  });

  it('runIntegrityScan aggregates across multiple entities and flags broken ones', async () => {
    const { prismaMock, rows } = createInMemoryPrismaMock();
    const logger = new AuditLogger(prismaMock);

    await logger.logTransaction('BillingCycle', 'good-1', 'CREATE', { a: 1 });
    await logger.logTransaction('BillingCycle', 'bad-1', 'CREATE', { a: 1 });

    const badRow = rows.find((r) => r.entityId === 'bad-1');
    badRow.payload = { a: 999 };

    const summary = await logger.runIntegrityScan();

    expect(summary.scannedChains).toBe(2);
    expect(summary.validChains).toBe(1);
    expect(summary.brokenChains).toHaveLength(1);
    expect(summary.brokenChains[0].entityId).toBe('bad-1');
  });

  it('exposes a public key derived from the signing key', () => {
    const { prismaMock } = createInMemoryPrismaMock();
    const logger = new AuditLogger(prismaMock);

    const publicKey = logger.getPublicKeyHex();
    expect(publicKey).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('canonicalJson', () => {
  it('produces identical output regardless of key insertion order', async () => {
    const { canonicalJson } = await import('../../../src/security/audit_logger.js');

    const a = { total: 100, currency: 'USD', meta: { x: 1, y: 2 } };
    const b = { meta: { y: 2, x: 1 }, currency: 'USD', total: 100 };

    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('preserves array order (arrays are not sorted, only object keys)', async () => {
    const { canonicalJson } = await import('../../../src/security/audit_logger.js');

    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });
});
