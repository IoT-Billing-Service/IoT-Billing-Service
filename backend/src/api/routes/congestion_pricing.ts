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
  CongestionPricingTier,
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

export interface EvaluateRequestBody {
  baseChargeMicros: number | string;
  score: number;
  deviceId?: string;
}

export interface VerifyRequestBody {
  result: Record<string, unknown>;
  deviceId?: string;
}

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

    return await reply.send({
      digest,
      tiers,
      generatedAt: new Date().toISOString(),
    });
  });

  /**
   * POST /api/v1/pricing/congestion/evaluate
   * Evaluate dynamic rate multiplier based on network congestion score.
   */
  app.post<{ Body: EvaluateRequestBody }>(
    '/api/v1/pricing/congestion/evaluate',
    async (request: FastifyRequest<{ Body: EvaluateRequestBody }>, reply: FastifyReply) => {
      const startTime = process.hrtime.bigint();
      const body = request.body;

      let baseCharge: bigint;
      try {
        baseCharge = BigInt(body.baseChargeMicros);
        if (baseCharge < 0n) throw new Error('Negative charge');
      } catch {
        return await reply.status(400).send({
          error: 'Bad Request',
          message: 'baseChargeMicros must be a valid non-negative integer or numeric string',
        });
      }

      if (!Number.isFinite(body.score)) {
        return await reply.status(400).send({
          error: 'Bad Request',
          message: 'score must be a finite number',
        });
      }

      const result = applyCongestionMultiplier(baseCharge, {
        score: body.score,
        deviceId: body.deviceId,
      });

      // Update Prometheus metrics & gauges
      setCongestionScoreGauge(result.score);
      recordCongestionMultiplierApplied(result.level);

      const endTime = process.hrtime.bigint();
      const durationSeconds = Number(endTime - startTime) / 1e9;
      observeCongestionEvalDuration(durationSeconds);

      return await reply.send({
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
  app.post<{ Body: VerifyRequestBody }>(
    '/api/v1/pricing/congestion/verify',
    async (request: FastifyRequest<{ Body: VerifyRequestBody }>, reply: FastifyReply) => {
      const body = request.body;
      const { result, deviceId } = body;

      if (typeof result['digest'] !== 'string') {
        return await reply.status(400).send({
          error: 'Bad Request',
          message: 'Invalid result payload or missing digest',
        });
      }

      try {
        const resultObject: CongestionMultiplierResult = {
          level: result['level'] as CongestionLevel,
          tier: result['tier'] as CongestionPricingTier,
          score: Number(result['score']),
          multiplier: Number(result['multiplier']),
          baseChargeMicros: BigInt(result['baseChargeMicros'] as string | number),
          adjustedChargeMicros: BigInt(result['adjustedChargeMicros'] as string | number),
          appliedAt: typeof result['appliedAt'] === 'string' ? result['appliedAt'] : '',
          digest: result['digest'],
        };

        const valid = verifyCongestionPricingIntegrity(resultObject, deviceId);
        return await reply.send({
          valid,
          verifiedAt: new Date().toISOString(),
        });
      } catch {
        return await reply.status(400).send({
          error: 'Bad Request',
          message: 'Malformed calculation payload',
          valid: false,
        });
      }
    },
  );
}
