# Subscription Auto-Renewal (Issue #36)

## Overview

The subscription auto-renewal feature automatically renews active subscriptions
before they expire, using the existing payment workflow and billing infrastructure.

---

## Auto-Renewal Flow

```
RenewalCron.tick()
  └─► SubscriptionStore.findDueForRenewal(horizon)
        Returns: autoRenew=true, status ACTIVE|RENEWAL_FAILED, expiresAt ≤ now+24h
  └─► renewSubscription(store, id, { processPayment })
        1. Fetch subscription — bail if not found
        2. Check eligibility — bail if CANCELLED / EXPIRED / autoRenew=false
        3. Optimistic CAS: ACTIVE → RENEWING (lockVersion guard)
           └─ Only one concurrent caller wins; others return `lost_race`
        4a. processPayment(sub) — existing payment workflow
            Success → recordRenewalSuccess → ACTIVE, expiresAt += periodDays
        4b. Failure → recordRenewalFailure → RENEWAL_FAILED, lastError stored
```

---

## Renewal Lifecycle

| Status           | Meaning                                            | Terminal? |
|------------------|----------------------------------------------------|-----------|
| `ACTIVE`         | Subscription is live; eligible for auto-renewal    | No        |
| `PENDING_RENEWAL`| (Reserved) Pre-renewal marker for external systems | No        |
| `RENEWING`       | CAS won; payment in flight                         | No        |
| `RENEWAL_FAILED` | Last payment failed; eligible for retry            | No        |
| `CANCELLED`      | Manually cancelled; no further renewals            | Yes       |
| `EXPIRED`        | Not renewed before expiry                          | Yes       |

A subscription moves: `ACTIVE → RENEWING → ACTIVE` (success) or
`ACTIVE → RENEWING → RENEWAL_FAILED` (payment failure). `RENEWAL_FAILED`
subscriptions are retried on every cron tick until they succeed, are cancelled,
or expire.

---

## Configuration

The `RenewalCron` is started in `src/api/index.ts` with defaults:

| Parameter            | Default   | Description                                          |
|----------------------|-----------|------------------------------------------------------|
| `intervalMs`         | 60 000 ms | How often the cron scans for due subscriptions       |
| `renewalLookaheadMs` | 86 400 000 ms (24 h) | Renew subscriptions expiring within this window |
| `batchSize`          | 50        | Maximum subscriptions processed per tick             |

---

## Operational Considerations

- **Idempotency**: The `ACTIVE → RENEWING` CAS is guarded by `lockVersion`, so
  concurrent cron instances or retried requests cannot double-charge.
- **Failure handling**: Payment failures set `RENEWAL_FAILED` with the error
  message in `lastError`. The subscription remains eligible for retry on the
  next tick.
- **Batch cap**: At most 50 subscriptions are processed per tick, ordered by
  `expiresAt ASC`, so the oldest-due subscriptions are always prioritised.
- **No new payment flow**: `processPayment` is an injectable callback. The
  production wiring in `buildPrismaSubscriptionStore` uses the existing Prisma
  ORM connection pool without adding a second database connection.

---

## Monitoring Metrics

All metrics are exposed on the standard `GET /metrics` (Prometheus scrape) endpoint.

| Metric name                                | Type    | Description                                             |
|--------------------------------------------|---------|---------------------------------------------------------|
| `subscription_renewals_succeeded_total`    | Counter | Successful auto-renewals since process start            |
| `subscription_renewals_failed_total`       | Counter | Failed renewal attempts (payment error) since start     |
| `subscription_renewal_queue_depth`         | Gauge   | Subscriptions queued in the current cron tick           |
| `subscription_renewal_running`             | Gauge   | `1` while a tick is active, `0` otherwise               |

Suggested alert rules:

```yaml
# Payment failures rising — investigate payment provider
- alert: SubscriptionRenewalFailureSpike
  expr: increase(subscription_renewals_failed_total[5m]) > 5

# Cron stuck — tick running for more than 5 minutes
- alert: SubscriptionRenewalCronStuck
  expr: subscription_renewal_running == 1 for 5m
```

---

## Database Schema

```prisma
model Subscription {
  id            String   @id @default(cuid())
  accountId     String   @map("account_id")
  planId        String   @map("plan_id")
  amountDue     BigInt   @map("amount_due")
  periodDays    Int      @default(30) @map("period_days")
  expiresAt     DateTime @map("expires_at")
  autoRenew     Boolean  @default(true) @map("auto_renew")
  renewalStatus String   @default("ACTIVE") @map("renewal_status")
  lockVersion   Int      @default(1) @map("lock_version")
  renewedAt     DateTime? @map("renewed_at")
  lastError     String?  @map("last_error")
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")

  account Account @relation(fields: [accountId], references: [id])
  @@index([renewalStatus, expiresAt])
  @@map("subscriptions")
}
```

Apply the schema change with:

```bash
npx prisma migrate dev --name add_subscriptions
```
