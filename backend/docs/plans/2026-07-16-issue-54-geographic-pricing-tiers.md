# Geographic Pricing Tiers Based on Node Location

**Issue:** #54  
**Date:** 2026-07-16  
**Status:** Implemented

---

## Problem Statement

IoT devices are deployed globally. Operational costs — infrastructure, data-egress fees,
compliance overhead — vary significantly by geography. A flat rate is unfair to the platform
in high-cost regions (NA, EU) and uncompetitive in cost-optimised regions (APAC, LATAM, MEA).

This document describes the design for region-aware billing multipliers applied at cycle
finalization time.

---

## Technical Bounds

| Constraint | Target |
|---|---|
| P99 billing operation latency | **< 200ms** |
| Cryptographic verification | All transactions signed; pricing table integrity via SHA-256 digest |
| Compliance | PCI-DSS (immutable rate table + audit trail) and SOC2 (tamper-evident log) |

---

## Architecture

### Region Taxonomy

Devices are assigned a two-letter ISO 3166-1 alpha-2 **country code** (`devices.country_code`).
The billing engine maps country codes → one of six `BillingRegion` values:

| Region | Description |
|---|---|
| `NA` | North America |
| `EU` | European Union / EEA |
| `APAC` | Asia-Pacific |
| `LATAM` | Latin America |
| `MEA` | Middle East & Africa |
| `ROW` | Rest of World (fallback, 1.0× — no premium/discount) |

### Multiplier Table

| Region | Multiplier | Notes |
|---|---|---|
| `NA` | 1.20× | Higher infra + compliance cost |
| `EU` | 1.15× | GDPR compliance overhead |
| `APAC` | 0.90× | Cost-optimised compute |
| `LATAM` | 0.80× | Market development discount |
| `MEA` | 0.75× | Market development discount |
| `ROW` | 1.00× | Neutral baseline |

Multipliers are defined in `src/billing/geo_pricing.ts` as a sealed compile-time constant.
Any change is a code change, captured in git history, satisfying SOC2 change-management requirements.

### Integer Arithmetic

To avoid IEEE-754 float rounding errors on billing charges, all multiplications use integer
arithmetic scaled by 10,000:

```
adjusted = ceil(base * round(multiplier * 10_000) / 10_000)
```

Ceiling-rounding ensures no fractional micro-unit is lost for the platform.

### Cryptographic Integrity (PCI-DSS / SOC2)

`pricingTableDigest()` returns a SHA-256 hex digest of the serialised tier table.
This digest is:

1. Returned on every `/api/pricing/tiers` response for client verification.
2. Stored in `geo_pricing_snapshots` alongside the billing cycle at finalization
   time so auditors can verify that the rate that was applied matches the
   current (or historical) table.

### Database Schema

Two schema changes:

```sql
-- devices: nullable country_code, fallback to ROW tier
ALTER TABLE devices ADD COLUMN country_code CHAR(2);

-- audit snapshot per billing cycle
CREATE TABLE geo_pricing_snapshots (
  id            TEXT PRIMARY KEY,
  cycle_id      TEXT UNIQUE REFERENCES billing_cycles(id),
  table_digest  TEXT NOT NULL,
  table_json    JSONB NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now()
);
```

---

## API Surface

### `GET /api/pricing/tiers`  _(requires JWT)_

Returns the full tier table and SHA-256 integrity digest.

```json
{
  "digest": "a3f0...",
  "tiers": [
    {
      "region": "NA",
      "name": "North America",
      "multiplier": 1.2,
      "currency": "USD",
      "countryCodes": ["CA", "MX", "US"]
    }
  ],
  "generatedAt": "2026-07-16T12:00:00.000Z"
}
```

### `GET /api/pricing/tiers/:region`  _(requires JWT)_

Returns details for a single region (e.g. `/api/pricing/tiers/EU`).

### `POST /api/pricing/preview`  _(no auth — safe for calculators)_

Preview the adjusted charge for a base amount and country code.

```json
// Request
{ "baseCharge": 1000, "countryCode": "DE" }

// Response
{
  "countryCode": "DE",
  "region": "EU",
  "tier": { "name": "European Union / EEA", "multiplier": 1.15, "currency": "EUR" },
  "baseCharge": 1000,
  "adjustedCharge": 1150,
  "tableDigest": "a3f0..."
}
```

### `PUT /api/admin/devices/:deviceId/region`  _(requires X-Admin-Key)_

Set a device's country code and therefore billing region.

---

## Billing Finalizer Integration

`finalizeBillingCycle()` now accepts an optional `countryCode` in `FinalizeOptions`.
When provided:

1. `applyGeoMultiplier()` is called (O(1) — two hash lookups).
2. The resolved region, multiplier, and table digest are included in `FinalizationResult.geo`.
3. Callers (settlement, event pipeline) pass the device's `countryCode` through so the
   final charge is adjusted before Stellar settlement.

---

## Monitoring

Three new Prometheus metrics:

| Metric | Type | Description |
|---|---|---|
| `geo_pricing_charges_total{region}` | Counter | Charges adjusted per region |
| `geo_pricing_multiplier_applied{region}` | Histogram | Multiplier distribution per region |
| `geo_pricing_unknown_country_codes_total` | Counter | ROW fallbacks (unknown/missing country) |

---

## Performance

All lookups are pure in-memory `Map` reads. Benchmarks show < 0.01ms per call,
comfortably within the < 200ms P99 billing operation budget even at 10k devices/s.

---

## Security

- The tier table is a compile-time constant: no runtime mutation path exists.
- Admin endpoints require `X-Admin-Key` (same pattern as other admin routes).
- The `countryCode` field on devices is set only by admin API; devices cannot self-assign.
- Digest verification lets any consumer independently confirm the rate applied.

---

## Testing

`tests/unit/billing/geo_pricing.test.ts` covers:

- Region resolution for all 6 regions + fallback cases
- Null/undefined/empty/mixed-case/whitespace inputs
- Multiplier application correctness (integer arithmetic, ceiling rounding)
- Zero and very large BigInt charges
- Digest determinism and format
- Map consistency (every country in country map has a tier)
- Performance: 10,000 iterations in < 1ms each
