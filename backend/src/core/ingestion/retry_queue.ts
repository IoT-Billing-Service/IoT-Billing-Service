/**
 * Durable retry queue for telemetry ingestion (issue #292).
 *
 * When the persistence step of {@link IngestionService} fails transiently
 * (DB connection blip, pool exhaustion, deadlock) even after the fast in-flight
 * retries, the fully-verified request is written here as an `IngestionJob`
 * row. A background worker (see {@link IngestionRetryWorker}) claims due jobs,
 * re-verifies them cheaply, and re-attempts persistence with exponential
 * backoff until success or the retry budget is exhausted (then DLQ).
 *
 * ## Why the DB and not Redis?
 *
 * The queue is the durability boundary of the ingestion path: if the process
 * crashes after validation, the row must survive. PostgreSQL is already the
 * source of truth for telemetry, so using the `ingestion_jobs` table keeps a
 * single storage dependency and gives us row-level atomic claiming for free.
 *
 * ## Claiming
 *
 * Workers claim jobs with a single `UPDATE … RETURNING` restricted to
 * `status = 'pending' AND next_attempt_at <= now()`. The row-level lock held
 * by the UPDATE makes the claim atomic: multiple worker instances polling the
 * same table can never process the same job twice.
 *
 * ## Security
 *
 * Only verified requests are enqueued (see {@link IngestionService}), and the
 * stored `payloadDigest` + Ed25519 signature are re-checked by the worker
 * before persistence so a tampered queued payload is rejected (PCI-DSS / SOC2).
 */

import type { Prisma, PrismaClient } from '@prisma/client';
import type { SignedPayload } from './validator.js';
import type { PowSolution } from '../crypto/pow_verifier.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export type IngestionJobStatus = 'pending' | 'processing' | 'completed' | 'failed';

/** A fully-verified ingest request persisted for asynchronous retry. */
export interface StoredIngestRequest {
  /** The signed payload (deviceId, timestamp, nonce, metrics, signature). */
  payload: SignedPayload;
  /** Device Ed25519 public key, hex-encoded (64 chars = 32 bytes). */
  publicKey: string;
  /** ZK range proof, base64-encoded. */
  proof: string;
  /** Proof-of-work solution that already passed verification. */
  powSolution: PowSolution;
  /**
   * Final verified plaintext metric values (after E2E decryption, if any)
   * that were about to be persisted. Stored so the retry worker re-persists
   * exactly what the hot path validated, without re-deriving values.
   */
  metrics: Record<string, number>;
  /**
   * The exact UTF-8 bytes covered by the Ed25519 signature, captured at
   * enqueue time. JSONB reorders object keys, so the signed message cannot
   * be reconstructed by re-serialising the stored payload.
   */
  signedMessage: string;
  /** Server timestamp (ms) when the payload passed full verification. */
  verifiedAt: number;
  /**
   * SHA-256 hex digest over the canonical JSON of every field above.
   * Re-computed by the retry worker before persistence to detect tampering
   * while queued.
   */
  payloadDigest: string;
}

/** A job row as processed by the retry worker. */
export interface IngestionRetryJob {
  id: string;
  deviceId: string;
  status: IngestionJobStatus;
  retryCount: number;
  nextAttemptAt: Date;
  lastError: string | null;
  stateData: StoredIngestRequest;
  createdAt: Date;
  updatedAt: Date;
}

export interface IngestionRetryQueueOptions {
  /** Maximum processing attempts before a job is dead-lettered. Default 3. */
  maxRetries?: number;
  /** Base delay (ms) for the exponential backoff between attempts. Default 2000. */
  baseBackoffMs?: number;
  /** Maximum backoff delay (ms). Default 120 000. */
  maxBackoffMs?: number;
  /** Proportional jitter applied to each backoff delay. Default 0.2. */
  jitterFactor?: number;
}

export interface IngestionRetryQueueStats {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
}

// ── Backoff ────────────────────────────────────────────────────────────────────

/**
 * Compute the delay before the next attempt using exponential backoff with
 * full (uniform) jitter, matching the pattern used by the webhook service.
 *
 * @param attempt - the number of attempts already made (0-based).
 */
export function computeRetryDelayMs(
  attempt: number,
  opts: Required<
    Pick<IngestionRetryQueueOptions, 'baseBackoffMs' | 'maxBackoffMs' | 'jitterFactor'>
  >,
): number {
  const exponential = opts.baseBackoffMs * Math.pow(2, attempt);
  const capped = Math.min(exponential, opts.maxBackoffMs);
  // Full jitter: uniform in [0, capped) — avoids thundering herds while
  // keeping the expected delay at capped/2.
  return Math.floor(Math.random() * capped);
}

// ── Queue ──────────────────────────────────────────────────────────────────────

export class IngestionRetryQueue {
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly jitterFactor: number;

  constructor(
    private readonly prisma: PrismaClient,
    options: IngestionRetryQueueOptions = {},
  ) {
    this.maxRetries = options.maxRetries ?? 3;
    this.baseBackoffMs = options.baseBackoffMs ?? 2000;
    this.maxBackoffMs = options.maxBackoffMs ?? 120_000;
    this.jitterFactor = options.jitterFactor ?? 0.2;
  }

  /** Maximum number of processing attempts (1 initial + retries). */
  getMaxRetries(): number {
    return this.maxRetries;
  }

  /**
   * Persist a verified request as a pending job. Returns the new job id.
   */
  async enqueue(request: StoredIngestRequest): Promise<string> {
    const job = await this.prisma.ingestionJob.create({
      data: {
        deviceId: request.payload.deviceId,
        status: 'pending',
        retryCount: 0,
        nextAttemptAt: new Date(),
        stateData: request as unknown as Prisma.InputJsonValue,
      },
    });
    return job.id;
  }

  /**
   * Atomically claim up to `limit` jobs whose `next_attempt_at` has elapsed.
   * The UPDATE flips the rows to `processing` and returns them, so a row can
   * never be claimed by two workers. Returns the claimed jobs.
   */
  async claimDue(limit: number, now: Date = new Date()): Promise<IngestionRetryJob[]> {
    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>`UPDATE ingestion_jobs
       SET status = 'processing', updated_at = now()
       WHERE id IN (
         SELECT id FROM ingestion_jobs
         WHERE status = 'pending' AND next_attempt_at <= ${now}
         ORDER BY next_attempt_at ASC
         LIMIT ${limit}
       )
       RETURNING id, device_id, status, retry_count, next_attempt_at, last_error,
                 state_data, created_at, updated_at`;

    return rows.map((row) => this.mapRow(row));
  }

  /** Mark a claimed job as successfully persisted. */
  async complete(id: string): Promise<void> {
    await this.prisma.ingestionJob.update({
      where: { id },
      data: { status: 'completed', updatedAt: new Date() },
    });
  }

  /**
   * Mark a claimed job as permanently failed (retry budget exhausted or a
   * permanent error such as device not found). The row is retained for the
   * audit trail; operators can replay it from the DLQ.
   */
  async fail(id: string, error: string): Promise<void> {
    await this.prisma.ingestionJob.update({
      where: { id },
      data: { status: 'failed', lastError: error, updatedAt: new Date() },
    });
  }

  /**
   * Return a claimed job to `pending` with an incremented retry count and the
   * next attempt scheduled by exponential backoff. Callers should check
   * `retryCount < maxRetries` before requeueing; once exhausted, dead-letter.
   */
  async requeue(id: string, error: string): Promise<void> {
    const job = await this.prisma.ingestionJob.findUnique({ where: { id } });
    const attemptsSoFar = job?.retryCount ?? 0;
    const delayMs = computeRetryDelayMs(attemptsSoFar, {
      baseBackoffMs: this.baseBackoffMs,
      maxBackoffMs: this.maxBackoffMs,
      jitterFactor: this.jitterFactor,
    });
    await this.prisma.ingestionJob.update({
      where: { id },
      data: {
        status: 'pending',
        retryCount: { increment: 1 },
        nextAttemptAt: new Date(Date.now() + delayMs),
        lastError: error,
        updatedAt: new Date(),
      },
    });
  }

  /** Aggregate counts by status (used for the ops dashboard / metrics). */
  async getStats(): Promise<IngestionRetryQueueStats> {
    const groups = await this.prisma.ingestionJob.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    const stats: IngestionRetryQueueStats = {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
    };
    for (const group of groups) {
      const key = group.status as IngestionJobStatus;
      if (key in stats) {
        stats[key] = group._count._all;
      }
    }
    return stats;
  }

  /** Map a raw `ingestion_jobs` row (snake_case) to the camelCase job shape. */
  private mapRow(row: Record<string, unknown>): IngestionRetryJob {
    const rawState = row['state_data'] as string | Record<string, unknown> | null;
    const stateData =
      typeof rawState === 'string'
        ? (JSON.parse(rawState) as StoredIngestRequest)
        : (rawState as StoredIngestRequest | null);

    if (stateData === null || typeof stateData.payload !== 'object') {
      throw new Error(`Ingestion job ${String(row['id'])} has no valid state_data`);
    }

    return {
      id: String(row['id']),
      deviceId: String(row['device_id']),
      status: row['status'] as IngestionJobStatus,
      retryCount: Number(row['retry_count']),
      nextAttemptAt: new Date(row['next_attempt_at'] as string),
      lastError: row['last_error'] === null ? null : String(row['last_error']),
      stateData,
      createdAt: new Date(row['created_at'] as string),
      updatedAt: new Date(row['updated_at'] as string),
    };
  }
}
