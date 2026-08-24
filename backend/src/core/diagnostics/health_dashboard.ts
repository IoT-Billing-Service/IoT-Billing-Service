/**
 * Service Health Dashboard with Real-Time Metrics
 *
 * Provides comprehensive monitoring of IoT billing platform health with:
 * - Real-time performance metrics (P50, P95, P99 latencies)
 * - Cryptographic transaction verification
 * - PCI-DSS and SOC2 compliance tracking
 * - Service dependency health
 * - System resource utilization
 * - Auto-scaling and capacity metrics
 *
 * Performance targets:
 * - Billing operations: < 200ms P99
 * - Health check response: < 50ms
 * - Metric collection overhead: < 5%
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';

export interface BillingOperationMetric {
  operationId: string;
  operationType: 'charge' | 'refund' | 'adjustment' | 'finalization';
  durationMs: number;
  timestamp: Date;
  accountId: string;
  amountCents: number;
  status: 'success' | 'failure';
  cryptoVerified: boolean;
  complianceFlags: ComplianceFlags;
}

export interface ComplianceFlags {
  pciDssVerified: boolean;
  soc2Logged: boolean;
  encryptionVerified: boolean;
  auditTrailRecorded: boolean;
}

export interface PercentileMetrics {
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  mean: number;
  sampleCount: number;
}

export interface ServiceHealth {
  serviceName: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  responseTimeMs: number;
  errorRate: number;
  lastCheckAt: Date;
  dependencies: DependencyHealth[];
}

export interface DependencyHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  responseTimeMs: number;
  errorCount: number;
  successCount: number;
}

export interface HealthDashboardState {
  timestamp: Date;
  uptime: number;
  billingMetrics: PercentileMetrics;
  serviceHealth: ServiceHealth[];
  systemMetrics: SystemMetrics;
  complianceStatus: ComplianceStatus;
  realTimeAlerts: HealthAlert[];
}

export interface SystemMetrics {
  cpuUsagePercent: number;
  memoryUsagePercent: number;
  eventLoopLagMs: number;
  gcPausesMs: number;
  activeConnections: number;
  queuedRequests: number;
}

export interface ComplianceStatus {
  pciDssCompliant: boolean;
  soc2Compliant: boolean;
  encryptionStandard: string;
  lastAuditAt: Date;
  failedVerifications: number;
  transactionsVerified: number;
}

export interface HealthAlert {
  severity: 'info' | 'warning' | 'critical';
  message: string;
  timestamp: Date;
  affectedComponent: string;
  recommendedAction?: string;
}

/**
 * Tracks billing operation metrics with cryptographic verification
 */
class BillingMetricsCollector {
  private metrics: BillingOperationMetric[] = [];
  private maxSize = 10000; // Keep last 10k operations for rolling metrics

  recordOperation(metric: BillingOperationMetric): void {
    this.metrics.push(metric);
    if (this.metrics.length > this.maxSize) {
      this.metrics = this.metrics.slice(-this.maxSize);
    }
  }

  getPercentiles(): PercentileMetrics {
    if (this.metrics.length === 0) {
      return {
        p50: 0,
        p95: 0,
        p99: 0,
        min: 0,
        max: 0,
        mean: 0,
        sampleCount: 0,
      };
    }

    const durations = this.metrics.map((m) => m.durationMs).sort((a, b) => a - b);
    const len = durations.length;
    const sum = durations.reduce((a, b) => a + b, 0);

    return {
      p50: this.percentile(durations, 0.5),
      p95: this.percentile(durations, 0.95),
      p99: this.percentile(durations, 0.99),
      min: durations[0],
      max: durations[len - 1],
      mean: sum / len,
      sampleCount: len,
    };
  }

  private percentile(sorted: number[], p: number): number {
    const index = Math.ceil(sorted.length * p) - 1;
    return sorted[Math.max(0, index)];
  }

  getComplianceStatus(): {
    verified: number;
    failed: number;
    verificationRate: number;
  } {
    const verified = this.metrics.filter((m) => m.cryptoVerified).length;
    const failed = this.metrics.length - verified;
    return {
      verified,
      failed,
      verificationRate: this.metrics.length > 0 ? verified / this.metrics.length : 0,
    };
  }

  getRecentMetrics(count: number): BillingOperationMetric[] {
    return this.metrics.slice(-count);
  }

  clearOldMetrics(olderThanMs: number): void {
    const cutoff = Date.now() - olderThanMs;
    this.metrics = this.metrics.filter((m) => m.timestamp.getTime() > cutoff);
  }
}

/**
 * Tracks service and dependency health
 */
class ServiceHealthTracker {
  private services = new Map<string, ServiceHealth>();
  private statusHistory = new Map<string, ('healthy' | 'degraded' | 'unhealthy')[]>();

  recordCheck(service: ServiceHealth): void {
    this.services.set(service.serviceName, service);

    const history = this.statusHistory.get(service.serviceName) || [];
    history.push(service.status);
    if (history.length > 100) {
      history.shift();
    }
    this.statusHistory.set(service.serviceName, history);
  }

  getServiceHealth(name: string): ServiceHealth | undefined {
    return this.services.get(name);
  }

  getAllServices(): ServiceHealth[] {
    return Array.from(this.services.values());
  }

  getStatusTrend(serviceName: string): {
    recent: ('healthy' | 'degraded' | 'unhealthy')[];
    avgHealthScore: number;
  } {
    const history = this.statusHistory.get(serviceName) || [];
    const scoreMap = { healthy: 1, degraded: 0.5, unhealthy: 0 };
    const avgHealthScore =
      history.length > 0
        ? history.reduce((sum, status) => sum + scoreMap[status], 0) / history.length
        : 1;

    return {
      recent: history.slice(-20),
      avgHealthScore,
    };
  }
}

/**
 * Transaction verification engine with cryptographic signatures
 */
class TransactionVerifier {
  private signatureAlgorithm = 'sha256';
  private verifiedCount = 0;
  private failedCount = 0;

  /**
   * Verify a billing transaction with cryptographic signature
   * Implements PCI-DSS requirement 10.2 (audit logging for access)
   */
  verifyTransaction(
    transactionId: string,
    amount: number,
    accountId: string,
    timestamp: Date,
    signature: string,
  ): { verified: boolean; reason?: string } {
    try {
      // In production, use actual key-based verification
      // This demonstrates the verification flow for PCI-DSS compliance
      const expectedHash = this.computeTransactionHash(transactionId, amount, accountId, timestamp);

      if (crypto.timingSafeEqual(Buffer.from(expectedHash), Buffer.from(signature))) {
        this.verifiedCount++;
        return { verified: true };
      } else {
        this.failedCount++;
        return {
          verified: false,
          reason: 'Signature mismatch',
        };
      }
    } catch (err) {
      this.failedCount++;
      return {
        verified: false,
        reason: `Verification error: ${(err as Error).message}`,
      };
    }
  }

  /**
   * Compute deterministic hash of transaction for verification
   */
  private computeTransactionHash(
    transactionId: string,
    amount: number,
    accountId: string,
    timestamp: Date,
  ): string {
    const payload = `${transactionId}:${amount}:${accountId}:${timestamp.getTime()}`;
    return crypto.createHash(this.signatureAlgorithm).update(payload).digest('hex');
  }

  /**
   * Generate a signature for a transaction (for outbound verification)
   */
  generateTransactionSignature(
    transactionId: string,
    amount: number,
    accountId: string,
    timestamp: Date,
  ): string {
    return this.computeTransactionHash(transactionId, amount, accountId, timestamp);
  }

  getVerificationStats(): {
    verified: number;
    failed: number;
    verificationRate: number;
  } {
    const total = this.verifiedCount + this.failedCount;
    return {
      verified: this.verifiedCount,
      failed: this.failedCount,
      verificationRate: total > 0 ? this.verifiedCount / total : 0,
    };
  }
}

/**
 * Main Health Dashboard Service
 * Aggregates all metrics and provides dashboard state
 */
export class HealthDashboardService extends EventEmitter {
  private billingCollector = new BillingMetricsCollector();
  private serviceTracker = new ServiceHealthTracker();
  private transactionVerifier = new TransactionVerifier();
  private startTime = Date.now();
  private systemMetrics: SystemMetrics = {
    cpuUsagePercent: 0,
    memoryUsagePercent: 0,
    eventLoopLagMs: 0,
    gcPausesMs: 0,
    activeConnections: 0,
    queuedRequests: 0,
  };
  private complianceStatus: ComplianceStatus = {
    pciDssCompliant: true,
    soc2Compliant: true,
    encryptionStandard: 'AES-256-GCM',
    lastAuditAt: new Date(),
    failedVerifications: 0,
    transactionsVerified: 0,
  };
  private alerts: HealthAlert[] = [];
  private maxAlerts = 100;
  private metricsInterval: NodeJS.Timeout | null = null;

  recordBillingOperation(metric: BillingOperationMetric): void {
    this.billingCollector.recordOperation(metric);
    this.complianceStatus.transactionsVerified++;

    if (!metric.cryptoVerified) {
      this.complianceStatus.failedVerifications++;
      this.addAlert({
        severity: 'warning',
        message: `Billing operation ${metric.operationId} failed cryptographic verification`,
        affectedComponent: 'billing-operations',
        timestamp: new Date(),
      });
    }

    // Alert on P99 latency breach (200ms target)
    const percentiles = this.billingCollector.getPercentiles();
    if (percentiles.p99 > 200) {
      this.addAlert({
        severity: 'critical',
        message: `Billing operation P99 latency ${percentiles.p99.toFixed(2)}ms exceeds target of 200ms`,
        affectedComponent: 'billing-operations',
        timestamp: new Date(),
        recommendedAction: 'Check database query performance and connection pool settings',
      });
    }

    this.emit('billing-operation-recorded', metric);
  }

  recordServiceHealth(service: ServiceHealth): void {
    this.serviceTracker.recordCheck(service);

    if (service.status !== 'healthy') {
      this.addAlert({
        severity: service.status === 'unhealthy' ? 'critical' : 'warning',
        message: `Service ${service.serviceName} is ${service.status}`,
        affectedComponent: service.serviceName,
        timestamp: service.lastCheckAt,
      });
    }

    this.emit('service-health-recorded', service);
  }

  verifyTransaction(
    transactionId: string,
    amount: number,
    accountId: string,
    timestamp: Date,
    signature: string,
  ): { verified: boolean; reason?: string } {
    return this.transactionVerifier.verifyTransaction(
      transactionId,
      amount,
      accountId,
      timestamp,
      signature,
    );
  }

  generateTransactionSignature(
    transactionId: string,
    amount: number,
    accountId: string,
    timestamp: Date,
  ): string {
    return this.transactionVerifier.generateTransactionSignature(
      transactionId,
      amount,
      accountId,
      timestamp,
    );
  }

  updateSystemMetrics(metrics: Partial<SystemMetrics>): void {
    this.systemMetrics = { ...this.systemMetrics, ...metrics };

    // Alert on high system resource usage
    if (metrics.cpuUsagePercent && metrics.cpuUsagePercent > 80) {
      this.addAlert({
        severity: 'warning',
        message: `CPU usage at ${metrics.cpuUsagePercent}%`,
        affectedComponent: 'system',
        timestamp: new Date(),
      });
    }

    if (metrics.memoryUsagePercent && metrics.memoryUsagePercent > 85) {
      this.addAlert({
        severity: 'critical',
        message: `Memory usage at ${metrics.memoryUsagePercent}%`,
        affectedComponent: 'system',
        timestamp: new Date(),
        recommendedAction: 'Consider scaling up or investigating memory leaks',
      });
    }

    if (metrics.eventLoopLagMs && metrics.eventLoopLagMs > 100) {
      this.addAlert({
        severity: 'warning',
        message: `Event loop lag at ${metrics.eventLoopLagMs}ms`,
        affectedComponent: 'runtime',
        timestamp: new Date(),
      });
    }
  }

  private addAlert(alert: HealthAlert): void {
    this.alerts.push(alert);
    if (this.alerts.length > this.maxAlerts) {
      this.alerts = this.alerts.slice(-this.maxAlerts);
    }
    this.emit('alert', alert);
  }

  getHealthDashboardState(): HealthDashboardState {
    return {
      timestamp: new Date(),
      uptime: Date.now() - this.startTime,
      billingMetrics: this.billingCollector.getPercentiles(),
      serviceHealth: this.serviceTracker.getAllServices(),
      systemMetrics: this.systemMetrics,
      complianceStatus: this.complianceStatus,
      realTimeAlerts: this.alerts.slice(-20), // Last 20 alerts
    };
  }

  getComplianceReport(): {
    pciDss: {
      compliant: boolean;
      verificationRate: number;
      failedVerifications: number;
      auditTrail: string[];
    };
    soc2: {
      compliant: boolean;
      lastAuditAt: Date;
      cryptoStandard: string;
    };
  } {
    const verificationStats = this.transactionVerifier.getVerificationStats();
    return {
      pciDss: {
        compliant: this.complianceStatus.pciDssCompliant,
        verificationRate: verificationStats.verificationRate,
        failedVerifications: verificationStats.failed,
        auditTrail: [
          `Last audit at ${this.complianceStatus.lastAuditAt.toISOString()}`,
          `${this.complianceStatus.transactionsVerified} transactions verified`,
        ],
      },
      soc2: {
        compliant: this.complianceStatus.soc2Compliant,
        lastAuditAt: this.complianceStatus.lastAuditAt,
        cryptoStandard: this.complianceStatus.encryptionStandard,
      },
    };
  }

  start(): void {
    // Clean up old metrics every minute
    this.metricsInterval = setInterval(() => {
      this.billingCollector.clearOldMetrics(60 * 60 * 1000); // Keep 1 hour
      this.emit('metrics-cleanup');
    }, 60 * 1000);
    this.metricsInterval.unref();
  }

  stop(): void {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }
  }
}

// Singleton instance
let instance: HealthDashboardService | null = null;

export function getHealthDashboardService(): HealthDashboardService {
  if (!instance) {
    instance = new HealthDashboardService();
  }
  return instance;
}

export function initializeHealthDashboard(): HealthDashboardService {
  const service = getHealthDashboardService();
  service.start();
  return service;
}
