# Payment Webhook Notifications

## Contract

Payment lifecycle events use stable event names: `payment.created`,
`payment.confirmed`, `payment.failed`, `payment.refunded`, and
`payment.settled`. Every event carries an immutable `eventId`, an ISO timestamp,
the account scope, and non-sensitive payment identifiers. PAN, CVV, private
keys, and raw device credentials are never included.

The receiver gets the JSON body plus `X-Webhook-Signature` (HMAC-SHA256),
`X-Webhook-Delivery-Id`, and `X-Webhook-Timestamp`. Receivers must verify the
raw body, reject timestamps outside five minutes in either direction, and
deduplicate `eventId` or delivery ID before applying the event.

## Delivery design

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

## Security and compliance

- Store only a hash in `webhook_subscriptions.secret_hash`; keep the signing
  secret in the managed secret store and rotate it with an overlap window.
- Require HTTPS endpoints, validate URL ownership at registration, and apply
  egress allowlists, rate limits, and response-size limits.
- Redact payloads and endpoint secrets from logs. Retain delivery audit records
  without payment card data for the SOC2 evidence period.
- Treat webhook delivery as a notification, never as authorization for a
  payment. The on-chain signature and nonce checks remain authoritative.

## Monitoring and deployment

Scrape `webhook_deliveries_total`, `webhook_delivery_duration_ms`, and
`webhook_outbox_depth`. Alert on sustained outbox growth, dead-letter rows,
signature failures, and delivery P99 above the endpoint timeout budget. Deploy
the API and webhook worker separately so worker concurrency can scale without
changing billing request capacity. Run the SQL migration under the existing
distributed migration lock, then deploy the worker and enable subscriptions.
