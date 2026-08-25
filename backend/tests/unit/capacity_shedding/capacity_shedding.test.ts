import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/api/metrics/prometheus.js', () => ({
  incrementFeatureFlagEvaluations: vi.fn(),
  setFeatureFlagOverride: vi.fn(),
  observeSheddedRequests: vi.fn(),
  setCapacitySheddingLevel: vi.fn(),
  updateRequestQueueDepth: vi.fn(),
  updateActiveRequestCount: vi.fn(),
}));

vi.mock('../../../src/core/feature_flags/index.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    isFlagEnabledSync: vi.fn().mockReturnValue(true),
    computeDegradationProfile: vi.fn().mockReturnValue({
      shedNonCritical: false,
      disabledFlags: [],
      activePriority: 'low',
    }),
    FlagPriority: (actual as any).FlagPriority,
  };
});

import {
  computeSheddingDecision,
  SheddingAction,
  RequestPriority,
  capacitySheddingHook,
  setSheddingConfig,
  getSheddingStatus,
  resetCapacitySheddingForTesting,
} from '../../../src/core/capacity_shedding/index.js';

function mockRequest(url: string, method = 'GET'): any {
  return {
    url,
    method,
    headers: {},
  };
}

function mockReply(): any {
  const status = vi.fn().mockReturnThis();
  const send = vi.fn().mockReturnThis();
  const header = vi.fn().mockReturnThis();
  return { status, send, header };
}

describe('computeSheddingDecision', () => {
  beforeEach(async () => {
    await resetCapacitySheddingForTesting();
    vi.clearAllMocks();
  });

  it('allows health check requests at any load', () => {
    const req = mockRequest('/health');
    const decision = computeSheddingDecision(req);
    expect(decision.action).toBe(SheddingAction.ALLOW);
  });

  it('allows low-priority requests under normal conditions', () => {
    const req = mockRequest('/api/reports');
    const decision = computeSheddingDecision(req);
    expect(decision.action).toBe(SheddingAction.ALLOW);
  });

  it('assigns CRITICAL priority to health endpoints', () => {
    const req = mockRequest('/health');
    const decision = computeSheddingDecision(req);
    expect(decision.priority).toBe(RequestPriority.CRITICAL);
  });

  it('assigns HIGH priority to billing endpoints', () => {
    const req = mockRequest('/api/billing/process');
    const decision = computeSheddingDecision(req);
    expect(decision.priority).toBe(RequestPriority.HIGH);
  });
});

describe('capacitySheddingHook', () => {
  beforeEach(async () => {
    await resetCapacitySheddingForTesting();
    vi.clearAllMocks();
  });

  it('allows requests through by default', () => {
    const req = mockRequest('/api/analytics');
    const reply = mockReply();
    const result = capacitySheddingHook(req, reply);
    expect(result).toBeNull();
  });

  it('does not shed CRITICAL priority requests', () => {
    const req = mockRequest('/health');
    const reply = mockReply();
    const result = capacitySheddingHook(req, reply);
    expect(result).toBeNull();
  });
});

describe('setSheddingConfig', () => {
  beforeEach(async () => {
    await resetCapacitySheddingForTesting();
  });

  it('updates configuration values', () => {
    setSheddingConfig({ maxConcurrency: 100, maxQueueDepth: 5000 });
    const config = getSheddingStatus().config;
    expect(config.maxConcurrency).toBe(100);
    expect(config.maxQueueDepth).toBe(5000);
  });
});

describe('getSheddingStatus', () => {
  beforeEach(async () => {
    await resetCapacitySheddingForTesting();
  });

  it('returns status object with all fields', () => {
    const status = getSheddingStatus();
    expect(status).toHaveProperty('queueDepth');
    expect(status).toHaveProperty('activeRequests');
    expect(status).toHaveProperty('degradationProfile');
    expect(status).toHaveProperty('config');
    expect(typeof status.queueDepth).toBe('number');
    expect(typeof status.activeRequests).toBe('number');
  });
});
