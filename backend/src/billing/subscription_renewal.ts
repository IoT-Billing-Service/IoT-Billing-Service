/**
 * Subscription auto-renewal service (issue #36).
 *
 * Mirrors the finalizeBillingCycle / BillingCycleStore pattern:
 *   - SubscriptionStore is the single persistence abstraction (InMemory + Pg).
 *   - renewSubscription() is the race-safe, idempotent renewal entry point.
 *   - ACTIVE -> RENEWING is an optimistic CAS (lockVersion guard), so two
 *     concurrent callers cannot both renew the same subscription.
 *
 * Renewal lifecycle:
 *   ACTIVE ──► RENEWING ──► ACTIVE      (success: expiry extended)
 *                       └──► RENEWAL_FAILED  (payment error: retryable)
 *
 * CANCELLED and EXPIRED are terminal.  PENDING_RENEWAL is an optional
 * intermediate state set by the cron before it attempts payment, allowing
 * external systems to observe that renewal is in progress.
 */

export enum SubscriptionRenewalStatus {
  ACTIVE = 'ACTIVE',
  PENDING_RENEWAL = 'PENDING_RENEWAL',
  RENEWING = 'RENEWING',
  RENEWAL_FAILED = 'RENEWAL_FAILED',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED',
}

// ── Persistence abstraction ────────────────────────────────────────────────

export interface SubscriptionRow {
  id: string;
  accountId: string;
  planId: string;
  amountDue: bigint;
  periodDays: number;
  expiresAt: Date;
  autoRenew: boolean;
  renewalStatus: SubscriptionRenewalStatus;
  lockVersion: number;
}

export interface SubscriptionStore {
  /**
   * Fetch a subscription by id.  Returns null when not found.
   */
  getSubscription(id: string): Promise<SubscriptionRow | null>;

  /**
   * Optimistic CAS transition.  Returns true iff THIS call applied the update
   * (status === `from` AND lockVersion === `expectedLockVersion`).
   */
  applyStatusTransition(
    id: string,
    from: SubscriptionRenewalStatus,
    to: SubscriptionRenewalStatus,
    expectedLockVersion: number,
  ): Promise<boolean>;

  /**
   * Record a successful renewal: advance expiresAt by periodDays, set status
   * back to ACTIVE, record renewedAt = now.  Must be atomic with the CAS won
   * in applyStatusTransition.
   */
  recordRenewalSuccess(id: string, newExpiresAt: Date, lockVersion: number): Promise<void>;

  /**
   * Record a failed renewal: set status to RENEWAL_FAILED, persist the error
   * message so the operator can inspect it.
   */
  recordRenewalFailure(id: string, error: string, lockVersion: number): Promise<void>;

  /**
   * Return subscriptions eligible for renewal: autoRenew=true, status ACTIVE
   * or RENEWAL_FAILED, expiresAt <= renewalHorizon (now + lookaheadMs).
   */
  findDueForRenewal(renewalHorizon: Date): Promise<SubscriptionRow[]>;
}

// ── In-memory store (tests / local dev) ───────────────────────────────────

interface InMemorySubscription extends SubscriptionRow {
  lastError?: string;
  renewedAt?: Date;
}

export class InMemorySubscriptionStore implements SubscriptionStore {
  private readonly subs = new Map<string, InMemorySubscription>();

  /** Seed a subscription for unit tests. */
  seed(row: SubscriptionRow): void {
    this.subs.set(row.id, { ...row });
  }

  async getSubscription(id: string): Promise<SubscriptionRow | null> {
    await Promise.resolve();
    const s = this.subs.get(id);
    return s ? { ...s } : null;
  }

  applyStatusTransition(
    id: string,
    from: SubscriptionRenewalStatus,
    to: SubscriptionRenewalStatus,
    expectedLockVersion: number,
  ): Promise<boolean> {
    const s = this.subs.get(id);
    if (s === undefined || s.renewalStatus !== from || s.lockVersion !== expectedLockVersion) {
      return Promise.resolve(false);
    }
    s.renewalStatus = to;
    s.lockVersion += 1;
    return Promise.resolve(true);
  }

  async recordRenewalSuccess(id: string, newExpiresAt: Date, lockVersion: number): Promise<void> {
    await Promise.resolve();
    const s = this.subs.get(id);
    if (s === undefined || s.lockVersion !== lockVersion) return;
    s.expiresAt = newExpiresAt;
    s.renewalStatus = SubscriptionRenewalStatus.ACTIVE;
    s.renewedAt = new Date();
    s.lastError = undefined;
    s.lockVersion += 1;
  }

  async recordRenewalFailure(id: string, error: string, lockVersion: number): Promise<void> {
    await Promise.resolve();
    const s = this.subs.get(id);
    if (s === undefined || s.lockVersion !== lockVersion) return;
    s.renewalStatus = SubscriptionRenewalStatus.RENEWAL_FAILED;
    s.lastError = error;
    s.lockVersion += 1;
  }

  async findDueForRenewal(renewalHorizon: Date): Promise<SubscriptionRow[]> {
    await Promise.resolve();
    const results: SubscriptionRow[] = [];
    for (const s of this.subs.values()) {
      if (
        s.autoRenew &&
        (s.renewalStatus === SubscriptionRenewalStatus.ACTIVE ||
          s.renewalStatus === SubscriptionRenewalStatus.RENEWAL_FAILED) &&
        s.expiresAt <= renewalHorizon
      ) {
        results.push({ ...s });
      }
    }
    return results;
  }
}

// ── Renewal result ─────────────────────────────────────────────────────────

export type RenewalOutcome =
  | 'renewed'
  | 'not_found'
  | 'not_eligible'
  | 'lost_race'
  | 'payment_failed';

export interface RenewalResult {
  subscriptionId: string;
  outcome: RenewalOutcome;
  renewed: boolean;
  newExpiresAt: Date | null;
  error?: string;
}

// ── Core renewal function ──────────────────────────────────────────────────

export interface RenewalOptions {
  /**
   * Payment processor callback.  Receives the subscription and must resolve
   * on success.  On payment failure it should throw an Error with a human-
   * readable message.  The default is a no-op (useful for tests).
   */
  processPayment?: (sub: SubscriptionRow) => Promise<void>;
}

/**
 * Attempt to renew a single subscription.  Race-safe and idempotent:
 *
 *   1. Fetch and validate eligibility.
 *   2. Win the ACTIVE -> RENEWING optimistic CAS (only one caller wins).
 *   3. Invoke the payment processor exactly once.
 *   4a. On success: advance expiresAt, reset status to ACTIVE.
 *   4b. On failure: set RENEWAL_FAILED, persist error message for retry.
 */
export async function renewSubscription(
  store: SubscriptionStore,
  subscriptionId: string,
  options: RenewalOptions = {},
): Promise<RenewalResult> {
  const sub = await store.getSubscription(subscriptionId);
  if (sub === null) {
    return makeResult(subscriptionId, 'not_found', null);
  }

  // Only ACTIVE and RENEWAL_FAILED subscriptions with autoRenew=true are
  // eligible.  PENDING_RENEWAL, RENEWING, CANCELLED, EXPIRED are not.
  const eligible =
    sub.autoRenew &&
    (sub.renewalStatus === SubscriptionRenewalStatus.ACTIVE ||
      sub.renewalStatus === SubscriptionRenewalStatus.RENEWAL_FAILED);
  if (!eligible) {
    return makeResult(subscriptionId, 'not_eligible', null);
  }

  // Optimistic CAS: only one racing caller flips to RENEWING.
  const won = await store.applyStatusTransition(
    subscriptionId,
    sub.renewalStatus,
    SubscriptionRenewalStatus.RENEWING,
    sub.lockVersion,
  );
  if (!won) {
    return makeResult(subscriptionId, 'lost_race', null);
  }

  // lockVersion was bumped by the CAS above.
  const renewingVersion = sub.lockVersion + 1;

  const processPayment = options.processPayment ?? (() => Promise.resolve());

  // Process payment — at most once per renewal attempt.
  try {
    await processPayment(sub);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await store.recordRenewalFailure(subscriptionId, msg, renewingVersion);
    return makeResult(subscriptionId, 'payment_failed', null, msg);
  }

  // Advance expiry by the subscription's period.
  const newExpiresAt = addDays(sub.expiresAt, sub.periodDays);
  await store.recordRenewalSuccess(subscriptionId, newExpiresAt, renewingVersion);

  return makeResult(subscriptionId, 'renewed', newExpiresAt);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function makeResult(
  subscriptionId: string,
  outcome: RenewalOutcome,
  newExpiresAt: Date | null,
  error?: string,
): RenewalResult {
  return {
    subscriptionId,
    outcome,
    renewed: outcome === 'renewed',
    newExpiresAt,
    error,
  };
}

/** Add `days` days to a Date, returning a new Date instance. */
export function addDays(date: Date, days: number): Date {
  const ms = date.getTime() + days * 24 * 60 * 60 * 1000;
  return new Date(ms);
}
