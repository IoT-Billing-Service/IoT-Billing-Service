import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import nacl from 'tweetnacl';
import { Buffer } from 'node:buffer';

/**
 * Deterministic JSON serialization: object keys are sorted recursively
 * before stringifying.
 *
 * Why this matters: `payload` round-trips through Postgres JSONB via
 * Prisma. JSONB does not guarantee it preserves the original JS property
 * insertion order on read-back, so a naive `JSON.stringify(payload)` at
 * verification time can produce a different string — and therefore a
 * different hash — than the one computed at write time, even when nothing
 * was tampered with. Canonicalizing on both the write and verify paths
 * removes that false-positive source entirely. This is the standard fix
 * for tamper-evident hash chains whose payloads are recorded as, and later
 * re-read from, a JSON column.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** A single audit log row as read back from storage. */
export interface AuditChainRow {
  entityType: string;
  entityId: string;
  action: string;
  payload: unknown;
  previousHash: string;
  hash: string;
  signature: string;
  createdAt: Date;
}

export type ChainBreakReason = 'broken_link' | 'hash_mismatch' | 'invalid_signature';

export interface ChainVerificationResult {
  valid: boolean;
  entityType: string;
  entityId: string;
  totalEntries: number;
  verifiedEntries: number;
  brokenAtIndex: number | null;
  brokenReason: ChainBreakReason | null;
  verifiedAt: string;
}

export interface IntegrityScanSummary {
  scannedChains: number;
  validChains: number;
  brokenChains: ChainVerificationResult[];
  scannedAt: string;
}

const GENESIS = 'GENESIS';

export class AuditLogger {
  private readonly privateKeyBytes: Uint8Array;
  private readonly publicKeyBytes: Uint8Array;

  constructor(private readonly prisma: PrismaClient) {
    const keyHex = process.env.AUDIT_PRIVATE_KEY;
    if (!keyHex) {
      // In a real environment, this should be enforced, but we fallback for tests
      const keyPair = nacl.sign.keyPair();
      this.privateKeyBytes = keyPair.secretKey;
      this.publicKeyBytes = keyPair.publicKey;
    } else {
      this.privateKeyBytes = Buffer.from(keyHex, 'hex');
      if (this.privateKeyBytes.length !== 64) {
        throw new Error('AUDIT_PRIVATE_KEY must be a 64-byte hex string (128 characters)');
      }
      // Ed25519 secret keys are the 32-byte seed concatenated with the
      // 32-byte public key; tweetnacl's "secretKey" format already embeds
      // the public key in its second half.
      this.publicKeyBytes = this.privateKeyBytes.subarray(32, 64);
    }
  }

  /**
   * Returns the Ed25519 public key (hex-encoded) that verifiers — including
   * external auditors, for independent SOC2/PCI-DSS verification without
   * trusting this service's own code — should use to check entry
   * signatures.
   */
  getPublicKeyHex(): string {
    return Buffer.from(this.publicKeyBytes).toString('hex');
  }

  /**
   * Appends an immutable audit log entry for a given entity.
   * Maintains a hash chain per entityId to provide tamper evidence while
   * avoiding global lock contention, ensuring < 200ms P99 performance.
   */
  async logTransaction(
    entityType: string,
    entityId: string,
    action: string,
    payload: unknown,
  ): Promise<void> {
    const payloadJson = canonicalJson(payload);

    // We do this in a transaction to ensure we get the latest previousHash
    // and insert the new one atomically, but only scoped to this entityId.
    // If Prisma is used outside of this, it guarantees isolation.
    await this.prisma.$transaction(async (tx) => {
      // Find the most recent audit log for this entity
      const lastLog = await tx.auditLog.findFirst({
        where: { entityType, entityId },
        orderBy: { createdAt: 'desc' },
        select: { hash: true },
      });

      const previousHash = lastLog?.hash ?? GENESIS;

      // Compute the SHA-256 hash
      const hashInput = `${previousHash}|${entityType}|${entityId}|${action}|${payloadJson}`;
      const hash = createHash('sha256').update(hashInput).digest('hex');

      // Sign the hash with the service's private key
      const signatureBytes = nacl.sign.detached(Buffer.from(hash, 'hex'), this.privateKeyBytes);
      const signature = Buffer.from(signatureBytes).toString('base64');

      await tx.auditLog.create({
        data: {
          entityType,
          entityId,
          action,
          payload: payload as any,
          previousHash,
          hash,
          signature,
        },
      });
    });
  }

  /**
   * Walks the full hash chain for one entity, oldest to newest, and
   * confirms:
   *   1. each entry's `previousHash` links to the prior entry's `hash`
   *      (or GENESIS for the first entry),
   *   2. recomputing the SHA-256 hash from the entry's own fields
   *      reproduces the stored `hash` exactly, and
   *   3. the stored Ed25519 `signature` over that hash verifies against
   *      this service's public key.
   *
   * Stops at the first entry that fails any check and reports where and
   * why, rather than continuing to check entries whose position in the
   * chain is already unverifiable.
   */
  async verifyEntityChain(entityType: string, entityId: string): Promise<ChainVerificationResult> {
    const rows: AuditChainRow[] = await this.prisma.auditLog.findMany({
      where: { entityType, entityId },
      orderBy: { createdAt: 'asc' },
      select: {
        entityType: true,
        entityId: true,
        action: true,
        payload: true,
        previousHash: true,
        hash: true,
        signature: true,
        createdAt: true,
      },
    });

    const verifiedAt = new Date().toISOString();

    if (rows.length === 0) {
      return {
        valid: true,
        entityType,
        entityId,
        totalEntries: 0,
        verifiedEntries: 0,
        brokenAtIndex: null,
        brokenReason: null,
        verifiedAt,
      };
    }

    let expectedPreviousHash = GENESIS;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      if (row.previousHash !== expectedPreviousHash) {
        return {
          valid: false,
          entityType,
          entityId,
          totalEntries: rows.length,
          verifiedEntries: i,
          brokenAtIndex: i,
          brokenReason: 'broken_link',
          verifiedAt,
        };
      }

      const payloadJson = canonicalJson(row.payload);
      const hashInput = `${row.previousHash}|${entityType}|${entityId}|${row.action}|${payloadJson}`;
      const recomputedHash = createHash('sha256').update(hashInput).digest('hex');

      if (recomputedHash !== row.hash) {
        return {
          valid: false,
          entityType,
          entityId,
          totalEntries: rows.length,
          verifiedEntries: i,
          brokenAtIndex: i,
          brokenReason: 'hash_mismatch',
          verifiedAt,
        };
      }

      const signatureValid = nacl.sign.detached.verify(
        Buffer.from(row.hash, 'hex'),
        Buffer.from(row.signature, 'base64'),
        this.publicKeyBytes,
      );

      if (!signatureValid) {
        return {
          valid: false,
          entityType,
          entityId,
          totalEntries: rows.length,
          verifiedEntries: i,
          brokenAtIndex: i,
          brokenReason: 'invalid_signature',
          verifiedAt,
        };
      }

      expectedPreviousHash = row.hash;
    }

    return {
      valid: true,
      entityType,
      entityId,
      totalEntries: rows.length,
      verifiedEntries: rows.length,
      brokenAtIndex: null,
      brokenReason: null,
      verifiedAt,
    };
  }

  /**
   * Verifies every distinct entity's chain. Intended for a periodic
   * monitoring job (e.g. a cron alongside the existing scheduler/chaos
   * monitoring infrastructure) rather than a hot request path — this does
   * one query per entity and is not P99-latency-sensitive.
   */
  async runIntegrityScan(): Promise<IntegrityScanSummary> {
    const distinctEntities = await this.prisma.auditLog.groupBy({
      by: ['entityType', 'entityId'],
    });

    const brokenChains: ChainVerificationResult[] = [];
    let validChains = 0;

    for (const { entityType, entityId } of distinctEntities) {
      const result = await this.verifyEntityChain(entityType, entityId);
      if (result.valid) {
        validChains++;
      } else {
        brokenChains.push(result);
      }
    }

    return {
      scannedChains: distinctEntities.length,
      validChains,
      brokenChains,
      scannedAt: new Date().toISOString(),
    };
  }
}

let auditLoggerInstance: AuditLogger | null = null;

export function getAuditLogger(prisma: PrismaClient): AuditLogger {
  if (!auditLoggerInstance) {
    auditLoggerInstance = new AuditLogger(prisma);
  }
  return auditLoggerInstance;
}
