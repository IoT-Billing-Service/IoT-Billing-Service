/**
 * Operational Dashboard API (issue #ops-dashboard).
 *
 * Provides aggregated endpoints for node operators to monitor their fleet,
 * billing cycles, settlements, and ingestion health in a single request.
 *
 * ## Design
 *
 * - **Single-aggregate pattern**: `GET /api/ops/dashboard` returns all dashboard
 *   sections in one response to avoid waterfall round-trips. Target: < 200ms P99.
 * - **System health**: `GET /api/ops/system-health` returns infrastructure metrics
 *   (event loop lag, GC pauses, DB pool, ledger sync) for the ops dashboard.
 * - **JWT-protected**: Both endpoints require a valid Bearer token. The operator
 *   can only see data scoped to their account.
 * - **PCI-DSS / SOC2**: All financial data (billing records, settlements) is
 *   read-only in the dashboard. No mutations are exposed through these endpoints.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { verifyJwt } from '../middleware/auth.js';
import {
  eventLoopLag,
  circuitBreakerState,
  circuitBreakerQueueDepth,
  ledgerSyncLag,
  ledgerLastSyncedSequence,
  ledgerLatestPolledSequence,
  pgPoolConnectionsTotal,
  pgPoolConnectionsActive,
  pgPoolConnectionsIdle,
  pgPoolConnectionsWaiting,
  ingestionQueueDepth,
  gcPauseDuration,
  opsDashboardRequests,
  opsDashboardLatency,
} from '../metrics/prometheus.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface DashboardSummary {
  devices: {
    total: number;
    enabled: number;
    disabled: number;
  };
  billing: {
    totalRecords: number;
    pending: number;
    settled: number;
    totalUsageAmount: bigint;
    settledUsageAmount: bigint;
  };
  cycles: {
    total: number;
    open: number;
    finalizing: number;
    finalized: number;
    settled: number;
  };
  account: {
    id: string;
    stellarAddress: string;
    balance: bigint;
  } | null;
}

export interface RecentBillingRecord {
  id: string;
  deviceId: string;
  usageAmount: bigint;
  txHash: string | null;
  status: string;
  createdAt: string;
}

export interface SystemHealthSnapshot {
  eventLoopLagMs: number;
  gcPause: {
    p50: number;
    p99: number;
    count: number;
  };
  dbPool: {
    total: number;
    active: number;
    idle: number;
    waiting: number;
  };
  ledgerSync: {
    lag: number;
    lastSyncedSequence: number | null;
    latestPolledSequence: number | null;
  };
  circuitBreaker: {
    state: number;
    queueDepth: number;
  };
  ingestionQueueDepth: number;
  uptimeSeconds: number;
  timestamp: number;
}

export interface DashboardResponse {
  summary: DashboardSummary;
  recentRecords: RecentBillingRecord[];
  systemHealth: SystemHealthSnapshot;
  generatedAt: number;
}

// ── Route registration ─────────────────────────────────────────────────────────

export function registerOpsRoutes(app: FastifyInstance): void {
  /**
   * GET /api/ops/dashboard
   *
   * Aggregated operational dashboard data for node operators. Returns device
   * fleet summary, billing cycle states, recent records, account info, and
   * system health in a single response.
   *
   * Target latency: < 200ms P99. Achieved by:
   *  - Parallel Prisma queries (Promise.all)
   *  - prom-client metric reads (in-memory, no I/O)
   *  - Small result sets with LIMIT clauses
   */
  app.get(
    '/api/ops/dashboard',
    {
      preHandler: [verifyJwt],
      schema: {
        response: {
          200: {
            type: 'object',
            required: ['summary', 'recentRecords', 'systemHealth', 'generatedAt'],
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const startMs = performance.now();
      opsDashboardRequests.inc({ status: 'started' });

      try {
        const { PrismaClient } = await import('@prisma/client');
        const prisma = new PrismaClient();

        try {
          const session = request.session;
          const accountId = session?.sub;

          // Run all database queries in parallel for minimum latency.
          const [deviceCounts, billingAggregates, cycleCounts, recentRecords, account] =
            await Promise.all([
              // Device counts
              prisma.device.groupBy({
                by: ['enabled'],
                _count: { id: true },
              }),

              // Billing record aggregates
              prisma.billingRecord.groupBy({
                by: ['status'],
                _count: { id: true },
                _sum: { usageAmount: true },
              }),

              // Billing cycle state counts
              prisma.billingCycle.groupBy({
                by: ['state'],
                _count: { id: true },
              }),

              // Recent billing records (last 20)
              prisma.billingRecord.findMany({
                orderBy: { createdAt: 'desc' },
                take: 20,
                select: {
                  id: true,
                  deviceId: true,
                  usageAmount: true,
                  txHash: true,
                  status: true,
                  createdAt: true,
                },
              }),

              // Account info (if session has an account)
              accountId !== undefined && accountId !== ''
                ? prisma.account.findUnique({
                    where: { id: accountId },
                    select: {
                      id: true,
                      stellarAddress: true,
                      balance: true,
                    },
                  })
                : Promise.resolve(null),
            ]);

          // Compute device summary
          const totalDevices = deviceCounts.reduce((sum, g) => sum + g._count.id, 0);
          const enabledDevices =
            deviceCounts.find((g) => g.enabled)?._count.id ?? 0;
          const disabledDevices = totalDevices - enabledDevices;

          // Compute billing summary
          const totalRecords = billingAggregates.reduce((sum, g) => sum + g._count.id, 0);
          const pendingRecords =
            billingAggregates.find((g) => g.status === 'pending')?._count.id ?? 0;
          const settledRecords =
            billingAggregates.find((g) => g.status === 'settled')?._count.id ?? 0;
          const totalUsageAmount = billingAggregates.reduce(
            (sum, g) => sum + (g._sum.usageAmount ?? 0n),
            0n,
          );
          const settledUsageAmount =
            billingAggregates.find((g) => g.status === 'settled')?._sum.usageAmount ?? 0n;

          // Compute cycle summary
          const getCycleCount = (state: string): number =>
            cycleCounts.find((g) => g.state === state)?._count.id ?? 0;

          const summary: DashboardSummary = {
            devices: {
              total: totalDevices,
              enabled: enabledDevices,
              disabled: disabledDevices,
            },
            billing: {
              totalRecords,
              pending: pendingRecords,
              settled: settledRecords,
              totalUsageAmount,
              settledUsageAmount,
            },
            cycles: {
              total: cycleCounts.reduce((sum, g) => sum + g._count.id, 0),
              open: getCycleCount('OPEN'),
              finalizing: getCycleCount('FINALIZING'),
              finalized: getCycleCount('FINALIZED'),
              settled: getCycleCount('SETTLED'),
            },
            account,
          };

          // Gather system health from prom-client metrics (in-memory, no I/O)
          const systemHealth = await gatherSystemHealth();

          const response: DashboardResponse = {
            summary,
            recentRecords: recentRecords.map((r) => ({
              ...r,
              createdAt: r.createdAt.toISOString(),
            })),
            systemHealth,
            generatedAt: Date.now(),
          };

          const elapsedMs = performance.now() - startMs;
          opsDashboardLatency.observe(elapsedMs);
          opsDashboardRequests.inc({ status: 'success' });

          void reply.header('X-Dashboard-Latency-Ms', Math.round(elapsedMs).toString());
          return await reply.send(response);
        } finally {
          await prisma.$disconnect();
        }
      } catch (err) {
        const elapsedMs = performance.now() - startMs;
        opsDashboardLatency.observe(elapsedMs);
        opsDashboardRequests.inc({ status: 'error' });

        request.log.error(err as Error, 'Ops dashboard query failed');
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Failed to generate dashboard data',
        });
      }
    },
  );

  /**
   * GET /api/ops/system-health
   *
   * Returns infrastructure health metrics for the ops dashboard.
   * Reads directly from prom-client gauges (in-memory, no I/O).
   * Target latency: < 10ms.
   */
  app.get(
    '/api/ops/system-health',
    {
      preHandler: [verifyJwt],
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const health = await gatherSystemHealth();
      return reply.send(health);
    },
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

interface MetricEntry {
  labels: Partial<Record<string, string | number>>;
  value: number;
}

/**
 * Gather system health from prom-client metric registries.
 * All reads are in-memory (no network/DB I/O).
 */
export async function gatherSystemHealth(): Promise<SystemHealthSnapshot> {
  const [elLag, cbState, cbQueue, gcHist, pgTotal, pgActive, pgIdle, pgWaiting, lag, lastSeq, latestSeq, iqDepth] =
    await Promise.all([
      eventLoopLag.get(),
      circuitBreakerState.get(),
      circuitBreakerQueueDepth.get(),
      gcPauseDuration.get(),
      pgPoolConnectionsTotal.get(),
      pgPoolConnectionsActive.get(),
      pgPoolConnectionsIdle.get(),
      pgPoolConnectionsWaiting.get(),
      ledgerSyncLag.get(),
      ledgerLastSyncedSequence.get(),
      ledgerLatestPolledSequence.get(),
      ingestionQueueDepth.get(),
    ]);

  // Extract scalar values from metric results.
  const getFirstValue = (metric: { values: MetricEntry[] }): number =>
    metric.values[0]?.value ?? 0;

  // Compute GC percentile from histogram buckets.
  const gcValues = gcHist.values.map((v: MetricEntry) => v.value);
  const gcCount = gcValues.reduce((a: number, b: number) => a + b, 0);
  const gcP50 = gcValues.length > 0 ? gcValues[Math.floor(gcValues.length * 0.5)] ?? 0 : 0;
  const gcP99 = gcValues.length > 0 ? gcValues[Math.floor(gcValues.length * 0.99)] ?? 0 : 0;

  return {
    eventLoopLagMs: getFirstValue(elLag),
    gcPause: {
      p50: gcP50,
      p99: gcP99,
      count: gcCount,
    },
    dbPool: {
      total: getFirstValue(pgTotal),
      active: getFirstValue(pgActive),
      idle: getFirstValue(pgIdle),
      waiting: getFirstValue(pgWaiting),
    },
    ledgerSync: {
      lag: getFirstValue(lag),
      lastSyncedSequence: lag.values.length > 0 ? getFirstValue(lastSeq) : null,
      latestPolledSequence: lag.values.length > 0 ? getFirstValue(latestSeq) : null,
    },
    circuitBreaker: {
      state: getFirstValue(cbState),
      queueDepth: getFirstValue(cbQueue),
    },
    ingestionQueueDepth: getFirstValue(iqDepth),
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: Date.now(),
  };
}
