/**
 * Refund record persistence layer.
 *
 * Provides an abstract {@link RefundStore} interface with two implementations:
 * 1. {@link InMemoryRefundStore} — synchronous, for tests and single-instance.
 * 2. {@link PgRefundStore} — Prisma-backed, for production multi-tenant use.
 *
 * All mutations use optimistic locking via `lockVersion` to prevent
 * concurrent state corruption (same pattern as the billing cycle repository).
 */

import type { PrismaClient } from '@prisma/client';
import { RefundState } from './state_machine.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface RefundRecord {
  id: string;
  billingRecordId: string;
  accountId: string;
  amount: bigint;
  state: RefundState;
  lockVersion: number;
  txHash: string | null;
  retryCount: number;
  reason: string | null;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateRefundInput {
  billingRecordId: string;
  accountId: string;
  amount: bigint;
  reason?: string;
  idempotencyKey: string;
}

export interface RefundStore {
  findById(id: string): Promise<RefundRecord | null>;
  findByIdempotencyKey(key: string): Promise<RefundRecord | null>;
  create(input: CreateRefundInput): Promise<RefundRecord>;
  applyTransition(
    id: string,
    from: RefundState,
    to: RefundState,
    expectedLockVersion: number,
  ): Promise<boolean>;
  updateTxHash(id: string, txHash: string): Promise<void>;
  incrementRetryCount(id: string): Promise<void>;
  findPendingVerification(maxAge?: number): Promise<RefundRecord[]>;
  findByAccountId(accountId: string): Promise<RefundRecord[]>;
  findByBillingRecordId(billingRecordId: string): Promise<RefundRecord[]>;
}

// ── In-Memory Store ────────────────────────────────────────────────────────────

/**
 * Synchronous in-memory store for tests and single-instance deployments.
 * State transitions use CAS semantics on a Map (event-loop atomic).
 */
export class InMemoryRefundStore implements RefundStore {
  private readonly records = new Map<string, RefundRecord>();

  // eslint-disable-next-line @typescript-eslint/require-await -- implements async RefundStore interface
  async findById(id: string): Promise<RefundRecord | null> {
    return this.records.get(id) ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- implements async RefundStore interface
  async findByIdempotencyKey(key: string): Promise<RefundRecord | null> {
    for (const record of this.records.values()) {
      if (record.idempotencyKey === key) return record;
    }
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- implements async RefundStore interface
  async create(input: CreateRefundInput): Promise<RefundRecord> {
    const id = `refund_${String(Date.now())}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date();
    const record: RefundRecord = {
      id,
      billingRecordId: input.billingRecordId,
      accountId: input.accountId,
      amount: input.amount,
      state: RefundState.REQUESTED,
      lockVersion: 1,
      txHash: null,
      retryCount: 0,
      reason: input.reason ?? null,
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(id, record);
    return record;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- implements async RefundStore interface
  async applyTransition(
    id: string,
    from: RefundState,
    to: RefundState,
    expectedLockVersion: number,
  ): Promise<boolean> {
    const record = this.records.get(id);
    if (record === undefined) return false;
    if (record.state !== from) return false;
    if (record.lockVersion !== expectedLockVersion) return false;

    record.state = to;
    record.lockVersion++;
    record.updatedAt = new Date();
    return true;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- implements async RefundStore interface
  async updateTxHash(id: string, txHash: string): Promise<void> {
    const record = this.records.get(id);
    if (record !== undefined) {
      record.txHash = txHash;
      record.updatedAt = new Date();
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- implements async RefundStore interface
  async incrementRetryCount(id: string): Promise<void> {
    const record = this.records.get(id);
    if (record !== undefined) {
      record.retryCount++;
      record.updatedAt = new Date();
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- implements async RefundStore interface
  async findPendingVerification(maxAge?: number): Promise<RefundRecord[]> {
    const cutoff = maxAge !== undefined ? Date.now() - maxAge : 0;
    return [...this.records.values()].filter(
      (r) =>
        r.state === RefundState.ON_CHAIN_SUBMITTED &&
        r.createdAt.getTime() >= cutoff,
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- implements async RefundStore interface
  async findByAccountId(accountId: string): Promise<RefundRecord[]> {
    return [...this.records.values()].filter((r) => r.accountId === accountId);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- implements async RefundStore interface
  async findByBillingRecordId(billingRecordId: string): Promise<RefundRecord[]> {
    return [...this.records.values()].filter(
      (r) => r.billingRecordId === billingRecordId,
    );
  }
}

// ── Prisma Store ───────────────────────────────────────────────────────────────

/**
 * Prisma-backed store for production multi-tenant deployments.
 * Uses raw SQL for the CAS transition to match the billing cycle repository
 * pattern (`WHERE state = $3 AND lock_version = $4`).
 */
export class PgRefundStore implements RefundStore {
  constructor(private readonly prisma: PrismaClient) {}

  async findById(id: string): Promise<RefundRecord | null> {
    const row = await this.prisma.refundRecord.findUnique({ where: { id } });
    return row === null ? null : mapRow(row);
  }

  async findByIdempotencyKey(key: string): Promise<RefundRecord | null> {
    const row = await this.prisma.refundRecord.findUnique({
      where: { idempotencyKey: key },
    });
    return row === null ? null : mapRow(row);
  }

  async create(input: CreateRefundInput): Promise<RefundRecord> {
    const row = await this.prisma.refundRecord.create({
      data: {
        billingRecordId: input.billingRecordId,
        accountId: input.accountId,
        amount: input.amount,
        state: RefundState.REQUESTED,
        reason: input.reason ?? null,
        idempotencyKey: input.idempotencyKey,
      },
    });
    return mapRow(row);
  }

  async applyTransition(
    id: string,
    from: RefundState,
    to: RefundState,
    expectedLockVersion: number,
  ): Promise<boolean> {
    const result = await this.prisma.$executeRaw`
      UPDATE refund_records
      SET state = ${to}, lock_version = lock_version + 1, updated_at = now()
      WHERE id = ${id}
        AND state = ${from}
        AND lock_version = ${expectedLockVersion}
    `;
    return result === 1;
  }

  async updateTxHash(id: string, txHash: string): Promise<void> {
    await this.prisma.refundRecord.update({
      where: { id },
      data: { txHash },
    });
  }

  async incrementRetryCount(id: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE refund_records
      SET retry_count = retry_count + 1, updated_at = now()
      WHERE id = ${id}
    `;
  }

  async findPendingVerification(maxAge?: number): Promise<RefundRecord[]> {
    const where: Record<string, unknown> = {
      state: RefundState.ON_CHAIN_SUBMITTED,
    };
    if (maxAge !== undefined) {
      where['createdAt'] = { gte: new Date(Date.now() - maxAge) };
    }
    const rows = await this.prisma.refundRecord.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    return rows.map(mapRow);
  }

  async findByAccountId(accountId: string): Promise<RefundRecord[]> {
    const rows = await this.prisma.refundRecord.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(mapRow);
  }

  async findByBillingRecordId(billingRecordId: string): Promise<RefundRecord[]> {
    const rows = await this.prisma.refundRecord.findMany({
      where: { billingRecordId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(mapRow);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function mapRow(row: {
  id: string;
  billingRecordId: string;
  accountId: string;
  amount: bigint;
  state: string;
  lockVersion: number;
  txHash: string | null;
  retryCount: number;
  reason: string | null;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
}): RefundRecord {
  return {
    id: row.id,
    billingRecordId: row.billingRecordId,
    accountId: row.accountId,
    amount: row.amount,
    state: row.state as RefundState,
    lockVersion: row.lockVersion,
    txHash: row.txHash,
    retryCount: row.retryCount,
    reason: row.reason,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
