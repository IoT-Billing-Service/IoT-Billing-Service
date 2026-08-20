# Technical Design: Dynamic Pricing Based on Network Congestion

**Issue Reference:** [#296](https://github.com/IoT-Billing-Service/IoT-Billing-Service/issues/296)  
**Author:** morelucks <luckykamshak@gmail.com>  
**Status:** Approved & Implemented  
**Scope:** IoT Billing Platform Core Service  

---

## 1. Executive Summary

This feature introduces real-time dynamic billing rate adjustments based on network congestion metrics for the IoT Billing Platform. When network congestion is high, surge multipliers disincentivise non-essential bandwidth consumption; during periods of low traffic, discounts encourage load smoothing.

## 2. Technical Bounds & Requirements

| Metric / Bound | Requirement | Design Implementation |
|---|---|---|
| **Performance Target** | P99 Latency < 200ms | Pure synchronous O(1) in-memory integer (BigInt) arithmetic (< 1ms per calculation). |
| **Security Verification** | Cryptographic verification | SHA-256 digest (`congestionPricingDigest`) calculated over input parameters and outputs. |
| **Compliance Standard** | PCI-DSS & SOC2 | Sealed, immutable rate tables at boot; tamper-verification functions (`verifyCongestionPricingIntegrity`). |
| **Auditability** | Structured audit trail | Prometheus metrics and SQL schema (`congestion_pricing_audit_logs`). |

---

## 3. Architecture & Level Taxonomy

### Network Congestion Levels & Multipliers

Network congestion is represented as a normalized score between `0.0` (0% load) and `1.0` (100% load):

| Level | Score Range | Multiplier | Description |
|---|---|---|---|
| **`LOW`** | `0.00` – `0.2499` | **0.90x** (10% Discount) | Abundant network capacity available. |
| **`NORMAL`** | `0.25` – `0.6999` | **1.00x** (Base Rate) | Standard operating bounds. |
| **`HIGH`** | `0.70` – `0.8999` | **1.25x** (25% Surge) | Constrained bandwidth; surge pricing active. |
| **`CRITICAL`** | `0.90` – `1.0000` | **1.50x** (50% Surge) | Critical network load; heavy surge active. |

### Integer Arithmetic & Ceiling Rounding

To maintain sub-millisecond execution and prevent float precision loss, calculations scale multipliers by `10,000n` using integer BigInt ceiling rounding:

$$\text{adjustedCharge} = \left\lfloor \frac{\text{baseCharge} \times \text{multiplierScaled} + 9999}{10000} \right\rfloor$$

This guarantees that fractional micro-units are safely rounded up in favor of the platform balance.

---

## 4. API Specification

### `GET /api/v1/pricing/congestion`
Returns the sealed congestion tier definitions and the SHA-256 table integrity digest.

### `POST /api/v1/pricing/congestion/evaluate`
Evaluates dynamic pricing multiplier for a transaction.
- **Request Body:**
  ```json
  {
    "baseChargeMicros": "10000",
    "score": 0.85,
    "deviceId": "dev_node_9481"
  }
  ```
- **Response Payload:**
  ```json
  {
    "level": "HIGH",
    "tier": {
      "level": "HIGH",
      "name": "High Congestion",
      "multiplier": 1.25
    },
    "score": 0.85,
    "multiplier": 1.25,
    "baseChargeMicros": "10000",
    "adjustedChargeMicros": "12500",
    "appliedAt": "2026-08-20T14:35:00.000Z",
    "digest": "7a3f8c..."
  }
  ```

### `POST /api/v1/pricing/congestion/verify`
Cryptographically verifies that a dynamic pricing calculation output has not been tampered with.

---

## 5. Monitoring & Observability

- **Prometheus Counter:** `iot_billing_congestion_multiplier_applied_total` (labeled by `level`).
- **Prometheus Gauge:** `iot_billing_congestion_score_gauge`.
- **Prometheus Histogram:** `iot_billing_congestion_eval_duration_seconds`.
- **Alert Rules:**
  - `HighNetworkCongestionBillingSurge`: Triggers when `iot_billing_congestion_score_gauge > 0.9` for > 5 minutes.
  - `CongestionPricingLatencyP99Exceeded`: Triggers if P99 calculation duration > 200ms.
