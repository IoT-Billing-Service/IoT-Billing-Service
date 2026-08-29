/**
 * Audit Trail with Tamper-Evident Hash Chain Verification (issue #272).
 *
 * Exposes endpoints for retrieving the audit-log signing public key (for
 * independent third-party verification, without trusting this service's own
 * code — a core PCI-DSS/SOC2 auditability requirement), verifying a single
 * entity's hash chain on demand, exporting a full chain for compliance
 * review, and running a full integrity scan across all recorded entities.
 *
 * Routes:
 *   GET  /api/v1/audit/public-key                    — Ed25519 public key for independent signature verification.
 *   GET  /api/v1/audit/:entityType/:entityId/verify   — Verify one entity's hash chain. (admin)
 *   GET  /api/v1/audit/:entityType/:entityId          — Export one entity's full audit chain. (admin)
 *   POST /api/v1/audit/scan                            — Verify every recorded entity's chain. (admin)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { getAuditLogger } from '../../security/audit_logger.js';
import { getEnv } from '../../config/env.js';

interface EntityParams {
  entityType: string;
  entityId: string;
}

/**
 * Verify the admin secret key header for authorization. Mirrors the
 * existing convention in `admin.ts` / `incident_response/routes.ts` — audit
 * chain contents and verification results are compliance-sensitive and
 * should not be readable by unauthenticated callers.
 */
function verifyAdminAuth(request: FastifyRequest, reply: FastifyReply): boolean {
  const env = getEnv();
  const authHeader = request.headers['x-admin-key'] as string | undefined;

  if (env.ADMIN_SECRET_KEY == null || env.ADMIN_SECRET_KEY === '') {
    void reply.status(503).send({
      error: 'Admin secret key not configured',
      message: 'Set ADMIN_SECRET_KEY environment variable to enable admin endpoints',
    });
    return false;
  }

  if (authHeader == null || authHeader === '' || authHeader !== env.ADMIN_SECRET_KEY) {
    void reply.status(401).send({
      error: 'Unauthorized',
      message: 'Invalid or missing X-Admin-Key header',
    });
    return false;
  }

  return true;
}

export function registerAuditRoutes(app: FastifyInstance, prisma?: PrismaClient): void {
  const client = prisma ?? new PrismaClient();
  const logger = getAuditLogger(client);

  /**
   * GET /api/v1/audit/public-key
   * Public key is, by design, meant to be public — this endpoint is
   * intentionally unauthenticated so external auditors can fetch it and
   * verify signatures without needing service credentials.
   */
  app.get('/api/v1/audit/public-key', async (_request: FastifyRequest, reply: FastifyReply) => {
    return await reply.send({
      algorithm: 'Ed25519',
      publicKey: logger.getPublicKeyHex(),
    });
  });

  /**
   * GET /api/v1/audit/:entityType/:entityId/verify
   * Walks the entity's hash chain and confirms link integrity, hash
   * recomputation, and signature validity for every entry.
   */
  app.get<{ Params: EntityParams }>(
    '/api/v1/audit/:entityType/:entityId/verify',
    async (request: FastifyRequest<{ Params: EntityParams }>, reply: FastifyReply) => {
      if (!verifyAdminAuth(request, reply)) return;

      const { entityType, entityId } = request.params;
      const result = await logger.verifyEntityChain(entityType, entityId);

      return await reply.status(result.valid ? 200 : 409).send(result);
    },
  );

  /**
   * GET /api/v1/audit/:entityType/:entityId
   * Returns the full recorded chain for one entity, oldest first — for
   * compliance export/review. Admin-gated since payloads may contain
   * business-sensitive billing data.
   */
  app.get<{ Params: EntityParams }>(
    '/api/v1/audit/:entityType/:entityId',
    async (request: FastifyRequest<{ Params: EntityParams }>, reply: FastifyReply) => {
      if (!verifyAdminAuth(request, reply)) return;

      const { entityType, entityId } = request.params;
      const rows = await client.auditLog.findMany({
        where: { entityType, entityId },
        orderBy: { createdAt: 'asc' },
      });

      return await reply.send({
        entityType,
        entityId,
        entryCount: rows.length,
        entries: rows,
      });
    },
  );

  /**
   * POST /api/v1/audit/scan
   * Verifies every distinct entity's chain in one pass. Intended to be
   * triggered by a periodic monitoring job (see docs/operators for
   * scheduling guidance) rather than called on a hot path — this issues one
   * chain-verification per recorded entity and is not latency-bounded like
   * the per-transaction billing operations are.
   */
  app.post('/api/v1/audit/scan', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!verifyAdminAuth(request, reply)) return;

    const summary = await logger.runIntegrityScan();

    return await reply.status(summary.brokenChains.length === 0 ? 200 : 409).send(summary);
  });
}
