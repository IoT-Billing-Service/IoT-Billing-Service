/**
 * Health Dashboard Service Tests
 *
 * Tests for:
 * - Billing operation metrics collection and percentile calculation
 * - Cryptographic transaction verification
 * - Service health tracking
 * - Compliance status monitoring
 * - Real-time alert generation
 * - Performance target validation (< 200ms P99)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  HealthDashboardService,
  getHealthDashboardService,
  type BillingOperationMetric,
  type ServiceHealth,
  ComplianceFlags,
} from '../../src/core/diagnostics/health_dashboard.js';

describe('HealthDashboardService', () => {
  let service: HealthDashboardService;

  beforeEach(() => {
    service = new HealthDashboardService();
    service.start();
  });

  afterEach(() => {
    service.stop();
  });

  describe('Billing Metrics Collection', () => {
    it('should record billing operations and calculate percentiles', () => {
      // Create sample billing operations
      const operations: BillingOperationMetric[] = [
        {
          operationId: 'op-1',
          operationType: 'charge',
          durationMs: 50,
          timestamp: new Date(),
          accountId: 'acc-1',
          amountCents: 1000,
          status: 'success',
          cryptoVerified: true,
          complianceFlags: {
            pciDssVerified: true,
            soc2Logged: true,
            encryptionVerified: true,
            auditTrailRecorded: true,
          },
        },
        {
          operationId: 'op-2',
          operationType: 'charge',
          durationMs: 120,
          timestamp: new Date(),
          accountId: 'acc-2',
          amountCents: 2000,
          status: 'success',
          cryptoVerified: true,
          complianceFlags: {
            pciDssVerified: true,
            soc2Logged: true,
            encryptionVerified: true,
            auditTrailRecorded: true,
          },
        },
        {
          operationId: 'op-3',
          operationType: 'charge',
          durationMs: 180,
          timestamp: new Date(),
          accountId: 'acc-3',
          amountCents: 3000,
          status: 'success',
          cryptoVerified: true,
          complianceFlags: {
            pciDssVerified: true,
            soc2Logged: true,
            encryptionVerified: true,
            auditTrailRecorded: true,
          },
        },
      ];

      for (const op of operations) {
        service.recordBillingOperation(op);
      }

      const state = service.getHealthDashboardState();
      expect(state.billingMetrics.sampleCount).toBe(3);
      expect(state.billingMetrics.min).toBe(50);
      expect(state.billingMetrics.max).toBe(180);
      expect(state.billingMetrics.mean).toBeCloseTo(116.67, 1);
    });

    it('should meet performance target of < 200ms P99', () => {
      // Generate 100 operations with latencies below 200ms
      for (let i = 0; i < 100; i++) {
        const metric: BillingOperationMetric = {
          operationId: `op-${i}`,
          operationType: 'charge',
          durationMs: Math.random() * 199, // 0-199ms
          timestamp: new Date(),
          accountId: `acc-${i}`,
          amountCents: 1000,
          status: 'success',
          cryptoVerified: true,
          complianceFlags: {
            pciDssVerified: true,
            soc2Logged: true,
            encryptionVerified: true,
            auditTrailRecorded: true,
          },
        };
        service.recordBillingOperation(metric);
      }

      const state = service.getHealthDashboardState();
      expect(state.billingMetrics.p99).toBeLessThan(200);
    });

    it('should handle different operation types', () => {
      const types: Array<'charge' | 'refund' | 'adjustment' | 'finalization'> = [
        'charge',
        'refund',
        'adjustment',
        'finalization',
      ];

      for (const type of types) {
        const metric: BillingOperationMetric = {
          operationId: `op-${type}`,
          operationType: type,
          durationMs: 100,
          timestamp: new Date(),
          accountId: 'acc-test',
          amountCents: 1000,
          status: 'success',
          cryptoVerified: true,
          complianceFlags: {
            pciDssVerified: true,
            soc2Logged: true,
            encryptionVerified: true,
            auditTrailRecorded: true,
          },
        };
        service.recordBillingOperation(metric);
      }

      const state = service.getHealthDashboardState();
      expect(state.billingMetrics.sampleCount).toBe(4);
    });

    it('should track compliance failures', () => {
      const failedMetric: BillingOperationMetric = {
        operationId: 'op-failed',
        operationType: 'charge',
        durationMs: 100,
        timestamp: new Date(),
        accountId: 'acc-1',
        amountCents: 1000,
        status: 'failure',
        cryptoVerified: false, // Failed verification
        complianceFlags: {
          pciDssVerified: false,
          soc2Logged: false,
          encryptionVerified: false,
          auditTrailRecorded: false,
        },
      };

      service.recordBillingOperation(failedMetric);
      expect(
        service.getHealthDashboardState().complianceStatus.failedVerifications,
      ).toBeGreaterThan(0);
    });
  });

  describe('Cryptographic Transaction Verification', () => {
    it('should verify valid transactions', () => {
      const transactionId = 'tx-123';
      const amount = 5000;
      const accountId = 'acc-123';
      const timestamp = new Date();

      const signature = service.generateTransactionSignature(
        transactionId,
        amount,
        accountId,
        timestamp,
      );

      const result = service.verifyTransaction(
        transactionId,
        amount,
        accountId,
        timestamp,
        signature,
      );

      expect(result.verified).toBe(true);
    });

    it('should reject tampered transactions', () => {
      const transactionId = 'tx-123';
      const amount = 5000;
      const accountId = 'acc-123';
      const timestamp = new Date();

      const correctSignature = service.generateTransactionSignature(
        transactionId,
        amount,
        accountId,
        timestamp,
      );

      const tamperedSignature = correctSignature.slice(0, -1) + '0'; // Tamper with last char

      const result = service.verifyTransaction(
        transactionId,
        amount,
        accountId,
        timestamp,
        tamperedSignature,
      );

      expect(result.verified).toBe(false);
      expect(result.reason).toBeDefined();
    });

    it('should reject transactions with different amounts', () => {
      const transactionId = 'tx-123';
      const amount = 5000;
      const accountId = 'acc-123';
      const timestamp = new Date();

      const signature = service.generateTransactionSignature(
        transactionId,
        amount,
        accountId,
        timestamp,
      );

      const result = service.verifyTransaction(
        transactionId,
        amount + 100, // Different amount
        accountId,
        timestamp,
        signature,
      );

      expect(result.verified).toBe(false);
    });

    it('should track verification statistics', () => {
      // Verify some transactions
      for (let i = 0; i < 10; i++) {
        const id = `tx-${i}`;
        const sig = service.generateTransactionSignature(id, 1000, 'acc-1', new Date());
        service.verifyTransaction(id, 1000, 'acc-1', new Date(), sig);
      }

      const report = service.getComplianceReport();
      expect(report.pciDss.verificationRate).toBeGreaterThan(0);
    });
  });

  describe('Service Health Tracking', () => {
    it('should record service health status', () => {
      const serviceHealth: ServiceHealth = {
        serviceName: 'billing-engine',
        status: 'healthy',
        responseTimeMs: 45,
        errorRate: 0,
        lastCheckAt: new Date(),
        dependencies: [
          {
            name: 'database',
            status: 'healthy',
            responseTimeMs: 10,
            errorCount: 0,
            successCount: 1000,
          },
        ],
      };

      service.recordServiceHealth(serviceHealth);

      const state = service.getHealthDashboardState();
      expect(state.serviceHealth).toHaveLength(1);
      expect(state.serviceHealth[0].serviceName).toBe('billing-engine');
      expect(state.serviceHealth[0].status).toBe('healthy');
    });

    it('should track degraded services', () => {
      const degradedService: ServiceHealth = {
        serviceName: 'payment-gateway',
        status: 'degraded',
        responseTimeMs: 250,
        errorRate: 0.05,
        lastCheckAt: new Date(),
        dependencies: [],
      };

      service.recordServiceHealth(degradedService);

      const state = service.getHealthDashboardState();
      const alerts = state.realTimeAlerts.filter((a) => a.affectedComponent === 'payment-gateway');
      expect(alerts.length).toBeGreaterThan(0);
      expect(alerts[0].severity).toBe('warning');
    });

    it('should track unhealthy services', () => {
      const unhealthyService: ServiceHealth = {
        serviceName: 'redis-cache',
        status: 'unhealthy',
        responseTimeMs: 5000,
        errorRate: 1.0,
        lastCheckAt: new Date(),
        dependencies: [],
      };

      service.recordServiceHealth(unhealthyService);

      const state = service.getHealthDashboardState();
      const alerts = state.realTimeAlerts.filter((a) => a.affectedComponent === 'redis-cache');
      expect(alerts[0].severity).toBe('critical');
    });
  });

  describe('System Metrics', () => {
    it('should update and track system metrics', () => {
      service.updateSystemMetrics({
        cpuUsagePercent: 45,
        memoryUsagePercent: 60,
        eventLoopLagMs: 5,
        gcPausesMs: 10,
        activeConnections: 50,
        queuedRequests: 5,
      });

      const state = service.getHealthDashboardState();
      expect(state.systemMetrics.cpuUsagePercent).toBe(45);
      expect(state.systemMetrics.memoryUsagePercent).toBe(60);
    });

    it('should alert on high CPU usage', () => {
      service.updateSystemMetrics({
        cpuUsagePercent: 85,
      });

      const state = service.getHealthDashboardState();
      const cpuAlerts = state.realTimeAlerts.filter(
        (a) => a.affectedComponent === 'system' && a.message.includes('CPU'),
      );
      expect(cpuAlerts.length).toBeGreaterThan(0);
      expect(cpuAlerts[0].severity).toBe('warning');
    });

    it('should alert on high memory usage', () => {
      service.updateSystemMetrics({
        memoryUsagePercent: 90,
      });

      const state = service.getHealthDashboardState();
      const memoryAlerts = state.realTimeAlerts.filter(
        (a) => a.affectedComponent === 'system' && a.message.includes('Memory'),
      );
      expect(memoryAlerts.length).toBeGreaterThan(0);
      expect(memoryAlerts[0].severity).toBe('critical');
    });

    it('should alert on high event loop lag', () => {
      service.updateSystemMetrics({
        eventLoopLagMs: 150,
      });

      const state = service.getHealthDashboardState();
      const lagAlerts = state.realTimeAlerts.filter(
        (a) => a.affectedComponent === 'runtime' && a.message.includes('lag'),
      );
      expect(lagAlerts.length).toBeGreaterThan(0);
    });
  });

  describe('Compliance Reporting', () => {
    it('should generate comprehensive compliance report', () => {
      const report = service.getComplianceReport();

      expect(report.pciDss).toBeDefined();
      expect(report.pciDss.compliant).toBe(true);
      expect(report.soc2).toBeDefined();
      expect(report.soc2.compliant).toBe(true);
      expect(report.soc2.cryptoStandard).toBe('AES-256-GCM');
    });

    it('should track transaction verification in compliance report', () => {
      for (let i = 0; i < 5; i++) {
        const id = `tx-${i}`;
        const sig = service.generateTransactionSignature(id, 1000, 'acc-1', new Date());
        service.verifyTransaction(id, 1000, 'acc-1', new Date(), sig);
      }

      const report = service.getComplianceReport();
      expect(report.pciDss.failedVerifications).toBe(0);
    });
  });

  describe('Real-Time Alerts', () => {
    it('should emit alert events', async () => {
      const alertListener = vi.fn();
      service.on('alert', alertListener);

      const unhealthyService: ServiceHealth = {
        serviceName: 'test-service',
        status: 'unhealthy',
        responseTimeMs: 1000,
        errorRate: 1.0,
        lastCheckAt: new Date(),
        dependencies: [],
      };

      service.recordServiceHealth(unhealthyService);

      expect(alertListener).toHaveBeenCalled();
      expect(alertListener.mock.calls[0][0].severity).toBe('critical');
    });

    it('should maintain alert history', () => {
      // Generate multiple alerts
      for (let i = 0; i < 25; i++) {
        const metric: BillingOperationMetric = {
          operationId: `op-${i}`,
          operationType: 'charge',
          durationMs: 250, // Exceeds 200ms target
          timestamp: new Date(),
          accountId: 'acc-1',
          amountCents: 1000,
          status: 'success',
          cryptoVerified: false, // Will trigger alert
          complianceFlags: {
            pciDssVerified: false,
            soc2Logged: false,
            encryptionVerified: false,
            auditTrailRecorded: false,
          },
        };
        service.recordBillingOperation(metric);
      }

      const state = service.getHealthDashboardState();
      expect(state.realTimeAlerts.length).toBeGreaterThan(0);
      expect(state.realTimeAlerts.length).toBeLessThanOrEqual(20); // Recent 20
    });
  });

  describe('Dashboard State', () => {
    it('should return complete dashboard state', async () => {
      // Record at least one operation to ensure uptime tracking is tested
      const metric: BillingOperationMetric = {
        operationId: 'op-state-test',
        operationType: 'charge',
        durationMs: 50,
        timestamp: new Date(),
        accountId: 'acc-1',
        amountCents: 1000,
        status: 'success',
        cryptoVerified: true,
        complianceFlags: {
          pciDssVerified: true,
          soc2Logged: true,
          encryptionVerified: true,
          auditTrailRecorded: true,
        },
      };
      service.recordBillingOperation(metric);

      const state = service.getHealthDashboardState();

      expect(state.timestamp).toBeInstanceOf(Date);
      expect(state.uptime).toBeGreaterThanOrEqual(0); // Uptime may be 0 in fast tests
      expect(state.billingMetrics).toBeDefined();
      expect(state.serviceHealth).toBeDefined();
      expect(state.systemMetrics).toBeDefined();
      expect(state.complianceStatus).toBeDefined();
      expect(state.realTimeAlerts).toBeDefined();
    });
  });

  describe('Singleton Pattern', () => {
    it('should return same instance', () => {
      const instance1 = getHealthDashboardService();
      const instance2 = getHealthDashboardService();

      expect(instance1).toBe(instance2);
    });
  });
});
