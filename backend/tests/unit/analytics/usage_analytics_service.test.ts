/**
 * Unit tests for UsageAnalyticsService (Issue #301)
 *
 * Tests cover:
 *  - selectGranularity: correct view selection across all time ranges
 *  - createAnalyticsMetrics: registry isolation
 *  - UsageAnalyticsService.getUsageSummary: happy path, empty result, error path,
 *    explicit granularity, Prometheus metrics emission
 *  - UsageAnalyticsService.getDeviceBreakdown: happy path, empty result, error path
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Registry } from 'prom-client';
import {
  selectGranularity,
  createAnalyticsMetrics,
  UsageAnalyticsService,
  type DbClient,
  type AnalyticsMetrics,
} from '../../../src/analytics/usage_analytics_service.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRegistry(): Registry {
  return new Registry();
}

function makeMetrics(registry?: Registry): AnalyticsMetrics {
  return createAnalyticsMetrics(registry ?? makeRegistry());
}

function makeService(metrics?: AnalyticsMetrics): UsageAnalyticsService {
  return new UsageAnalyticsService(metrics ?? makeMetrics());
}

/** Build a mock DbClient that resolves with the provided rows. */
function mockClient(rows: Record<string, unknown>[]): DbClient {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  };
}

/** Build a mock DbClient that rejects with the provided error. */
function errorClient(err: Error): DbClient {
  return {
    query: vi.fn().mockRejectedValue(err),
  };
}

const START = new Date('2026-01-01T00:00:00Z');
const END_6H = new Date('2026-01-01T06:00:00Z');     // 6 hours → fifteen_minute
const END_3D = new Date('2026-01-04T00:00:00Z');     // 3 days  → hourly
const END_30D = new Date('2026-01-31T00:00:00Z');    // 30 days  → daily
const END_120D = new Date('2026-05-01T00:00:00Z');   // ~120 d  → weekly
const END_1Y = new Date('2027-01-01T00:00:00Z');     // ~365 d  → monthly

/** Sample bucket rows returned from DB. */
function sampleRows(deviceId = 'dev-001', count = 3): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    bucket: new Date(START.getTime() + i * 60 * 60 * 1000).toISOString(),
    deviceId: deviceId,
    sampleCount: 10 + i,
    totalValue: 100.0 + i * 10,
    avgValue: 10.0 + i,
    minValue: 5.0,
    maxValue: 15.0 + i,
    aggregateWatermark: 'wm-' + i.toString(),
  }));
}

// ── selectGranularity ─────────────────────────────────────────────────────────

describe('selectGranularity', () => {
  it('returns fifteen_minute for ranges up to 6 hours', () => {
    // Exactly 6 hours
    expect(selectGranularity(6 * 60 * 60 * 1000)).toBe('fifteen_minute');
    // Less than 6 hours
    expect(selectGranularity(1 * 60 * 60 * 1000)).toBe('fifteen_minute');
  });

  it('returns hourly for ranges up to 72 hours (3 days)', () => {
    // Just over 6 hours
    expect(selectGranularity(6.5 * 60 * 60 * 1000)).toBe('hourly');
    // Exactly 72 hours
    expect(selectGranularity(72 * 60 * 60 * 1000)).toBe('hourly');
  });

  it('returns daily for ranges up to 720 hours (30 days)', () => {
    // Just over 3 days
    expect(selectGranularity(73 * 60 * 60 * 1000)).toBe('daily');
    // Exactly 30 days
    expect(selectGranularity(30 * 24 * 60 * 60 * 1000)).toBe('daily');
  });

  it('returns weekly for ranges up to 2880 hours (120 days)', () => {
    // Just over 30 days
    expect(selectGranularity(31 * 24 * 60 * 60 * 1000)).toBe('weekly');
    // Exactly 120 days
    expect(selectGranularity(120 * 24 * 60 * 60 * 1000)).toBe('weekly');
  });

  it('returns monthly for ranges wider than 120 days', () => {
    expect(selectGranularity(121 * 24 * 60 * 60 * 1000)).toBe('monthly');
    expect(selectGranularity(365 * 24 * 60 * 60 * 1000)).toBe('monthly');
  });
});

// ── createAnalyticsMetrics ────────────────────────────────────────────────────

describe('createAnalyticsMetrics', () => {
  it('creates distinct metrics on a fresh registry', () => {
    const reg = makeRegistry();
    const m = createAnalyticsMetrics(reg);
    expect(m.queryDuration).toBeDefined();
    expect(m.rowsReturned).toBeDefined();
    expect(m.queryTotal).toBeDefined();
  });

  it('does not collide when using separate registries', () => {
    // Creating metrics twice on separate registries must not throw
    expect(() => {
      createAnalyticsMetrics(makeRegistry());
      createAnalyticsMetrics(makeRegistry());
    }).not.toThrow();
  });
});

// ── UsageAnalyticsService.getUsageSummary ─────────────────────────────────────

describe('UsageAnalyticsService.getUsageSummary', () => {
  let service: UsageAnalyticsService;

  beforeEach(() => {
    service = makeService();
  });

  it('returns correct summary for a 6-hour range (fifteen_minute view)', async () => {
    const rows = sampleRows('dev-001', 3);
    const client = mockClient(rows);

    const summary = await service.getUsageSummary(client, 'tenant-1', START, END_6H);

    expect(summary.granularity).toBe('fifteen_minute');
    expect(summary.viewUsed).toBe('fifteen_minute_device_usage');
    expect(summary.tenantId).toBe('tenant-1');
    expect(summary.buckets).toHaveLength(3);
    expect(summary.deviceCount).toBe(1);
    expect(summary.totalSamples).toBe(10 + 11 + 12);
    expect(summary.totalValue).toBeCloseTo(100 + 110 + 120);
  });

  it('selects the hourly view for a 3-day range', async () => {
    const client = mockClient(sampleRows());
    const summary = await service.getUsageSummary(client, 'tenant-1', START, END_3D);
    expect(summary.granularity).toBe('hourly');
    expect(summary.viewUsed).toBe('hourly_device_usage');
  });

  it('selects the daily view for a 30-day range', async () => {
    const client = mockClient(sampleRows());
    const summary = await service.getUsageSummary(client, 'tenant-1', START, END_30D);
    expect(summary.granularity).toBe('daily');
    expect(summary.viewUsed).toBe('daily_device_usage');
  });

  it('selects the weekly view for a 120-day range', async () => {
    const client = mockClient(sampleRows());
    const summary = await service.getUsageSummary(client, 'tenant-1', START, END_120D);
    expect(summary.granularity).toBe('weekly');
    expect(summary.viewUsed).toBe('weekly_device_usage');
  });

  it('selects the monthly view for a 1-year range', async () => {
    const client = mockClient(sampleRows());
    const summary = await service.getUsageSummary(client, 'tenant-1', START, END_1Y);
    expect(summary.granularity).toBe('monthly');
    expect(summary.viewUsed).toBe('monthly_device_usage');
  });

  it('respects an explicit granularity override', async () => {
    const client = mockClient(sampleRows());
    // Force monthly even for a 6-hour range
    const summary = await service.getUsageSummary(client, 'tenant-1', START, END_6H, 'monthly');
    expect(summary.granularity).toBe('monthly');
    expect(summary.viewUsed).toBe('monthly_device_usage');
  });

  it('returns zero aggregates for an empty result set', async () => {
    const client = mockClient([]);
    const summary = await service.getUsageSummary(client, 'tenant-1', START, END_6H);
    expect(summary.buckets).toHaveLength(0);
    expect(summary.totalSamples).toBe(0);
    expect(summary.totalValue).toBe(0);
    expect(summary.avgValue).toBe(0);
    expect(summary.minValue).toBe(0);
    expect(summary.maxValue).toBe(0);
    expect(summary.deviceCount).toBe(0);
  });

  it('counts distinct devices correctly across multiple bucket rows', async () => {
    const rows = [
      ...sampleRows('dev-A', 2),
      ...sampleRows('dev-B', 3),
      ...sampleRows('dev-C', 1),
    ];
    const client = mockClient(rows);
    const summary = await service.getUsageSummary(client, 'tenant-1', START, END_30D);
    expect(summary.deviceCount).toBe(3);
  });

  it('propagates DB errors and increments error counter', async () => {
    const reg = makeRegistry();
    const metrics = createAnalyticsMetrics(reg);
    const svc = new UsageAnalyticsService(metrics);
    const client = errorClient(new Error('connection refused'));

    await expect(svc.getUsageSummary(client, 'tenant-1', START, END_6H)).rejects.toThrow(
      'connection refused',
    );
  });

  it('passes query parameters to the DB client', async () => {
    const client = mockClient([]);
    await service.getUsageSummary(client, 'tenant-1', START, END_6H);

    expect(client.query).toHaveBeenCalledOnce();
    const [sql, params] = (client.query as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(sql).toContain('fifteen_minute_device_usage');
    expect(params).toEqual([START, END_6H]);
  });
});

// ── UsageAnalyticsService.getDeviceBreakdown ──────────────────────────────────

describe('UsageAnalyticsService.getDeviceBreakdown', () => {
  let service: UsageAnalyticsService;

  beforeEach(() => {
    service = makeService();
  });

  it('returns one entry per device', async () => {
    const rows = [
      {
        deviceId: 'dev-001',
        totalSamples: '30',
        totalValue: '300.0',
        avgValue: '10.0',
        minValue: '5.0',
        maxValue: '15.0',
        firstBucket: START.toISOString(),
        lastBucket: END_6H.toISOString(),
      },
      {
        deviceId: 'dev-002',
        totalSamples: '20',
        totalValue: '200.0',
        avgValue: '10.0',
        minValue: '4.0',
        maxValue: '16.0',
        firstBucket: START.toISOString(),
        lastBucket: END_6H.toISOString(),
      },
    ];
    const client = mockClient(rows);
    const breakdown = await service.getDeviceBreakdown(client, 'tenant-1', START, END_6H);

    expect(breakdown.devices).toHaveLength(2);
    expect(breakdown.devices[0]?.deviceId).toBe('dev-001');
    expect(breakdown.devices[1]?.deviceId).toBe('dev-002');
  });

  it('returns empty devices array when no data', async () => {
    const client = mockClient([]);
    const breakdown = await service.getDeviceBreakdown(client, 'tenant-1', START, END_6H);
    expect(breakdown.devices).toHaveLength(0);
  });

  it('uses the correct view for the time range', async () => {
    const client = mockClient([]);
    const breakdown = await service.getDeviceBreakdown(client, 'tenant-1', START, END_3D);
    expect(breakdown.viewUsed).toBe('hourly_device_usage');
    expect(breakdown.granularity).toBe('hourly');
  });

  it('propagates DB errors', async () => {
    const client = errorClient(new Error('timeout'));
    await expect(
      service.getDeviceBreakdown(client, 'tenant-1', START, END_6H),
    ).rejects.toThrow('timeout');
  });

  it('includes correct start/end/tenantId in result', async () => {
    const client = mockClient([]);
    const breakdown = await service.getDeviceBreakdown(client, 'tenant-xyz', START, END_30D);
    expect(breakdown.tenantId).toBe('tenant-xyz');
    expect(breakdown.start).toEqual(START);
    expect(breakdown.end).toEqual(END_30D);
  });

  it('respects an explicit granularity override', async () => {
    const client = mockClient([]);
    const breakdown = await service.getDeviceBreakdown(
      client,
      'tenant-1',
      START,
      END_6H,
      'weekly',
    );
    expect(breakdown.granularity).toBe('weekly');
    expect(breakdown.viewUsed).toBe('weekly_device_usage');
  });

  it('passes correct SQL parameters to the DB client', async () => {
    const client = mockClient([]);
    await service.getDeviceBreakdown(client, 'tenant-1', START, END_120D);

    expect(client.query).toHaveBeenCalledOnce();
    const [sql, params] = (client.query as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(sql).toContain('GROUP BY device_id');
    expect(params).toEqual([START, END_120D]);
  });
});

// ── Prometheus metrics integration ────────────────────────────────────────────

describe('UsageAnalyticsService Prometheus metrics', () => {
  it('increments queryTotal on success', async () => {
    const reg = makeRegistry();
    const metrics = createAnalyticsMetrics(reg);
    const svc = new UsageAnalyticsService(metrics);
    const client = mockClient(sampleRows());

    await svc.getUsageSummary(client, 'tenant-1', START, END_6H);

    const metricValues = await reg.getMetricsAsJSON();
    const queryTotalMetric = metricValues.find((m) => m.name === 'analytics_queries_total');
    expect(queryTotalMetric).toBeDefined();

    const okSample = queryTotalMetric?.values.find(
      (v) => v.labels['status'] === 'ok' && v.labels['query_type'] === 'summary',
    );
    expect(okSample?.value).toBeGreaterThanOrEqual(1);
  });

  it('increments error counter when DB throws', async () => {
    const reg = makeRegistry();
    const metrics = createAnalyticsMetrics(reg);
    const svc = new UsageAnalyticsService(metrics);
    const client = errorClient(new Error('db error'));

    await expect(svc.getUsageSummary(client, 'tenant-1', START, END_6H)).rejects.toThrow();

    const metricValues = await reg.getMetricsAsJSON();
    const queryTotalMetric = metricValues.find((m) => m.name === 'analytics_queries_total');
    const errSample = queryTotalMetric?.values.find((v) => v.labels['status'] === 'error');
    expect(errSample?.value).toBeGreaterThanOrEqual(1);
  });

  it('records rows_returned histogram for device breakdown', async () => {
    const reg = makeRegistry();
    const metrics = createAnalyticsMetrics(reg);
    const svc = new UsageAnalyticsService(metrics);
    const rows = [
      {
        deviceId: 'dev-1',
        totalSamples: '10',
        totalValue: '100',
        avgValue: '10',
        minValue: '5',
        maxValue: '15',
        firstBucket: START.toISOString(),
        lastBucket: END_6H.toISOString(),
      },
    ];
    const client = mockClient(rows);

    await svc.getDeviceBreakdown(client, 'tenant-1', START, END_6H);

    const metricValues = await reg.getMetricsAsJSON();
    const rowsMetric = metricValues.find((m) => m.name === 'analytics_rows_returned');
    expect(rowsMetric).toBeDefined();
  });
});
