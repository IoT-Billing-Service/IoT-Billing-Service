# Hardware Attestation and Cryptographic Validation

**Issue:** #3  
**Status:** Implemented  
**Author:** IoT Billing Service Team  
**Date:** 2026-07-30  

---

## Table of Contents

- [Problem Statement](#problem-statement)
- [Goals and Non-Goals](#goals-and-non-goals)
- [Technical Bounds](#technical-bounds)
- [Architecture Overview](#architecture-overview)
- [Attestation Pipeline](#attestation-pipeline)
- [Data Model](#data-model)
- [API Reference](#api-reference)
- [Security Properties](#security-properties)
- [Compliance Mapping](#compliance-mapping)
- [Monitoring and Alerting](#monitoring-and-alerting)
- [Performance Budget](#performance-budget)
- [Testing Strategy](#testing-strategy)
- [Threat Model](#threat-model)
- [Future Work](#future-work)

---

## Problem Statement

IoT devices connecting to the billing platform must be cryptographically verified
before their telemetry data can be trusted for billing. Without hardware attestation:

- A malicious device can impersonate a legitimate device (spoofing).
- A compromised device can replay old attestation results (replay attack).
- There is no cryptographic audit trail linking a billing transaction to a
  specific, verified hardware identity.

This feature implements a decentralised hardware attestation pipeline that is
append-only, cryptographically bound, and auditable — satisfying PCI-DSS and
SOC2 requirements.

---

## Goals and Non-Goals

### Goals

- Verify device identity via Ed25519 signatures before admitting telemetry.
- Prevent replay attacks via a nonce guard scoped to a sliding time window.
- Detect revoked hardware certificates without rekeying all devices.
- Persist an append-only attestation record for every successful verification.
- Expose Prometheus metrics for attestation throughput, failure rates, and latency.
- Alert on anomalous failure rates and certificate revocation spikes.

### Non-Goals

- Full TPM / TEE attestation (hardware root of trust): out of scope for phase 1.
- Certificate issuance or lifecycle management (handled by a separate CA service).
- Revocation list distribution (registry is updated via admin API and replicated).

---

## Technical Bounds

| Constraint | Target |
|---|---|
| P99 billing operation latency | < 200 ms |
| Attestation endpoint P99 latency | < 50 ms |
| Cryptography primitive | Ed25519 (via tweetnacl) |
| Replay window | 5 000 ms |
| Max clock drift | 30 000 ms |
| Compliance | PCI-DSS req 4.2 / SOC2 CC6.1, CC6.7 |

---

## Architecture Overview

```
IoT Device
  │
  │  POST /attestation  (deviceId, publicKey, nonce, timestamp, certSerial, signature)
  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          AttestationService                                 │
│                                                                             │
│  1. Schema validation           (sync, ~1 µs)                               │
│  2. Timestamp drift check       (sync, ~1 µs)                               │
│  3. Nonce replay guard          (sync / Redis, ~1 ms)                       │
│  4. Ed25519 signature verify    (sync, ~50 µs)                              │
│  5. Certificate registry lookup (async Prisma, ~5 ms)                       │
│  6. Revocation check            (sync, ~1 µs)                               │
│  7. Attestation record persist  (async Prisma, ~5 ms)                       │
│  8. Prometheus metrics emit     (sync, ~1 µs)                               │
└─────────────────────────────────────────────────────────────────────────────┘
         │                          │
         ▼                          ▼
  HardwareCertificate         AttestationRecord
  (Prisma / PostgreSQL)       (Prisma / PostgreSQL)
```

The verification path is almost entirely synchronous.  Only steps 5 and 7 touch
async I/O, keeping the P99 latency well under the 50 ms budget and far below the
200 ms billing operation target.

---

## Attestation Pipeline

### Step 1 – Schema Validation

All six required fields are present and have the correct types and lengths:

- `deviceId`: non-empty string
- `publicKey`: exactly 64 hex characters (32 bytes Ed25519 public key)
- `nonce`: non-empty string
- `timestamp`: finite number (Unix epoch milliseconds)
- `certSerial`: non-empty string
- `signature`: exactly 128 hex characters (64 bytes Ed25519 signature)

**Failure:** `ATTEST_ERR_INVALID_PAYLOAD` → HTTP 400

### Step 2 – Timestamp Drift Check

The absolute difference between the device-supplied `timestamp` and the
server clock must be ≤ `MAX_TIMESTAMP_DRIFT_MS` (30 s by default). This
prevents an attacker from pre-computing valid attestations and replaying them
outside the nonce window.

**Failure:** `ATTEST_ERR_STALE_TIMESTAMP` → HTTP 400

### Step 3 – Nonce Replay Guard

The nonce is consumed atomically in the replay-guard store. If the same nonce
has been seen within the last `ATTESTATION_NONCE_WINDOW_MS` (5 s), the request
is rejected immediately. The guard is implemented as an in-memory LRU window
for single-node deployments; the interface is swappable for a Redis-backed
variant in multi-node setups.

**Failure:** `ATTEST_ERR_REPLAY` → HTTP 409

### Step 4 – Ed25519 Signature Verification

The device signs the canonical message:

```
<deviceId>|<publicKey>|<nonce>|<timestamp>|<certSerial>
```

using its Ed25519 private key.  The server verifies the detached signature via
`nacl.sign.detached.verify` from `tweetnacl`.

The pipe (`|`) separator prevents field-merging ambiguities (e.g., a `deviceId`
of `"A|B"` with an empty `publicKey` cannot collide with `deviceId = "A"` and
`publicKey = "B"`).

**Failure:** `ATTEST_ERR_SIGNATURE_MISMATCH` → HTTP 401

### Step 5 – Certificate Registry Lookup

The `HardwareCertificate` table is queried by `certSerial`.  If the certificate
is not found the request is rejected; the device must be provisioned before it
can attest.

**Failure:** `ATTEST_ERR_CERT_MISSING` → HTTP 404

### Step 6 – Revocation Check

If the certificate's `revoked` flag is `true` the request is rejected.
Certificate revocation is the primary mechanism for removing a compromised device
from the network without requiring all healthy devices to re-key.

**Failure:** `ATTEST_ERR_CERT_REVOKED` → HTTP 403

### Step 7 – Attestation Record Persistence

A SHA-512/256 digest of the canonical message is computed and stored alongside
the attestation metadata in the `attestation_records` table.  Records are
append-only: once written they are never mutated.  This creates an auditable,
tamper-evident history of every device attestation.

### Step 8 – Metrics Emission

Prometheus counters and histograms are updated synchronously after step 7.

---

## Data Model

### `HardwareCertificate` (existing)

```prisma
model HardwareCertificate {
  serial    String   @id
  model     String
  batch     String
  revoked   Boolean  @default(false)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

### `AttestationRecord` (new)

```prisma
model AttestationRecord {
  id            String   @id @default(cuid())
  deviceId      String
  publicKey     String
  certSerial    String
  nonce         String
  messageDigest String
  attestedAt    DateTime @default(now())
  createdAt     DateTime @default(now())

  certificate HardwareCertificate @relation(fields: [certSerial], references: [serial])

  @@index([deviceId])
  @@index([certSerial])
  @@index([attestedAt])
}
```

The `messageDigest` is the first 32 bytes (64 hex chars) of the SHA-512 hash
of the canonical message.  It uniquely identifies the attested state and can
be used to reproduce the verification without the original payload.

---

## API Reference

### `POST /attestation`

Submit a device attestation request.

**Request body:**

```json
{
  "deviceId": "MTR-001",
  "publicKey": "a1b2c3...",
  "nonce": "unique-random-value",
  "timestamp": 1722297600000,
  "certSerial": "CERT-2026-001",
  "signature": "d4e5f6..."
}
```

**Success response (200):**

```json
{
  "success": true,
  "deviceId": "MTR-001",
  "attestedAt": "2026-07-30T05:22:44.920Z",
  "messageDigest": "a3f8..."
}
```

**Error response (example 401):**

```json
{
  "success": false,
  "errorCode": "ATTEST_ERR_SIGNATURE_MISMATCH",
  "reason": "Ed25519 signature verification failed",
  "deviceId": "MTR-001"
}
```

### `GET /attestation/health`

Liveness probe for the attestation service.

**Response (200):**

```json
{
  "status": "ok",
  "service": "hardware-attestation",
  "timestamp": "2026-07-30T05:22:44.920Z"
}
```

### Error Code → HTTP Status Mapping

| Error code | HTTP status | Meaning |
|---|---|---|
| `ATTEST_OK` | 200 | Attestation accepted |
| `ATTEST_ERR_INVALID_PAYLOAD` | 400 | Schema validation failure |
| `ATTEST_ERR_STALE_TIMESTAMP` | 400 | Timestamp outside drift window |
| `ATTEST_ERR_SIGNATURE_MISMATCH` | 401 | Ed25519 verification failed |
| `ATTEST_ERR_CERT_REVOKED` | 403 | Certificate revoked |
| `ATTEST_ERR_CERT_MISSING` | 404 | Certificate not in registry |
| `ATTEST_ERR_REPLAY` | 409 | Nonce already consumed |
| `ATTEST_ERR_CHAIN_INVALID` | 422 | Certificate chain invalid |
| `ATTEST_ERR_INTERNAL` | 500 | Unexpected internal error |

---

## Security Properties

### Binding

Each attestation is cryptographically bound to the tuple
`(deviceId, publicKey, nonce, timestamp, certSerial)`.  Altering any field
invalidates the signature.

### Non-repudiation

The persisted `messageDigest` allows any auditor to independently verify that
the device held the private key corresponding to `publicKey` at `attestedAt`.

### Replay resistance

The nonce guard rejects any nonce that has already been consumed within the
replay window.  Even if an attacker captures a valid attestation request, they
cannot reuse it after the first submission.

### Forward secrecy for revoked devices

Certificate revocation immediately prevents any future attestation attempts
without requiring the device's public key to be rotated.  Existing
`AttestationRecord` rows remain valid history.

### Append-only audit trail

`AttestationRecord` rows are never updated or deleted.  This provides an
immutable, time-ordered ledger of all device attestations, satisfying PCI-DSS
audit requirements.

---

## Compliance Mapping

| Requirement | Standard | How it is addressed |
|---|---|---|
| Strong cryptography for data in transit | PCI-DSS Req 4.2 | Ed25519 signatures; no symmetric shared secrets over the wire |
| Logical access controls | SOC2 CC6.1 | Only devices with a valid, non-revoked certificate are admitted |
| Transmission protection | SOC2 CC6.7 | TLS at the transport layer; Ed25519 at the application layer |
| Audit logging | PCI-DSS Req 10.3, SOC2 CC7.2 | Append-only `AttestationRecord` table with `messageDigest` |
| Key management | PCI-DSS Req 3.6 | Public keys are stored; private keys never leave the device |
| Anomaly detection | SOC2 CC7.3 | Prometheus alerts on failure rate and revocation spikes |

---

## Monitoring and Alerting

### Prometheus Metrics

| Metric | Type | Labels | Description |
|---|---|---|---|
| `attestation_requests_total` | Counter | `result` (success/failure) | Total attestation attempts |
| `attestation_failures_total` | Counter | `error_code` | Failures by error code |
| `attestation_duration_ms` | Histogram | — | End-to-end latency of attestation |
| `attestation_cert_revocations_total` | Counter | — | Requests rejected due to revoked cert |

### Prometheus Alert Rules

See `monitoring/billing_alerts.yml`, group `iot_attestation_alerts`:

- **AttestationHighFailureRate** — fires when the failure rate exceeds 10% over
  5 minutes (indicates an attack or misconfiguration).
- **AttestationP99LatencyHigh** — fires when P99 exceeds 50 ms (service
  degradation).
- **AttestationCertRevocationSpike** — fires when more than 5 revocations are
  observed in 1 minute (possible key compromise event; trigger incident response).
- **AttestationServiceDown** — fires when the health endpoint returns no
  metrics for 2 minutes.

---

## Performance Budget

The attestation pipeline is designed for sub-50 ms P99 at the HTTP layer:

| Step | Expected time |
|---|---|
| Schema validation | ~1 µs |
| Timestamp check | ~1 µs |
| Nonce guard (in-process) | ~1 µs |
| Ed25519 verify (tweetnacl) | ~50 µs |
| Prisma cert lookup (PostgreSQL, warm) | ~5 ms |
| Revocation check | ~1 µs |
| Prisma record insert (PostgreSQL) | ~5 ms |
| Prometheus counter increment | ~1 µs |
| HTTP overhead (Fastify) | ~1 ms |
| **Total P99 (estimate)** | **~12 ms** |

The 200 ms billing operation P99 budget is easily accommodated.

---

## Testing Strategy

### Unit tests (`backend/tests/unit/crypto/attestation.test.ts`)

- Happy path (valid keypair, fresh nonce, non-revoked cert)
- All 9 error codes individually
- Timestamp drift edge cases (exactly at limit, just over)
- Nonce replay (same nonce submitted twice)
- Certificate revocation
- Schema validation (missing fields, wrong lengths)
- Concurrent attestation requests (no race on nonce consumption)
- `InMemoryAttestationNonceGuard` prune/dispose lifecycle
- `PrismaBackedCertificateRegistry` and `PrismaBackedAttestationStore` with mocked Prisma

### Integration tests (`backend/tests/integration/e2e_attestation_flow.test.ts`)

- Full Fastify route: POST /attestation happy path
- POST /attestation error codes map to correct HTTP statuses
- GET /attestation/health returns 200
- Rate-limiting behaviour (too many requests)

---

## Threat Model

| Threat | Mitigation |
|---|---|
| Device impersonation | Ed25519 signature verification (step 4) |
| Replay attack | Nonce guard + timestamp drift check (steps 2-3) |
| Certificate forgery | Trust anchor: registry is write-only via admin API with JWT auth |
| Key compromise | Certificate revocation (step 6); operator revokes via admin endpoint |
| Timing side-channel | `nacl.sign.detached.verify` uses constant-time comparison |
| DoS via large payloads | Fastify body size limit (default 1 MB); schema validation rejects early |
| Metric cardinality explosion | Error-code label (bounded set of 9 values) only; no device-id labels |

---

## Future Work

- **Redis-backed nonce guard** for multi-node / horizontally-scaled deployments.
- **TPM 2.0 / TEE integration** for hardware root of trust (phase 2).
- **Certificate transparency log** (append-only Merkle tree over attestation records).
- **Batch attestation** endpoint for factory provisioning of large device batches.
- **Attestation expiry** — force periodic re-attestation after N days to detect
  long-lived compromised devices.
