/**
 * Distributed Job Scheduler with Lease-based Worker Claiming (issue #73).
 *
 * A Redis-backed distributed job scheduler that coordinates workers across
 * multiple pods/processes. Each worker claims a job by acquiring a
 * short-lived lease key in Redis. While processing the worker periodically
 * renews the lease; if the worker dies the lease expires and another worker
 * can claim the abandoned job.
 *
 * ## Design
 *
 * - **Job State** lives in PostgreSQL (a `jobs` table) for durability.
 * - **Lease** lives in Redis for speed and automatic TTL-based expiry.
 * - **Claiming** uses `SET job:lease:<jobId> <workerId> NX PX <leaseMs>`
 *   which is atomic and guaranteed single-winner.
 * - **Heartbeat** runs on a `setInterval` that `PEXPIRE`s the lease key every
 *   `leaseMs / 2` while the job is being processed.
 * - **Recovery** makes abandoned jobs visible again when their Redis lease key
 *   has expired and the DB still shows status = ACTIVE. A separate
 *   `recoverAbandonedJobs()` poller resets them to PENDING.
 *
 * ## Integration
 *
 * This module follows the same scheduler idiom as {@link BillingCycleScheduler}
 * and {@link RenewalCron}: `setInterval` + `unref()`, overlap suppression via a
 * `running` flag, injected error handler.
 */

import type { Redis } from 'ioredis';
import type pg from 'pg';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LEASE_KEY_PREFIX = 'job:lease:';
const DEFAULT_LEASE_MS = 30_000; // 30 s
const DEFAULT_POLL_INTERVAL_MS = 5_000; // 5 s
const DEFAULT_MAX_RETRIES = 3;
const JOBS_TABLE = 'scheduler_jobs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JobStatus = 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'DLQ';

export interface Job<T = unknown> {
  id: string;
  type: string;
  payload: T;
  priority: number;
  status: JobStatus;
  retries: number;
  maxRetries: number;
  workerId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type JobHandler = (job: Job) => Promise<void>;

export interface DistributedSchedulerOptions {
  /** How long a lease lasts before expiry (ms). Default 30 000. */
  leaseMs?: number;
  /** How often to poll for new jobs (ms). Default 5 000. */
  pollIntervalMs?: number;
  /** Max concurrent jobs this worker can process at once. Default 1. */
  concurrency?: number;
  /** Called when a job-level error occurs. Default: console.error. */
  onError?: (err: unknown, jobId?: string) => void;
  /** Called when lease renewal fails (worker likely dead). Default: console.warn. */
  onLeaseExpired?: (jobId: string) => void;
}

export interface EnqueueOptions {
  /** Retry budget for this job. Default 3. */
  maxRetries?: number;
  /** Lower = higher priority. Default 0. */
  priority?: number;
}

export interface SchedulerStats {
  pending: number;
  active: number;
  completed: number;
  failed: number;
  dlq: number;
}

// ---------------------------------------------------------------------------
// WorkId generator
// ---------------------------------------------------------------------------

function generateWorkerId(): string {
  return `${process.env['HOST'] ?? 'worker'}-${process.pid.toString()}-${randomBytes(4).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Ensure jobs table
// ---------------------------------------------------------------------------

const CREATE_JOBS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ${JOBS_TABLE} (
    id          TEXT        NOT NULL PRIMARY KEY,
    type        TEXT        NOT NULL,
    payload     JSONB       NOT NULL DEFAULT '{}',
    priority    INTEGER     NOT NULL DEFAULT 0,
    status      TEXT        NOT NULL DEFAULT 'PENDING',
    retries     INTEGER     NOT NULL DEFAULT 0,
    max_retries INTEGER     NOT NULL DEFAULT 3,
    worker_id   TEXT,
    error       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS idx_scheduler_jobs_status_priority
    ON ${JOBS_TABLE} (status, priority, created_at);
`;

// ---------------------------------------------------------------------------
// DistributedScheduler
// ---------------------------------------------------------------------------

export class DistributedScheduler {
  private readonly redis: Redis;
  private readonly pool: pg.Pool;
  private readonly leaseMs: number;
  private readonly pollIntervalMs: number;
  private readonly concurrency: number;
  private readonly onError: (err: unknown, jobId?: string) => void;
  private readonly onLeaseExpired: (jobId: string) => void;

  private readonly workerId: string;
  private readonly handlers = new Map<string, JobHandler>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private activeJobs = 0;
  private heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    redis: Redis,
    pool: pg.Pool,
    options: DistributedSchedulerOptions = {},
  ) {
    this.redis = redis;
    this.pool = pool;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.concurrency = options.concurrency ?? 1;
    this.onError =
      options.onError ??
      ((err, jobId): void => {
        console.error(`[distributed-scheduler] job ${jobId ?? '?'} error:`, err);
      });
    this.onLeaseExpired =
      options.onLeaseExpired ??
      ((jobId): void => {
        console.warn(`[distributed-scheduler] lease expired for job ${jobId}`);
      });
    this.workerId = generateWorkerId();
  }

  /** Register a handler for a job type. Only one handler per type allowed. */
  registerHandler(jobType: string, handler: JobHandler): void {
    this.handlers.set(jobType, handler);
  }

  /** Unregister a handler. */
  unregisterHandler(jobType: string): void {
    this.handlers.delete(jobType);
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    await this.ensureJobsTable();
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.poll().catch(() => { /* intentionally fire-and-forget */ });
    }, this.pollIntervalMs);
    this.timer.unref();

    // Recovery poller runs at double the lease interval.
    this.recoveryTimer = setInterval(
      () => {
        this.recoverAbandonedJobs().catch(() => { /* intentionally fire-and-forget */ });
      },
      this.leaseMs * 2,
    );
    this.recoveryTimer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.recoveryTimer !== null) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    for (const timer of this.heartbeatTimers.values()) {
      clearInterval(timer);
    }
    this.heartbeatTimers.clear();
  }

  // -----------------------------------------------------------------------
  // Public: enqueue
  // -----------------------------------------------------------------------

  /**
   * Enqueue a new job. Returns the created job's id.
   */
  async enqueue(
    type: string,
    payload: unknown,
    options: EnqueueOptions = {},
  ): Promise<string> {
    const id = randomBytes(16).toString('hex');
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const priority = options.priority ?? 0;

    await this.ensureJobsTable();
    await this.pool.query(
      `INSERT INTO ${JOBS_TABLE} (id, type, payload, priority, max_retries)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, type, JSON.stringify(payload), priority, maxRetries],
    );
    return id;
  }

  // -----------------------------------------------------------------------
  // Public: stats
  // -----------------------------------------------------------------------

  async getStats(): Promise<SchedulerStats> {
    const res = await this.pool.query<{
      status: JobStatus;
      count: number;
    }>(
      `SELECT status, COUNT(*)::int AS count FROM ${JOBS_TABLE} GROUP BY status`,
    );

    const counts: Partial<Record<JobStatus, number>> = {};
    for (const row of res.rows) {
      counts[row.status] = row.count;
    }
    return {
      pending: counts.PENDING ?? 0,
      active: counts.ACTIVE ?? 0,
      completed: counts.COMPLETED ?? 0,
      failed: counts.FAILED ?? 0,
      dlq: counts.DLQ ?? 0,
    };
  }

  // -----------------------------------------------------------------------
  // Public: recover abandoned jobs (also called automatically)
  // -----------------------------------------------------------------------

  async recoverAbandonedJobs(): Promise<number> {
    const res = await this.pool.query<{ id: string }>(
      `SELECT id FROM ${JOBS_TABLE} WHERE status = 'ACTIVE'`,
    );
    let recovered = 0;
    for (const row of res.rows) {
      const leaseKey = `${LEASE_KEY_PREFIX}${row.id}`;
      const exists = await this.redis.exists(leaseKey);
      if (exists === 0) {
        await this.pool.query(
          `UPDATE ${JOBS_TABLE} SET status = 'PENDING', worker_id = NULL, updated_at = now() WHERE id = $1`,
          [row.id],
        );
        recovered++;
      }
    }
    return recovered;
  }

  // -----------------------------------------------------------------------
  // Private: polling loop
  // -----------------------------------------------------------------------

  private async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.activeJobs < this.concurrency) {
        const job = await this.claimNextJob();
        if (job === null) break;
        this.activeJobs++;
        // Fire-and-forget but chain error handling.
        this.executeJob(job).finally(() => {
          this.activeJobs = Math.max(0, this.activeJobs - 1);
        }).catch(() => { /* fire-and-forget with error handled in executeJob */ });
      }
    } catch (err) {
      this.onError(err);
    } finally {
      this.running = false;
    }
  }

  // -----------------------------------------------------------------------
  // Private: claim
  // -----------------------------------------------------------------------

  /**
   * Atomically claim the next available job. Steps:
   * 1. SELECT the next PENDING job (by priority, created_at).
   * 2. Attempt Redis `SET … NX PX` for the lease.
   * 3. On success, UPDATE the DB row to ACTIVE + workerId and return it.
   * 4. On failure, loop to the next candidate.
   */
  private async claimNextJob(): Promise<Job | null> {
    const candidates = await this.pool.query<Job>(
      `SELECT * FROM ${JOBS_TABLE}
       WHERE status IN ('PENDING', 'FAILED')
       ORDER BY priority ASC, created_at ASC
       LIMIT 5`,
    );

    for (const row of candidates.rows) {
      const leaseKey = `${LEASE_KEY_PREFIX}${row.id}`;
      const acquired = await this.redis.set(
        leaseKey,
        this.workerId,
        'PX',
        this.leaseMs,
        'NX',
      );
      if (acquired !== 'OK') continue;

      // We won the lease — flip DB state.
      const updateRes = await this.pool.query<Job>(
        `UPDATE ${JOBS_TABLE}
         SET status = 'ACTIVE', worker_id = $1, updated_at = now()
         WHERE id = $2 AND status IN ('PENDING', 'FAILED')
         RETURNING *`,
        [this.workerId, row.id],
      );

      if (updateRes.rows.length > 0 && updateRes.rows[0] !== undefined) {
        return updateRes.rows[0];
      }

      // DB update lost a race — release the Redis lease.
      await this.redis.del(leaseKey);
    }

    return null;
  }

  // -----------------------------------------------------------------------
  // Private: execute
  // -----------------------------------------------------------------------

  private async executeJob(job: Job): Promise<void> {
    const leaseKey = `${LEASE_KEY_PREFIX}${job.id}`;
    this.startHeartbeat(leaseKey, job.id);

    try {
      const handler = this.handlers.get(job.type);
      if (!handler) {
        throw new Error(`No handler registered for job type "${job.type}"`);
      }

      await handler(job);

      // Success.
      await this.pool.query(
        `UPDATE ${JOBS_TABLE} SET status = 'COMPLETED', updated_at = now() WHERE id = $1`,
        [job.id],
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const newRetries = (job.retries) + 1;

      if (newRetries <= job.maxRetries) {
        // Retryable.
        await this.pool.query(
          `UPDATE ${JOBS_TABLE}
           SET status = 'PENDING', retries = $1, worker_id = NULL,
               error = $2, updated_at = now()
           WHERE id = $3`,
          [newRetries, msg, job.id],
        );
      } else {
        // Dead-letter queue.
        await this.pool.query(
          `UPDATE ${JOBS_TABLE}
           SET status = 'DLQ', retries = $1, error = $2, updated_at = now()
           WHERE id = $3`,
          [newRetries, msg, job.id],
        );
      }
      this.onError(err, job.id);
    } finally {
      this.stopHeartbeat(leaseKey);
      await this.redis.del(leaseKey);
    }
  }

  // -----------------------------------------------------------------------
  // Private: heartbeat
  // -----------------------------------------------------------------------

  private startHeartbeat(leaseKey: string, jobId: string): void {
    const intervalMs = Math.floor(this.leaseMs / 2);
    const timer = setInterval(() => {
      this.redis
        .pexpire(leaseKey, this.leaseMs)
        .then((renewed) => {
          if (renewed === 0) {
            this.onLeaseExpired(jobId);
          }
        })
        .catch((err: unknown) => {
          this.onError(err, jobId);
        });
    }, intervalMs);
    this.heartbeatTimers.set(leaseKey, timer);
  }

  private stopHeartbeat(leaseKey: string): void {
    const timer = this.heartbeatTimers.get(leaseKey);
    if (timer !== undefined) {
      clearInterval(timer);
      this.heartbeatTimers.delete(leaseKey);
    }
  }

  // -----------------------------------------------------------------------
  // Private: db setup
  // -----------------------------------------------------------------------

  private async ensureJobsTable(): Promise<void> {
    await this.pool.query(CREATE_JOBS_TABLE_SQL);
  }
}
