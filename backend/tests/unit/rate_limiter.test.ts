import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { Redis } from 'ioredis';
import {
  TenantRateLimiter,
  TenantComplianceTracker,
} from '../../src/api/middleware/rate_limiter.js';
import type { TenantProfile } from '../../src/core/ingestion/tenant_cache.js';

interface MockRedis {
  eval: Mock;
  hmget: Mock;
  del: Mock;
  expire: Mock;
}

function createMockRedis(): MockRedis {
  return {
    eval: vi.fn(),
    hmget: vi.fn(),
    del: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
  };
}

const highComplianceProfile: TenantProfile = {
  tenantId: 'tenant-high',
  billingTier: 'standard',
  historicalCompliance: 0.97,
};

const lowComplianceProfile: TenantProfile = {
  tenantId: 'tenant-low',
  billingTier: 'standard',
  historicalCompliance: 0.2,
};

describe('TenantRateLimiter', () => {
  let mockRedis: MockRedis;
  let limiter: TenantRateLimiter;

  beforeEach(() => {
    mockRedis = createMockRedis();
    limiter = new TenantRateLimiter(mockRedis as unknown as Redis);
  });

  it('allows request when tokens are available', async () => {
    const now = Date.now();
    mockRedis.eval.mockResolvedValueOnce([49, 100, now + 100, 1]);

    const result = await limiter.checkLimit(highComplianceProfile);

    expect(result.allowed).toBe(true);
    expect(result.tokensRemaining).toBe(49);
    expect(result.retryAfterMs).toBeUndefined();
  });

  it('denies request when tokens are exhausted and sets retryAfterMs', async () => {
    const now = Date.now();
    const resetAt = now + 600;
    mockRedis.eval.mockResolvedValueOnce([0, 100, resetAt, 0]);

    const result = await limiter.checkLimit(lowComplianceProfile);

    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('high-compliance device shows 3x burst maxTokens', async () => {
    const now = Date.now();
    mockRedis.eval.mockResolvedValueOnce([299, 300, now + 10, 1]);

    const result = await limiter.checkLimit(highComplianceProfile);

    expect(result.allowed).toBe(true);
    expect(result.maxTokens).toBe(300);
  });

  it('low-compliance device gets throttled and denied', async () => {
    const now = Date.now();
    mockRedis.eval.mockResolvedValueOnce([0, 60, now + 2000, 0]);

    const result = await limiter.checkLimit(lowComplianceProfile);

    expect(result.allowed).toBe(false);
    expect(result.maxTokens).toBe(60);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('passes compliance score in eval argv', async () => {
    const now = Date.now();
    mockRedis.eval.mockResolvedValueOnce([99, 100, now + 100, 1]);

    await limiter.checkLimit(highComplianceProfile);

    expect(mockRedis.eval.mock.calls[0]).toContain('0.97');
  });

  it('returns correct header data from result', async () => {
    const now = Date.now();
    const resetAt = now + 500;
    mockRedis.eval.mockResolvedValueOnce([50, 100, resetAt, 1]);

    const result = await limiter.checkLimit(highComplianceProfile);

    expect(result.maxTokens).toBe(100);
    expect(result.tokensRemaining).toBe(50);
    expect(result.resetAtMs).toBe(resetAt);
  });

  it('throws when Lua returns unexpected shape', async () => {
    mockRedis.eval.mockResolvedValueOnce(null);

    await expect(limiter.checkLimit(highComplianceProfile)).rejects.toThrow(
      'Unexpected Lua response',
    );
  });

  it('reset deletes the bucket key', async () => {
    await limiter.reset('tenant-abc');

    expect(mockRedis.del).toHaveBeenCalledWith('rate:bucket:tenant:tenant-abc');
  });
});

describe('TenantComplianceTracker', () => {
  let mockRedis: MockRedis;
  let tracker: TenantComplianceTracker;

  beforeEach(() => {
    mockRedis = createMockRedis();
    tracker = new TenantComplianceTracker(mockRedis as unknown as Redis);
  });

  it('returns 0.5 default when no data exists', async () => {
    mockRedis.hmget.mockResolvedValueOnce([null, null]);

    const score = await tracker.getComplianceScore('new-tenant');

    expect(score).toBe(0.5);
  });

  it('computes compliance ratio from stored success/total', async () => {
    mockRedis.hmget.mockResolvedValueOnce(['800', '1000']);

    const score = await tracker.getComplianceScore('tenant-1');

    expect(score).toBeCloseTo(0.8);
  });

  it('returns 0.5 when total is 0', async () => {
    mockRedis.hmget.mockResolvedValueOnce(['0', '0']);

    const score = await tracker.getComplianceScore('tenant-1');

    expect(score).toBe(0.5);
  });

  it('calls eval with success field on successful submission', async () => {
    mockRedis.eval.mockResolvedValueOnce(1);

    await tracker.recordSubmission('tenant-1', true);

    expect(mockRedis.eval.mock.calls[0]).toContain('success');
  });

  it('calls eval with failure field on failed submission', async () => {
    mockRedis.eval.mockResolvedValueOnce(1);

    await tracker.recordSubmission('tenant-1', false);

    expect(mockRedis.eval.mock.calls[0]).toContain('failure');
  });

  it('passes compliance key to eval', async () => {
    mockRedis.eval.mockResolvedValueOnce(1);

    await tracker.recordSubmission('tenant-xyz', true);

    expect(mockRedis.eval.mock.calls[0]).toContain('rate:compliance:tenant:tenant-xyz');
  });
});
