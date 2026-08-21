# Capacity Planning with Historical Usage Trending

**Issue:** #87  
**Added:** 2026-07-17

---

## Overview

The `/api/analytics/capacity-planning` endpoint provides historical usage trending
and forward-looking capacity projections for IoT devices and accounts.  It is built
entirely on top of the existing TimescaleDB continuous-aggregate views and the
shared tenant pool proxy, introducing no new background jobs or database tables.

---

## Endpoint

```
GET /api/analytics/capacity-planning
Authorization: Bearer <JWT>
```

### Query parameters

| Parameter     | Default | Description |
|---------------|---------|-------------|
| `deviceId`    | —       | Device ID filter (required unless `accountId` is supplied) |
| `accountId`   | —       | Account ID filter (required unless `deviceId` is supplied) |
| `period`      | `daily` | Aggregation period: `daily`, `weekly`, or `monthly` |
| `lookbackDays`| `30`    | Historical window length in days (1–365) |
| `horizonDays` | `30`    | Projection horizon in days (1–365) |

At least one of `deviceId` or `accountId` must be provided.

### Response schema

```jsonc
{
  "deviceId": "dev-001",          // null when queried by accountId only
  "accountId": null,              // null when queried by deviceId only
  "period": "daily",
  "lookbackDays": 30,
  "viewUsed": "daily_device_usage",
  "trend": {
    "slopePerDay": 12.4,          // linear regression slope (usage units/day)
    "r2": 0.91,                   // goodness-of-fit [0, 1]
    "avgUsage": 320.0,            // mean usage over the lookback window
    "peakUsage": 580.0,           // maximum usage in the lookback window
    "coefficientOfVariation": 0.18, // stddev/mean (0 = perfectly stable)
    "dataPoints": 30
  },
  "projection": {
    "horizonDays": 30,
    "projectedUsage": 692.0,      // avg + slope * horizonDays
    "growthRate": 1.16            // (projected - avg) / avg
  },
  "lastDataPoint": "2026-07-16T00:00:00.000Z",
  "computedAt": "2026-07-17T02:00:00.000Z"
}
```

---

## Data Sources

| Filter       | View used                 | Notes |
|--------------|---------------------------|-------|
| `deviceId`   | `daily_device_usage` / `weekly_device_usage` / `monthly_device_usage` | Selects `total_value` per bucket |
| `accountId` only | `daily_billing_summary` | Aggregates `total_usage` across all devices for the account; period parameter is ignored (always daily) |
| Both         | device-based view         | `accountId` is ignored when `deviceId` is also present (telemetry views don't carry `account_id`) |

---

## Trend Calculation

The trend is computed using **Ordinary Least Squares linear regression**:

1. The `x`-axis is the elapsed time in days from the first bucket in the lookback window.
2. The `y`-axis is `total_value` (or `total_usage`) for each bucket.
3. The regression produces a **slope** (usage units per day) and an **intercept**.
4. **R²** (Pearson coefficient of determination) quantifies how well the linear model
   fits the data.  R² = 1 means a perfect linear trend; R² near 0 means noisy or
   non-linear growth.
5. **Coefficient of Variation** (σ / μ) flags devices with erratic usage patterns
   (e.g. intermittent activity or usage spikes).  Values > 1 indicate high volatility.

---

## Projection

```
projectedUsage = avgUsage + slopePerDay × horizonDays
growthRate     = (projectedUsage − avgUsage) / avgUsage
```

The projection is a simple linear extrapolation.  It is most reliable when:
- R² is high (≥ 0.7).
- The lookback window is long enough to capture seasonal cycles.
- The coefficient of variation is low (< 0.5).

Negative `growthRate` indicates projected usage decline.

---

## Monitoring

Four Prometheus gauges are updated on every successful request:

| Metric | Description |
|--------|-------------|
| `capacity_utilization_ratio{dimension, period}` | Projected growth rate (dimensionless) |
| `capacity_projected_growth_rate{dimension, period}` | Slope in usage units per day |
| `capacity_trend_data_points{dimension, period}` | Number of historical buckets used |
| `capacity_trend_last_updated_timestamp{dimension, period}` | Unix timestamp of last computation |

The `dimension` label carries the `deviceId` or `accountId` value.  Per-tenant
labels are intentionally omitted to keep cardinality bounded (consistent with the
rest of the metrics surface).

### Suggested Alertmanager rules

```yaml
- alert: CapacityGrowthRateHigh
  expr: capacity_utilization_ratio > 2.0
  for: 1h
  annotations:
    summary: "Device {{ $labels.dimension }} projected to triple usage within horizon"

- alert: CapacityTrendDataStaleness
  expr: time() - capacity_trend_last_updated_timestamp > 3600
  for: 15m
  annotations:
    summary: "Capacity planning data for {{ $labels.dimension }} is stale"
```

---

## Operational Considerations

- **Continuous aggregate lag:** results reflect data up to the end offset of the
  underlying continuous aggregate (1 day for daily, 1 week for weekly, 1 month for
  monthly).  Very recent usage is not yet reflected.
- **Retention:** the 365-day telemetry retention policy limits the maximum useful
  `lookbackDays` to ~360.
- **Cold starts:** a device with fewer than two data points returns a flat trend
  (slope = 0, R² = 0).  Consumers should check `dataPoints` before acting on
  projection output.
- **Billing summary view:** `daily_billing_summary` only aggregates `usage_amount`
  from `billing_records`, which are in Soroban precision (7 decimal places).
  Interpret projected values in the same unit.

---

## Assumptions

1. Linear growth is a reasonable first-order approximation for capacity planning
   horizons of 30–90 days.  Seasonal or exponential patterns are not modelled.
2. Usage spikes are included in the regression; callers should filter anomalous
   devices using `coefficientOfVariation` before acting on projections.
3. The endpoint is read-only and does not modify any state.
4. Security: tenant isolation is enforced by the existing pool proxy; no cross-tenant
   data is ever accessible regardless of filter parameters.
