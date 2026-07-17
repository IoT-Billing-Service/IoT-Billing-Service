import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  gatherSystemHealth,
  type DashboardResponse,
  type DashboardSummary,
  type SystemHealthSnapshot,
} from '../../src/api/routes/ops.js';

// ── Mock prom-client metrics ──────────────────────────────────────────────────
// The gatherSystemHealth function reads from prom-client registries. We mock
// the metric .get() methods to return controlled values.

vi.mock('../../src/api/metrics/prometheus.js', () => {
  const fakeMetric = (values: Array<{ labels: Record<string, string | number>; value: number }>) => ({
    get: vi.fn().mockResolvedValue({ values }),
  });

  return {
    eventLoopLag: fakeMetric([{ labels: {}, value: 12.5 }]),
    circuitBreakerState: fakeMetric([{ labels: { client: 'soroban' }, value: 0 }]),
    circuitBreakerQueueDepth: fakeMetric([{ labels: { client: 'soroban' }, value: 3 }]),
    gcPauseDuration: fakeMetric([
      { labels: { le: '10' }, value: 150 },
      { labels: { le: '50' }, value: 45 },
      { labels: { le: '100' }, value: 8 },
    ]),
    pgPoolConnectionsTotal: fakeMetric([{ labels: { pool: 'global' }, value: 20 }]),
    pgPoolConnectionsActive: fakeMetric([{ labels: { pool: 'global' }, value: 5 }]),
    pgPoolConnectionsIdle: fakeMetric([{ labels: { pool: 'global' }, value: 15 }]),
    pgPoolConnectionsWaiting: fakeMetric([{ labels: { pool: 'global' }, value: 0 }]),
    ledgerSyncLag: fakeMetric([{ labels: { sync_id: 'primary' }, value: 2 }]),
    ledgerLastSyncedSequence: fakeMetric([{ labels: { sync_id: 'primary' }, value: 12345 }]),
    ledgerLatestPolledSequence: fakeMetric([{ labels: { sync_id: 'primary' }, value: 12347 }]),
    ingestionQueueDepth: fakeMetric([{ labels: {}, value: 42 }]),
    opsDashboardRequests: { inc: vi.fn(), labels: vi.fn().mockReturnThis() },
    opsDashboardLatency: { observe: vi.fn() },
  };
});

describe('gatherSystemHealth', () => {
  it('should return a complete SystemHealthSnapshot', async () => {
    const health = await gatherSystemHealth();

    expect(health).toHaveProperty('eventLoopLagMs');
    expect(health).toHaveProperty('gcPause');
    expect(health).toHaveProperty('dbPool');
    expect(health).toHaveProperty('ledgerSync');
    expect(health).toHaveProperty('circuitBreaker');
    expect(health).toHaveProperty('ingestionQueueDepth');
    expect(health).toHaveProperty('uptimeSeconds');
    expect(health).toHaveProperty('timestamp');
  });

  it('should return numeric event loop lag', async () => {
    const health = await gatherSystemHealth();
    expect(typeof health.eventLoopLagMs).toBe('number');
    expect(health.eventLoopLagMs).toBeGreaterThanOrEqual(0);
  });

  it('should return valid GC pause stats', async () => {
    const health = await gatherSystemHealth();
    expect(health.gcPause.p50).toBeGreaterThanOrEqual(0);
    expect(health.gcPause.p99).toBeGreaterThanOrEqual(0);
    expect(health.gcPause.count).toBeGreaterThanOrEqual(0);
  });

  it('should return valid DB pool stats', async () => {
    const health = await gatherSystemHealth();
    expect(health.dbPool.total).toBeGreaterThanOrEqual(0);
    expect(health.dbPool.active).toBeGreaterThanOrEqual(0);
    expect(health.dbPool.idle).toBeGreaterThanOrEqual(0);
    expect(health.dbPool.waiting).toBeGreaterThanOrEqual(0);
  });

  it('should return valid ledger sync info', async () => {
    const health = await gatherSystemHealth();
    expect(health.ledgerSync.lag).toBeGreaterThanOrEqual(0);
  });

  it('should return valid circuit breaker state', async () => {
    const health = await gatherSystemHealth();
    expect([0, 1, 2]).toContain(health.circuitBreaker.state);
    expect(health.circuitBreaker.queueDepth).toBeGreaterThanOrEqual(0);
  });

  it('should return valid ingestion queue depth', async () => {
    const health = await gatherSystemHealth();
    expect(typeof health.ingestionQueueDepth).toBe('number');
    expect(health.ingestionQueueDepth).toBeGreaterThanOrEqual(0);
  });

  it('should return positive uptime', async () => {
    const health = await gatherSystemHealth();
    expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('should return recent timestamp', async () => {
    const before = Date.now();
    const health = await gatherSystemHealth();
    const after = Date.now();

    expect(health.timestamp).toBeGreaterThanOrEqual(before);
    expect(health.timestamp).toBeLessThanOrEqual(after);
  });
});

describe('DashboardResponse type', () => {
  it('should define all required fields', () => {
    const response: DashboardResponse = {
      summary: {
        devices: { total: 0, enabled: 0, disabled: 0 },
        billing: {
          totalRecords: 0,
          pending: 0,
          settled: 0,
          totalUsageAmount: 0n,
          settledUsageAmount: 0n,
        },
        cycles: { total: 0, open: 0, finalizing: 0, finalized: 0, settled: 0 },
        account: null,
      },
      recentRecords: [],
      systemHealth: {
        eventLoopLagMs: 0,
        gcPause: { p50: 0, p99: 0, count: 0 },
        dbPool: { total: 0, active: 0, idle: 0, waiting: 0 },
        ledgerSync: { lag: 0, lastSyncedSequence: null, latestPolledSequence: null },
        circuitBreaker: { state: 0, queueDepth: 0 },
        ingestionQueueDepth: 0,
        uptimeSeconds: 0,
        timestamp: 0,
      },
      generatedAt: Date.now(),
    };

    expect(response).toHaveProperty('summary');
    expect(response).toHaveProperty('recentRecords');
    expect(response).toHaveProperty('systemHealth');
    expect(response).toHaveProperty('generatedAt');
  });

  it('should support BigInt usage amounts in summary', () => {
    const summary: DashboardSummary = {
      devices: { total: 100, enabled: 95, disabled: 5 },
      billing: {
        totalRecords: 500,
        pending: 10,
        settled: 490,
        totalUsageAmount: 5000000n,
        settledUsageAmount: 4900000n,
      },
      cycles: { total: 50, open: 2, finalizing: 1, finalized: 3, settled: 44 },
      account: {
        id: 'acc-001',
        stellarAddress: 'GA...TEST',
        balance: 10000000n,
      },
    };

    expect(summary.billing.totalUsageAmount).toBe(5000000n);
    expect(summary.account?.balance).toBe(10000000n);
  });

  it('should support recent records with optional txHash', () => {
    const records: DashboardResponse['recentRecords'] = [
      {
        id: 'br-001',
        deviceId: 'dev-001',
        usageAmount: 100000n,
        txHash: 'abc123',
        status: 'settled',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'br-002',
        deviceId: 'dev-002',
        usageAmount: 50000n,
        txHash: null,
        status: 'pending',
        createdAt: new Date().toISOString(),
      },
    ];

    expect(records[0]?.txHash).toBe('abc123');
    expect(records[1]?.txHash).toBeNull();
  });
});

describe('SystemHealthSnapshot type', () => {
  it('should accept healthy system values', () => {
    const health: SystemHealthSnapshot = {
      eventLoopLagMs: 5.2,
      gcPause: { p50: 2, p99: 15, count: 100 },
      dbPool: { total: 20, active: 8, idle: 12, waiting: 0 },
      ledgerSync: { lag: 0, lastSyncedSequence: 12345, latestPolledSequence: 12345 },
      circuitBreaker: { state: 0, queueDepth: 0 },
      ingestionQueueDepth: 50,
      uptimeSeconds: 86400,
      timestamp: Date.now(),
    };

    expect(health.eventLoopLagMs).toBeLessThan(100);
    expect(health.dbPool.active).toBeLessThan(health.dbPool.total);
    expect(health.ledgerSync.lag).toBe(0);
    expect(health.circuitBreaker.state).toBe(0); // closed
  });

  it('should accept degraded system values', () => {
    const health: SystemHealthSnapshot = {
      eventLoopLagMs: 250,
      gcPause: { p50: 20, p99: 150, count: 500 },
      dbPool: { total: 20, active: 20, idle: 0, waiting: 5 },
      ledgerSync: { lag: 15, lastSyncedSequence: 12000, latestPolledSequence: 12015 },
      circuitBreaker: { state: 2, queueDepth: 50 },
      ingestionQueueDepth: 800,
      uptimeSeconds: 3600,
      timestamp: Date.now(),
    };

    expect(health.eventLoopLagMs).toBeGreaterThan(100);
    expect(health.dbPool.waiting).toBeGreaterThan(0);
    expect(health.ledgerSync.lag).toBeGreaterThan(10);
    expect(health.circuitBreaker.state).toBe(2); // open
  });
});
