# Service Health Dashboard with Real-Time Metrics

## Overview

The Service Health Dashboard provides comprehensive, real-time monitoring of the IoT billing platform with a focus on performance, security, and compliance. It tracks billing operations, service dependencies, system resources, and generates cryptographically verified transaction audits.

## Architecture

### Core Components

1. **HealthDashboardService** - Main orchestrator for metrics collection and analysis
2. **BillingMetricsCollector** - Tracks operation latencies and calculates percentiles
3. **ServiceHealthTracker** - Monitors service and dependency health status
4. **TransactionVerifier** - Cryptographic verification for PCI-DSS compliance
5. **Health Dashboard Routes** - REST and WebSocket API endpoints

## Performance Targets

| Metric | Target | Status |
|--------|--------|--------|
| Billing operations P99 latency | < 200ms | Monitored |
| Health check response time | < 50ms | Monitored |
| Metric collection overhead | < 5% | Tracked |
| Cache hit ratio | > 80% | Optimized |

## Security & Compliance

### PCI-DSS Compliance (Requirement 10.2 - Cryptographic Verification)

- All billing transactions are cryptographically signed
- Signatures use SHA-256 hash with HMAC validation
- Transaction verification includes: ID, amount, account ID, timestamp
- Verification failures are logged and alerted

### SOC2 Compliance

- Real-time audit trail of all transactions
- Encryption standard: AES-256-GCM
- Last audit timestamp tracking
- Failed verification metrics

## API Endpoints

### REST Endpoints

#### GET /dashboard/health
Returns the complete health dashboard state with all metrics.

**Response:**
```json
{
  "timestamp": "2026-08-22T10:30:00Z",
  "uptime": 3600000,
  "billingMetrics": {
    "p50": 45,
    "p95": 180,
    "p99": 195,
    "min": 10,
    "max": 199,
    "mean": 92.5,
    "sampleCount": 1000
  },
  "serviceHealth": [
    {
      "serviceName": "billing-engine",
      "status": "healthy",
      "responseTimeMs": 45,
      "errorRate": 0,
      "lastCheckAt": "2026-08-22T10:30:00Z",
      "dependencies": []
    }
  ],
  "systemMetrics": {
    "cpuUsagePercent": 45,
    "memoryUsagePercent": 60,
    "eventLoopLagMs": 5,
    "gcPausesMs": 10,
    "activeConnections": 50,
    "queuedRequests": 5
  },
  "complianceStatus": {
    "pciDssCompliant": true,
    "soc2Compliant": true,
    "encryptionStandard": "AES-256-GCM",
    "lastAuditAt": "2026-08-22T10:30:00Z",
    "failedVerifications": 0,
    "transactionsVerified": 10000
  },
  "realTimeAlerts": []
}
```

**Performance:** Cached response (500ms TTL), < 50ms

#### GET /dashboard/health/compliance
Returns compliance status for PCI-DSS and SOC2.

**Response:**
```json
{
  "pciDss": {
    "compliant": true,
    "verificationRate": 1.0,
    "failedVerifications": 0,
    "auditTrail": [
      "Last audit at 2026-08-22T10:30:00Z",
      "10000 transactions verified"
    ]
  },
  "soc2": {
    "compliant": true,
    "lastAuditAt": "2026-08-22T10:30:00Z",
    "cryptoStandard": "AES-256-GCM"
  }
}
```

#### GET /dashboard/health/billing
Returns billing operation metrics and performance targets.

**Response:**
```json
{
  "billingMetrics": {
    "p50": 45,
    "p95": 180,
    "p99": 195,
    "min": 10,
    "max": 199,
    "mean": 92.5,
    "sampleCount": 1000
  },
  "timestamp": "2026-08-22T10:30:00Z",
  "performanceTarget": "< 200ms P99",
  "targetMet": true
}
```

#### GET /dashboard/health/services
Returns individual service health status.

**Response:**
```json
{
  "services": [
    {
      "serviceName": "billing-engine",
      "status": "healthy",
      "responseTimeMs": 45,
      "errorRate": 0,
      "lastCheckAt": "2026-08-22T10:30:00Z",
      "dependencies": []
    }
  ],
  "timestamp": "2026-08-22T10:30:00Z",
  "healthyCount": 5,
  "degradedCount": 0,
  "unhealthyCount": 0
}
```

#### GET /dashboard/health/alerts
Returns recent health alerts.

**Response:**
```json
{
  "alerts": [
    {
      "severity": "critical",
      "message": "Billing operation P99 latency 215ms exceeds target of 200ms",
      "timestamp": "2026-08-22T10:30:00Z",
      "affectedComponent": "billing-operations",
      "recommendedAction": "Check database query performance"
    }
  ],
  "totalAlerts": 1,
  "criticalCount": 1,
  "warningCount": 0
}
```

### Recording Endpoints

#### POST /dashboard/health/record-billing
Record a billing operation for metrics collection.

**Request:**
```json
{
  "operationId": "op-123",
  "operationType": "charge",
  "durationMs": 45,
  "timestamp": "2026-08-22T10:30:00Z",
  "accountId": "acc-123",
  "amountCents": 5000,
  "status": "success",
  "cryptoVerified": true,
  "complianceFlags": {
    "pciDssVerified": true,
    "soc2Logged": true,
    "encryptionVerified": true,
    "auditTrailRecorded": true
  }
}
```

**Response:** `202 Accepted`

#### POST /dashboard/health/record-service
Record service health check result.

**Request:**
```json
{
  "serviceName": "billing-engine",
  "status": "healthy",
  "responseTimeMs": 45,
  "errorRate": 0,
  "lastCheckAt": "2026-08-22T10:30:00Z",
  "dependencies": []
}
```

**Response:** `202 Accepted`

#### POST /dashboard/health/verify-transaction
Verify a billing transaction with cryptographic signature (PCI-DSS 10.2).

**Request:**
```json
{
  "transactionId": "tx-123",
  "amount": 5000,
  "accountId": "acc-123",
  "timestamp": "2026-08-22T10:30:00Z",
  "signature": "sha256_hash_value"
}
```

**Response:**
```json
{
  "verified": true,
  "transactionId": "tx-123",
  "pciDssCompliant": true
}
```

#### POST /dashboard/health/update-system-metrics
Update system resource metrics.

**Request:**
```json
{
  "cpuUsagePercent": 45,
  "memoryUsagePercent": 60,
  "eventLoopLagMs": 5,
  "gcPausesMs": 10,
  "activeConnections": 50,
  "queuedRequests": 5
}
```

**Response:** `200 OK`

### WebSocket Endpoints

#### WS /dashboard/health/stream
Real-time health metrics streaming.

**Connection:**
```bash
wscat -c ws://localhost:3000/dashboard/health/stream
```

**Messages:**

Dashboard state update (every 1 second):
```json
{
  "type": "dashboard_state",
  "data": {
    "timestamp": "2026-08-22T10:30:00Z",
    "billingMetrics": { ... },
    "serviceHealth": [ ... ],
    "systemMetrics": { ... },
    "complianceStatus": { ... },
    "realTimeAlerts": [ ... ]
  }
}
```

Real-time alert:
```json
{
  "type": "alert",
  "data": {
    "severity": "critical",
    "message": "Billing operation P99 latency exceeds target",
    "timestamp": "2026-08-22T10:30:00Z",
    "affectedComponent": "billing-operations",
    "recommendedAction": "Check database performance"
  }
}
```

## Integration Guide

### Adding to FastifyInstance

```typescript
import { registerHealthDashboardRoutes, registerHealthDashboardWebSocket } from './api/routes/health_dashboard.js';
import { initializeHealthDashboard } from './core/diagnostics/health_dashboard.js';

// Initialize the service
const dashboardService = initializeHealthDashboard();

// Register routes
await registerHealthDashboardRoutes(app);
await registerHealthDashboardWebSocket(app);
```

### Recording Billing Operations

```typescript
import { getHealthDashboardService } from './core/diagnostics/health_dashboard.js';

const dashboardService = getHealthDashboardService();

dashboardService.recordBillingOperation({
  operationId: 'op-123',
  operationType: 'charge',
  durationMs: 45,
  timestamp: new Date(),
  accountId: 'acc-123',
  amountCents: 5000,
  status: 'success',
  cryptoVerified: true,
  complianceFlags: {
    pciDssVerified: true,
    soc2Logged: true,
    encryptionVerified: true,
    auditTrailRecorded: true,
  },
});
```

### Transaction Verification (PCI-DSS)

```typescript
const dashboardService = getHealthDashboardService();

// Generate signature for a transaction
const signature = dashboardService.generateTransactionSignature(
  'tx-123',
  5000,
  'acc-123',
  new Date()
);

// Verify transaction
const result = dashboardService.verifyTransaction(
  'tx-123',
  5000,
  'acc-123',
  new Date(),
  signature
);

if (result.verified) {
  console.log('Transaction verified for PCI-DSS compliance');
}
```

## Monitoring & Alerting

### Alert Severity Levels

- **Critical** (red): Service unhealthy, compliance violation, memory critical
- **Warning** (yellow): Degraded service, compliance warning, CPU high
- **Info** (blue): Normal operational events

### Key Metrics to Monitor

1. **P99 Latency Trend**: Should remain < 200ms
2. **Error Rate**: Track per operation type
3. **Verification Success Rate**: Should be > 99.9% for PCI-DSS
4. **Service Dependency Health**: Alert on any unhealthy dependency
5. **System Resource Usage**: CPU, memory, event loop lag

## Testing

Run the test suite:

```bash
# Unit tests for core service
npm run test -- tests/unit/health_dashboard.test.ts

# Integration tests for API routes
npm run test -- tests/integration/health_dashboard_routes.test.ts

# All dashboard tests
npm run test -- tests/**/health_dashboard*
```

## Performance Considerations

### Caching Strategy

- Dashboard state cached for 500ms
- Metrics aggregated every 1 second
- Old metrics (> 1 hour) automatically cleaned up
- Maximum 10,000 operations in memory

### Scaling

- Metric collection uses rolling window (latest 10k operations)
- Alert buffer limited to 100 recent alerts
- WebSocket broadcasts at 1Hz (configurable)
- Percentile calculation O(n log n) on recorded metrics

## Troubleshooting

### P99 Latency Exceeds 200ms

1. Check database query performance
2. Review connection pool settings
3. Monitor CPU and memory usage
4. Check for GC pauses

### Transaction Verification Failures

1. Verify cryptographic key configuration
2. Check timestamp synchronization
3. Review audit trail logs
4. Enable debug logging

### High Alert Volume

1. Review alert thresholds
2. Check system resource usage
3. Investigate service dependency health
4. Consider increasing resource allocation

## References

- [PCI-DSS Requirement 10.2](https://www.pcisecuritystandards.org/)
- [SOC2 Trust Service Criteria](https://www.aicpa.org/)
- [NIST Cybersecurity Framework](https://www.nist.gov/cyberframework)
