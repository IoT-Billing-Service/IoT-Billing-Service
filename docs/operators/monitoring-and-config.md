# Monitoring & Configuration Operations

> Consolidated from `backend/docs/runtime-configuration-auditing.md` and `backend/docs/payment-webhook-notifications.md` (issue #308).

## Runtime Configuration Auditing and Drift Detection

### Design

Billing-tier configuration is a signed release artifact, not an operational
toggle. The trusted state is `config:active` in Redis and the active billing
process retains only a SHA-256 baseline hash in memory. Each artifact uses an
Ed25519 signature over a deterministic JSON representation of `algorithm`,
`issuedAt`, `keyId`, `payload`, and `versionId`.

Only public keys supplied through `RUNTIME_CONFIG_AUTHORIZED_KEYS` are trusted.
Private signing keys belong in the release system/HSM and must never be placed
in Redis, source control, or application environment variables.

The finalization path makes a synchronous in-memory hash comparison before the
first billing-cycle state transition. A missing baseline, invalid signature, or
hash mismatch throws `RuntimeConfigurationIntegrityError`; no payment callback
or state transition is reached. Signature verification runs only during a
configuration activation. The 1-second scanner is for early detection and
alerting, not for request correctness, so it does not add network I/O or a
queue to billing requests.

This separates duties cleanly:

- Release authority signs a proposed configuration.
- Redis distributes the immutable signed artifact.
- The service verifies the signer and enforces the baseline locally.
- Prometheus and structured JSON audit events provide the tamper-evident
  operational record. Ship those logs to a write-once/WORM-capable retention
  system to satisfy the PCI-DSS/SOC 2 evidence-retention control.

### Redis artifact format

`config:active` must contain this envelope in production. `max: null` denotes
an unbounded top tier, avoiding non-standard JSON `Infinity` values.

```json
{
  "algorithm": "ed25519",
  "keyId": "billing-config-release-2026-07",
  "versionId": "2026-07-20.1",
  "issuedAt": "2026-07-20T12:00:00.000Z",
  "payload": {
    "version_id": "2026-07-20.1",
    "tiers": {
      "TIER_1": { "min": 0, "max": 1000 },
      "TIER_2": { "min": 1001, "max": 10000 },
      "TIER_3": { "min": 10001, "max": null }
    }
  },
  "signature": "base64-ed25519-signature"
}
```

The signature must be generated over the canonical serialization implemented
by `canonicalizeConfiguration`; do not use ordinary `JSON.stringify` in a
separate release tool. Pin a small signer utility to this repository or invoke
the exported canonicalizer in the release pipeline.

### Deployment

1. Publish the release key's PEM public key as JSON in
   `RUNTIME_CONFIG_AUTHORIZED_KEYS`, for example
   `{"billing-config-release-2026-07":"-----BEGIN PUBLIC KEY-----\\n..."}`.
2. Sign and atomically place the envelope in Redis `config:active` before
   deploying the application.
3. Deploy normally with the backend Docker image. Production startup rejects an
   empty key set, an unsigned artifact, and an invalid artifact.
4. Confirm `/metrics` reports `runtime_config_integrity_state 1` before sending
   billing traffic.
5. Restrict Redis write access to the release identity and enable audit logging
   on that account. Rotate keys by publishing both public keys, deploying, then
   retiring the old key after all active artifacts are updated.

### Monitoring and incident response

The alert rules in `monitoring/billing_alerts.yml` page immediately when
integrity becomes unverified/drifted or a signed update is rejected. The events
`runtime_config_activated`, `runtime_config_drift_detected`, and
`runtime_config_rejected` are structured JSON audit records; they include no
secret material. Investigate drift as a security incident: preserve the
expected/observed hashes, revoke Redis write access, compare the active
artifact to the release record, and restore a newly signed known-good artifact.

The relevant signals are:

- `runtime_config_integrity_state` — 1 healthy, 0 unverified, -1 drifted.
- `runtime_config_drift_events_total` — drift detections.
- `runtime_config_signature_failures_total` — rejected changes.
- `billing_operation_duration_ms` — verify the P99 remains below 200 ms.

No deployment was attempted by this change: it requires the target environment's
authorized public key and a signed release artifact.

---

## Payment Webhook Notifications

### Contract

Payment lifecycle events use stable event names: `payment.created`,
`payment.confirmed`, `payment.failed`, `payment.refunded`, and
`payment.settled`. Every event carries an immutable `eventId`, an ISO timestamp,
the account scope, and non-sensitive payment identifiers. PAN, CVV, private
keys, and raw device credentials are never included.

The receiver gets the JSON body plus `X-Webhook-Signature` (HMAC-SHA256),
`X-Webhook-Delivery-Id`, and `X-Webhook-Timestamp`. Receivers must verify the
raw body, reject timestamps outside five minutes in either direction, and
deduplicate `eventId` or delivery ID before applying the event.

### Delivery design

1. The billing transaction is cryptographically verified and committed.
2. The same database transaction inserts one outbox row per enabled subscription,
   using `(subscription_id, event_id)` as the idempotency constraint.
3. A dedicated worker claims pending rows with a short lease, signs the raw
   payload, and delivers with a bounded timeout and exponential backoff.
4. `2xx` acknowledges the row. `4xx` is terminal. `5xx`, timeout, and network
   failures are retried; exhausted rows become `dead_letter` for replay.

The billing request never waits for an HTTP webhook response. This preserves the
`<200ms P99` billing target while the durable outbox provides at-least-once
delivery. The finalizer publisher hook in `src/billing/finalizer.ts` is the
boundary for wiring the transaction commit to this outbox writer.

### Security and compliance

- Store only a hash in `webhook_subscriptions.secret_hash`; keep the signing
  secret in the managed secret store and rotate it with an overlap window.
- Require HTTPS endpoints, validate URL ownership at registration, and apply
  egress allowlists, rate limits, and response-size limits.
- Redact payloads and endpoint secrets from logs. Retain delivery audit records
  without payment card data for the SOC2 evidence period.
- Treat webhook delivery as a notification, never as authorization for a
  payment. The on-chain signature and nonce checks remain authoritative.

### Monitoring and deployment

Scrape `webhook_deliveries_total`, `webhook_delivery_duration_ms`, and
`webhook_outbox_depth`. Alert on sustained outbox growth, dead-letter rows,
signature failures, and delivery P99 above the endpoint timeout budget. Deploy
the API and webhook worker separately so worker concurrency can scale without
changing billing request capacity. Run the SQL migration under the existing
distributed migration lock, then deploy the worker and enable subscriptions.
