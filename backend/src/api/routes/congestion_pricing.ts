/**
 * Dynamic Pricing Based on Network Congestion API Routes (issue #296).
 *
 * Exposes endpoints for retrieving dynamic pricing congestion tiers,
 * evaluating dynamic charge multipliers based on real-time network congestion,
 * and cryptographically verifying calculation integrity for PCI-DSS & SOC2 compliance.
 *
 * Routes:
 *   GET  /api/v1/pricing/congestion          — Congestion pricing tier table & snapshot digest.
 *   POST /api/v1/pricing/congestion/evaluate — Evaluate dynamic price adjustment based on score.
 *   POST /api/v1/pricing/congestion/verify   — Cryptographically verify dynamic pricing result.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  CongestionLevel,
  CongestionMultiplierResult,
  applyCongestionMultiplier,
  congestionTableDigest,
  getCongestionPricingTable,
  verifyCongestionPricingIntegrity,
} from '../../billing/congestion_pricing.js';
import {
  recordCongestionMultiplierApplied,
  setCongestionScoreGauge,
  observeCongestionEvalDuration,
} from '../metrics/prometheus.js';

export function registerCongestionPricingRoutes(app: FastifyInstance): void {
  /**
   * GET /api/v1/pricing/congestion
   * Returns current network congestion tiers and active table digest.
   */
  app.get('/api/v1/pricing/congestion', async (_request: FastifyRequest, reply: FastifyReply) => {
    const table = getCongestionPricingTable();
    const digest = congestionTableDigest();

    const tiers = [...table.entries()].map(([level, tier]) => ({
      level,
      name: tier.name,
      minScore: tier.minScore,
      maxScore: tier.maxScore,
      multiplier: tier.multiplier,
      description: tier.description,
    }));

    return reply.send({
      digest,
      tiers,
      generatedAt: new Date().toISOString(),
    });
  });

  /**
   * POST /api/v1/pricing/congestion/evaluate
   * Evaluate dynamic rate multiplier based on network congestion score.
   */
  app.post<{
    Body: {
      baseChargeMicros: number | string;
      score: number;
      deviceId?: string;
    };
  }>(
    '/api/v1/pricing/congestion/evaluate',
    async (
      request: FastifyRequest<{
        Body: { baseChargeMicros: number | string; score: number; deviceId?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const startTime = process.hrtime.bigint();
      const body = request.body || {};
      const { baseChargeMicros, score, deviceId } = body;

      if (baseChargeMicros === undefined || baseChargeMicros === null) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Missing baseChargeMicros',
        });
      }

      let baseCharge: bigint;
      try {
        baseCharge = BigInt(baseChargeMicros);
        if (baseCharge < 0n) throw new Error('Negative charge');
      } catch {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'baseChargeMicros must be a valid non-negative integer or numeric string',
        });
      }

      if (typeof score !== 'number' || !Number.isFinite(score)) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'score must be a finite number',
        });
      }

      const result = applyCongestionMultiplier(baseCharge, {
        score,
        deviceId,
      });

      // Update Prometheus metrics & gauges
      setCongestionScoreGauge(result.score);
      recordCongestionMultiplierApplied(result.level);

      const endTime = process.hrtime.bigint();
      const durationSeconds = Number(endTime - startTime) / 1e9;
      observeCongestionEvalDuration(durationSeconds);

      return reply.send({
        level: result.level,
        tier: result.tier,
        score: result.score,
        multiplier: result.multiplier,
        baseChargeMicros: result.baseChargeMicros.toString(),
        adjustedChargeMicros: result.adjustedChargeMicros.toString(),
        appliedAt: result.appliedAt,
        digest: result.digest,
      });
    },
  );

  /**
   * POST /api/v1/pricing/congestion/verify
   * Cryptographically verify dynamic pricing integrity for PCI-DSS / SOC2 auditability.
   */
  app.post<{
    Body: {
      result: any;
      deviceId?: string;
    };
  }>(
    '/api/v1/pricing/congestion/verify',
    async (
      request: FastifyRequest<{ Body: { result: any; deviceId?: string } }>,
      reply: FastifyReply,
    ) => {
      const body = request.body || {};
      const { result, deviceId } = body;

      if (!result || typeof result !== 'object' || typeof result.digest !== 'string') {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Invalid result payload or missing digest',
        });
      }

      try {
        const resultObject: CongestionMultiplierResult = {
          level: result.level as CongestionLevel,
          tier: result.tier,
          score: Number(result.score),
          multiplier: Number(result.multiplier),
          baseChargeMicros: BigInt(result.baseChargeMicros),
          adjustedChargeMicros: BigInt(result.adjustedChargeMicros),
          appliedAt: result.appliedAt,
          digest: result.digest,
        };

        const valid = verifyCongestionPricingIntegrity(resultObject, deviceId);
        return reply.send({
          valid,
          verifiedAt: new Date().toISOString(),
        });
      } catch {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Malformed calculation payload',
          valid: false,
        });
      }
    },
  );
}
