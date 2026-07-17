/**
 * Geographic Pricing Tier API routes (issue #54).
 *
 * Exposes read-only endpoints so operators and integrators can inspect the
 * active tier table and verify its cryptographic integrity without connecting
 * directly to the database.
 *
 * Routes:
 *   GET  /api/pricing/tiers         — Full pricing tier table + integrity digest.
 *   GET  /api/pricing/tiers/:region — Single tier lookup by region code.
 *   POST /api/pricing/preview        — Preview the adjusted charge for a given
 *                                      base amount and country code (no auth;
 *                                      safe for frontend pricing calculators).
 *   PUT  /api/admin/devices/:deviceId/region — Admin: set a device's country
 *                                              code (requires X-Admin-Key).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';
import {
  BillingRegion,
  applyGeoMultiplier,
  getPricingTable,
  getCountryRegionMap,
  getTierForRegion,
  pricingTableDigest,
  resolveRegion,
} from '../../billing/geo_pricing.js';
import { getEnv } from '../../config/env.js';
import { verifyJwt } from '../middleware/auth.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isBillingRegion(value: string): value is BillingRegion {
  return Object.values(BillingRegion).includes(value as BillingRegion);
}

function verifyAdminKey(request: FastifyRequest, reply: FastifyReply): boolean {
  const env = getEnv();
  const key = request.headers['x-admin-key'] as string | undefined;
  if (!env.ADMIN_SECRET_KEY) {
    void reply.status(503).send({ error: 'Admin key not configured' });
    return false;
  }
  if (!key || key !== env.ADMIN_SECRET_KEY) {
    void reply.status(401).send({ error: 'Unauthorized', message: 'Invalid or missing X-Admin-Key' });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerGeoPricingRoutes(app: FastifyInstance): void {
  /**
   * GET /api/pricing/tiers
   * Returns the full pricing tier table and a SHA-256 integrity digest.
   * Requires a valid JWT (any authenticated user can inspect pricing).
   */
  app.get(
    '/api/pricing/tiers',
    { preHandler: [verifyJwt] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const table = getPricingTable();
      const countryMap = getCountryRegionMap();
      const digest = pricingTableDigest();

      const tiers = [...table.entries()].map(([region, tier]) => ({
        region,
        name: tier.name,
        multiplier: tier.multiplier,
        currency: tier.currency,
        countryCodes: [...countryMap.entries()]
          .filter(([, r]) => r === region)
          .map(([cc]) => cc)
          .sort(),
      }));

      return reply.send({
        digest,
        tiers,
        generatedAt: new Date().toISOString(),
      });
    },
  );

  /**
   * GET /api/pricing/tiers/:region
   * Returns details for a single region (e.g. /api/pricing/tiers/EU).
   */
  app.get<{ Params: { region: string } }>(
    '/api/pricing/tiers/:region',
    { preHandler: [verifyJwt] },
    async (request: FastifyRequest<{ Params: { region: string } }>, reply: FastifyReply) => {
      const { region } = request.params;
      if (!isBillingRegion(region.toUpperCase())) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: `Unknown region "${region}". Valid values: ${Object.values(BillingRegion).join(', ')}`,
        });
      }

      const billingRegion = region.toUpperCase() as BillingRegion;
      const tier = getTierForRegion(billingRegion);
      const countryMap = getCountryRegionMap();

      return reply.send({
        region: billingRegion,
        name: tier.name,
        multiplier: tier.multiplier,
        currency: tier.currency,
        countryCodes: [...countryMap.entries()]
          .filter(([, r]) => r === billingRegion)
          .map(([cc]) => cc)
          .sort(),
        tableDigest: pricingTableDigest(),
      });
    },
  );

  /**
   * POST /api/pricing/preview
   * Preview the geo-adjusted charge for a base amount and country code.
   * No authentication required — safe for use in pricing calculators.
   *
   * Body: { baseCharge: number, countryCode: string }
   */
  app.post<{ Body: { baseCharge: unknown; countryCode: unknown } }>(
    '/api/pricing/preview',
    {
      schema: {
        body: {
          type: 'object',
          required: ['baseCharge', 'countryCode'],
          properties: {
            baseCharge: { type: 'number', minimum: 0 },
            countryCode: { type: 'string' },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Body: { baseCharge: unknown; countryCode: unknown } }>,
      reply: FastifyReply,
    ) => {
      const { baseCharge, countryCode } = request.body;

      if (typeof baseCharge !== 'number' || !Number.isFinite(baseCharge) || baseCharge < 0) {
        return reply.status(400).send({ error: 'Bad Request', message: 'Invalid baseCharge' });
      }
      if (typeof countryCode !== 'string') {
        return reply.status(400).send({ error: 'Bad Request', message: 'Invalid countryCode' });
      }

      const baseChargeInt = BigInt(Math.round(baseCharge));
      const result = applyGeoMultiplier(baseChargeInt, countryCode);

      return reply.send({
        countryCode: countryCode.toUpperCase().trim() || null,
        region: result.region,
        tier: {
          name: result.tier.name,
          multiplier: result.tier.multiplier,
          currency: result.tier.currency,
        },
        baseCharge: Number(baseChargeInt),
        adjustedCharge: Number(result.adjustedCharge),
        tableDigest: pricingTableDigest(),
      });
    },
  );

  /**
   * PUT /api/admin/devices/:deviceId/region
   * Set the country code (and therefore billing region) for a device.
   * Requires X-Admin-Key.
   *
   * Body: { countryCode: string }
   */
  app.put<{ Params: { deviceId: string }; Body: { countryCode: string } }>(
    '/api/admin/devices/:deviceId/region',
    {
      schema: {
        params: {
          type: 'object',
          required: ['deviceId'],
          properties: { deviceId: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['countryCode'],
          properties: { countryCode: { type: 'string', maxLength: 2 } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { deviceId: string }; Body: { countryCode: string } }>,
      reply: FastifyReply,
    ) => {
      if (!verifyAdminKey(request, reply)) return;

      const { deviceId } = request.params;
      const { countryCode } = request.body;

      // Validate the country code resolves to a known region (not necessarily
      // in COUNTRY_TO_REGION — ROW is also acceptable as a catch-all).
      const normalised = countryCode.toUpperCase().trim();
      if (normalised.length !== 2 || !/^[A-Z]{2}$/.test(normalised)) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'countryCode must be a 2-letter ISO 3166-1 alpha-2 code',
        });
      }

      const resolvedRegion = resolveRegion(normalised);
      const tier = getTierForRegion(resolvedRegion);

      const prisma = new PrismaClient();
      try {
        const device = await prisma.device.findUnique({ where: { id: deviceId } });
        if (!device) {
          return reply.status(404).send({ error: 'Not Found', message: 'Device not found' });
        }

        const updated = await prisma.device.update({
          where: { id: deviceId },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          data: { countryCode: normalised } as any,
        });

        request.log.info(
          {
            deviceId,
            countryCode: normalised,
            region: resolvedRegion,
            multiplier: tier.multiplier,
          },
          'geo_pricing: device region updated',
        );

        return reply.send({
          deviceId: updated.id,
          countryCode: normalised,
          region: resolvedRegion,
          tier: { name: tier.name, multiplier: tier.multiplier, currency: tier.currency },
          updatedAt: updated.updatedAt.toISOString(),
        });
      } finally {
        await prisma.$disconnect();
      }
    },
  );
}
