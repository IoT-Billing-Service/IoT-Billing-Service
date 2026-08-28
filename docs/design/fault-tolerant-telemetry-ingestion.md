# Fault-Tolerant Telemetry Ingestion with Retry Logic

**Issue:** #292 · **Status:** Implemented · **Scope:** IoT billing platform

## Problem

`POST /ingest` is a single-shot pipeline: verify (PoW, Ed25519 signature +
nonce, ZK range proof, metric bounds) then persist via Prisma. If the database
write fails transiently (connection blip, pool exhaustion, deadlock), the
request fails with `ERR_INTERNAL` and the payload is lost. A client retry does
not help: the nonce was already consumed during verification, so the retried
payload is rejected as a replay (`ERR_REPLAY_DETECTED`).

Requirements driving the design:

- **Performance** — billing operations must stay < 200 ms P99.
- **Security** — every persisted transaction must be cryptographically verified.
- **Compliance** — PCI-DSS / SOC2 auditability and no silent data loss.

## Design

Two complementary retry layers, both keyed off the same verification pipeline:

```
POST /ingest
  └─ verify payload (PoW, signature+nonce, ZK proof, bounds)     [unchanged]
  └─ persist with fast in-flight retries (default 2, ≤100 ms each)
       ├─ success → 200 OK
       ├─ transient failure after fast retries + durable queue enabled
       │    └─ enqueue IngestionJob (verified request + digest) → 202 Accepted
       │         (Retry-After hint, jobId in body)
       └─ transient failure, no durable queue → 500 ERR_INTERNAL (legacy)

IngestionRetryWorker (poll loop, default 5 s)
  └─ claim due jobs atomically (UPDATE … RETURNING on (status, next_attempt_at))
       └─ re-verify (digest + Ed25519 signature + bounds)
            ├─ success      → status=completed → publish to SSE stream
            ├─ permanent    → status=failed    → DLQ (telemetry_ingestion)
            └─ transient    → retries left     → status=pending, exponential
                                 backoff (full jitter); exhausted → failed + DLQ
```

### Layer 1 — fast in-flight retries

`IngestionService.persistWithFastRetry()` retries the Prisma write a small
number of times (default 2) with capped exponential backoff (base 10 ms,
cap 100 ms). Only *transient* failures are retried — `DeviceNotFoundError` /
`DeviceDisabledError` (permanent) propagate immediately. Worst-case added
latency is well under the 200 ms P99 budget.

### Layer 2 — durable retry queue

If fast retries are exhausted and a queue is configured, the *fully verified*
request is written to the `ingestion_jobs` table (the `IngestionJob` Prisma
model, previously unused) and the endpoint answers `202 Accepted` with a
`Retry-After` hint and the `jobId`. The client treats 202 as success — the
payload is durably captured, so nothing is lost even if the process crashes.

A background `IngestionRetryWorker` polls the queue, claims due jobs with a
single atomic `UPDATE … RETURNING` (row-level locks make claims single-winner
across multiple worker instances), re-attempts persistence with exponential
backoff + full jitter, and dead-letters jobs that exhaust the budget via the
existing `DlqManager` (`telemetry_ingestion` queue). Operators can replay DLQ
messages back into the queue through the registered handler.

### Why the re-verification on retry

Jobs are enqueued only *after* the full verification pipeline passes, but the
retry worker still re-checks before persisting, because the queue is a new
trust boundary:

1. **Integrity** — a SHA-256 digest over the canonical JSON of the stored
   request must still match. Canonical serialisation (sorted keys) is used
   because Postgres JSONB reorders object keys.
2. **Authenticity** — the Ed25519 signature must still verify over the exact
   signed message bytes captured at enqueue time (JSONB key reordering makes
   reconstructing the signed message from the stored payload unreliable).
3. **Bounds** — metric values must still satisfy `MetricBoundsEnforcer`.

The sliding-window nonce/timestamp checks are intentionally *not* re-run: the
payload already passed them, and a delayed retry would fail the timestamp
window for legitimate reasons.

## Schema

`ingestion_jobs` (extends the existing `IngestionJob` model):

| column           | type        | notes                                        |
|------------------|-------------|----------------------------------------------|
| `id`             | text        | PK                                           |
| `device_id`      | text        |                                              |
| `status`         | text        | `pending` → `processing` → `completed\|failed` |
| `retry_count`    | int         | failed attempts so far                       |
| `next_attempt_at`| timestamptz | earliest claim time (backoff schedule)       |
| `last_error`     | text        | most recent failure reason                   |
| `state_data`     | jsonb       | verified request + digest                    |
| `created_at`/`updated_at` | timestamptz |                                  |

Index: `(status, next_attempt_at)` for the worker's claim scan. DDL lives in
`backend/prisma/sql/20260828000000_ingestion_retry_jobs.sql` (idempotent,
matches the Prisma model).

## Configuration

All knobs are optional with defaults; no schema/`state_data` compatibility
break.

- `IngestionServiceOptions.retryQueue` — inject the durable queue (default:
  wired by `initIngestionService`).
- `maxFastRetries` (2), `fastRetryBaseDelayMs` (10), `fastRetryMaxDelayMs` (100).
- `IngestionRetryQueueOptions` — `maxRetries` (3), `baseBackoffMs` (2000),
  `maxBackoffMs` (120 000), `jitterFactor`.
- `IngestionRetryWorkerOptions` — `pollIntervalMs` (5000), `batchSize` (20).
- `IngestionRetryConfig.enabled` — disable the whole pipeline (legacy mode).

## Monitoring

Prometheus metrics (registered in `src/api/metrics/prometheus.ts`):

- `ingestion_retry_jobs_enqueued_total`
- `ingestion_retry_attempts_total`
- `ingestion_retry_requeued_total`
- `ingestion_retry_completed_total`
- `ingestion_retry_dlq_total`
- `ingestion_retry_queue_depth{state="pending|processing"}`

Alerting signals: a sustained non-zero `ingestion_retry_dlq_total` rate
indicates either a DB outage beyond the retry budget or a permanent
configuration issue (e.g. devices missing from the registry).

## Security & compliance

- Only verified payloads are ever enqueued; the queue never runs PoW / ZK
  verification again (they already passed once), but digest + signature +
  bounds are re-checked at persist time (PCI-DSS Req 10.2-style evidence).
- `ingestion_jobs` rows are never hard-deleted, preserving the audit trail.
- Queued payload tampering (digest or signature mismatch) is rejected as a
  permanent `PayloadIntegrityError` and dead-lettered for operator review.

## Testing

Unit tests cover the queue (`ingestion_retry_queue.test.ts`), the worker
(`ingestion_retry_worker.test.ts`), the service fast-retry/enqueue/verified-job
replay paths (`ingestion_service_retry.test.ts`), and the route's 202 +
`Retry-After` semantics (`ingestion_route.test.ts`).
