/**
 * Background retry worker for telemetry ingestion (issue #292).
 *
 * Polls the {@link IngestionRetryQueue} for due jobs and re-attempts
 * persistence with exponential backoff:
 *
 * ```
 * poll
 *   └─ claim up to batchSize due jobs (atomic UPDATE … RETURNING)
 *        └─ for each job:
 *             ├─ persistFn(job)  → success → queue.complete + onCompleted
 *             ├─ permanent error → queue.fail + DLQ
 *             └─ transient error → retries left → queue.requeue (backoff)
 *                                 └─ exhausted     → queue.fail + DLQ
 * ```
 *
 * The worker follows the codebase's scheduler idiom (`setInterval` +
 * `unref()`, overlap suppression via a `running` flag, injected error
 * handler) used by {@link RenewalCron} and the distributed scheduler.
 *
 * ## Performance
 *
 * The poll loop is deliberately light: a single indexed UPDATE…RETURNING per
 * poll plus one Prisma write per job. It never touches the synchronous ingest
 * hot path, so it cannot affect the < 200 ms P99 billing-operation target.
 */

import type { DlqManager } from '../dlq_manager.js';
import { isPermanentIngestionError } from './errors.js';
import { IngestionRetryQueue, type IngestionRetryJob } from './retry_queue.js';
import {
  incrementIngestionRetryAttempts,
  incrementIngestionRetryCompleted,
  incrementIngestionRetryDlq,
  incrementIngestionRetryRequeued,
  setIngestionRetryQueueDepth,
} from '../../api/metrics/prometheus.js';

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * Re-persist a claimed job's telemetry. Implementations MUST re-verify the
 * queued request before writing (digest + Ed25519 signature) and throw a
 * {@link PermanentIngestionError} subclass for non-retryable failures.
 *
 * @returns the number of telemetry records written.
 */
export type IngestionPersistFn = (job: IngestionRetryJob) => Promise<number>;

/** Invoked after a job's telemetry has been durably persisted. */
export type IngestionJobCompletedHook = (
  job: IngestionRetryJob,
  recordsWritten: number,
) => void | Promise<void>;

export interface IngestionRetryWorkerOptions {
  /** How often (ms) to poll for due jobs. Default 5000. */
  pollIntervalMs?: number;
  /** Maximum jobs claimed per poll. Default 20. */
  batchSize?: number;
  /** Retry budget: retries after the initial attempt. Defaults to queue value. */
  maxRetries?: number;
  /** Optional DLQ sink for jobs that exhaust the retry budget. */
  dlq?: DlqManager;
  /** Called after a job is durably persisted (e.g. stream publish). */
  onCompleted?: IngestionJobCompletedHook;
  /** Called when a job-level error occurs. Default: console.error. */
  onError?: (err: unknown, jobId?: string) => void;
}

// ── Worker ─────────────────────────────────────────────────────────────────────

export class IngestionRetryWorker {
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private readonly dlq?: DlqManager;
  private readonly onCompleted?: IngestionJobCompletedHook;
  private readonly onError: (err: unknown, jobId?: string) => void;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly queue: IngestionRetryQueue,
    private readonly persistFn: IngestionPersistFn,
    options: IngestionRetryWorkerOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.batchSize = options.batchSize ?? 20;
    this.maxRetries = options.maxRetries ?? queue.getMaxRetries();
    this.dlq = options.dlq;
    this.onCompleted = options.onCompleted;
    this.onError =
      options.onError ??
      ((err, jobId): void => {
        console.error(`[ingestion-retry] job ${jobId ?? '?'} error:`, err);
      });
  }

  /**
   * Start the poll loop. Idempotent; the interval is `unref()`ed so it never
   * keeps the process alive on its own. An immediate poll runs on start so
   * queued work is not delayed by one full interval.
   */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.pollOnce().catch((err: unknown) => {
        this.onError(err);
      });
    }, this.pollIntervalMs);
    this.timer.unref();

    // Kick an immediate poll (fire-and-forget; errors go to onError).
    this.pollOnce().catch((err: unknown) => {
      this.onError(err);
    });
  }

  /** Stop the poll loop. Safe to call multiple times. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run a single poll: claim due jobs and process them. Exposed publicly so
   * tests can drive the worker deterministically.
   *
   * @returns the number of jobs processed this poll.
   */
  async pollOnce(now: Date = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const jobs = await this.queue.claimDue(this.batchSize, now);
      await this.updateQueueDepthGauge();
      for (const job of jobs) {
        await this.processJob(job);
      }
      return jobs.length;
    } finally {
      this.running = false;
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async processJob(job: IngestionRetryJob): Promise<void> {
    incrementIngestionRetryAttempts();

    try {
      const recordsWritten = await this.persistFn(job);
      await this.queue.complete(job.id);
      incrementIngestionRetryCompleted();
      try {
        await this.onCompleted?.(job, recordsWritten);
      } catch (err) {
        // Stream/notification failures must never fail the persistence outcome.
        this.onError(err, job.id);
      }
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (isPermanentIngestionError(err)) {
        await this.deadLetter(job, message);
        return;
      }

      // Transient failure: requeue with backoff while retries remain.
      if (job.retryCount < this.maxRetries) {
        await this.queue.requeue(job.id, message);
        incrementIngestionRetryRequeued();
        return;
      }

      // Retry budget exhausted — dead-letter for operator review.
      await this.deadLetter(job, message);
    }
  }

  /** Mark a job failed and push it to the DLQ (best-effort). */
  private async deadLetter(job: IngestionRetryJob, message: string): Promise<void> {
    try {
      await this.queue.fail(job.id, message);
      incrementIngestionRetryDlq();
      if (this.dlq !== undefined) {
        try {
          await this.dlq.push(
            'telemetry_ingestion',
            { jobId: job.id, deviceId: job.deviceId, request: job.stateData },
            message,
          );
        } catch (dlqErr) {
          this.onError(dlqErr, job.id);
        }
      }
    } catch (err) {
      // If even marking the job failed fails (DB down), surface to onError.
      this.onError(err, job.id);
      throw err;
    }
  }

  /** Keep the Prometheus queue-depth gauge fresh after every poll. */
  private async updateQueueDepthGauge(): Promise<void> {
    try {
      const stats = await this.queue.getStats();
      setIngestionRetryQueueDepth(stats.pending, stats.processing);
    } catch {
      // Gauge refresh must never break the poll loop.
    }
  }
}
