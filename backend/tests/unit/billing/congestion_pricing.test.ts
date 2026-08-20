import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import {
  CongestionLevel,
  applyCongestionMultiplier,
  congestionPricingDigest,
  congestionTableDigest,
  getCongestionPricingTable,
  getTierForCongestionLevel,
  normalizeCongestionScore,
  resolveCongestionLevel,
  verifyCongestionPricingIntegrity,
} from '../../../src/billing/congestion_pricing.js';
import { registerCongestionPricingRoutes } from '../../../src/api/routes/congestion_pricing.js';

describe('Congestion Pricing Core Engine', () => {
  describe('normalizeCongestionScore', () => {
    it('normalizes valid decimal scores (0.0 to 1.0)', () => {
      expect(normalizeCongestionScore(0.0)).toBe(0.0);
      expect(normalizeCongestionScore(0.5)).toBe(0.5);
      expect(normalizeCongestionScore(1.0)).toBe(1.0);
    });

    it('converts percentage values (1.0 to 100) to decimal', () => {
      expect(normalizeCongestionScore(25)).toBe(0.25);
      expect(normalizeCongestionScore(85)).toBe(0.85);
      expect(normalizeCongestionScore(100)).toBe(1.0);
    });

    it('clamps out-of-bounds numbers safely', () => {
      expect(normalizeCongestionScore(-0.5)).toBe(0.0);
      expect(normalizeCongestionScore(150)).toBe(1.0);
    });

    it('throws RangeError for invalid or non-finite values', () => {
      expect(() => normalizeCongestionScore(NaN)).toThrow(RangeError);
      expect(() => normalizeCongestionScore(Infinity)).toThrow(RangeError);
    });
  });

  describe('resolveCongestionLevel', () => {
    it('maps scores to correct CongestionLevel enum', () => {
      expect(resolveCongestionLevel(0.1)).toBe(CongestionLevel.LOW);
      expect(resolveCongestionLevel(0.5)).toBe(CongestionLevel.NORMAL);
      expect(resolveCongestionLevel(0.8)).toBe(CongestionLevel.HIGH);
      expect(resolveCongestionLevel(0.95)).toBe(CongestionLevel.CRITICAL);
    });
  });

  describe('applyCongestionMultiplier', () => {
    it('applies LOW congestion 0.90x discount', () => {
      const result = applyCongestionMultiplier(10_000n, { score: 0.1 });
      expect(result.level).toBe(CongestionLevel.LOW);
      expect(result.multiplier).toBe(0.9);
      expect(result.adjustedChargeMicros).toBe(9_000n);
    });

    it('applies NORMAL congestion 1.00x base rate', () => {
      const result = applyCongestionMultiplier(10_000n, { score: 0.5 });
      expect(result.level).toBe(CongestionLevel.NORMAL);
      expect(result.multiplier).toBe(1.0);
      expect(result.adjustedChargeMicros).toBe(10_000n);
    });

    it('applies HIGH congestion 1.25x surge rate', () => {
      const result = applyCongestionMultiplier(10_000n, { score: 0.8 });
      expect(result.level).toBe(CongestionLevel.HIGH);
      expect(result.multiplier).toBe(1.25);
      expect(result.adjustedChargeMicros).toBe(12_500n);
    });

    it('applies CRITICAL congestion 1.50x surge rate', () => {
      const result = applyCongestionMultiplier(10_000n, { score: 0.95 });
      expect(result.level).toBe(CongestionLevel.CRITICAL);
      expect(result.multiplier).toBe(1.5);
      expect(result.adjustedChargeMicros).toBe(15_000n);
    });

    it('uses BigInt ceiling rounding to avoid fractional unit loss', () => {
      // 1n * 1.25 = 1.25 -> rounded ceiling up = 2n
      const result = applyCongestionMultiplier(1n, { score: 0.8 });
      expect(result.adjustedChargeMicros).toBe(2n);
    });

    it('rejects negative base charges', () => {
      expect(() => applyCongestionMultiplier(-100n, { score: 0.5 })).toThrow(RangeError);
    });
  });

  describe('Cryptographic Integrity & Auditability (SOC2 / PCI-DSS)', () => {
    it('generates valid SHA-256 digests and verifies integrity', () => {
      const result = applyCongestionMultiplier(50_000n, {
        score: 0.85,
        deviceId: 'device-test-1',
      });

      expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(verifyCongestionPricingIntegrity(result, 'device-test-1')).toBe(true);
    });

    it('detects tampered calculation results', () => {
      const result = applyCongestionMultiplier(50_000n, {
        score: 0.85,
        deviceId: 'device-test-1',
      });

      const tampered = {
        ...result,
        adjustedChargeMicros: result.adjustedChargeMicros + 100n,
      };

      expect(verifyCongestionPricingIntegrity(tampered, 'device-test-1')).toBe(false);
    });

    it('generates reproducible table digest', () => {
      const digest1 = congestionTableDigest();
      const digest2 = congestionTableDigest();
      expect(digest1).toMatch(/^[a-f0-9]{64}$/);
      expect(digest1).toBe(digest2);
    });
  });

  describe('Performance Bounds (< 200ms P99 target)', () => {
    it('executes 1,000 evaluations well within P99 target bounds (< 1ms per op)', () => {
      const start = performance.now();
      const iterations = 1000;

      for (let i = 0; i < iterations; i++) {
        applyCongestionMultiplier(BigInt(i * 100), {
          score: (i % 100) / 100,
          deviceId: `device-${i}`,
        });
      }

      const totalDurationMs = performance.now() - start;
      const avgDurationMs = totalDurationMs / iterations;

      expect(avgDurationMs).toBeLessThan(0.5); // Sub-millisecond execution (< 0.5ms)
      expect(totalDurationMs).toBeLessThan(200); // 1,000 operations completed under 200ms total
    });
  });
});

describe('Congestion Pricing API Endpoints', () => {
  async function createTestApp() {
    const app = Fastify();
    registerCongestionPricingRoutes(app);
    await app.ready();
    return app;
  }

  it('GET /api/v1/pricing/congestion returns tiers and digest', async () => {
    const app = await createTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/pricing/congestion',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.tiers).toHaveLength(4);
    expect(body.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('POST /api/v1/pricing/congestion/evaluate calculates dynamic multiplier', async () => {
    const app = await createTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/pricing/congestion/evaluate',
      payload: {
        baseChargeMicros: '10000',
        score: 0.85,
        deviceId: 'dev-123',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.level).toBe(CongestionLevel.HIGH);
    expect(body.multiplier).toBe(1.25);
    expect(body.adjustedChargeMicros).toBe('12500');
    expect(body.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('POST /api/v1/pricing/congestion/verify validates cryptographic digest', async () => {
    const app = await createTestApp();

    const evalResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/pricing/congestion/evaluate',
      payload: {
        baseChargeMicros: '10000',
        score: 0.85,
        deviceId: 'dev-123',
      },
    });

    const evalBody = JSON.parse(evalResponse.body);

    const verifyResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/pricing/congestion/verify',
      payload: {
        result: evalBody,
        deviceId: 'dev-123',
      },
    });

    expect(verifyResponse.statusCode).toBe(200);
    const verifyBody = JSON.parse(verifyResponse.body);
    expect(verifyBody.valid).toBe(true);
  });
});
