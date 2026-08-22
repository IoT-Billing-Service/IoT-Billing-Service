/**
 * Analytics API routes.
 *
 * Existing endpoint:
 *   GET /api/analytics/telemetry         — raw time-bucket rows for a single device
 *
 * New endpoints (Issue #301 — Usage Analytics with Time-Series Aggregation):
 *   GET /api/analytics/usage/summary         — aggregated summary across all devices
 *   GET /api/analytics/usage/device-breakdown — per-device roll-up for the range
 *
 * Both new endpoints are tenant-aware (x-tenant-id header required), use JWT auth,
 * and emit Prometheus metrics through UsageAnalyticsService.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Registry } from 'prom-client';
import { verifyJwt } from '../middleware/auth.js';
import {
  extractTenantId,
  getTenantPoolProxy,
  isPoolContentionError,
  sendPoolContentionResponse,
} from '../middleware/tenant.js';
import { assertTenantContextAvailable, tenantContext } from '../../config/index.js';
import {
  UsageAnalyticsService,
  createAnalyticsMetrics,
  type Granularity,
} from '../../analytics/usage_analytics_service.js';

// ── Module-level singleton: one metrics registry per process ───────────────────
const analyticsRegistry = new Registry();
const analyticsMetrics = createAnalyticsMetrics(analyticsRegistry);
const analyticsService = new UsageAnalyticsService(analyticsMetrics);

// ── Query-string shapes ────────────────────────────────────────────────────────

interface AnalyticsQuery {
  deviceId: string;
  start: string;
  end: string;
}

interface UsageRangeQuery {
  start: string;
  end: string;
  granularity?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const VALID_GRANULARITIES: ReadonlySet<string> = new Set([
  'auto',
  'fifteen_minute',
  'hourly',
  'daily',
  'weekly',
  'monthly',
]);

function parseUsageQuery(
  query: UsageRangeQuery,
  reply: FastifyReply,
): { start: Date; end: Date; granularity: Granularity } | null {
  const startDate = new Date(query.start);
  const endDate = new Date(query.end);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    void reply.status(400).send({
      error: 'Bad Request',
      message: 'Invalid start or end date format. Use ISO 8601 (e.g. 2026-01-01T00:00:00Z).',
    });
    return null;
  }

  if (startDate >= endDate) {
    void reply.status(400).send({
      error: 'Bad Request',
      message: 'start must be strictly before end',
    });
    return null;
  }

  const granularity = (query.granularity ?? 'auto') as Granularity;
  if (!VALID_GRANULARITIES.has(granularity)) {
    void reply.status(400).send({
      error: 'Bad Request',
      message: `Invalid granularity "${granularity}". Valid values: ${[...VALID_GRANULARITIES].join(', ')}`,
    });
    return null;
  }

  return { start: startDate, end: endDate, granularity };
}

// ── Route registration ─────────────────────────────────────────────────────────

export function registerAnalyticsRoutes(app: FastifyInstance): void {
  // ── Existing endpoint ──────────────────────────────────────────────────────

  /**
   * GET /api/analytics/telemetry
   * Retrieve aggregated telemetry data using the smallest granularity satisfying the time range.
   */
  app.get<{ Querystring: AnalyticsQuery }>(
    '/api/analytics/telemetry',
    {
      preHandler: [verifyJwt, extractTenantId],
      schema: {
        querystring: {
          type: 'object',
          required: ['deviceId', 'start', 'end'],
          properties: {
            deviceId: { type: 'string' },
            start: { type: 'string', format: 'date-time' },
            end: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: AnalyticsQuery }>, reply: FastifyReply) => {
      const { deviceId, start, end } = request.query;

      const startDate = new Date(start);
      const endDate = new Date(end);

      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        await reply.status(400).send({
          error: 'Bad Request',
          message: 'Invalid start or end date format',
        });
        return;
      }

      if (startDate > endDate) {
        await reply.status(400).send({
          error: 'Bad Request',
          message: 'Start date must be before end date',
        });
        return;
      }

      const rangeMs = endDate.getTime() - startDate.getTime();
      const rangeDays = rangeMs / (1000 * 60 * 60 * 24);

      // Select the smallest aggregate view satisfying the time range
      let viewName = 'monthly_device_usage';
      if (rangeDays <= 0.25) {
        // <= 6 hours
        viewName = 'fifteen_minute_device_usage';
      } else if (rangeDays <= 3) {
        // <= 3 days
        viewName = 'hourly_device_usage';
      } else if (rangeDays <= 30) {
        // <= 30 days
        viewName = 'daily_device_usage';
      } else if (rangeDays <= 120) {
        // <= 120 days
        viewName = 'weekly_device_usage';
      }

      assertTenantContextAvailable();
      const tenantId = tenantContext() ?? request.tenantId;
      if (tenantId === undefined) {
        await reply.status(400).send({
          error: 'Bad Request',
          message: 'Missing tenant context',
        });
        return;
      }

      const poolProxy = getTenantPoolProxy();
      let client;
      try {
        client = await poolProxy.connect(tenantId);

        const query = `
          SELECT 
            bucket,
            device_id AS "deviceId",
            sample_count AS "sampleCount",
            total_value AS "totalValue",
            avg_value AS "avgValue",
            min_value AS "minValue",
            max_value AS "maxValue",
            _aggregate_watermark AS "aggregateWatermark"
          FROM ${viewName}
          WHERE device_id = $1 AND bucket >= $2 AND bucket <= $3
          ORDER BY bucket ASC
        `;

        const result = await client.query(query, [deviceId, startDate, endDate]);
        await reply.send({
          viewUsed: viewName,
          rangeDays,
          data: result.rows,
        });
        return;
      } catch (error) {
        if (isPoolContentionError(error)) {
          await sendPoolContentionResponse(reply, error);
          return;
        }
        request.log.error(error as Error, 'Analytics query failed');
        await reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Failed to retrieve telemetry analytics',
        });
        return;
      } finally {
        client?.release();
      }
    },
  );

  // ── New endpoints (Issue #301) ─────────────────────────────────────────────

  /**
   * GET /api/analytics/usage/summary
   *
   * Returns an aggregated usage summary across the tenant's entire device fleet
   * for a given time range. Supports multi-granularity bucketing (auto | fifteen_minute |
   * hourly | daily | weekly | monthly).
   *
   * Query parameters:
   *   start       — ISO 8601 start timestamp (required)
   *   end         — ISO 8601 end timestamp (required)
   *   granularity — bucket size; defaults to "auto" (finest adequate view)
   */
  app.get<{ Querystring: UsageRangeQuery }>(
    '/api/analytics/usage/summary',
    {
      preHandler: [verifyJwt, extractTenantId],
      schema: {
        querystring: {
          type: 'object',
          required: ['start', 'end'],
          properties: {
            start: { type: 'string' },
            end: { type: 'string' },
            granularity: { type: 'string' },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: UsageRangeQuery }>, reply: FastifyReply) => {
      const parsed = parseUsageQuery(request.query, reply);
      if (!parsed) return;
      const { start, end, granularity } = parsed;

      assertTenantContextAvailable();
      const tenantId = tenantContext() ?? request.tenantId;
      if (tenantId === undefined) {
        await reply.status(400).send({
          error: 'Bad Request',
          message: 'Missing tenant context',
        });
        return;
      }

      const poolProxy = getTenantPoolProxy();
      let client;
      try {
        client = await poolProxy.connect(tenantId);
        const summary = await analyticsService.getUsageSummary(
          client,
          tenantId,
          start,
          end,
          granularity,
        );
        await reply.send(summary);
        return;
      } catch (error) {
        if (isPoolContentionError(error)) {
          await sendPoolContentionResponse(reply, error);
          return;
        }
        request.log.error(error as Error, 'Analytics usage summary query failed');
        await reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Failed to retrieve usage summary',
        });
        return;
      } finally {
        client?.release();
      }
    },
  );

  /**
   * GET /api/analytics/usage/device-breakdown
   *
   * Returns per-device aggregated usage for a given time range. Each device
   * in the tenant fleet appears as a single entry showing total, avg, min, and
   * max values together with the first and last active bucket timestamps.
   *
   * Query parameters:
   *   start       — ISO 8601 start timestamp (required)
   *   end         — ISO 8601 end timestamp (required)
   *   granularity — bucket size; defaults to "auto"
   */
  app.get<{ Querystring: UsageRangeQuery }>(
    '/api/analytics/usage/device-breakdown',
    {
      preHandler: [verifyJwt, extractTenantId],
      schema: {
        querystring: {
          type: 'object',
          required: ['start', 'end'],
          properties: {
            start: { type: 'string' },
            end: { type: 'string' },
            granularity: { type: 'string' },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: UsageRangeQuery }>, reply: FastifyReply) => {
      const parsed = parseUsageQuery(request.query, reply);
      if (!parsed) return;
      const { start, end, granularity } = parsed;

      assertTenantContextAvailable();
      const tenantId = tenantContext() ?? request.tenantId;
      if (tenantId === undefined) {
        await reply.status(400).send({
          error: 'Bad Request',
          message: 'Missing tenant context',
        });
        return;
      }

      const poolProxy = getTenantPoolProxy();
      let client;
      try {
        client = await poolProxy.connect(tenantId);
        const breakdown = await analyticsService.getDeviceBreakdown(
          client,
          tenantId,
          start,
          end,
          granularity,
        );
        await reply.send(breakdown);
        return;
      } catch (error) {
        if (isPoolContentionError(error)) {
          await sendPoolContentionResponse(reply, error);
          return;
        }
        request.log.error(error as Error, 'Analytics device breakdown query failed');
        await reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Failed to retrieve device breakdown',
        });
        return;
      } finally {
        client?.release();
      }
    },
  );
}
