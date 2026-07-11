import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import pg from 'pg';
import {
  CONNECTION_WAIT_TIMEOUT_MS,
  ElasticPoolManager,
  PoolContentionError,
  TENANT_MAX_CONNECTIONS,
  TenantAwarePoolProxy,
  tenantSchemaName,
} from '../../src/database/pool_manager.js';

function registerPool(manager: ElasticPoolManager, name: string, pool: pg.Pool): void {
  (manager as unknown as { pools: Map<string, pg.Pool> }).pools.set(name, pool);
}

type MockClient = pg.PoolClient & {
  queryMock: ReturnType<typeof vi.fn>;
};

function asMockClient(client: pg.PoolClient): MockClient {
  return client as MockClient;
}

function createMockClient(id: number): MockClient {
  const queryMock = vi.fn().mockResolvedValue({ rows: [] });
  const client = {
    query: queryMock,
    queryMock,
    release: vi.fn(),
    id,
  } as unknown as MockClient;
  return client;
}

describe('tenantSchemaName', () => {
  it('sanitizes tenant ids into postgres schema names', () => {
    expect(tenantSchemaName('acme-corp')).toBe('tenant_acmecorp');
    expect(tenantSchemaName('tenant-123')).toBe('tenant_tenant123');
  });

  it('rejects empty tenant ids after sanitization', () => {
    expect(() => tenantSchemaName('!!!')).toThrow('Invalid tenant id');
  });
});

describe('ElasticPoolManager', () => {
  let manager: ElasticPoolManager;

  beforeEach(() => {
    manager = new ElasticPoolManager();
  });

  it('creates named pools with global bounds', () => {
    const pool = manager.createPool('test', { max: 50 });
    expect(pool).toBeDefined();
    expect(manager.getPool('test')).toBe(pool);
  });

  it('clamps adjustPoolSize to 10-200', () => {
    manager.createPool('test', {});
    expect(() => {
      manager.adjustPoolSize(5, 20);
    }).toThrow();
    expect(() => {
      manager.adjustPoolSize(10, 250);
    }).toThrow();
    manager.adjustPoolSize(15, 150);
    expect(manager.getGlobalMin()).toBe(15);
    expect(manager.getGlobalMax()).toBe(150);
  });
});

describe('TenantAwarePoolProxy', () => {
  let manager: ElasticPoolManager;
  let proxy: TenantAwarePoolProxy;
  let mockClients: MockClient[];
  let connectDelayMs: number;

  beforeEach(() => {
    manager = new ElasticPoolManager();
    mockClients = [];
    connectDelayMs = 0;

    const mockPool = {
      connect: vi.fn(async () => {
        if (connectDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, connectDelayMs));
        }
        const client = createMockClient(mockClients.length + 1);
        mockClients.push(client);
        return client;
      }),
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
      on: vi.fn(),
      end: vi.fn(),
    } as unknown as pg.Pool;

    vi.spyOn(manager, 'createPool').mockReturnValue(mockPool);
    registerPool(manager, 'timescale', mockPool);
    proxy = new TenantAwarePoolProxy(manager, 'timescale');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockClients.length = 0;
  });

  it('grants connections and sets tenant schema search_path', async () => {
    const client = asMockClient(await proxy.connect('acme'));
    expect(client.queryMock).toHaveBeenCalledWith('SET search_path TO tenant_acme, public');
    expect(proxy.getTenantActiveCount('acme')).toBe(1);
    client.release();
    expect(proxy.getTenantActiveCount('acme')).toBe(0);
  });

  it('enforces per-tenant max connections', async () => {
    const clients: pg.PoolClient[] = [];
    for (let i = 0; i < TENANT_MAX_CONNECTIONS; i++) {
      clients.push(await proxy.connect('heavy'));
    }
    expect(proxy.getTenantActiveCount('heavy')).toBe(TENANT_MAX_CONNECTIONS);

    const pending = proxy.connect('heavy');
    clients[0]?.release();
    const granted = await pending;
    expect(granted).toBeDefined();
    for (const client of clients.slice(1)) {
      client.release();
    }
    granted.release();
  });

  it('rejects waits exceeding 500ms with PoolContentionError', async () => {
    vi.useFakeTimers();
    manager.adjustPoolSize(10, TENANT_MAX_CONNECTIONS);

    const holders: pg.PoolClient[] = [];
    for (let i = 0; i < TENANT_MAX_CONNECTIONS; i++) {
      holders.push(await proxy.connect('saturated'));
    }

    const pending = proxy.connect('saturated');
    const rejection = expect(pending).rejects.toBeInstanceOf(PoolContentionError);
    await vi.advanceTimersByTimeAsync(CONNECTION_WAIT_TIMEOUT_MS + 1);
    await rejection;

    for (const client of holders) {
      client.release();
    }
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  });

  it('fair-queues across tenants so each receives at least minimum capacity', async () => {
    manager.adjustPoolSize(10, 12);

    const tenantAConnections = await Promise.all([
      proxy.connect('tenant-a'),
      proxy.connect('tenant-a'),
      proxy.connect('tenant-a'),
      proxy.connect('tenant-a'),
      proxy.connect('tenant-a'),
    ]);
    const tenantBConnections = await Promise.all([
      proxy.connect('tenant-b'),
      proxy.connect('tenant-b'),
      proxy.connect('tenant-b'),
      proxy.connect('tenant-b'),
      proxy.connect('tenant-b'),
    ]);

    expect(proxy.getTenantActiveCount('tenant-a')).toBe(5);
    expect(proxy.getTenantActiveCount('tenant-b')).toBe(5);

    const pendingA = proxy.connect('tenant-a');
    const pendingB = proxy.connect('tenant-b');

    tenantAConnections[0].release();
    const grantedB = await pendingB;
    expect(grantedB).toBeDefined();

    tenantBConnections[0].release();
    const grantedA = await pendingA;
    expect(grantedA).toBeDefined();

    for (const client of [
      ...tenantAConnections.slice(1),
      ...tenantBConnections.slice(1),
      grantedA,
      grantedB,
    ]) {
      client.release();
    }
  });

  it('prioritizes tenants below minimum connection guarantee', async () => {
    manager.adjustPoolSize(10, 10);

    const tenantA = await proxy.connect('alpha');
    const tenantBConnections: pg.PoolClient[] = [];
    for (let i = 0; i < 8; i++) {
      tenantBConnections.push(await proxy.connect('beta'));
    }

    expect(proxy.getGlobalActiveCount()).toBe(9);

    const pendingAlphaSecond = proxy.connect('alpha');
    const pendingBetaNinth = proxy.connect('beta').catch((error: unknown) => error);

    tenantBConnections[0]?.release();
    const alphaSecond = await pendingAlphaSecond;
    expect(alphaSecond).toBeDefined();
    expect(proxy.getTenantActiveCount('alpha')).toBe(2);

    tenantA.release();
    alphaSecond.release();
    for (const client of tenantBConnections.slice(1)) {
      client.release();
    }

    await pendingBetaNinth;
  });
});

describe('pool stress scenario', () => {
  it('handles 5 tenants with 100 concurrent requests each', async () => {
    const manager = new ElasticPoolManager();
    const mockClients: MockClient[] = [];

    const mockPool = {
      connect: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        const client = createMockClient(mockClients.length + 1);
        mockClients.push(client);
        return client;
      }),
      on: vi.fn(),
      end: vi.fn(),
    } as unknown as pg.Pool;

    vi.spyOn(manager, 'createPool').mockReturnValue(mockPool);
    registerPool(manager, 'timescale', mockPool);
    manager.adjustPoolSize(10, 50);

    const proxy = new TenantAwarePoolProxy(manager, 'timescale');
    const tenants = ['tenant-1', 'tenant-2', 'tenant-3', 'tenant-4', 'tenant-5'];
    const requestsPerTenant = 100;

    const results = await Promise.all(
      tenants.flatMap((tenantId) =>
        Array.from({ length: requestsPerTenant }, async () => {
          try {
            const client = await proxy.connect(tenantId);
            await client.query('SELECT 1');
            client.release();
            return 'granted' as const;
          } catch (error) {
            if (error instanceof PoolContentionError) {
              return 'rejected' as const;
            }
            throw error;
          }
        }),
      ),
    );

    const granted = results.filter((result) => result === 'granted').length;
    const rejected = results.filter((result) => result === 'rejected').length;

    expect(granted + rejected).toBe(tenants.length * requestsPerTenant);
    expect(granted).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);
    for (const tenantId of tenants) {
      expect(proxy.getTenantActiveCount(tenantId)).toBe(0);
    }
  });
});
