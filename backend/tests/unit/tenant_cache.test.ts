import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@prisma/client';
import { TenantCache } from '../../src/core/ingestion/tenant_cache.js';

describe('TenantCache', () => {
  let mockRedis: any;
  let mockPrisma: any;
  let cache: TenantCache;

  beforeEach(() => {
    mockRedis = {
      get: vi.fn(),
      set: vi.fn(),
      del: vi.fn(),
    };
    mockPrisma = {
      device: {
        findUnique: vi.fn(),
      },
    };
    cache = new TenantCache(mockRedis as unknown as Redis, mockPrisma as unknown as PrismaClient);
  });

  it('fetches from prisma on L1/L2 miss', async () => {
    mockRedis.get.mockResolvedValueOnce(null);
    mockPrisma.device.findUnique.mockResolvedValueOnce({ ownerId: 'tenant-1' });

    const profile = await cache.getTenantProfile('device-1');

    expect(profile).toEqual({
      tenantId: 'tenant-1',
      billingTier: 'standard',
      historicalCompliance: 1.0,
    });
    expect(mockRedis.get).toHaveBeenCalledWith('device_tenant:device-1');
    expect(mockPrisma.device.findUnique).toHaveBeenCalledWith({
      where: { serial: 'device-1' },
      select: { ownerId: true },
    });
    expect(mockRedis.set).toHaveBeenCalled();
  });

  it('returns null if device not found in prisma', async () => {
    mockRedis.get.mockResolvedValueOnce(null);
    mockPrisma.device.findUnique.mockResolvedValueOnce(null);

    const profile = await cache.getTenantProfile('device-1');

    expect(profile).toBeNull();
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it('fetches from Redis L2 and populates L1', async () => {
    mockRedis.get.mockResolvedValueOnce(JSON.stringify({
      tenantId: 'tenant-2',
      billingTier: 'enterprise',
      historicalCompliance: 0.99,
    }));

    const profile = await cache.getTenantProfile('device-2');

    expect(profile).toEqual({
      tenantId: 'tenant-2',
      billingTier: 'enterprise',
      historicalCompliance: 0.99,
    });
    expect(mockPrisma.device.findUnique).not.toHaveBeenCalled();
    
    // Call again to test L1 Cache
    mockRedis.get.mockClear();
    const l1Profile = await cache.getTenantProfile('device-2');
    expect(l1Profile).toEqual(profile);
    expect(mockRedis.get).not.toHaveBeenCalled();
  });

  it('invalidates L1 and L2 cache', async () => {
    mockRedis.get.mockResolvedValueOnce(JSON.stringify({
      tenantId: 'tenant-2',
      billingTier: 'enterprise',
      historicalCompliance: 0.99,
    }));

    await cache.getTenantProfile('device-3'); // populate caches
    
    await cache.invalidate('device-3');

    expect(mockRedis.del).toHaveBeenCalledWith('device_tenant:device-3');

    // Should fetch from Redis again since L1 is cleared
    // We didn't set up the mock to return anything this time, so it's a miss
    mockRedis.get.mockResolvedValueOnce(null);
    mockPrisma.device.findUnique.mockResolvedValueOnce(null);
    await cache.getTenantProfile('device-3');

    expect(mockRedis.get).toHaveBeenCalledWith('device_tenant:device-3');
  });
});
