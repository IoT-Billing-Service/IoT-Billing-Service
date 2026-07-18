# Predictive Analytics for Revenue Forecasting — Design Document

## Issue
#58 — Predictive Analytics for Revenue Forecasting

## Overview
This document describes the architecture, data model, and implementation strategy for adding revenue forecasting capabilities to the IoT Billing Platform. The solution provides daily, weekly, and monthly revenue projections with confidence intervals while maintaining the platform's strict performance and security requirements.

## Goals
- Predict revenue 7, 30, and 90 days into the future with ±5% mean absolute percentage error (MAPE)
- Keep billing operation latency under 200ms P99
- Ensure all forecast-related transactions are cryptographically signed and verifiable
- Maintain PCI-DSS and SOC2 compliance (audit trails, data encryption, access controls)

## Non-Goals
- Real-time streaming predictions (batch/pre-computed model)
- Multi-tenant model training per customer (single model per deployment)
- GPU-based deep learning (kept lightweight for edge/IoT billing constraints)

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        IoT Billing Platform                      │
│                                                                  │
│  ┌──────────────┐    ┌──────────────────┐    ┌──────────────┐  │
│  │   Billing    │    │ Revenue Forecast │    │   Monitor    │  │
│  │   API        │◄──►│   Service        │    │   & Alert    │  │
│  │   (<200ms)   │    │   (async/cache)  │    │   (Prom/Grafana)│  │
│  └──────────────┘    └──────────────────┘    └──────────────┘  │
│         │                     │                                  │
│         │            ┌────────┴────────┐                        │
│         │            │  Forecast Cache │                        │
│         │            │  (Redis, 5-min) │                        │
│         │            └─────────────────┘                        │
│         │                                                        │
│  ┌──────┴──────┐    ┌──────────────────┐    ┌──────────────┐  │
│  │ Transaction │    │   Revenue        │    │  Crypto      │  │
│  │ Ledger      │    │   Aggregates     │    │  Verify      │  │
│  │ (signed)    │    │   (PostgreSQL)   │    │  (HMAC)      │  │
│  └─────────────┘    └──────────────────┘    └──────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Data Model

### `revenue_snapshots` (time-series aggregate table)
| Column | Type | Description |
|--------|------|-------------|
| id | BIGSERIAL PK | Surrogate key |
| snapshot_date | DATE NOT NULL | Aggregation date |
| granularity | VARCHAR(10) NOT NULL | `daily`, `weekly`, `monthly` |
| total_revenue | DECIMAL(18,4) NOT NULL | Sum of revenue |
| transaction_count | INTEGER NOT NULL | Count of billed transactions |
| device_count | INTEGER NOT NULL | Unique devices billed |
| avg_ticket_size | DECIMAL(18,4) | Average revenue per transaction |
| metadata | JSONB | Extra dimensions (region, tier, etc.) |
| created_at | TIMESTAMPTZ | Insert timestamp |
| signature | BYTEA NOT NULL | HMAC-SHA256 of the row |

### `revenue_forecasts` (prediction output)
| Column | Type | Description |
|--------|------|-------------|
| id | BIGSERIAL PK | Surrogate key |
| forecast_date | DATE NOT NULL | Date being predicted |
| horizon_days | INTEGER NOT NULL | 7, 30, or 90 |
| predicted_revenue | DECIMAL(18,4) NOT NULL | Point estimate |
| lower_bound | DECIMAL(18,4) | 95% confidence lower |
| upper_bound | DECIMAL(18,4) | 95% confidence upper |
| model_version | VARCHAR(32) | Model identifier |
| generated_at | TIMESTAMPTZ | When forecast was computed |
| signature | BYTEA NOT NULL | HMAC-SHA256 of the row |

## Forecasting Algorithm

We use **Holt-Winters Triple Exponential Smoothing** (additive seasonality, weekly cycle) for daily granularity, and **simple linear regression** on rolling aggregates for weekly/monthly horizons.

Why this choice:
- Deterministic, explainable, audit-friendly (SOC2 requirement)
- No external ML dependencies (keeps deployment simple)
- Fast inference: O(n) where n = history window (default 90 days)
- Easy to cryptographically verify outputs

### Algorithm Parameters
- `alpha` (level smoothing): 0.3
- `beta` (trend smoothing): 0.1
- `gamma` (seasonal smoothing): 0.1
- `seasonal_period`: 7 (weekly cycle typical for IoT billing)

## Security & Compliance

### Cryptographic Verification
Every `revenue_snapshots` and `revenue_forecasts` row is signed with HMAC-SHA256 using a platform secret key (`REVENUE_SIGNING_KEY`). The signature covers all non-signature columns in canonical JSON order. This ensures:
- **Integrity**: Tampering with historical revenue data is detectable
- **Non-repudiation**: Forecasts are provably generated from authentic data
- **Auditability**: SOC2 Type II auditors can verify data lineage

### PCI-DSS Controls
- Revenue data is encrypted at rest (AES-256 via PostgreSQL TDE)
- Signing keys are stored in a secrets manager (HashiCorp Vault / AWS KMS)
- Access to `revenue_snapshots` is restricted to the forecast service role
- All reads are logged to an immutable audit table

### SOC2 Controls
- Forecast generation is logged with `generated_at`, `model_version`, and input hash
- The forecast service emits OpenTelemetry traces for every prediction batch
- Alerting on forecast accuracy drift (MAPE > 10% triggers incident)

## Performance Budget

| Operation | Target | Strategy |
|-----------|--------|----------|
| Billing transaction | < 200ms P99 | Forecast is async; billing path only writes to ledger |
| Forecast query (API) | < 50ms P99 | Pre-computed, served from Redis cache |
| Forecast recompute | < 5s | Runs every 6 hours via cron job; N=90 days |
| Revenue aggregate | < 100ms | Materialized view refreshed hourly |

## API Design

### `GET /api/v1/forecast/revenue`
Query params: `horizon` (7|30|90), `granularity` (daily|weekly|monthly)
Response: `{ forecast: [...], confidenceInterval: { lower, upper }, generatedAt }`

### `GET /api/v1/forecast/accuracy`
Query params: `horizon` (7|30|90), `daysBack` (default 30)
Response: `{ mape, rmse, bias, sampleCount }`

### `POST /api/v1/forecast/refresh` (admin)
Trigger manual forecast recomputation. Requires `forecast:admin` scope.

## Monitoring

- `forecast_mape` (gauge): Tracks model accuracy per horizon
- `forecast_generation_duration_ms` (histogram): Time to recompute
- `forecast_cache_hit_ratio` (gauge): Redis cache effectiveness
- `revenue_signature_verify_failures` (counter): Security incidents

## Deployment

The forecast service is deployed as a sidecar container alongside the billing API. It exposes a private port (not internet-facing) and communicates via Unix socket or localhost. The cron job runs as a Kubernetes CronJob every 6 hours.
