import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PoolHealthProbe } from '../../../src/database/pool_health_probe.js';
import type { PoolHealthProbeConfig, PoolHealthSnapshot } from '../../../src/database/pool_health_probe.js';

function createMockManager() {
  const pools = new Map<string, any>();

  return {
    getPool: vi.fn((name: string) => pools.get(name) ?? null),
    setPool: (name: string, pool: any) => pools.set(name, pool),
    getGlobalMin: vi.fn(() => 10),
    getGlobalMax: vi.fn(() => 200),
    adjustPoolSize: vi.fn(),
    getPoolNames: vi.fn(() => Array.from(pools.keys())),
  };
}

function createMockPool(overrides?: Partial<{ totalCount: number; idleCount: number; waitingCount: number }>) {
  return {
    totalCount: overrides?.totalCount ?? 20,
    idleCount: overrides?.idleCount ?? 15,
    waitingCount: overrides?.waitingCount ?? 0,
    connect: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
  };
}

function createReadyClient() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    release: vi.fn(),
  };
}

describe('PoolHealthProbe', () => {
  let manager: ReturnType<typeof createMockManager>;
  let pool: ReturnType<typeof createMockPool>;
  let client: ReturnType<typeof createReadyClient>;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = createMockManager();
    pool = createMockPool();
    client = createReadyClient();
    pool.connect.mockResolvedValue(client);
    manager.setPool('timescale', pool);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should create a probe with default config', () => {
    const probe = new PoolHealthProbe({ manager: manager as any, poolName: 'timescale' });
    expect(probe).toBeInstanceOf(PoolHealthProbe);
    const config = probe.getCurrentConfig();
    expect(config.checkIntervalMs).toBe(10000);
    expect(config.cooldownPeriodMs).toBe(30000);
  });

  it('should report healthy for a well-performing pool', async () => {
    const probe = new PoolHealthProbe({ manager: manager as any, poolName: 'timescale' });
    const snapshot = await probe.probe();
    expect(snapshot.status).toBe('healthy');
    expect(snapshot.score).toBeGreaterThanOrEqual(80);
    expect(snapshot.poolName).toBe('timescale');
  });

  it('should report degraded when latency exceeds 200ms', async () => {
    const probe = new PoolHealthProbe({
      manager: manager as any,
      poolName: 'timescale',
      probeConnection: async () => 250,
    });
    const snapshot = await probe.probe();
    expect(snapshot.status).toBe('degraded');
    expect(snapshot.score).toBeLessThanOrEqual(80);
  });

  it('should report critical when latency exceeds 500ms', async () => {
    const probe = new PoolHealthProbe({
      manager: manager as any,
      poolName: 'timescale',
      probeConnection: async () => 600,
    });
    const snapshot = await probe.probe();
    expect(snapshot.status).toBe('critical');
    expect(snapshot.score).toBeLessThanOrEqual(60);
  });

  it('should report critical when pool is missing', async () => {
    const probe = new PoolHealthProbe({ manager: manager as any, poolName: 'nonexistent' });
    const snapshot = await probe.probe();
    expect(snapshot.status).toBe('critical');
    expect(snapshot.score).toBe(0);
  });

  it('should scale up on high utilization', async () => {
    pool.totalCount = 190;
    pool.idleCount = 10;
    const probe = new PoolHealthProbe({ manager: manager as any, poolName: 'timescale' });

    await probe.probe();
    const bounds = probe.getCurrentPoolBounds();

    expect(bounds.max).toBeGreaterThanOrEqual(200);
    expect(manager.adjustPoolSize).toHaveBeenCalled();
  });

  it('should scale down on low utilization', async () => {
    pool.totalCount = 20;
    pool.idleCount = 17;
    const probe = new PoolHealthProbe({
      manager: manager as any,
      poolName: 'timescale',
      probeConnection: async () => 10,
    });

    await probe.probe();
    const bounds = probe.getCurrentPoolBounds();

    expect(bounds.max).toBeLessThan(200);
    expect(manager.adjustPoolSize).toHaveBeenCalled();
  });

  it('should fire onStatusChange callback', async () => {
    const onStatusChange = vi.fn();
    const probe = new PoolHealthProbe({
      manager: manager as any,
      poolName: 'timescale',
      onStatusChange,
    });

    await probe.probe();
    expect(onStatusChange).toHaveBeenCalledTimes(1);
    const snapshot: PoolHealthSnapshot = onStatusChange.mock.calls[0][0];
    expect(snapshot.poolName).toBe('timescale');
  });

  it('should start and stop the probe timer', async () => {
    const onStatusChange = vi.fn();
    const probe = new PoolHealthProbe({
      manager: manager as any,
      poolName: 'timescale',
      config: { checkIntervalMs: 5000 } as PoolHealthProbeConfig,
      onStatusChange,
    });

    probe.start();
    // initial probe completes asynchronously
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatusChange).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(onStatusChange).toHaveBeenCalledTimes(2);

    probe.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(onStatusChange).toHaveBeenCalledTimes(2);
  });

  it('should reset metrics', async () => {
    const probe = new PoolHealthProbe({ manager: manager as any, poolName: 'timescale' });
    await probe.probe();
    expect(probe.getLastSnapshot()).not.toBeNull();

    probe.resetMetrics();
    expect(probe.getLastSnapshot()).toBeNull();
  });

  it('should indicate health on custom probe connection latency', async () => {
    const probe = new PoolHealthProbe({
      manager: manager as any,
      poolName: 'timescale',
      probeConnection: async () => 5,
    });
    for (let i = 0; i < 5; i++) {
      await probe.probe();
    }
    const snapshot = probe.getLastSnapshot()!;
    expect(snapshot.status).toBe('healthy');
    expect(snapshot.avgLatencyMs).toBeLessThan(10);
  });

  it('should handle probe connection failures gracefully', async () => {
    const probe = new PoolHealthProbe({
      manager: manager as any,
      poolName: 'timescale',
      probeConnection: async () => {
        throw new Error('connection refused');
      },
    });
    const snapshot = await probe.probe();
    expect(snapshot.status).toBe('critical');
    expect(snapshot.avgLatencyMs).toBeGreaterThanOrEqual(1000);
  });
});
