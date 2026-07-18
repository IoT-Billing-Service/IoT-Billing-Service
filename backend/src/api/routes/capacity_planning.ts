/**
 * Capacity Planning – Historical Usage Trending (issue #87)
 *
 * GET /api/analytics/capacity-planning
 *
 * Queries the existing TimescaleDB continuous-aggregate views (daily, weekly,
 * or monthly) to compute a linear trend over a configurable lookback window,
 * then projects utilization forward over a configurable horizon.  No new DB
 * tables or background jobs are introduced – everything reuses the continuous
 * aggregates already maintained by the analytics pipeline.
 *
 * Security: the endpoint requires a valid JWT and honours tenant isolation via
 * the shared tenant pool proxy (same as /api/analytics/telemetry).  No raw
 * billing amounts are returned – only aggregated usage statistics.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { verifyJwt } from '../middleware/auth.js';
import {
  extractTenantId,
  getTenantPoolProxy,
  isPoolContentionError,
  sendPoolContentionResponse,
} from '../middleware/tenant.js';
import { assertTenantContextAvailable, tenantContext } from '../../config/index.js';
import {
  setCapacityUtilizationRatio,
  setCapacityProjectedGrowthRate,
  setCapacityTrendDataPoints,
  setCapacityTrendLastUpdated,
} from '../metrics/prometheus.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Period = 'daily' | 'weekly' | 'monthly';

interface CapacityPlanningQuery {
  deviceId?: string;
  accountId?: string;
  period?: Period;
  lookbackDays?: string;
  horizonDays?: string;
}

interface UsagePoint {
  bucket: Date;
  totalValue: number;
}

export interface TrendResult {
  /** Linear regression slope (usage units per day). */
  slopePerDay: number;
  /** Pearson R² goodness-of-fit [0, 1]. */
  r2: number;
  /** Average usage across the lookback window. */
  avgUsage: number;
  /** Peak (maximum) usage in the lookback window. */
  peakUsage: number;
  /** Coefficient of variation (stddev / mean).  NaN when mean is 0. */
  coefficientOfVariation: number;
  /** Number of data points used. */
  dataPoints: number;
}

export interface CapacityProjection {
  horizonDays: number;
  /** Projected total usage at the end of the horizon, derived from the trend. */
  projectedUsage: number;
  /** Growth rate relative to current average: (projected - avg) / avg. */
  growthRate: number;
}

export interface CapacityPlanningResponse {
  deviceId: string | null;
  accountId: string | null;
  period: Period;
  lookbackDays: number;
  viewUsed: string;
  trend: TrendResult;
  projection: CapacityProjection;
  /** ISO timestamp of the most recent bucket in the query result. */
  lastDataPoint: string | null;
  computedAt: string;
}

// ---------------------------------------------------------------------------
// Pure computation helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Ordinary Least Squares linear regression.
 *
 * @param xs  – independent variable (time offset in days from first bucket)
 * @param ys  – dependent variable (usage value)
 * @returns slope (Δy per day) and intercept
 */
export function linearRegression(xs: number[], ys: number[]): { slope: number; intercept: number } {
  const n = xs.length;
  if (n === 0) return { slope: 0, intercept: 0 };
  if (n === 1) return { slope: 0, intercept: ys[0] ?? 0 };

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;

  for (let i = 0; i < n; i++) {
    const x = xs[i] ?? 0;
    const y = ys[i] ?? 0;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }

  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: sumY / n };

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

/**
 * Compute Pearson R² for a set of observed and predicted values.
 */
export function computeR2(ys: number[], yPred: number[]): number {
  const n = ys.length;
  if (n < 2) return 0;

  const mean = ys.reduce((a, b) => a + b, 0) / n;
  let ssTot = 0;
  let ssRes = 0;

  for (let i = 0; i < n; i++) {
    const y = ys[i] ?? 0;
    const p = yPred[i] ?? 0;
    ssTot += (y - mean) ** 2;
    ssRes += (y - p) ** 2;
  }

  if (ssTot === 0) return 1; // perfect flat line
  return Math.max(0, 1 - ssRes / ssTot);
}

/**
 * Derive all capacity metrics from a sorted array of usage buckets.
 */
export function computeTrend(points: UsagePoint[]): TrendResult {
  const n = points.length;
  if (n === 0) {
    return {
      slopePerDay: 0,
      r2: 0,
      avgUsage: 0,
      peakUsage: 0,
      coefficientOfVariation: 0,
      dataPoints: 0,
    };
  }

  const t0 = points[0]!.bucket.getTime();
  const MS_PER_DAY = 86_400_000;

  const xs = points.map((p) => (p.bucket.getTime() - t0) / MS_PER_DAY);
  const ys = points.map((p) => p.totalValue);

  const { slope, intercept } = linearRegression(xs, ys);
  const yPred = xs.map((x) => slope * x + intercept);
  const r2 = computeR2(ys, yPred);

  const avgUsage = ys.reduce((a, b) => a + b, 0) / n;
  const peakUsage = Math.max(...ys);

  let variance = 0;
  for (const y of ys) {
    variance += (y - avgUsage) ** 2;
  }
  variance /= n;
  const stdDev = Math.sqrt(variance);
  const coefficientOfVariation = avgUsage === 0 ? 0 : stdDev / avgUsage;

  return { slopePerDay: slope, r2, avgUsage, peakUsage, coefficientOfVariation, dataPoints: n };
}

/**
 * Project utilization `horizonDays` into the future.
 *
 * Uses the current average as the baseline and the linear trend slope to
 * estimate growth.  If the average is zero we cannot compute a relative growth
 * rate, so we fall back to zero.
 */
export function projectCapacity(trend: TrendResult, horizonDays: number): CapacityProjection {
  const projectedUsage = trend.avgUsage + trend.slopePerDay * horizonDays;
  const growthRate =
    trend.avgUsage === 0 ? 0 : (projectedUsage - trend.avgUsage) / trend.avgUsage;
  return { horizonDays, projectedUsage, growthRate };
}

// ---------------------------------------------------------------------------
// View selection (reuses the same logic as the analytics route)
// ---------------------------------------------------------------------------

function selectView(period: Period): string {
  switch (period) {
    case 'weekly':
      return 'weekly_device_usage';
    case 'monthly':
      return 'monthly_device_usage';
    default:
      return 'daily_device_usage';
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerCapacityPlanningRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: CapacityPlanningQuery }>(
    '/api/analytics/capacity-planning',
    {
      preHandler: [verifyJwt, extractTenantId],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            deviceId: { type: 'string' },
            accountId: { type: 'string' },
            period: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
            lookbackDays: { type: 'string' },
            horizonDays: { type: 'string' },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Querystring: CapacityPlanningQuery }>,
      reply: FastifyReply,
    ) => {
      const {
        deviceId,
        accountId,
        period = 'daily',
        lookbackDays: lookbackDaysStr = '30',
        horizonDays: horizonDaysStr = '30',
      } = request.query;

      // Validate at least one filter is provided
      if (!deviceId && !accountId) {
        await reply.status(400).send({
          error: 'Bad Request',
          message: 'At least one of deviceId or accountId is required',
        });
        return;
      }

      const lookbackDays = parseInt(lookbackDaysStr, 10);
      const horizonDays = parseInt(horizonDaysStr, 10);

      if (!Number.isFinite(lookbackDays) || lookbackDays < 1 || lookbackDays > 365) {
        await reply.status(400).send({
          error: 'Bad Request',
          message: 'lookbackDays must be between 1 and 365',
        });
        return;
      }

      if (!Number.isFinite(horizonDays) || horizonDays < 1 || horizonDays > 365) {
        await reply.status(400).send({
          error: 'Bad Request',
          message: 'horizonDays must be between 1 and 365',
        });
        return;
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

      const viewName = selectView(period);
      const startDate = new Date(Date.now() - lookbackDays * 86_400_000);
      const endDate = new Date();

      const poolProxy = getTenantPoolProxy();
      let client;
      try {
        client = await poolProxy.connect(tenantId);

        // Build a WHERE clause that filters by deviceId and/or accountId.
        // daily_device_usage has device_id; daily_billing_summary has both.
        // For the telemetry views (daily/weekly/monthly_device_usage) we only
        // have device_id, so when accountId is provided without deviceId we
        // fall back to the daily_billing_summary view.
        let rows: UsagePoint[];

        if (accountId && !deviceId) {
          // Use billing summary view which has account_id
          const sql = `
            SELECT
              bucket,
              SUM(total_usage)::double precision AS "totalValue"
            FROM daily_billing_summary
            WHERE account_id = $1
              AND bucket >= $2
              AND bucket <= $3
            GROUP BY bucket
            ORDER BY bucket ASC
          `;
          const result = await client.query(sql, [accountId, startDate, endDate]);
          rows = (result.rows as { bucket: Date; totalValue: string | number }[]).map((r) => ({
            bucket: new Date(r.bucket),
            totalValue: Number(r.totalValue),
          }));
        } else {
          // Use the telemetry continuous-agg view (device_id filter required)
          const params: (string | Date)[] = [deviceId!, startDate, endDate];
          let sql = `
            SELECT
              bucket,
              total_value::double precision AS "totalValue"
            FROM ${viewName}
            WHERE device_id = $1
              AND bucket >= $2
              AND bucket <= $3
          `;
          if (accountId) {
            // Extra safety: when both are provided, we trust the deviceId filter
            // and note that telemetry views don't carry account_id, so the
            // accountId is ignored here (documented assumption).
            void accountId; // explicitly unused
          }
          sql += ' ORDER BY bucket ASC';
          const result = await client.query(sql, params);
          rows = (result.rows as { bucket: Date; totalValue: string | number }[]).map((r) => ({
            bucket: new Date(r.bucket),
            totalValue: Number(r.totalValue),
          }));
        }

        const trend = computeTrend(rows);
        const projection = projectCapacity(trend, horizonDays);

        const lastDataPoint =
          rows.length > 0 ? (rows[rows.length - 1]!.bucket.toISOString()) : null;

        // Update Prometheus gauges (tenant + device labels kept off to cap cardinality)
        const dimensionLabel = deviceId ?? accountId ?? 'unknown';
        setCapacityUtilizationRatio(dimensionLabel, period, projection.growthRate);
        setCapacityProjectedGrowthRate(dimensionLabel, period, trend.slopePerDay);
        setCapacityTrendDataPoints(dimensionLabel, period, trend.dataPoints);
        setCapacityTrendLastUpdated(dimensionLabel, period, Date.now() / 1000);

        const body: CapacityPlanningResponse = {
          deviceId: deviceId ?? null,
          accountId: accountId ?? null,
          period,
          lookbackDays,
          viewUsed: accountId && !deviceId ? 'daily_billing_summary' : viewName,
          trend,
          projection,
          lastDataPoint,
          computedAt: new Date().toISOString(),
        };

        await reply.send(body);
        return;
      } catch (error) {
        if (isPoolContentionError(error)) {
          await sendPoolContentionResponse(reply, error);
          return;
        }
        request.log.error(error as Error, 'Capacity planning query failed');
        await reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Failed to compute capacity planning metrics',
        });
        return;
      } finally {
        client?.release();
      }
    },
  );
}
