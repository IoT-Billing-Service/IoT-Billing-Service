# Incident Response Runbook Automation with PagerDuty Integration

## Overview

This module provides automated incident response for the IoT billing platform, integrating with PagerDuty for alerting and providing configurable runbooks for common incident scenarios.

### Key Features

- **PagerDuty Events API v2 Integration**: Trigger, acknowledge, and resolve incidents automatically
- **Multi-Source Incident Detection**: Monitor Prometheus alerts, health checks, SLO burn rates, circuit breakers, replication lag, and billing anomalies
- **Automated Runbook Execution**: Execute predefined response steps with support for HTTP requests, database queries, blockchain transactions, notifications, and more
- **Conditional Logic**: Branch execution based on incident severity, source, or context
- **Parallel Execution**: Run multiple response steps concurrently
- **Rollback Support**: Automatic rollback on step failure
- **Template Variables**: Dynamic substitution of incident context into step parameters
- **Prometheus Metrics**: Full observability of incident detection and runbook execution
- **Admin REST API**: Manual incident triggering and runbook management
- **PCI-DSS / SOC2 Compliant**: All actions are auditable through execution history

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Detection       │     │  Runbook Engine   │     │  PagerDuty       │
│  Sources         │────▶│                   │────▶│  Events API      │
│                  │     │  - Step execution │     │  - Trigger       │
│  - Prometheus    │     │  - Condition eval │     │  - Acknowledge   │
│  - Health checks │     │  - Rollback       │     │  - Resolve       │
│  - SLO burn rate │     │  - Metrics        │     └─────────────────┘
│  - Circuit brkr  │     └──────────────────┘
│  - Replication   │              │
│  - Billing anom  │              ▼
└─────────────────┘     ┌──────────────────┐
                        │  Admin REST API   │
                        │  - /api/admin/    │
                        │    incidents      │
                        │    runbooks       │
                        │    executions     │
                        └──────────────────┘
```

## Quick Start

### 1. Environment Configuration

Add to your `.env` file:

```env
# PagerDuty Integration
PAGERDUTY_ROUTING_KEY=your_pagerduty_routing_key
PAGERDUTY_API_BASE_URL=https://events.pagerduty.com/v2

# Incident Detection
INCIDENT_DETECTION_INTERVAL_MS=30000
INCIDENT_MAX_CONCURRENT_EXECUTIONS=10
```

### 2. Integration with Application

```typescript
import { createIncidentResponseModule } from './incident_response/index.js';
import { registerIncidentResponseRoutes } from './incident_response/routes.js';

// Create the module
const config = {
  pagerDuty: {
    routingKey: process.env['PAGERDUTY_ROUTING_KEY'] ?? '',
  },
  detectionIntervalMs: Number(process.env['INCIDENT_DETECTION_INTERVAL_MS']) || 30000,
  maxConcurrentExecutions: Number(process.env['INCIDENT_MAX_CONCURRENT_EXECUTIONS']) || 10,
};

const { engine, detector, start, stop } = createIncidentResponseModule(config);

// Register admin routes
registerIncidentResponseRoutes(app, engine, detector);

// Start detection
start();

// Graceful shutdown
process.on('SIGTERM', () => {
  stop();
});
```

## Built-in Runbooks

### 1. SLO Burn Rate Response (`slo_burn_rate_response`)

Responds to SLO burn rate alerts for billing operations.

**Triggers**: `slo_burn_rate`, `prometheus_alert`

**Steps**:
1. Notify #oncall-billing Slack channel
2. Check billing operation P99 latency from `/metrics`
3. Check circuit breaker states from `/circuit-health`
4. Check replication lag from `/health`
5. **If critical**: Escalate to #engineering-billing and trigger auto-scaling
6. **If warning**: Notify #billing-team

### 2. Circuit Breaker Response (`circuit_breaker_response`)

Handles circuit breaker state changes for Soroban RPC.

**Triggers**: `circuit_breaker`

**Steps**:
1. Notify #oncall-billing Slack channel
2. Check circuit breaker queue depth
3. Check Soroban RPC endpoint health
4. Wait 30 seconds for automatic recovery
5. Verify recovery
6. **If still open**: Escalate to #engineering-billing

### 3. Replication Lag Response (`replication_lag_response`)

Manages replication lag incidents for multi-region DR.

**Triggers**: `replication_lag`

**Steps**:
1. Notify #oncall-billing Slack channel
2. Check replication lag metrics from Prometheus
3. Check secondary region health
4. **If critical**: Initiate planned failover to secondary region

### 4. Billing Anomaly Response (`billing_anomaly_response`)

Responds to billing pipeline anomalies.

**Triggers**: `billing_anomaly`

**Steps**:
1. Notify #oncall-billing Slack channel
2. Check billing pipeline state from `/api/admin/sync-status`
3. Run billing cycle audit query
4. **If critical**: Freeze billing pipeline and pause settlement cron

### 5. Health Check Failure Response (`health_check_failure`)

Handles health check failures.

**Triggers**: `health_check`, `prometheus_alert`

**Steps**:
1. Notify #oncall-billing Slack channel
2. Check main health endpoint
3. Check aggregate health endpoint
4. Wait 15 seconds for automatic recovery
5. Verify recovery
6. **If critical**: Escalate to #engineering-billing

### 6. Chaos Experiment Failure Response (`chaos_experiment_failure`)

Responds to chaos experiment failures.

**Triggers**: `chaos_experiment`

**Steps**:
1. Notify #chaos-engineering Slack channel
2. Check for double finalization events
3. Check for spurious billing computations
4. Document the failure for post-mortem analysis

## Admin REST API

All endpoints require `X-Admin-Key` header matching `ADMIN_SECRET_KEY` environment variable.

### Module Status

```
GET /api/admin/incident-response/status
```

Returns module version, detector stats, engine state, and available runbooks.

### List Runbooks

```
GET /api/admin/runbooks
```

Returns summary of all available runbooks.

### Get Runbook Definition

```
GET /api/admin/runbooks/:name
```

Returns the full runbook definition including all steps.

### Execute Runbook

```
POST /api/admin/runbooks/:name/execute
Content-Type: application/json
X-Admin-Key: your-admin-key

{
  "title": "Manual test incident",
  "description": "Testing the runbook execution",
  "severity": "critical",
  "context": {
    "custom_field": "value"
  }
}
```

### Trigger Incident (Auto-select Runbook)

```
POST /api/admin/incidents
Content-Type: application/json
X-Admin-Key: your-admin-key

{
  "title": "Production incident",
  "description": "Something went wrong",
  "severity": "critical",
  "source": "slo_burn_rate",
  "context": {
    "burn_rate": 14.4,
    "window": "1h"
  }
}
```

### List Executions

```
GET /api/admin/executions
```

Returns execution history with summary for each run.

### Get Execution Details

```
GET /api/admin/executions/:id
```

Returns full execution details including all step results and PagerDuty events.

## Prometheus Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `incident_response_detected_total` | Counter | `source`, `severity` | Total incidents detected |
| `incident_response_triggered_total` | Counter | `runbook` | Incidents that triggered a runbook |
| `incident_response_runbook_executions_total` | Counter | `runbook`, `status` | Runbook execution results |
| `incident_response_runbook_duration_ms` | Histogram | `runbook`, `status` | Runbook execution duration |
| `incident_response_step_executions_total` | Counter | `type`, `status` | Step execution results |
| `incident_response_pagerduty_events_total` | Counter | `action`, `status` | PagerDuty API call results |
| `incident_response_pagerduty_duration_ms` | Histogram | `action` | PagerDuty API call duration |
| `incident_response_active_executions` | Gauge | | Current active executions |
| `incident_response_detection_errors_total` | Counter | `rule` | Detection rule evaluation errors |

## Detection Rules

The module registers the following detection rules on startup:

| Rule | Source | Severity | Suggested Runbook |
|------|--------|----------|-------------------|
| SLO burn rate (1h, 14.4x) | `slo_burn_rate` | `critical` | `slo_burn_rate_response` |
| SLO burn rate (6h, 6x) | `slo_burn_rate` | `warning` | `slo_burn_rate_response` |
| SLO burn rate (3d, 1x) | `slo_burn_rate` | `info` | `slo_burn_rate_response` |
| Circuit breaker (soroban) | `circuit_breaker` | `critical` | `circuit_breaker_response` |
| Replication lag (>5s) | `replication_lag` | `warning` | `replication_lag_response` |
| Replication lag (>30s) | `replication_lag` | `critical` | `replication_lag_response` |
| Double finalization | `billing_anomaly` | `critical` | `billing_anomaly_response` |
| Spurious computation | `billing_anomaly` | `error` | `billing_anomaly_response` |

## Step Types

| Type | Description | Configuration |
|------|-------------|---------------|
| `http_request` | Make an HTTP request | method, url, headers, body, expectedStatuses |
| `database_query` | Execute a database query | query, params, expectedRowCount |
| `blockchain_tx` | Submit a blockchain transaction | contractFunction, args, maxFeeStroops |
| `notification` | Send a notification | channel (slack/email/webhook/pagerduty), message, target |
| `script` | Execute a script/command | command, env, cwd |
| `sleep` | Wait for a duration | durationMs |
| `conditional` | Conditional branching | condition, ifTrue, ifFalse |
| `parallel` | Execute steps in parallel | steps, waitForAll |
| `rollback` | Rollback a previous step | targetStep, rollbackAction |

## Template Variables

Steps support template variable substitution using `{{ variable_name }}` syntax:

- `{{ id }}` — Incident ID
- `{{ title }}` — Incident title
- `{{ description }}` — Incident description
- `{{ severity }}` — Incident severity
- `{{ source }}` — Detection source
- `{{ detectionRule }}` — Detection rule name
- `{{ detectedAt }}` — Detection timestamp
- `{{ dedupKey }}` — PagerDuty deduplication key
- `{{ context.* }}` — Any key from the incident context

## Condition Expressions

Conditional steps support simple comparison expressions:

- `severity == "critical"` — Equality check
- `severity != "info"` — Inequality check
- `context.count >= 10` — Numeric comparison
- `source == "slo_burn_rate"` — Source matching

## Security & Compliance

- **Authentication**: All admin endpoints require `X-Admin-Key` header
- **Audit Trail**: Every runbook execution is recorded with full step results
- **PagerDuty Deduplication**: Events are idempotent via dedup keys
- **Retry with Backoff**: API calls use exponential backoff with jitter
- **Timeout Enforcement**: All steps have configurable timeouts
- **PCI-DSS / SOC2**: No billing data is modified without audit trail

## Testing

```bash
# Run all incident response tests
npx vitest run tests/unit/incident_response/

# Run specific test file
npx vitest run tests/unit/incident_response/pagerduty_client.test.ts
npx vitest run tests/unit/incident_response/incident_detector.test.ts
npx vitest run tests/unit/incident_response/runbook_engine.test.ts
```

## File Structure

```
backend/src/incident_response/
├── index.ts                  # Module entry point & factory
├── types.ts                  # Type definitions
├── pagerduty_client.ts       # PagerDuty Events API v2 client
├── incident_detector.ts      # Incident detection engine
├── runbook_engine.ts         # Runbook execution engine
├── runbook_definitions.ts    # Built-in runbook definitions
├── metrics.ts                # Prometheus metrics
└── routes.ts                 # Admin REST API routes

backend/tests/unit/incident_response/
├── pagerduty_client.test.ts  # PagerDuty client tests
├── incident_detector.test.ts # Incident detector tests
└── runbook_engine.test.ts    # Runbook engine tests