import type { Redis } from 'ioredis';
import type { PrismaClient } from '@prisma/client';

export interface TenantProfile {
  tenantId: string;
  billingTier: 'free' | 'standard' | 'enterprise';
  historicalCompliance: number;
}

const L2_CACHE_TTL_S = 3600; // 1 hour

export class TenantCache {
  // L1 Cache: In-memory mapping to avoid Redis roundtrips for the hottest devices.
  // We limit the size to avoid memory leaks.
  private l1Cache = new Map<string, { profile: TenantProfile; expiresAt: number }>();
  private readonly l1MaxKeys = 10000;
  private readonly l1TtlMs = 60000; // 1 minute

  constructor(
    private readonly redis: Redis,
    private readonly prisma: PrismaClient,
  ) {}

  /**
   * Resolve a device's tenant profile.
   * Checks L1 (Memory) -> L2 (Redis) -> DB (Prisma).
   */
  async getTenantProfile(deviceId: string): Promise<TenantProfile | null> {
    const now = Date.now();

    // 1. Check L1 Cache
    const l1Hit = this.l1Cache.get(deviceId);
    if (l1Hit && l1Hit.expiresAt > now) {
      return l1Hit.profile;
    } else if (l1Hit) {
      this.l1Cache.delete(deviceId);
    }

    // 2. Check L2 Cache (Redis)
    const redisKey = `device_tenant:${deviceId}`;
    const l2Hit = await this.redis.get(redisKey);
    if (l2Hit) {
      try {
        const profile = JSON.parse(l2Hit) as TenantProfile;
        this.setL1Cache(deviceId, profile);
        return profile;
      } catch (err) {
        // Invalid JSON in cache, fallback to DB
      }
    }

    // 3. Fallback to Database
    const device = await this.prisma.device.findUnique({
      where: { serial: deviceId },
      select: { ownerId: true },
    });

    if (!device) {
      return null;
    }

    const tenantId = device.ownerId;
    
    // For now, we assume all tenants are on the 'standard' tier
    // and have a base compliance of 1.0 until historical compliance is tracked per-tenant.
    const profile: TenantProfile = {
      tenantId,
      billingTier: 'standard',
      historicalCompliance: 1.0,
    };

    // Populate L2 Cache
    await this.redis.set(redisKey, JSON.stringify(profile), 'EX', L2_CACHE_TTL_S);
    
    // Populate L1 Cache
    this.setL1Cache(deviceId, profile);

    return profile;
  }

  private setL1Cache(deviceId: string, profile: TenantProfile): void {
    if (this.l1Cache.size >= this.l1MaxKeys) {
      // Very naive eviction: just clear the whole map when full
      // Since TTL is short (1 min), this is usually fine for a hot-path cache
      this.l1Cache.clear();
    }
    this.l1Cache.set(deviceId, { profile, expiresAt: Date.now() + this.l1TtlMs });
  }

  /**
   * Invalidate a device's tenant mapping from all caches.
   */
  async invalidate(deviceId: string): Promise<void> {
    this.l1Cache.delete(deviceId);
    await this.redis.del(`device_tenant:${deviceId}`);
  }
}
