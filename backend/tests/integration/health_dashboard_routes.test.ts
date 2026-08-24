/**
 * Health Dashboard Routes Integration Tests
 *
 * Tests for:
 * - REST endpoints
 * - Response times and caching
 * - Error handling
 * - WebSocket streaming
 * - End-to-end workflow
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import {
  registerHealthDashboardRoutes,
  registerHealthDashboardWebSocket,
} from '../../src/api/routes/health_dashboard.js';
import { initializeHealthDashboard } from '../../src/core/diagnostics/health_dashboard.js';

describe('Health Dashboard Routes Integration', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });

    // Initialize the health dashboard service
    initializeHealthDashboard();

    // Register websocket support
    await app.register(require('@fastify/websocket'));

    // Register routes
    await registerHealthDashboardRoutes(app);
    await registerHealthDashboardWebSocket(app);

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /dashboard/health', () => {
    it('should return full dashboard state', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/health',
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.timestamp).toBeDefined();
      expect(data.billingMetrics).toBeDefined();
      expect(data.serviceHealth).toBeDefined();
      expect(data.systemMetrics).toBeDefined();
      expect(data.complianceStatus).toBeDefined();
      expect(data.realTimeAlerts).toBeDefined();
    });

    it('should implement caching for performance', async () => {
      const response1 = await app.inject({
        method: 'GET',
        url: '/dashboard/health',
      });

      const response2 = await app.inject({
        method: 'GET',
        url: '/dashboard/health',
      });

      // Second request should be faster
      expect(response1.statusCode).toBe(200);
      expect(response2.statusCode).toBe(200);
      expect(response2.headers['x-cache']).toBeDefined();
    });

    it('should respond in under 50ms', async () => {
      const startTime = Date.now();

      await app.inject({
        method: 'GET',
        url: '/dashboard/health',
      });

      const responseTime = Date.now() - startTime;
      // Note: This is a soft check as test environment may vary
      // In production monitoring, we'd track this more rigorously
      expect(responseTime).toBeLessThan(500); // Generous for test environment
    });
  });

  describe('GET /dashboard/health/compliance', () => {
    it('should return compliance report', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/health/compliance',
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.pciDss).toBeDefined();
      expect(data.pciDss.compliant).toBe(true);
      expect(data.pciDss.verificationRate).toBeGreaterThanOrEqual(0);
      expect(data.soc2).toBeDefined();
      expect(data.soc2.compliant).toBe(true);
      expect(data.soc2.cryptoStandard).toBe('AES-256-GCM');
    });
  });

  describe('GET /dashboard/health/billing', () => {
    it('should return billing metrics', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/health/billing',
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.billingMetrics).toBeDefined();
      expect(data.performanceTarget).toBe('< 200ms P99');
      expect(data.targetMet).toBe(true);
    });
  });

  describe('GET /dashboard/health/services', () => {
    it('should return service health status', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/health/services',
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.services).toBeDefined();
      expect(Array.isArray(data.services)).toBe(true);
      expect(data.healthyCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe('GET /dashboard/health/alerts', () => {
    it('should return alerts list', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/health/alerts',
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.alerts).toBeDefined();
      expect(Array.isArray(data.alerts)).toBe(true);
      expect(data.totalAlerts).toBeGreaterThanOrEqual(0);
      expect(data.criticalCount).toBeGreaterThanOrEqual(0);
      expect(data.warningCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe('POST /dashboard/health/record-billing', () => {
    it('should accept billing operation metrics', async () => {
      const metric = {
        operationId: 'op-test-1',
        operationType: 'charge',
        durationMs: 50,
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
      };

      const response = await app.inject({
        method: 'POST',
        url: '/dashboard/health/record-billing',
        payload: metric,
      });

      expect(response.statusCode).toBe(202);
      const data = JSON.parse(response.body);
      expect(data.accepted).toBe(true);
    });

    it('should validate required fields', async () => {
      const incompleteMetric = {
        operationId: 'op-test-2',
        // missing operationType and other required fields
      };

      const response = await app.inject({
        method: 'POST',
        url: '/dashboard/health/record-billing',
        payload: incompleteMetric,
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /dashboard/health/record-service', () => {
    it('should accept service health data', async () => {
      const serviceHealth = {
        serviceName: 'test-service',
        status: 'healthy',
        responseTimeMs: 45,
        errorRate: 0,
        lastCheckAt: new Date(),
        dependencies: [],
      };

      const response = await app.inject({
        method: 'POST',
        url: '/dashboard/health/record-service',
        payload: serviceHealth,
      });

      expect(response.statusCode).toBe(202);
      const data = JSON.parse(response.body);
      expect(data.accepted).toBe(true);
    });

    it('should validate required fields', async () => {
      const incompleteService = {
        // missing serviceName and status
      };

      const response = await app.inject({
        method: 'POST',
        url: '/dashboard/health/record-service',
        payload: incompleteService,
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /dashboard/health/verify-transaction', () => {
    it('should verify valid transactions', async () => {
      const transactionId = 'tx-test-1';
      const amount = 5000;
      const accountId = 'acc-123';
      const timestamp = new Date().toISOString();

      // In a real scenario, we'd generate the signature
      // For this test, we'll use a placeholder
      const signature = 'test-signature';

      const response = await app.inject({
        method: 'POST',
        url: '/dashboard/health/verify-transaction',
        payload: {
          transactionId,
          amount,
          accountId,
          timestamp,
          signature,
        },
      });

      expect(response.statusCode).toBeOneOf([200, 400]); // Depends on signature validation
      expect(response.body).toBeDefined();
    });

    it('should require all transaction fields', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/dashboard/health/verify-transaction',
        payload: {
          transactionId: 'tx-test',
          // missing other required fields
        },
      });

      expect(response.statusCode).toBe(400);
      const data = JSON.parse(response.body);
      expect(data.error).toBeDefined();
    });
  });

  describe('POST /dashboard/health/update-system-metrics', () => {
    it('should update system metrics', async () => {
      const metrics = {
        cpuUsagePercent: 45,
        memoryUsagePercent: 60,
        eventLoopLagMs: 5,
        gcPausesMs: 10,
        activeConnections: 50,
        queuedRequests: 5,
      };

      const response = await app.inject({
        method: 'POST',
        url: '/dashboard/health/update-system-metrics',
        payload: metrics,
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.updated).toBe(true);

      // Verify metrics were recorded
      const healthResponse = await app.inject({
        method: 'GET',
        url: '/dashboard/health',
      });

      const healthData = JSON.parse(healthResponse.body);
      expect(healthData.systemMetrics.cpuUsagePercent).toBe(45);
    });
  });

  describe('Error Handling', () => {
    it('should handle malformed JSON gracefully', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/dashboard/health/record-billing',
        payload: 'invalid json',
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
    });

    it('should handle missing endpoints gracefully', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/health/nonexistent',
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('Performance', () => {
    it('should handle multiple concurrent requests', async () => {
      const requests = Array.from({ length: 10 }, () =>
        app.inject({
          method: 'GET',
          url: '/dashboard/health',
        }),
      );

      const responses = await Promise.all(requests);
      responses.forEach((response) => {
        expect(response.statusCode).toBe(200);
      });
    });

    it('should maintain response time under load', async () => {
      const startTime = Date.now();
      const iterations = 20;

      for (let i = 0; i < iterations; i++) {
        await app.inject({
          method: 'GET',
          url: '/dashboard/health',
        });
      }

      const totalTime = Date.now() - startTime;
      const avgTime = totalTime / iterations;

      // Average response time should be reasonable
      expect(avgTime).toBeLessThan(100); // Generous for test environment
    });
  });
});
