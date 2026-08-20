# Technical Design: Peer-to-Peer Payment Channels for Microtransactions

**Issue Reference:** [#295](https://github.com/IoT-Billing-Service/IoT-Billing-Service/issues/295)  
**Status:** Approved & Implemented  
**Scope:** IoT Billing Platform Core Service & Blockchain Layer  

---

## 1. Executive Summary

In high-density IoT deployments (such as smart energy metering, EV charging stations, mesh telemetry relays, and autonomous drone fleet charging), devices generate millions of microtransactions per day. Committing every individual fractional transaction to an on-chain blockchain ledger induces unacceptable transaction fee overhead, network congestion, and latency (> 2–5 seconds).

This feature introduces a production-ready **Peer-to-Peer (P2P) Payment Channel** architecture. Participating nodes (senders and recipients) lock collateral into an escrow channel once, exchange millions of off-chain cryptographically signed payment vouchers at sub-millisecond speeds, and settle net balances atomically on-chain only upon channel closure or dispute.

---

## 2. Technical Bounds & Requirements

| Metric / Requirement | Target / SLA | Implementation Details |
|---|---|---|
| **Performance SLA** | P99 Latency < 200ms | In-memory cryptographic signature verification and state evaluation executing in < 5ms per voucher (< 1ms CPU). |
| **Security** | Tamper-evident & Cryptographically Verified | Ed25519 / EIP-712 digital signatures, SHA-256 state digests, strictly monotonic sequence counters, cumulative amount guarantees. |
| **Compliance** | PCI-DSS & SOC2 | Non-custodial voucher processing; zero storage of plaintext private keys; immutable append-only audit trail with previous-hash chaining (PCI-DSS req 4.2, 10.3; SOC2 CC6.1, CC7.2). |
| **Fault Tolerance** | Unilateral Dispute Resolution | Timelocked challenge window allowing honest parties to settle with the latest signed state if a counterparty goes offline or attempts fraud. |

---

## 3. Protocol Architecture & State Machine

### 3.1 Lifecycle States

```
                 [ OPENING ]
                      │ (Deposit locked & initial state attested)
                      ▼
                   [ OPEN ] ◄──────────────┐ (Top-up deposit)
                      │                    │
        ┌─────────────┴─────────────┐      │
        │ (Cooperative Close)       │ (Unilateral Dispute)
        ▼                           ▼
   [ CLOSING ]                [ DISPUTED ]
        │                           │ (Challenge window expires)
        └─────────────┬─────────────┘
                      ▼
                  [ SETTLED ]
```

1. **`OPENING` / `OPEN`**: Sender creates a channel by depositing an initial balance, setting an expiration epoch, and registering recipient and channel parameters.
2. **Off-Chain Microtransactions**: The sender issues successive cryptographically signed payment vouchers to the recipient:
   - Each voucher includes `(channelId, sequenceNumber, cumulativeAmount, nonce, expiresAt)`.
   - The sequence number is strictly incremented ($S_{k+1} > S_k$).
   - The cumulative amount is non-decreasing ($A_{k+1} \ge A_k$) and cannot exceed the total deposited balance ($A \le \text{totalDeposit}$).
3. **`CLOSING` / `SETTLED` (Cooperative Path)**: When the interaction finishes, sender and recipient co-sign the final state voucher. The contract / billing engine immediately disburses the accumulated amount to the recipient and returns remaining collateral to the sender.
4. **`DISPUTED` (Unilateral Challenge Path)**: If one party becomes unresponsive or malicious, either party can submit the latest valid voucher to trigger a dispute challenge window (e.g. 24 hours). If no newer valid voucher with a higher sequence number is presented before the deadline, the channel settles at the claimed state.

---

## 4. Cryptographic Specification

### 4.1 Voucher Structure & Canonical Hash
```typescript
interface PaymentChannelVoucher {
  channelId: string;         // UUID / Bytes32 identifier
  sequence: number;          // Monotonically increasing (1, 2, 3...)
  cumulativeAmount: bigint;  // Total stroops / micro-units authorized
  nonce: string;             // Anti-replay entropy (Hex / UUID)
  expiresAt: number;         // Unix timestamp (seconds)
}
```

The canonical hash is computed deterministically using SHA-256 over sorted key-value pairs or EIP-712 structured hashing:
$$\text{Digest} = \text{SHA256}(\text{CanonicalJSON}(\text{Voucher}))$$
$$\text{Signature} = \text{Sign}_{\text{PrivateKey}}(\text{Digest})$$

### 4.2 Replay & Double-Spend Prevention
- **Channel ID Scope**: Every voucher is strictly bound to `channelId`. A voucher from Channel A cannot be applied to Channel B.
- **Monotonic Sequence Enforcement**: Only vouchers with $\text{sequence} > \text{lastRecordedSequence}$ are accepted.
- **Cumulative Monotonicity**: $\text{cumulativeAmount} \ge \text{lastRecordedAmount}$ prevents retroactively reducing owed funds.
- **Collateral Upper Bound**: $\text{cumulativeAmount} \le \text{totalDeposit}$ guarantees full solvency.

---

## 5. API Specification

### `POST /api/v1/payment-channels/open`
Opens a new peer-to-peer payment channel with deposited collateral.
- **Request Body:**
  ```json
  {
    "senderAddress": "0x1111111111111111111111111111111111111111",
    "recipientAddress": "0x2222222222222222222222222222222222222222",
    "totalDeposit": "1000000000",
    "expirationSeconds": 86400,
    "disputePeriodSeconds": 3600
  }
  ```
- **Response:**
  ```json
  {
    "channelId": "chan_01j7abc12345...",
    "senderAddress": "0x1111...",
    "recipientAddress": "0x2222...",
    "totalDeposit": "1000000000",
    "settledAmount": "0",
    "status": "OPEN",
    "sequence": 0,
    "createdAt": "2026-08-20T17:00:00.000Z",
    "expiresAt": "2026-08-21T17:00:00.000Z"
  }
  ```

### `POST /api/v1/payment-channels/voucher/verify`
Cryptographically verifies an off-chain microtransaction voucher in real time.
- **Request Body:**
  ```json
  {
    "channelId": "chan_01j7abc12345...",
    "sequence": 42,
    "cumulativeAmount": "50000",
    "nonce": "e4d3c2b1...",
    "expiresAt": 1787250000,
    "signature": "3045022100...",
    "signerPublicKey": "0x1111..."
  }
  ```
- **Response:**
  ```json
  {
    "isValid": true,
    "channelId": "chan_01j7abc12345...",
    "sequence": 42,
    "cumulativeAmount": "50000",
    "transactedAmount": "1000",
    "remainingDeposit": "999950000",
    "verifiedAt": "2026-08-20T17:01:23.456Z",
    "digest": "9f8a7c6..."
  }
  ```

### `POST /api/v1/payment-channels/close`
Cooperatively closes a channel and settles final net balances.

### `POST /api/v1/payment-channels/dispute`
Initiates a unilateral dispute challenge with the latest signed voucher.

### `POST /api/v1/payment-channels/settle`
Finalizes a settled or expired dispute after challenge window maturation.

### `GET /api/v1/payment-channels/:channelId`
Retrieves live state and audit information for a payment channel.

---

## 6. Monitoring & Observability

### Prometheus Metrics
- `iot_billing_payment_channel_operations_total`: Counter partitioned by `operation` (`open`, `voucher_verify`, `top_up`, `close`, `dispute`, `settle`) and `status` (`success`, `failure`).
- `iot_billing_payment_channel_active_count`: Gauge tracking currently active open channels.
- `iot_billing_payment_channel_operation_duration_seconds`: Histogram tracking latency per operation (with sub-millisecond and < 200ms target buckets).
- `iot_billing_payment_channel_transacted_amount_total`: Counter tracking total cumulative micro-units settled across channels.
- `iot_billing_payment_channel_disputes_total`: Counter tracking unilateral dispute events.

### Alerting Rules (`monitoring/billing_alerts.yml`)
- `PaymentChannelOperationLatencyP99Exceeded`: Triggers when P99 channel evaluation latency exceeds 200ms over a 5-minute window.
- `PaymentChannelDisputeSurge`: Triggers when more than 10 disputes occur within 15 minutes, indicating potential node desynchronization or network anomalies.
- `PaymentChannelInvalidSignatureRateHigh`: Triggers if signature verification failures spike, indicating spoofing attempts or malformed client keys.
