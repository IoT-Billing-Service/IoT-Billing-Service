# Blockchain Transaction Explorer for IoT Payment Auditing

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           IoT Devices (Edge)                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │ Smart Meter │  │ EV Charger  │  │Solar Inverter│  │Industrial   │        │
│  │             │  │             │  │              │  │  Sensor     │        │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘        │
└─────────┼────────────────┼────────────────┼────────────────┼───────────────┘
          │                │                │                │
          └────────────────┴────────────────┴────────────────┘
                                   │
                    ┌──────────────┴──────────────┐
                    │   IoT Gateway / MQTT Broker │
                    │   (TLS 1.3, mTLS certs)   │
                    └──────────────┬──────────────┘
                                   │
┌──────────────────────────────────┴───────────────────────────────────────┐
│                        Transaction Explorer API                             │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  Fastify REST API (P99 < 200ms)                                    │  │
│  │  ├── POST /transactions          → Record billing event            │  │
│  │  ├── GET  /transactions          → Query with filters + pagination    │  │
│  │  ├── GET  /transactions/:id      → Get single transaction            │  │
│  │  ├── POST /transactions/:id/verify → Cryptographic verification      │  │
│  │  ├── GET  /audit-log             → Compliance audit trail           │  │
│  │  ├── GET  /health                → System health + metrics          │  │
│  │  └── GET  /metrics               → Prometheus-compatible metrics    │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│  ┌────────────────────────────────┴────────────────────────────────────┐   │
│  │                    TransactionExplorer Core                        │   │
│  │  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │   │
│  │  │ In-Memory Index  │  │  Audit Log       │  │  Metrics Engine  │  │   │
│  │  │ (O(1) lookups)   │  │  (Chain-hashed)  │  │  (P50/P99/TP99)  │  │   │
│  │  │                  │  │                  │  │                  │  │   │
│  │  │ • byId           │  │ • Append-only    │  │ • Latency hist   │  │   │
│  │  │ • byDevice       │  │ • Tamper-evident │  │ • Error rate     │  │   │
│  │  │ • byCustomer     │  │ • PCI-DSS/SOC2   │  │ • Throughput     │  │   │
│  │  │ • byStatus       │  │                  │  │                  │  │   │
│  │  │ • byTime (sorted)│  │                  │  │                  │  │   │
│  │  │ • byRegion       │  │                  │  │                  │  │   │
│  │  └──────────────────┘  └──────────────────┘  └──────────────────┘  │   │
│  └────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│  ┌────────────────────────────────┴────────────────────────────────────┐   │
│  │                  Cryptographic Verification Engine                  │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐            │   │
│  │  │ SHA-256 Hash │  │ Ed25519 Sig  │  │ Merkle Tree  │            │   │
│  │  │              │  │ Verification │  │ Batch Verify │            │   │
│  │  │ • tx hash    │  │ • envelope   │  │ • root hash  │            │   │
│  │  │ • envelope   │  │ • signatures │  │ • inclusion  │            │   │
│  │  │ • chain hash │  │ • public key │  │ • proofs     │            │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘            │   │
│  └────────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────────┘
                                   │
                    ┌──────────────┴──────────────┐
                    │     Stellar Blockchain       │
                    │  (Soroban Smart Contracts)   │
                    │  • Payment operations          │
                    │  • Contract invocations        │
                    │  • Ledger sequence tracking    │
                    └───────────────────────────────┘
```

## Performance Design

### P99 < 200ms Target

| Component | Strategy | Expected Latency |
|-----------|----------|-----------------|
| **Write** | In-memory index insert + async audit log append | ~5-15ms |
| **Read (filtered)** | Set intersection on indexed fields | ~10-30ms |
| **Read (by ID)** | HashMap lookup | ~0.1ms |
| **Verification** | SHA-256 + signature check | ~20-50ms |
| **API overhead** | Fastify parsing + serialization | ~5-10ms |
| **Total P99** | Worst-case: large intersection + pagination | **< 150ms** |

### Indexing Strategy

```
Primary Index:    Map<string, IndexEntry>     byId
Secondary Indexes: Map<string, Set<string>>    byDevice, byCustomer, byRegion, byDeviceType
Status Index:      Map<Status, Set<string>>    byStatus
Time Index:        IndexEntry[]                byTime (sorted desc, for range queries)
TxHash Index:      Map<string, string>         byTxHash → id

Query Execution:
  1. Intersect applicable secondary indexes
  2. Apply post-filter (date range, amount range)
  3. Sort by timestamp (already sorted in time index)
  4. Slice for pagination
```

## Security Model

### Cryptographic Verification

```
Transaction Record (off-chain)          Blockchain Envelope (on-chain)
┌─────────────────────────┐            ┌─────────────────────────┐
│ id: uuid                │            │ txHash: sha256          │
│ deviceId: string        │            │ sourceAccount: G...     │
│ customerId: string      │  verify    │ sequence: 12345         │
│ amount: {stroops}       │  ────────► │ operations: [...]       │
│ status: confirmed       │            │ signatures: [...]       │
│ txHash: sha256          │            │ fee: 100 stroops        │
│ ledgerSequence: 12345   │            │ networkPassphrase       │
└─────────────────────────┘            └─────────────────────────┘
         │                                       │
         └──────────► hashMatch? ◄───────────────┘
                      signatureValid?
                      ledgerConfirmed?
                              │
                              ▼
                    VerificationResult
                    { isValid, verifiedAt, ... }
```

### Tamper Detection

```
Audit Log Chain:
Entry 0: hash = SHA256(data_0 + "0...0")
Entry 1: hash = SHA256(data_1 + entry_0.hash)
Entry 2: hash = SHA256(data_2 + entry_1.hash)
...
Entry N: hash = SHA256(data_N + entry_{N-1}.hash)

To verify: recompute all hashes and check chain.
To tamper: must recompute ALL subsequent hashes.
```

## Compliance Mapping

### PCI-DSS Level 1

| Requirement | Implementation | Evidence |
|-------------|----------------|----------|
| **4.2** Strong cryptography | SHA-256 for hashing, Ed25519 for signatures | `crypto-engine.ts` |
| **10.2** Audit trail coverage | Every transaction event logged with chain hash | `AuditLog` class |
| **10.3** Audit log integrity | Chain-hashed, append-only log | `verifyAuditLog()` |
| **10.5** Log protection | Read-only log entries, no deletion API | Immutable `AuditLogEntry` |
| **11.4** Intrusion detection | Tamper detection via hash mismatch | `detectTampering()` |

### SOC2 Type II

| Trust Service Criteria | Control | Evidence |
|------------------------|---------|----------|
| **CC6.1** Logical access | All access logged in audit trail | `actor` field in audit log |
| **CC6.2** Prior to access | Authentication via verifier key | `verifierKey` parameter |
| **CC7.2** System monitoring | Health checks + metrics | `/health`, `/metrics` endpoints |
| **CC7.3** System changes | All status changes logged | `updateStatus()` audit trail |
| **CC8.1** Change management | Immutable transaction records | `BillingTransaction` readonly |

## Data Flow

```
1. IoT Device sends billing event
   └──► Gateway validates device cert (mTLS)
        └──► POST /transactions
             └──► TransactionExplorer.recordTransaction()
                  ├──► Generate nonce (replay protection)
                  ├──► Compute SHA-256 hash
                  ├──► Insert into in-memory index
                  ├──► Append to audit log (chain hash)
                  └──► Return { id, hash }

2. Auditor queries transactions
   └──► GET /transactions?deviceId=X&status=confirmed
        └──► TransactionExplorer.queryTransactions()
             ├──► Intersect indexes (byDevice ∩ byStatus)
             ├──► Apply date/amount filters
             ├──► Sort by timestamp
             ├──► Paginate (limit/offset/cursor)
             └──► Return PaginatedResult<BillingTransaction>

3. Compliance officer verifies
   └──► POST /transactions/:id/verify
        └──► TransactionExplorer.verifyTransaction()
             ├──► Fetch local record from index
             ├──► Hash on-chain envelope
             ├──► Verify signatures
             ├──► Compare txHash match
             ├──► Check ledger confirmation
             ├──► Log verification attempt
             └──► Return VerificationResult
```

## Deployment

### Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist/ ./dist/
EXPOSE 3000
ENV VERIFIER_KEY=${VERIFIER_KEY}
CMD ["node", "dist/index.js"]
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | API server port | `3000` |
| `VERIFIER_KEY` | Public key for verification | `default-verifier` |
| `NODE_ENV` | `production` or `development` | `development` |

### Monitoring

```yaml
# Prometheus scrape config
scrape_configs:
  - job_name: 'iot-billing-explorer'
    static_configs:
      - targets: ['explorer:3000']
    metrics_path: '/metrics'
    scrape_interval: 15s
```

## Testing

```bash
# Unit tests
pnpm test

# Coverage (threshold: 80% lines, 80% functions, 75% branches)
pnpm test:coverage

# Performance benchmark
pnpm test -- --reporter=verbose tests/explorer.test.ts
```
