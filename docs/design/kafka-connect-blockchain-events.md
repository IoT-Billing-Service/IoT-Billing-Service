# Kafka Connect Sink for Blockchain Event Streaming

> Issue #291 — implementation status: implemented (see `backend/src/stream/kafka_connect/`).

## Problem

The IoT billing platform verifies and records every billing-relevant blockchain
event (payment finalization, fee oracle data, escrow lifecycle transitions) in
a durable, ordered ledger. Today the canonical ledger is a Redis Streams
consumer-group stream (`billing:events`, see `ledger_event_bus.ts`), and it is
produced directly by the in-process blockchain relayer.

High-density IoT deployments need a decoupling and buffering layer in front of
that ledger: a Kafka topic is the natural choice because it gives operators a
log-structured, replayable buffer that can buffer bursts, be replayed on
upstream outage, and be replicated independently of the billing service. The
missing piece is a *Kafka Connect Sink* — the component that drains that Kafka
topic and re-hydrates the platform's durable ledger.

**Goals**

- Consume blockchain event envelopes from a Kafka topic and write them, in
  order, into the durable Redis Streams ledger bus (`billing:events`).
- Preserve the platform's invariants:
  - *Durability* — no event is lost while a consumer is offline (consumer
    group offset persists; replay on crash).
  - *Ordering* — within a partition, records are applied in offset order.
  - *Cryptographic verification* — every transaction can be verified before it
    touches the ledger (optional Ed25519 signature + SHA-256 tamper hash).
  - *Performance* — single-record sink latency far below the <200ms P99 billing
    budget.
- Be portable to a real Kafka Connect runtime without changing the sink logic.

**Non-goals**

- Running/storing the Kafka cluster itself.
- Changing the durable ledger (`billing:events`) semantics.
- Replacing the billing consumers.

## Design

### Topology

```
 block explorer / relayer
        │ produces
        ▼
 ┌─────────────────────┐     Kafka topic          ┌────────────────────────────┐
 │ Kafka topic         │   (blockchain.events)    │  Kafka Connect Sink worker │
 │ blockchain.events   ├─────────────────────────► │  backend/stream/           │
 └─────────────────────┘        consumes          │  kafka_connect_worker.ts   │
                                                  │                            │
                                                  │  BlockchainEventSinkTask  │
                                                  │   decode/verify → publish │
                                                  │            │               │
                                                  │            ▼               │
                                                  │  Redis Streams ledger     │
                                                  │  billing:events (durable) │
                                                  └───────────┬────────────────┘
                                                              │ consumers
                                                              ▼
                                                   existing billing workers /
                                                          feature consumers
```

### Project structure (new files)

| File | Role |
|---|---|
| `backend/src/stream/kafka_connect/types.ts` | Kafka Connect API types (`SinkRecord`, offsets, sink target) |
| `backend/src/stream/kafka_connect/record_codec.ts` | Validate + decode record envelopes; SHA-256 tamper hash; Ed25519 verify |
| `backend/src/stream/kafka_connect/connector.ts` | Kafka Connect `SinkConnector` descriptor (config schema, task fan-out) |
| `backend/src/stream/kafka_connect/sink_task.ts` | `SinkTask` lifecycle: `start → put → flush → stop`; ordering + metrics |
| `backend/src/stream/kafka_connect_worker.ts` | Native worker: KafkaJS consumer → task → offset commit |
| `k8s/kafka-connect-sink-*.yaml` | Deployment + HPA for the worker |

### Key behaviours

**Record envelope** (JSON on the Kafka topic):

```jsonc
{
  "v": 1,                      // envelope version (required)
  "sequence": 42,              // monotonic ledger sequence (required)
  "event": {                   // event body (required)
    "type": "PaymentFinalized",
    "hash": "0xabc…",
    "amount": "42"
  },
  "contentHash": "sha256(…)",  // SHA-256 of canonical event body (optional)
  "signature": "base64…",      // optional Ed25519 sig over contentHash source
  "producedAt": 1700000000000  // producer timestamp (ms), optional
}
```

`record_codec` decodes and validates an envelope, recomputes the canonical
(key-sorted) JSON hash, verifies the signature when `KAFKA_CONNECT_VERIFY_PUBLIC_KEY`
is configured, and rejects the record with a structured reason otherwise. A
rejected record is never written to the ledger — it is counted
(`kafka_connect_events_failed_total{reason=…}`) and skipped, so one bad record
cannot stall a partition.

**SinkTask semantics.** `put()` enqueues each batch behind a single in-process
promise chain so delivery order is preserved per partition (mirroring how
Kafka Connect hands records to a task). A completed record advances the
high-water offset map; the runtime commits consumer-group offsets only for
records actually sunk. Publish failures are counted and *not* committed, so
Kafka replays them (at-least-once). Because a `LedgerEvent` with the same
`sequence` is idempotent for the ledger continuity invariant, at-least-once
replay is safe and no dedup state is required.

**Sink target.** The durable target is the existing `LedgerEventBus` (Redis
Streams `billing:events`), reached through a narrow `LedgerSinkTarget`
interface. Tests inject an in-memory fake, so the sink logic is testable with
no Redis or Kafka.

### Metrics (issue #291 block in `prometheus.ts`)

| Metric | Type | Meaning |
|---|---|---|
| `kafka_connect_events_received_total{topic}` | Counter | Records delivered to the task |
| `kafka_connect_events_sunk_total{topic}` | Counter | Records written to the ledger |
| `kafka_connect_events_failed_total{topic,reason}` | Counter | Records rejected, by reason |
| `kafka_connect_sink_duration_ms{topic}` | Histogram | Per-record decode+publish latency |
| `kafka_connect_sink_backlog_records{task}` | Gauge | Records buffered awaiting flush |

Alert on `kafka_connect_events_failed_total{reason="signature-invalid"}` and
`reason="hash-mismatch"` (tampering), and on a sustained
`kafka_connect_events_sunk_total` rate near 0 while `received_total` grows
(stuck sink). The latency histogram buckets were chosen around the
`<200ms P99` budget.

### Configuration

New env vars (`backend/src/config/env.ts`, defaults):

| Variable | Default | Notes |
|---|---|---|
| `KAFKA_CONNECT_SINK_ENABLED` | `false` | Master switch — off by default (fail-closed) |
| `KAFKA_BROKERS` | `localhost:9092` | Comma-separated bootstrap brokers |
| `KAFKA_CLIENT_ID` | `iot-billing-kafka-connect` | Client id |
| `KAFKA_GROUP_ID` | `iot-billing-blockchain-sink` | Consumer group (offset persistence) |
| `KAFKA_BLOCKCHAIN_EVENTS_TOPIC` | `blockchain.events` | Source topic |
| `KAFKA_CONNECT_VERIFY_PUBLIC_KEY` | unset | Ed25519 PEM/SPKI-DER verification key |
| `KAFKA_SSL` | `false` | Broker TLS |
| `KAFKA_SASL_USERNAME` / `KAFKA_SASL_PASSWORD` | unset | SCRAM-SHA-256 SASL |

## Testing

- `tests/unit/stream/kafka_connect/record_codec.test.ts` — decode/validation,
  tamper detection, and real-node Ed25519 signature verification.
- `tests/unit/stream/kafka_connect/connector.test.ts` — config schema and task
  fan-out.
- `tests/unit/stream/kafka_connect/sink_task.test.ts` — ordering, offset
  reporting, malformed-drop, publish-failure retry semantics.
- `tests/unit/stream/kafka_connect/worker.test.ts` — KafkaJS consumer wiring,
  batch→sink→commit flow against a fake consumer and in-memory target.

## Deployment

- Run `node dist/stream/kafka_connect_worker.js` enabled via
  `KAFKA_CONNECT_SINK_ENABLED=true`.
- `k8s/kafka-connect-sink-deployment.yaml` + `k8s/kafka-connect-sink-hpa.yaml`
  run 2+ replicas, scale on ledger-stream pending entries, and scrape
  `/metrics`.
- The worker shares the `billing-consumer` service account and needs
  `kafka-brokers`, `redis-url`, and (optionally) SASL credentials in the
  `billing-secrets` secret.