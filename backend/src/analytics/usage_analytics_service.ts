/**
 * UsageAnalyticsService — Issue #301: Usage Analytics with Time-Series Aggregation
 *
 * Provides multi-granularity time-series aggregation over device telemetry data
 * stored in TimescaleDB continuous aggregate views. Tenant-aware, with Prometheus
 * instrumentation for query latency and result set sizes.
 *
 * Supported granularities map to the TimescaleDB continuous aggregate views
 * already defined in src/database/views/continuous_aggs.sql:
 *
 *   fifteen_minute_device_usage  — ≤ 6 hours of data
 *   hourly_device_usage          — ≤ 3 days of data
 *   daily_device_usage           — ≤ 30 days of data
 *   weekly_device_usage          — ≤ 120 days of data
 *   monthly_device_usage         — anything wider
 */

import { Counter, Histogram, type Registry } from 'prom-client';

// ── Granularity ────────────────────────────────────────────────────────────────

export type Granularity =
  | 'fifteen_minute'
  | 'hourly'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'auto';

/** Continuous-aggregate view names, keyed by granularity. */
const VIEW_NAMES: Record<Exclude<Granularity, 'auto'>, string> = {
  fifteen_minute: 'fifteen_minute_device_usage',
  hourly: 'hourly_device_usage',
  daily: 'daily_device_usage',
  weekly: 'weekly_device_usage',
  monthly: 'monthly_device_usage',
};

/**
 * Automatically select the finest granularity that covers the given range.
 *
 * @param rangeMs — time range in milliseconds
 * @returns the coarsest view that still has full coverage for this range
 */
export function selectGranularity(rangeMs: number): Exclude<Granularity, 'auto'> {
  const hours = rangeMs / (1000 * 60 * 60);
  if (hours <= 6) return 'fifteen_minute';
  if (hours <= 72) return 'hourly';
  if (hours <= 720) return 'daily';
  if (hours <= 2880) return 'weekly';
  return 'monthly';
}

// ── Types ──────────────────────────────────────────────────────────────────────

/** A single time-bucket row returned from the aggregate view. */
export interface UsageBucket {
  bucket: Date;
  deviceId: string;
  sampleCount: number;
  totalValue: number;
  avgValue: number;
  minValue: number;
  maxValue: number;
  aggregateWatermark?: string;
}

/** Aggregated usage summary across all devices for the requested range. */
export interface UsageSummary {
  tenantId: string;
  start: Date;
  end: Date;
  granularity: Exclude<Granularity, 'auto'>;
  viewUsed: string;
  totalSamples: number;
  totalValue: number;
  avgValue: number;
  minValue: number;
  maxValue: number;
  deviceCount: number;
  buckets: UsageBucket[];
}

/** Per-device aggregation for the device-breakdown endpoint. */
export interface DeviceUsageEntry {
  deviceId: string;
  totalSamples: number;
  totalValue: number;
  avgValue: number;
  minValue: number;
  maxValue: number;
  firstBucket: Date;
  lastBucket: Date;
}

export interface DeviceBreakdown {
  tenantId: string;
  start: Date;
  end: Date;
  granularity: Exclude<Granularity, 'auto'>;
  viewUsed: string;
  devices: DeviceUsageEntry[];
}

/** Minimal interface for a DB client — compatible with pg.PoolClient. */
export interface DbClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

// ── Prometheus metrics ─────────────────────────────────────────────────────────

export interface AnalyticsMetrics {
  queryDuration: Histogram;
  rowsReturned: Histogram;
  queryTotal: Counter;
}

/**
 * Create and register the Prometheus metrics for the analytics service.
 * Pass a custom `Registry` (or the default `register`) to avoid collisions
 * in tests.
 */
export function createAnalyticsMetrics(registry: Registry): AnalyticsMetrics {
  const queryDuration = new Histogram({
    name: 'analytics_query_duration_seconds',
    help: 'Latency of analytics DB queries in seconds',
    labelNames: ['granularity', 'query_type', 'tenant_id'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2],
    registers: [registry],
  });

  const rowsReturned = new Histogram({
    name: 'analytics_rows_returned',
    help: 'Number of rows returned by analytics queries',
    labelNames: ['granularity', 'query_type', 'tenant_id'],
    buckets: [1, 5, 10, 50, 100, 500, 1000, 5000],
    registers: [registry],
  });

  const queryTotal = new Counter({
    name: 'analytics_queries_total',
    help: 'Total number of analytics queries executed',
    labelNames: ['granularity', 'query_type', 'tenant_id', 'status'],
    registers: [registry],
  });

  return { queryDuration, rowsReturned, queryTotal };
}

// ── UsageAnalyticsService ──────────────────────────────────────────────────────

/**
 * Service that aggregates IoT device telemetry by time bucket and tenant.
 *
 * All queries are parameterised to prevent SQL injection. The service itself
 * is stateless — callers supply the DB client and tenant ID on every call,
 * making it safe to share across requests.
 */
export class UsageAnalyticsService {
  private readonly metrics: AnalyticsMetrics;

  constructor(metrics: AnalyticsMetrics) {
    this.metrics = metrics;
  }

  /**
   * Return a usage summary (one row per bucket, aggregated across the entire
   * tenant fleet) for the given time range.
   *
   * @param client    — authenticated DB connection for this tenant
   * @param tenantId  — used as a Prometheus label and for audit purposes
   * @param start     — inclusive start timestamp
   * @param end       — inclusive end timestamp
   * @param granularity — time bucket size; `'auto'` picks the finest adequate view
   */
  async getUsageSummary(
    client: DbClient,
    tenantId: string,
    start: Date,
    end: Date,
    granularity: Granularity = 'auto',
  ): Promise<UsageSummary> {
    const rangeMs = end.getTime() - start.getTime();
    const resolved: Exclude<Granularity, 'auto'> =
      granularity === 'auto' ? selectGranularity(rangeMs) : granularity;
    const viewName = VIEW_NAMES[resolved];

    const end_ = this.metrics.queryDuration.startTimer({
      granularity: resolved,
      query_type: 'summary',
      tenant_id: tenantId,
    });

    try {
      const sql = `
        SELECT
          bucket,
          device_id                AS "deviceId",
          sample_count             AS "sampleCount",
          total_value              AS "totalValue",
          avg_value                AS "avgValue",
          min_value                AS "minValue",
          max_value                AS "maxValue",
          _aggregate_watermark     AS "aggregateWatermark"
        FROM ${viewName}
        WHERE bucket >= $1
          AND bucket <= $2
        ORDER BY bucket ASC
      `;

      const result = await client.query(sql, [start, end]);
      const buckets = result.rows.map((r) => this.mapBucketRow(r));

      const summary = this.summariseBuckets(buckets, tenantId, start, end, resolved, viewName);

      this.metrics.rowsReturned.observe(
        { granularity: resolved, query_type: 'summary', tenant_id: tenantId },
        buckets.length,
      );
      this.metrics.queryTotal.inc({
        granularity: resolved,
        query_type: 'summary',
        tenant_id: tenantId,
        status: 'ok',
      });

      return summary;
    } catch (err) {
      this.metrics.queryTotal.inc({
        granularity: resolved,
        query_type: 'summary',
        tenant_id: tenantId,
        status: 'error',
      });
      throw err;
    } finally {
      end_();
    }
  }

  /**
   * Return per-device usage aggregates (one row per device) for the given
   * time range, suitable for the device-breakdown endpoint.
   */
  async getDeviceBreakdown(
    client: DbClient,
    tenantId: string,
    start: Date,
    end: Date,
    granularity: Granularity = 'auto',
  ): Promise<DeviceBreakdown> {
    const rangeMs = end.getTime() - start.getTime();
    const resolved: Exclude<Granularity, 'auto'> =
      granularity === 'auto' ? selectGranularity(rangeMs) : granularity;
    const viewName = VIEW_NAMES[resolved];

    const endTimer = this.metrics.queryDuration.startTimer({
      granularity: resolved,
      query_type: 'device_breakdown',
      tenant_id: tenantId,
    });

    try {
      const sql = `
        SELECT
          device_id                    AS "deviceId",
          SUM(sample_count)            AS "totalSamples",
          SUM(total_value)             AS "totalValue",
          AVG(avg_value)               AS "avgValue",
          MIN(min_value)               AS "minValue",
          MAX(max_value)               AS "maxValue",
          MIN(bucket)                  AS "firstBucket",
          MAX(bucket)                  AS "lastBucket"
        FROM ${viewName}
        WHERE bucket >= $1
          AND bucket <= $2
        GROUP BY device_id
        ORDER BY "totalValue" DESC
      `;

      const result = await client.query(sql, [start, end]);
      const devices: DeviceUsageEntry[] = result.rows.map((r) => ({
        deviceId: String(r['deviceId'] ?? r['device_id'] ?? ''),
        totalSamples: Number(r['totalSamples'] ?? 0),
        totalValue: Number(r['totalValue'] ?? 0),
        avgValue: Number(r['avgValue'] ?? 0),
        minValue: Number(r['minValue'] ?? 0),
        maxValue: Number(r['maxValue'] ?? 0),
        firstBucket: new Date(String(r['firstBucket'])),
        lastBucket: new Date(String(r['lastBucket'])),
      }));

      this.metrics.rowsReturned.observe(
        { granularity: resolved, query_type: 'device_breakdown', tenant_id: tenantId },
        devices.length,
      );
      this.metrics.queryTotal.inc({
        granularity: resolved,
        query_type: 'device_breakdown',
        tenant_id: tenantId,
        status: 'ok',
      });

      return { tenantId, start, end, granularity: resolved, viewUsed: viewName, devices };
    } catch (err) {
      this.metrics.queryTotal.inc({
        granularity: resolved,
        query_type: 'device_breakdown',
        tenant_id: tenantId,
        status: 'error',
      });
      throw err;
    } finally {
      endTimer();
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private mapBucketRow(r: Record<string, unknown>): UsageBucket {
    return {
      bucket: new Date(String(r['bucket'])),
      deviceId: String(r['deviceId'] ?? r['device_id'] ?? ''),
      sampleCount: Number(r['sampleCount'] ?? 0),
      totalValue: Number(r['totalValue'] ?? 0),
      avgValue: Number(r['avgValue'] ?? 0),
      minValue: Number(r['minValue'] ?? 0),
      maxValue: Number(r['maxValue'] ?? 0),
      aggregateWatermark:
        r['aggregateWatermark'] !== undefined ? String(r['aggregateWatermark']) : undefined,
    };
  }

  private summariseBuckets(
    buckets: UsageBucket[],
    tenantId: string,
    start: Date,
    end: Date,
    granularity: Exclude<Granularity, 'auto'>,
    viewUsed: string,
  ): UsageSummary {
    if (buckets.length === 0) {
      return {
        tenantId,
        start,
        end,
        granularity,
        viewUsed,
        totalSamples: 0,
        totalValue: 0,
        avgValue: 0,
        minValue: 0,
        maxValue: 0,
        deviceCount: 0,
        buckets: [],
      };
    }

    let totalSamples = 0;
    let totalValue = 0;
    let minValue = Infinity;
    let maxValue = -Infinity;
    const deviceIds = new Set<string>();

    for (const b of buckets) {
      totalSamples += b.sampleCount;
      totalValue += b.totalValue;
      if (b.minValue < minValue) minValue = b.minValue;
      if (b.maxValue > maxValue) maxValue = b.maxValue;
      deviceIds.add(b.deviceId);
    }

    return {
      tenantId,
      start,
      end,
      granularity,
      viewUsed,
      totalSamples,
      totalValue,
      avgValue: totalSamples > 0 ? totalValue / totalSamples : 0,
      minValue: isFinite(minValue) ? minValue : 0,
      maxValue: isFinite(maxValue) ? maxValue : 0,
      deviceCount: deviceIds.size,
      buckets,
    };
  }
}
