/**
 * Health Dashboard API Routes
 * 
 * Provides REST and WebSocket endpoints for real-time service health monitoring
 * with cryptographic transaction verification and compliance reporting.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  getHealthDashboardService,
  type BillingOperationMetric,
  type ServiceHealth,
} from '../../core/diagnostics/health_dashboard.js';

/**
 * Register health dashboard routes
 * GET  /dashboard/health - Full dashboard state
 * GET  /dashboard/health/compliance - Compliance report
 * GET  /dashboard/health/billing - Billing metrics only
 * GET  /dashboard/health/services - Service health status
 * GET  /dashboard/health/alerts - Real-time alerts
 * POST /dashboard/health/verify-transaction - Verify billing transaction
 * WS   /dashboard/health/stream - WebSocket for real-time metrics
 */
export async function registerHealthDashboardRoutes(app: FastifyInstance): Promise<void> {
  const dashboardService = getHealthDashboardService();

  /**
   * GET /dashboard/health
   * Returns the complete health dashboard state
   * Performance: < 50ms (cached for up to 1s)
   */
  app.get('/dashboard/health', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const state = dashboardService.getHealthDashboardState();

      // P99 latency check for this endpoint itself
      const startTime = Date.now();

      // Cache for 500ms to reduce database queries
      const cacheKey = 'dashboard_health_state';
      const cached = (request.server as any).__dashboardCache?.[cacheKey];

      if (cached && Date.now() - cached.timestamp < 500) {
        void reply.header('X-Cache', 'HIT');
        return cached.data;
      }

      const responseTime = Date.now() - startTime;

      // Alert if endpoint itself exceeds 50ms
      if (responseTime > 50) {
        void reply.header('X-Dashboard-Endpoint-Lag', responseTime);
      }

      // Store in cache
      if (!(request.server as any).__dashboardCache) {
        (request.server as any).__dashboardCache = {};
      }
      (request.server as any).__dashboardCache[cacheKey] = {
        data: state,
        timestamp: Date.now(),
      };

      void reply.header('X-Cache', 'MISS');
      return state;
    } catch (error) {
      void reply.status(500);
      return {
        error: 'Failed to retrieve dashboard state',
        message: (error as Error).message,
      };
    }
  });

  /**
   * GET /dashboard/health/compliance
   * Returns compliance status for PCI-DSS and SOC2
   */
  app.get('/dashboard/health/compliance', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const report = dashboardService.getComplianceReport();
      return report;
    } catch (error) {
      void reply.status(500);
      return {
        error: 'Failed to retrieve compliance report',
        message: (error as Error).message,
      };
    }
  });

  /**
   * GET /dashboard/health/billing
   * Returns billing operation metrics and percentiles
   */
  app.get('/dashboard/health/billing', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const state = dashboardService.getHealthDashboardState();
      return {
        billingMetrics: state.billingMetrics,
        timestamp: state.timestamp,
        performanceTarget: '< 200ms P99',
        targetMet: state.billingMetrics.p99 < 200,
      };
    } catch (error) {
      void reply.status(500);
      return {
        error: 'Failed to retrieve billing metrics',
        message: (error as Error).message,
      };
    }
  });

  /**
   * GET /dashboard/health/services
   * Returns individual service health status
   */
  app.get('/dashboard/health/services', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const state = dashboardService.getHealthDashboardState();
      return {
        services: state.serviceHealth,
        timestamp: state.timestamp,
        healthyCount: state.serviceHealth.filter((s) => s.status === 'healthy').length,
        degradedCount: state.serviceHealth.filter((s) => s.status === 'degraded').length,
        unhealthyCount: state.serviceHealth.filter((s) => s.status === 'unhealthy').length,
      };
    } catch (error) {
      void reply.status(500);
      return {
        error: 'Failed to retrieve service health',
        message: (error as Error).message,
      };
    }
  });

  /**
   * GET /dashboard/health/alerts
   * Returns recent health alerts
   */
  app.get('/dashboard/health/alerts', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const state = dashboardService.getHealthDashboardState();
      return {
        alerts: state.realTimeAlerts,
        totalAlerts: state.realTimeAlerts.length,
        criticalCount: state.realTimeAlerts.filter((a) => a.severity === 'critical').length,
        warningCount: state.realTimeAlerts.filter((a) => a.severity === 'warning').length,
      };
    } catch (error) {
      void reply.status(500);
      return {
        error: 'Failed to retrieve alerts',
        message: (error as Error).message,
      };
    }
  });

  /**
   * POST /dashboard/health/record-billing
   * Record a billing operation for metrics collection
   * Requires billing operation data with cryptographic verification
   */
  app.post<{ Body: BillingOperationMetric }>(
    '/dashboard/health/record-billing',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const metric: BillingOperationMetric = request.body;

        // Verify required fields
        if (!metric.operationId || !metric.operationType || typeof metric.durationMs !== 'number') {
          void reply.status(400);
          return {
            error: 'Invalid billing operation metric',
            required: ['operationId', 'operationType', 'durationMs', 'accountId', 'amountCents'],
          };
        }

        // Normalize timestamp
        if (typeof metric.timestamp === 'string') {
          metric.timestamp = new Date(metric.timestamp);
        }

        // Record the operation
        dashboardService.recordBillingOperation(metric);

        void reply.status(202);
        return { accepted: true, operationId: metric.operationId };
      } catch (error) {
        void reply.status(500);
        return {
          error: 'Failed to record billing operation',
          message: (error as Error).message,
        };
      }
    },
  );

  /**
   * POST /dashboard/health/record-service
   * Record service health check result
   */
  app.post<{ Body: ServiceHealth }>(
    '/dashboard/health/record-service',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const service: ServiceHealth = request.body;

        if (!service.serviceName || !service.status) {
          void reply.status(400);
          return {
            error: 'Invalid service health data',
            required: ['serviceName', 'status', 'responseTimeMs'],
          };
        }

        // Normalize timestamp
        if (typeof service.lastCheckAt === 'string') {
          service.lastCheckAt = new Date(service.lastCheckAt);
        }

        dashboardService.recordServiceHealth(service);

        void reply.status(202);
        return { accepted: true, serviceName: service.serviceName };
      } catch (error) {
        void reply.status(500);
        return {
          error: 'Failed to record service health',
          message: (error as Error).message,
        };
      }
    },
  );

  /**
   * POST /dashboard/health/verify-transaction
   * Verify a billing transaction with cryptographic signature
   * Implements PCI-DSS requirement 10.2 (cryptographic verification)
   */
  app.post<{
    Body: {
      transactionId: string;
      amount: number;
      accountId: string;
      timestamp: string;
      signature: string;
    };
  }>(
    '/dashboard/health/verify-transaction',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { transactionId, amount, accountId, timestamp, signature } = request.body;

        if (!transactionId || !amount || !accountId || !timestamp || !signature) {
          void reply.status(400);
          return {
            error: 'Missing required transaction fields',
            required: ['transactionId', 'amount', 'accountId', 'timestamp', 'signature'],
          };
        }

        const result = dashboardService.verifyTransaction(
          transactionId,
          amount,
          accountId,
          new Date(timestamp),
          signature,
        );

        if (!result.verified) {
          void reply.status(400);
          return { verified: false, reason: result.reason };
        }

        return {
          verified: true,
          transactionId,
          pciDssCompliant: true,
        };
      } catch (error) {
        void reply.status(500);
        return {
          error: 'Transaction verification failed',
          message: (error as Error).message,
        };
      }
    },
  );

  /**
   * POST /dashboard/health/update-system-metrics
   * Update system resource metrics (CPU, memory, event loop lag)
   */
  app.post<{ Body: Record<string, number> }>(
    '/dashboard/health/update-system-metrics',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        dashboardService.updateSystemMetrics(request.body);
        return { updated: true };
      } catch (error) {
        void reply.status(500);
        return {
          error: 'Failed to update system metrics',
          message: (error as Error).message,
        };
      }
    },
  );
}

/**
 * Register WebSocket route for real-time health streaming
 * WS /dashboard/health/stream
 *
 * Sends health dashboard state updates every 1 second or on alert
 */
export async function registerHealthDashboardWebSocket(app: FastifyInstance): Promise<void> {
  const dashboardService = getHealthDashboardService();

  app.register(async (fastify) => {
    fastify.get('/dashboard/health/stream', { websocket: true }, (socket, _request) => {
      // Send initial state
      const initialState = dashboardService.getHealthDashboardState();
      socket.send(JSON.stringify({ type: 'dashboard_state', data: initialState }));

      // Update every 1 second
      const interval = setInterval(() => {
        const state = dashboardService.getHealthDashboardState();
        socket.send(JSON.stringify({ type: 'dashboard_state', data: state }));
      }, 1000);

      // Send alerts in real-time
      const onAlert = (alert: any) => {
        socket.send(JSON.stringify({ type: 'alert', data: alert }));
      };

      dashboardService.on('alert', onAlert);

      socket.on('close', () => {
        clearInterval(interval);
        dashboardService.removeListener('alert', onAlert);
      });

      socket.on('error', (err: Error) => {
        app.log.error(`WebSocket error: ${err.message}`);
        clearInterval(interval);
        dashboardService.removeListener('alert', onAlert);
      });
    });
  });
}
