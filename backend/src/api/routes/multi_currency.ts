/**
 * Multi-Currency API routes (issue #288).
 *
 * Exposes endpoints for currency discovery, exchange-rate inspection,
 * and currency conversion. All conversion results carry cryptographic
 * integrity digests for PCI-DSS / SOC2 audit trails.
 *
 * Routes:
 *   GET /api/currencies              — List all supported currencies.
 *   GET /api/exchange-rates           — Current exchange-rate table + digest.
 *   GET /api/exchange-rates/digest    — SHA-256 digest of the active rate table.
 *   POST /api/currency/convert        — Convert an amount between currencies.
 *   POST /api/admin/exchange-rates    — Admin endpoint to update exchange rates.
 *                                        Requires X-Admin-Key.
 *   GET /api/currencies/region/:region — List supported currencies for a region.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { verifyJwt } from '../middleware/auth.js';
import { getEnv } from '../../config/env.js';
import {
  listSupportedCurrencies,
  getCurrencyInfo,
  isSupportedCurrency,
  convertCurrency,
  getRateTable,
  getRateTableStatus,
  updateRates,
  ensureRateTableInitialized,
  formatCurrencyDisplay,
  parseCurrencyAmount,
  getRegionDefaultCurrency,
  getRegionLocalCurrencies,
  EXCHANGE_RATE_SCALE,
  type ConversionResult,
  type CurrencyCode,
} from '../../billing/multi_currency.js';
import { BillingRegion } from '../../billing/geo_pricing.js';

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
    void reply
      .status(401)
      .send({ error: 'Unauthorized', message: 'Invalid or missing X-Admin-Key' });
    return false;
  }
  return true;
}

/**
 * Deserialise conversion response for the JSON API, converting
 * BigInt fields to strings so they serialise cleanly.
 */
function conversionToResponse(conversion: ConversionResult): Record<string, unknown> {
  return {
    sourceAmountMicros: conversion.sourceAmountMicros.toString(),
    sourceCurrency: conversion.sourceCurrency,
    targetAmountMicros: conversion.targetAmountMicros.toString(),
    targetCurrency: conversion.targetCurrency,
    rateScaled: conversion.rateScaled.toString(),
    rateTableVersionId: conversion.rateTableVersionId,
    digest: conversion.digest,
    convertedAt: conversion.convertedAt,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerMultiCurrencyRoutes(app: FastifyInstance): void {
  // Ensure the rate table is initialised before any routes are called
  ensureRateTableInitialized();

  /**
   * GET /api/currencies
   * List all supported currencies with their metadata.
   * Public — no authentication required.
   */
  app.get('/api/currencies', async (_request: FastifyRequest, reply: FastifyReply) => {
    const currencies = listSupportedCurrencies();
    const rateTable = getRateTable();

    return reply.send({
      currencies: currencies.map((c) => ({
        code: c.code,
        name: c.name,
        symbol: c.symbol,
        decimals: c.decimals,
        isoNumeric: c.isoNumeric,
      })),
      count: currencies.length,
      baseCurrency: rateTable.baseCurrency,
      rateTableVersionId: rateTable.versionId,
    });
  });

  /**
   * GET /api/exchange-rates
   * Returns the current exchange-rate table with integrity digest.
   * Requires a valid JWT for rate inspection.
   */
  app.get(
    '/api/exchange-rates',
    { preHandler: [verifyJwt] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const rateTable = getRateTable();
      const rates = [...rateTable.rates.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([_code, entry]) => ({
          from: entry.from,
          to: entry.to,
          rateScaled: entry.rateScaled.toString(),
          rateDecimal: Number(entry.rateScaled) / Number(EXCHANGE_RATE_SCALE),
          updatedAt: entry.updatedAt,
          source: entry.source,
        }));

      return reply.send({
        versionId: rateTable.versionId,
        generatedAt: rateTable.generatedAt,
        baseCurrency: rateTable.baseCurrency,
        digest: rateTable.digest,
        rates,
        count: rates.length,
      });
    },
  );

  /**
   * GET /api/exchange-rates/digest
   * Returns just the SHA-256 digest of the active rate table for quick
   * integrity checks. No auth required — digest is safe to expose.
   */
  app.get('/api/exchange-rates/digest', async (_request: FastifyRequest, reply: FastifyReply) => {
    const rateTable = getRateTable();
    return reply.send({
      versionId: rateTable.versionId,
      baseCurrency: rateTable.baseCurrency,
      digest: rateTable.digest,
      generatedAt: rateTable.generatedAt,
    });
  });

  /**
   * POST /api/currency/convert
   * Convert an amount between two supported currencies.
   * No authentication required — conversion is a pure read operation.
   *
   * Body:
   *   { amount: number, sourceCurrency: string, targetCurrency: string }
   *
   * The `amount` is treated as a display amount (e.g. 100.50) and is
   * converted to micro-units internally. The result includes the converted
   * micro-unit value, the display value, and an integrity digest.
   */
  app.post<{
    Body: {
      amount: unknown;
      sourceCurrency: unknown;
      targetCurrency: unknown;
    };
  }>(
    '/api/currency/convert',
    {
      schema: {
        body: {
          type: 'object',
          required: ['amount', 'sourceCurrency', 'targetCurrency'],
          properties: {
            amount: { type: 'number', minimum: 0 },
            sourceCurrency: { type: 'string', minLength: 3, maxLength: 3 },
            targetCurrency: { type: 'string', minLength: 3, maxLength: 3 },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Body: { amount: unknown; sourceCurrency: unknown; targetCurrency: unknown };
      }>,
      reply: FastifyReply,
    ) => {
      const { amount, sourceCurrency, targetCurrency } = request.body;

      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'amount must be a non-negative finite number',
        });
      }

      if (typeof sourceCurrency !== 'string' || sourceCurrency.length !== 3) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'sourceCurrency must be a 3-letter ISO 4217 code',
        });
      }

      if (typeof targetCurrency !== 'string' || targetCurrency.length !== 3) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'targetCurrency must be a 3-letter ISO 4217 code',
        });
      }

      const srcCode = sourceCurrency.toUpperCase();
      const tgtCode = targetCurrency.toUpperCase();

      if (!isSupportedCurrency(srcCode)) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: `Unsupported source currency: ${sourceCurrency}`,
        });
      }
      if (!isSupportedCurrency(tgtCode)) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: `Unsupported target currency: ${targetCurrency}`,
        });
      }

      try {
        // Convert display amount → micro-units
        const amountStr = amount.toFixed(getCurrencyInfo(srcCode)?.decimals ?? 2);
        const sourceMicros = parseCurrencyAmount(amountStr, srcCode);

        // Perform the conversion
        const conversion = convertCurrency(sourceMicros, srcCode, tgtCode);

        // Format the target amount for display
        const displayAmount = formatCurrencyDisplay(conversion.targetAmountMicros, tgtCode);

        return reply.send({
          ...conversionToResponse(conversion),
          sourceDisplayAmount: formatCurrencyDisplay(sourceMicros, srcCode),
          targetDisplayAmount: displayAmount,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Conversion failed';
        return reply.status(400).send({ error: 'Bad Request', message });
      }
    },
  );

  /**
   * POST /api/admin/exchange-rates
   * Update exchange rates programmatically. Requires X-Admin-Key.
   *
   * Body:
   *   {
   *     baseCurrency?: string,   // defaults to "USD"
   *     source?: string,         // e.g. "manual", "ecb", "fixer"
   *     rates: { EUR: 0.92, GBP: 0.79, ... }  // decimal rates
   *   }
   */
  app.post<{
    Body: {
      baseCurrency: unknown;
      source: unknown;
      rates: unknown;
    };
  }>(
    '/api/admin/exchange-rates',
    {
      schema: {
        body: {
          type: 'object',
          required: ['rates'],
          properties: {
            baseCurrency: { type: 'string', minLength: 3, maxLength: 4 },
            source: { type: 'string' },
            rates: {
              type: 'object',
              additionalProperties: { type: 'number', minimum: 0 },
            },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Body: { baseCurrency: unknown; source: unknown; rates: unknown };
      }>,
      reply: FastifyReply,
    ) => {
      if (!verifyAdminKey(request, reply)) return;

      const { baseCurrency, source, rates } = request.body;

      if (rates === null || typeof rates !== 'object') {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'rates must be an object mapping currency codes to decimal rates',
        });
      }

      const baseCur = typeof baseCurrency === 'string' ? baseCurrency.toUpperCase() : 'USD';
      if (!isSupportedCurrency(baseCur)) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: `Unsupported base currency: ${String(baseCurrency)}`,
        });
      }

      const srcLabel = typeof source === 'string' ? source : 'manual';
      const rateMap = new Map<CurrencyCode, bigint>();

      for (const [code, rate] of Object.entries(rates as Record<string, unknown>)) {
        const upperCode = code.toUpperCase();
        if (!isSupportedCurrency(upperCode)) continue;
        if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) continue;
        rateMap.set(upperCode, BigInt(Math.round(rate * Number(EXCHANGE_RATE_SCALE))));
      }

      if (rateMap.size === 0) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'No valid rates provided',
        });
      }

      const newTable = updateRates(rateMap, baseCur, srcLabel);

      return reply.send({
        versionId: newTable.versionId,
        generatedAt: newTable.generatedAt,
        baseCurrency: newTable.baseCurrency,
        digest: newTable.digest,
        rateCount: newTable.rates.size,
        status: 'updated',
      });
    },
  );

  /**
   * GET /api/currencies/region/:region
   * List currencies relevant to a billing region, ordered by preference.
   * Public — no auth required.
   */
  app.get<{ Params: { region: string } }>(
    '/api/currencies/region/:region',
    async (request: FastifyRequest<{ Params: { region: string } }>, reply: FastifyReply) => {
      const { region } = request.params;
      const upperRegion = region.toUpperCase();

      if (!isBillingRegion(upperRegion)) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: `Unknown region "${region}". Valid values: ${Object.values(BillingRegion).join(', ')}`,
        });
      }

      const billingRegion = upperRegion as BillingRegion;
      const defaultCurrency = getRegionDefaultCurrency(billingRegion);
      const localCurrencies = getRegionLocalCurrencies(billingRegion);

      return reply.send({
        region: billingRegion,
        defaultCurrency: {
          code: defaultCurrency,
          info: getCurrencyInfo(defaultCurrency),
        },
        localCurrencies: localCurrencies.map((code) => ({
          code,
          info: getCurrencyInfo(code),
        })),
      });
    },
  );

  /**
   * GET /api/exchange-rates/status
   * Returns rate-table observability status (metrics-compatible).
   * Public — no auth, safe for monitoring dashboards.
   */
  app.get('/api/exchange-rates/status', async (_request: FastifyRequest, reply: FastifyReply) => {
    const status = getRateTableStatus();
    const table = getRateTable();

    return reply.send({
      ...status,
      baseCurrency: table.baseCurrency,
      rateCount: table.rates.size,
      rateTableDigest: table.digest,
    });
  });
}
