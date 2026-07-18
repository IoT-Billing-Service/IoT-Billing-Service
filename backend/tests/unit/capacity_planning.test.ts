/**
 * Tests for issue #87 – Capacity Planning with Historical Usage Trending.
 *
 * Covers:
 *  - pure math helpers (linearRegression, computeR2, computeTrend, projectCapacity)
 *  - HTTP endpoint contract (validation, view selection, tenant isolation)
 *  - edge cases: empty history, single point, flat usage, negative trend, spikes
 *  - Prometheus metric setters (smoke check)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import {
  linearRegression,
  computeR2,
  computeTrend,
  projectCapacity,
  registerCapacityPlanningRoutes,
  type TrendResult,
  type CapacityPlanningResponse,
} from '../../src/api/routes/capacity_planning.js';
import {
  capacityUtilizationRatio,
  capacityProjectedGrowthRate,
  capacityTrendDataPoints,
  capacityTrendLastUpdated,
  setCapacityUtilizationRatio,
  setCapacityProjectedGrowthRate,
  setCapacityTrendDataPoints,
  setCapacityTrendLastUpdated,
} from '../../src/api/metrics/prometheus.js';

// ---------------------------------------------------------------------------
// Mock auth + tenant middleware (mirrors analytics.test.ts pattern)
// ---------------------------------------------------------------------------

vi.mock('../../src/api/middleware/auth.js', () => ({
  verifyJwt: async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const req = request as unknown as { user?: { address: string } };
    req.user = { address: 'GTEST123' };
    await Promise.resolve();
  },
}));

const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
const mockRelease = vi.fn();
const mockConnect = vi.fn().mockResolvedValue({
  query: mockQuery,
  release: mockRelease,
});

vi.mock('../../src/api/middleware/tenant.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/api/middleware/tenant.js')>();
  return {
    ...actual,
    extractTenantId: async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
      const raw = request.headers['x-tenant-id'];
      request.tenantId =
        typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : 'test-tenant';
      await Promise.resolve();
    },
    getTenantPoolProxy: (): { connect: typeof mockConnect } => ({ connect: mockConnect }),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a sorted array of daily usage points anchored at `baseDate`. */
function makeDailyPoints(
  values: number[],
  baseDate = new Date('2026-01-01T00:00:00Z'),
): { bucket: Date; totalValue: number }[] {
  return values.map((v, i) => ({
    bucket: new Date(baseDate.getTime() + i * 86_400_000),
    totalValue: v,
  }));
}

// ---------------------------------------------------------------------------
// Pure math helpers
// ---------------------------------------------------------------------------

describe('linearRegression', () => {
  it('returns zero slope and intercept for empty input', () => {
    const { slope, intercept } = linearRegression([], []);
    expect(slope).toBe(0);
    expect(intercept).toBe(0);
  });

  it('returns zero slope and the single value as intercept for one point', () => {
    const { slope, intercept } = linearRegression([0], [42]);
    expect(slope).toBe(0);
    expect(intercept).toBe(42);
  });

  it('fits a perfect upward line', () => {
    // y = 2x + 1  →  xs=[0,1,2,3], ys=[1,3,5,7]
    const { slope, intercept } = linearRegression([0, 1, 2, 3], [1, 3, 5, 7]);
    expect(slope).toBeCloseTo(2, 5);
    expect(intercept).toBeCloseTo(1, 5);
  });

  it('fits a perfect downward line', () => {
    const { slope, intercept } = linearRegression([0, 1, 2, 3], [10, 8, 6, 4]);
    expect(slope).toBeCloseTo(-2, 5);
    expect(intercept).toBeCloseTo(10, 5);
  });

  it('returns mean as intercept and zero slope for a flat line', () => {
    const { slope, intercept } = linearRegression([0, 1, 2, 3], [5, 5, 5, 5]);
    expect(slope).toBeCloseTo(0, 5);
    expect(intercept).toBeCloseTo(5, 5);
  });
});

describe('computeR2', () => {
  it('returns 1 for a perfect fit', () => {
    const ys = [1, 3, 5, 7];
    const yPred = [1, 3, 5, 7];
    expect(computeR2(ys, yPred)).toBeCloseTo(1, 5);
  });

  it('returns 1 for a perfect flat line', () => {
    expect(computeR2([5, 5, 5], [5, 5, 5])).toBe(1);
  });

  it('returns 0 for length < 2', () => {
    expect(computeR2([5], [5])).toBe(0);
    expect(computeR2([], [])).toBe(0);
  });

  it('returns value < 1 for an imperfect fit', () => {
    const ys = [1, 3, 5, 7];
    const yPred = [2, 3, 4, 5]; // off by 1 on ends
    expect(computeR2(ys, yPred)).toBeLessThan(1);
    expect(computeR2(ys, yPred)).toBeGreaterThan(0);
  });
});

describe('computeTrend', () => {
  it('returns zero metrics for empty input', () => {
    const t = computeTrend([]);
    expect(t.slopePerDay).toBe(0);
    expect(t.r2).toBe(0);
    expect(t.avgUsage).toBe(0);
    expect(t.peakUsage).toBe(0);
    expect(t.coefficientOfVariation).toBe(0);
    expect(t.dataPoints).toBe(0);
  });

  it('handles a single data point', () => {
    const t = computeTrend(makeDailyPoints([100]));
    expect(t.slopePerDay).toBe(0);
    expect(t.avgUsage).toBe(100);
    expect(t.peakUsage).toBe(100);
    expect(t.dataPoints).toBe(1);
  });

  it('detects steady upward growth', () => {
    // Usage grows by 10 units/day over 7 days: [10, 20, 30, 40, 50, 60, 70]
    const points = makeDailyPoints([10, 20, 30, 40, 50, 60, 70]);
    const t = computeTrend(points);
    expect(t.slopePerDay).toBeCloseTo(10, 1);
    expect(t.r2).toBeCloseTo(1, 2);
    expect(t.avgUsage).toBeCloseTo(40, 1);
    expect(t.peakUsage).toBe(70);
    expect(t.dataPoints).toBe(7);
  });

  it('detects flat (stable) usage', () => {
    const points = makeDailyPoints([50, 50, 50, 50, 50]);
    const t = computeTrend(points);
    expect(t.slopePerDay).toBeCloseTo(0, 5);
    expect(t.avgUsage).toBe(50);
    expect(t.coefficientOfVariation).toBe(0);
  });

  it('detects a decreasing trend', () => {
    const points = makeDailyPoints([100, 90, 80, 70, 60]);
    const t = computeTrend(points);
    expect(t.slopePerDay).toBeCloseTo(-10, 1);
    expect(t.peakUsage).toBe(100);
  });

  it('handles a spike without skewing average incorrectly', () => {
    // Normal usage ~10 with a single day spike to 1000
    const values = [10, 10, 10, 1000, 10, 10, 10];
    const points = makeDailyPoints(values);
    const t = computeTrend(points);
    expect(t.peakUsage).toBe(1000);
    expect(t.avgUsage).toBeCloseTo(values.reduce((a, b) => a + b, 0) / values.length, 1);
    // CoV should be high due to spike
    expect(t.coefficientOfVariation).toBeGreaterThan(1);
  });

  it('handles long history (90 days) without precision loss', () => {
    // Grow by 1 unit/day for 90 days
    const values = Array.from({ length: 90 }, (_, i) => i + 1);
    const points = makeDailyPoints(values);
    const t = computeTrend(points);
    expect(t.slopePerDay).toBeCloseTo(1, 1);
    expect(t.dataPoints).toBe(90);
  });
});

describe('projectCapacity', () => {
  it('projects zero growth for flat usage', () => {
    const trend: TrendResult = {
      slopePerDay: 0,
      r2: 1,
      avgUsage: 100,
      peakUsage: 100,
      coefficientOfVariation: 0,
      dataPoints: 30,
    };
    const p = projectCapacity(trend, 30);
    expect(p.projectedUsage).toBe(100);
    expect(p.growthRate).toBe(0);
    expect(p.horizonDays).toBe(30);
  });

  it('projects positive growth for upward trend', () => {
    const trend: TrendResult = {
      slopePerDay: 10,
      r2: 0.95,
      avgUsage: 100,
      peakUsage: 150,
      coefficientOfVariation: 0.1,
      dataPoints: 30,
    };
    const p = projectCapacity(trend, 30);
    // projected = 100 + 10 * 30 = 400
    expect(p.projectedUsage).toBeCloseTo(400, 1);
    // growthRate = (400 - 100) / 100 = 3.0 (300%)
    expect(p.growthRate).toBeCloseTo(3.0, 5);
  });

  it('handles zero average usage without dividing by zero', () => {
    const trend: TrendResult = {
      slopePerDay: 5,
      r2: 0,
      avgUsage: 0,
      peakUsage: 0,
      coefficientOfVariation: 0,
      dataPoints: 0,
    };
    const p = projectCapacity(trend, 30);
    expect(p.growthRate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// HTTP endpoint
// ---------------------------------------------------------------------------

describe('GET /api/analytics/capacity-planning', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = Fastify({ logger: false });
    registerCapacityPlanningRoutes(app);
    mockQuery.mockClear();
    mockConnect.mockClear();
    mockRelease.mockClear();
  });

  it('returns 400 when neither deviceId nor accountId is supplied', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics/capacity-planning',
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid lookbackDays', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics/capacity-planning?deviceId=dev-001&lookbackDays=0',
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for lookbackDays > 365', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics/capacity-planning?deviceId=dev-001&lookbackDays=400',
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid horizonDays', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics/capacity-planning?deviceId=dev-001&horizonDays=0',
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 200 with empty trend for deviceId when no DB rows', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics/capacity-planning?deviceId=dev-001',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<CapacityPlanningResponse>();
    expect(body.deviceId).toBe('dev-001');
    expect(body.period).toBe('daily');
    expect(body.viewUsed).toBe('daily_device_usage');
    expect(body.trend.dataPoints).toBe(0);
    expect(body.trend.slopePerDay).toBe(0);
    expect(body.projection.growthRate).toBe(0);
    expect(body.lastDataPoint).toBeNull();
  });

  it('returns 200 with computed trend for deviceId with DB rows', async () => {
    const base = new Date('2026-06-01T00:00:00Z');
    const rows = Array.from({ length: 10 }, (_, i) => ({
      bucket: new Date(base.getTime() + i * 86_400_000),
      totalValue: (i + 1) * 100,
    }));
    mockQuery.mockResolvedValueOnce({ rows });

    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics/capacity-planning?deviceId=dev-001&lookbackDays=10&horizonDays=10',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<CapacityPlanningResponse>();
    expect(body.trend.dataPoints).toBe(10);
    expect(body.trend.slopePerDay).toBeCloseTo(100, 0);
    expect(body.trend.peakUsage).toBe(1000);
    expect(body.lastDataPoint).not.toBeNull();
    const sqlCall = mockQuery.mock.calls[0]?.[0] as string;
    expect(sqlCall).toContain('daily_device_usage');
  });

  it('uses weekly_device_usage view when period=weekly', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics/capacity-planning?deviceId=dev-001&period=weekly',
    });
    expect(res.statusCode).toBe(200);
    const sqlCall = mockQuery.mock.calls[0]?.[0] as string;
    expect(sqlCall).toContain('weekly_device_usage');
  });

  it('uses monthly_device_usage view when period=monthly', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics/capacity-planning?deviceId=dev-001&period=monthly',
    });
    expect(res.statusCode).toBe(200);
    const sqlCall = mockQuery.mock.calls[0]?.[0] as string;
    expect(sqlCall).toContain('monthly_device_usage');
  });

  it('uses daily_billing_summary when accountId is given without deviceId', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics/capacity-planning?accountId=acct-001',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<CapacityPlanningResponse>();
    expect(body.viewUsed).toBe('daily_billing_summary');
    expect(body.accountId).toBe('acct-001');
    const sqlCall = mockQuery.mock.calls[0]?.[0] as string;
    expect(sqlCall).toContain('daily_billing_summary');
  });

  it('applies tenant isolation: each tenant connects to its own pool', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    mockConnect.mockImplementation((tenantId: string) => ({
      tenantId,
      query: mockQuery,
      release: mockRelease,
    }));

    const [tenantA, tenantB] = await Promise.all([
      app.inject({
        method: 'GET',
        url: '/api/analytics/capacity-planning?deviceId=dev-001',
        headers: { 'x-tenant-id': 'tenant-a' },
      }),
      app.inject({
        method: 'GET',
        url: '/api/analytics/capacity-planning?deviceId=dev-001',
        headers: { 'x-tenant-id': 'tenant-b' },
      }),
    ]);

    expect(tenantA.statusCode).toBe(200);
    expect(tenantB.statusCode).toBe(200);
    expect(mockConnect).toHaveBeenCalledWith('tenant-a');
    expect(mockConnect).toHaveBeenCalledWith('tenant-b');
  });

  it('returns 500 on unexpected DB error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB connection refused'));
    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics/capacity-planning?deviceId=dev-001',
    });
    expect(res.statusCode).toBe(500);
  });

  it('releases the DB client even when an error is thrown', async () => {
    mockQuery.mockRejectedValueOnce(new Error('timeout'));
    await app.inject({
      method: 'GET',
      url: '/api/analytics/capacity-planning?deviceId=dev-001',
    });
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Prometheus gauge setters – smoke tests
// ---------------------------------------------------------------------------

describe('Capacity planning Prometheus metrics', () => {
  beforeEach(() => {
    capacityUtilizationRatio.reset();
    capacityProjectedGrowthRate.reset();
    capacityTrendDataPoints.reset();
    capacityTrendLastUpdated.reset();
  });

  it('sets utilization ratio gauge without throwing', () => {
    expect(() => setCapacityUtilizationRatio('dev-001', 'daily', 0.25)).not.toThrow();
  });

  it('sets projected growth rate gauge without throwing', () => {
    expect(() => setCapacityProjectedGrowthRate('dev-001', 'daily', 10.5)).not.toThrow();
  });

  it('sets trend data points gauge without throwing', () => {
    expect(() => setCapacityTrendDataPoints('dev-001', 'daily', 30)).not.toThrow();
  });

  it('sets last updated timestamp gauge without throwing', () => {
    expect(() => setCapacityTrendLastUpdated('dev-001', 'daily', Date.now() / 1000)).not.toThrow();
  });

  it('ignores NaN values without throwing', () => {
    expect(() => setCapacityUtilizationRatio('dev-001', 'daily', NaN)).not.toThrow();
    expect(() => setCapacityProjectedGrowthRate('dev-001', 'daily', NaN)).not.toThrow();
    expect(() => setCapacityTrendDataPoints('dev-001', 'daily', NaN)).not.toThrow();
    expect(() => setCapacityTrendLastUpdated('dev-001', 'daily', NaN)).not.toThrow();
  });
});
