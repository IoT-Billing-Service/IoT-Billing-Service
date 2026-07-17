/**
 * Subscription auto-renewal unit tests (issue #36).
 *
 * Covers:
 *   - Successful renewal (happy path)
 *   - Duplicate / concurrent renewal prevention (optimistic CAS)
 *   - Failed payment handling (RENEWAL_FAILED + retryable)
 *   - Subscription expiry advancement
 *   - Ineligible states (CANCELLED, EXPIRED, autoRenew=false)
 *   - RenewalCron tick integration (fake timers, queue depth, metrics)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  renewSubscription,
  InMemorySubscriptionStore,
  SubscriptionRenewalStatus,
  addDays,
  type SubscriptionRow,
} from '../../../src/billing/subscription_renewal.js';
import { RenewalCron } from '../../../src/billing/renewal_cron.js';
import {
  subscriptionRenewalsSucceeded,
  subscriptionRenewalsFailed,
  subscriptionRenewalQueueDepth,
  subscriptionRenewalRunning,
} from '../../../src/api/metrics/prometheus.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Build a minimal subscription row with sensible defaults. */
function makeSub(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: 'sub-1',
    accountId: 'acct-1',
    planId: 'plan-basic',
    amountDue: 1000n,
    periodDays: 30,
    expiresAt: new Date(Date.now() + 1000), // expires in 1 second (due soon)
    autoRenew: true,
    renewalStatus: SubscriptionRenewalStatus.ACTIVE,
    lockVersion: 1,
    ...overrides,
  };
}

// ── renewSubscription — single-call behaviour ─────────────────────────────────

describe('renewSubscription — single-call behaviour', () => {
  it('renews an ACTIVE subscription and extends expiresAt by periodDays', async () => {
    const store = new InMemorySubscriptionStore();
    const sub = makeSub();
    store.seed(sub);

    const result = await renewSubscription(store, sub.id);

    expect(result.outcome).toBe('renewed');
    expect(result.renewed).toBe(true);
    expect(result.newExpiresAt).not.toBeNull();
    // New expiry must be exactly periodDays after the original expiresAt.
    const expectedExpiry = addDays(sub.expiresAt, sub.periodDays);
    expect(result.newExpiresAt?.getTime()).toBe(expectedExpiry.getTime());

    // Persistent state: status reset to ACTIVE, lockVersion advanced.
    const updated = await store.getSubscription(sub.id);
    expect(updated?.renewalStatus).toBe(SubscriptionRenewalStatus.ACTIVE);
    expect(updated?.lockVersion).toBeGreaterThan(sub.lockVersion);
    expect(updated?.expiresAt.getTime()).toBe(expectedExpiry.getTime());
  });

  it('retries a RENEWAL_FAILED subscription successfully', async () => {
    const store = new InMemorySubscriptionStore();
    store.seed(makeSub({ renewalStatus: SubscriptionRenewalStatus.RENEWAL_FAILED }));

    const result = await renewSubscription(store, 'sub-1');

    expect(result.outcome).toBe('renewed');
    const updated = await store.getSubscription('sub-1');
    expect(updated?.renewalStatus).toBe(SubscriptionRenewalStatus.ACTIVE);
  });

  it('returns not_found for an unknown subscription', async () => {
    const store = new InMemorySubscriptionStore();
    const result = await renewSubscription(store, 'no-such-sub');
    expect(result.outcome).toBe('not_found');
    expect(result.renewed).toBe(false);
  });

  it('returns not_eligible when autoRenew is false', async () => {
    const store = new InMemorySubscriptionStore();
    store.seed(makeSub({ autoRenew: false }));
    const result = await renewSubscription(store, 'sub-1');
    expect(result.outcome).toBe('not_eligible');
  });

  it('returns not_eligible for CANCELLED subscription', async () => {
    const store = new InMemorySubscriptionStore();
    store.seed(makeSub({ renewalStatus: SubscriptionRenewalStatus.CANCELLED }));
    const result = await renewSubscription(store, 'sub-1');
    expect(result.outcome).toBe('not_eligible');
  });

  it('returns not_eligible for EXPIRED subscription', async () => {
    const store = new InMemorySubscriptionStore();
    store.seed(makeSub({ renewalStatus: SubscriptionRenewalStatus.EXPIRED }));
    const result = await renewSubscription(store, 'sub-1');
    expect(result.outcome).toBe('not_eligible');
  });

  it('returns not_eligible for RENEWING subscription (in-flight guard)', async () => {
    const store = new InMemorySubscriptionStore();
    store.seed(makeSub({ renewalStatus: SubscriptionRenewalStatus.RENEWING }));
    const result = await renewSubscription(store, 'sub-1');
    expect(result.outcome).toBe('not_eligible');
  });
});

// ── renewSubscription — payment failure ────────────────────────────────────────

describe('renewSubscription — payment failure', () => {
  it('records RENEWAL_FAILED and preserves error message on payment error', async () => {
    const store = new InMemorySubscriptionStore();
    const sub = makeSub();
    store.seed(sub);
    const originalExpiry = sub.expiresAt.getTime();

    const result = await renewSubscription(store, 'sub-1', {
      processPayment: () => Promise.reject(new Error('insufficient balance')),
    });

    expect(result.outcome).toBe('payment_failed');
    expect(result.renewed).toBe(false);
    expect(result.error).toBe('insufficient balance');

    const updated = await store.getSubscription('sub-1');
    expect(updated?.renewalStatus).toBe(SubscriptionRenewalStatus.RENEWAL_FAILED);
    // Expiry must NOT have changed.
    expect(updated?.expiresAt.getTime()).toBe(originalExpiry);
  });

  it('leaves state consistent after payment failure (lockVersion advanced once)', async () => {
    const store = new InMemorySubscriptionStore();
    store.seed(makeSub());

    await renewSubscription(store, 'sub-1', {
      processPayment: () => Promise.reject(new Error('timeout')),
    });

    const updated = await store.getSubscription('sub-1');
    // The CAS + recordRenewalFailure each bump the version once.
    expect(updated?.lockVersion).toBe(3); // 1 (seed) + 1 (CAS) + 1 (failure record)
  });
});

// ── renewSubscription — concurrency (duplicate prevention) ────────────────────

describe('renewSubscription — concurrency', () => {
  it('20 concurrent callers on one subscription => exactly one renewal', async () => {
    const store = new InMemorySubscriptionStore();
    store.seed(makeSub());
    let paymentCalls = 0;

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        renewSubscription(store, 'sub-1', {
          processPayment: () => {
            paymentCalls++;
            return Promise.resolve();
          },
        }),
      ),
    );

    // Only one caller may win the ACTIVE -> RENEWING CAS.
    expect(paymentCalls).toBe(1);
    expect(results.filter((r) => r.renewed)).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'lost_race')).toHaveLength(19);

    const updated = await store.getSubscription('sub-1');
    expect(updated?.renewalStatus).toBe(SubscriptionRenewalStatus.ACTIVE);
  });

  it('sequential retry after RENEWAL_FAILED succeeds exactly once', async () => {
    const store = new InMemorySubscriptionStore();
    store.seed(makeSub({ renewalStatus: SubscriptionRenewalStatus.RENEWAL_FAILED }));

    // First caller wins, second is not_eligible because status is now RENEWING.
    const [first, second] = await Promise.all([
      renewSubscription(store, 'sub-1'),
      renewSubscription(store, 'sub-1'),
    ]);
    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toContain('renewed');
    expect(outcomes).toContain('lost_race');
  });
});

// ── addDays helper ─────────────────────────────────────────────────────────────

describe('addDays', () => {
  it('adds exactly periodDays × 24h of milliseconds', () => {
    const base = new Date('2025-01-01T00:00:00.000Z');
    const result = addDays(base, 30);
    expect(result.getTime() - base.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

// ── RenewalCron — tick integration ─────────────────────────────────────────────

describe('RenewalCron', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    subscriptionRenewalsSucceeded.reset();
    subscriptionRenewalsFailed.reset();
    subscriptionRenewalQueueDepth.reset();
    subscriptionRenewalRunning.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires on the configured interval and renews due subscriptions', async () => {
    const store = new InMemorySubscriptionStore();
    store.seed(makeSub({ id: 'sub-a', expiresAt: new Date(Date.now() - 1000) })); // already expired
    store.seed(makeSub({ id: 'sub-b', expiresAt: new Date(Date.now() - 500) })); // also overdue

    const cron = new RenewalCron(store, { intervalMs: 1000, renewalLookaheadMs: 60_000 });
    cron.start();
    await vi.advanceTimersByTimeAsync(1000);
    cron.stop();

    expect(cron.getRenewedCount()).toBe(2);
    expect(cron.getFailedCount()).toBe(0);
  });

  it('does not renew subscriptions outside the lookahead window', async () => {
    const store = new InMemorySubscriptionStore();
    // Expires far in the future — outside the lookahead window.
    store.seed(makeSub({ id: 'sub-future', expiresAt: new Date(Date.now() + 999_999_999) }));

    const cron = new RenewalCron(store, { intervalMs: 1000, renewalLookaheadMs: 60_000 });
    cron.start();
    await vi.advanceTimersByTimeAsync(1000);
    cron.stop();

    expect(cron.getRenewedCount()).toBe(0);
  });

  it('increments failed counter and does not throw on payment error', async () => {
    const store = new InMemorySubscriptionStore();
    store.seed(makeSub({ expiresAt: new Date(Date.now() - 1000) }));

    const cron = new RenewalCron(store, {
      intervalMs: 1000,
      renewalLookaheadMs: 60_000,
      processPayment: () => Promise.reject(new Error('card declined')),
    });
    cron.start();
    await vi.advanceTimersByTimeAsync(1000);
    cron.stop();

    expect(cron.getFailedCount()).toBe(1);
    expect(cron.getRenewedCount()).toBe(0);
  });

  it('skips a tick if the previous one is still running (no overlap)', async () => {
    const store = new InMemorySubscriptionStore();
    store.seed(makeSub({ expiresAt: new Date(Date.now() - 1000) }));

    let active = 0;
    let maxConcurrent = 0;
    let resolvePayment!: () => void;

    const cron = new RenewalCron(store, {
      intervalMs: 500,
      renewalLookaheadMs: 60_000,
      processPayment: () =>
        new Promise<void>((resolve) => {
          active++;
          maxConcurrent = Math.max(maxConcurrent, active);
          resolvePayment = () => {
            active--;
            resolve();
          };
        }),
    });

    cron.start();
    await vi.advanceTimersByTimeAsync(1500); // 3 potential ticks, first still in flight
    expect(maxConcurrent).toBe(1);
    resolvePayment();
    cron.stop();
  });

  it('stop() and start() are idempotent', async () => {
    const store = new InMemorySubscriptionStore();
    store.seed(makeSub({ expiresAt: new Date(Date.now() - 1000) }));

    const cron = new RenewalCron(store, { intervalMs: 1000, renewalLookaheadMs: 60_000 });
    cron.start();
    cron.start(); // no-op
    await vi.advanceTimersByTimeAsync(1000);
    cron.stop();
    cron.stop(); // no-op
    expect(cron.getRenewedCount()).toBe(1);
  });

  it('does not renew autoRenew=false subscriptions', async () => {
    const store = new InMemorySubscriptionStore();
    store.seed(makeSub({ expiresAt: new Date(Date.now() - 1000), autoRenew: false }));

    const cron = new RenewalCron(store, { intervalMs: 1000, renewalLookaheadMs: 60_000 });
    cron.start();
    await vi.advanceTimersByTimeAsync(1000);
    cron.stop();

    expect(cron.getRenewedCount()).toBe(0);
  });
});

// ── Prometheus metrics surface ─────────────────────────────────────────────────

describe('subscription renewal Prometheus metrics', () => {
  beforeEach(() => {
    subscriptionRenewalsSucceeded.reset();
    subscriptionRenewalsFailed.reset();
    subscriptionRenewalQueueDepth.reset();
  });

  it('increments succeeded counter on successful renewal', async () => {
    const store = new InMemorySubscriptionStore();
    store.seed(makeSub());

    const cron = new RenewalCron(store, {
      renewalLookaheadMs: 999_999_999,
      intervalMs: 999_999,
    });
    await cron.tick();

    const val = (await subscriptionRenewalsSucceeded.get()).values[0]?.value ?? 0;
    expect(val).toBe(1);
  });

  it('increments failed counter on payment error', async () => {
    const store = new InMemorySubscriptionStore();
    store.seed(makeSub());

    const cron = new RenewalCron(store, {
      renewalLookaheadMs: 999_999_999,
      processPayment: () => Promise.reject(new Error('fail')),
      intervalMs: 999_999,
    });
    await cron.tick();

    const val = (await subscriptionRenewalsFailed.get()).values[0]?.value ?? 0;
    expect(val).toBe(1);
  });
});
