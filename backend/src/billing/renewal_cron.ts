/**
 * Subscription auto-renewal cron (issue #36).
 *
 * Polls for subscriptions that are due for renewal — i.e. those whose
 * `expiresAt` falls within the lookahead window — and calls
 * {@link renewSubscription} for each one.
 *
 * ## Design decisions
 *
 * - Follows the same scheduler idiom as {@link BillingCycleScheduler} and
 *   {@link SettlementCron}: `setInterval` + `unref()`, overlapping ticks
 *   suppressed by the `running` flag.
 * - The renewal function itself is idempotent and race-safe (optimistic CAS),
 *   so running multiple cron instances is safe.
 * - Prometheus counters are incremented here so the caller does not need to
 *   inspect individual results.
 *
 * ## Configuration
 *
 * | Option              | Default  | Description                                    |
 * |---------------------|----------|------------------------------------------------|
 * | `intervalMs`        | 60 000   | How often to scan for due subscriptions        |
 * | `renewalLookaheadMs`| 86 400 000 | Renew subscriptions expiring within 24 h     |
 * | `batchSize`         | 50       | Maximum subscriptions to process per tick      |
 * | `processPayment`    | no-op    | Payment processor callback                     |
 * | `onError`           | console  | Called when an unexpected error is thrown      |
 */

import {
  renewSubscription,
  type SubscriptionStore,
  type RenewalResult,
  type RenewalOptions,
} from './subscription_renewal.js';
import {
  incrementSubscriptionRenewalsSucceeded,
  incrementSubscriptionRenewalsFailed,
  setSubscriptionRenewalQueueDepth,
  setSubscriptionRenewalRunning,
} from '../api/metrics/prometheus.js';

export const DEFAULT_RENEWAL_INTERVAL_MS = 60_000; // 1 minute
export const DEFAULT_RENEWAL_LOOKAHEAD_MS = 24 * 60 * 60 * 1000; // 24 hours
export const DEFAULT_RENEWAL_BATCH_SIZE = 50;

export interface RenewalCronOptions {
  /** How often to scan for due subscriptions (ms). Default: 60 000 */
  intervalMs?: number;
  /** Renew subscriptions expiring within this window (ms). Default: 86 400 000 */
  renewalLookaheadMs?: number;
  /** Maximum subscriptions to process per tick. Default: 50 */
  batchSize?: number;
  /** Payment processor — must throw on failure. Default: no-op */
  processPayment?: RenewalOptions['processPayment'];
  /** Called when a tick-level error occurs. Default: console.error */
  onError?: (err: unknown) => void;
}

export class RenewalCron {
  private readonly intervalMs: number;
  private readonly renewalLookaheadMs: number;
  private readonly batchSize: number;
  private readonly processPayment: RenewalOptions['processPayment'];
  private readonly onError: (err: unknown) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private renewedCount = 0;
  private failedCount = 0;

  constructor(
    private readonly store: SubscriptionStore,
    options: RenewalCronOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_RENEWAL_INTERVAL_MS;
    this.renewalLookaheadMs = options.renewalLookaheadMs ?? DEFAULT_RENEWAL_LOOKAHEAD_MS;
    this.batchSize = options.batchSize ?? DEFAULT_RENEWAL_BATCH_SIZE;
    this.processPayment = options.processPayment;
    this.onError =
      options.onError ??
      ((err): void => {
        console.error('[renewal-cron] tick failed:', err);
      });
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Total successful renewals since this instance started. */
  getRenewedCount(): number {
    return this.renewedCount;
  }

  /** Total failed renewal attempts since this instance started. */
  getFailedCount(): number {
    return this.failedCount;
  }

  /**
   * Run one renewal tick.  Returns `true` if it ran, `false` if a previous
   * tick was still in flight (overlap suppression).
   */
  async tick(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    setSubscriptionRenewalRunning(true);
    try {
      const horizon = new Date(Date.now() + this.renewalLookaheadMs);
      const due = await this.store.findDueForRenewal(horizon);

      // Respect batch cap.
      const batch = due.slice(0, this.batchSize);
      setSubscriptionRenewalQueueDepth(batch.length);

      for (const sub of batch) {
        try {
          const result = await this.processOne(sub.id);
          this.applyResult(result);
        } catch (err) {
          this.onError(err);
        }
      }
    } catch (err) {
      this.onError(err);
    } finally {
      this.running = false;
      setSubscriptionRenewalRunning(false);
    }
    return true;
  }

  /**
   * Manually renew a specific subscription.  Exposed for admin / test use.
   */
  async renewOne(subscriptionId: string): Promise<RenewalResult> {
    const result = await this.processOne(subscriptionId);
    this.applyResult(result);
    return result;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private async processOne(subscriptionId: string): Promise<RenewalResult> {
    return renewSubscription(this.store, subscriptionId, {
      processPayment: this.processPayment,
    });
  }

  private applyResult(result: RenewalResult): void {
    if (result.renewed) {
      this.renewedCount++;
      incrementSubscriptionRenewalsSucceeded();
    } else if (result.outcome === 'payment_failed') {
      this.failedCount++;
      incrementSubscriptionRenewalsFailed();
    }
    // 'not_found', 'not_eligible', 'lost_race' are silent no-ops —
    // they are expected in normal concurrent operation.
  }
}
