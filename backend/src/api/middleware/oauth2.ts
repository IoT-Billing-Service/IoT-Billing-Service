/**
 * OAuth2 Bearer token middleware — Issue #57
 *
 * Verifies an OAuth2 access token (issued by the platform token endpoint) and
 * attaches the introspection result to `request.oauth2Session`. Routes that
 * require third-party delegated access use this as their preHandler instead of
 * (or in addition to) `verifyJwt`.
 *
 * Scope enforcement is separate: use `requireScopes(...scopes)` to build a
 * preHandler that checks for specific scopes after token verification.
 *
 * Performance: single indexed lookup on `oauth2_tokens.token_hash` — the
 * SHA-256 hex string is 64 chars, hits a UNIQUE index, and is well within the
 * 200ms P99 billing SLA.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { sha256Hex } from '../oauth2/oauth2_service.js';

export interface OAuth2Session {
  clientId: string;
  walletAddress: string;
  scopes: string[];
  tokenId: string;
  expiresAt: Date;
}

declare module 'fastify' {
  interface FastifyRequest {
    oauth2Session?: OAuth2Session;
  }
}

let sharedPrisma: PrismaClient | null = null;

function getPrisma(): PrismaClient {
  if (!sharedPrisma) {
    sharedPrisma = new PrismaClient();
  }
  return sharedPrisma;
}

/**
 * Fastify preHandler: verify an OAuth2 Bearer token.
 * Attaches `request.oauth2Session` on success, replies 401 on failure.
 */
export async function verifyOAuth2Token(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    await reply.status(401).send({
      error: 'Unauthorized',
      message: 'Missing or malformed Authorization header',
    });
    return;
  }

  const rawToken = header.slice('Bearer '.length).trim();
  if (!rawToken) {
    await reply.status(401).send({ error: 'Unauthorized', message: 'Empty Bearer token' });
    return;
  }

  // Only handle OAuth2 tokens (prefixed oat_ or ort_). Stellar JWT tokens
  // start with a base64 segment — let the regular verifyJwt middleware handle
  // them. Routes that accept EITHER type should chain both preHandlers.
  if (!rawToken.startsWith('oat_') && !rawToken.startsWith('ort_')) {
    await reply.status(401).send({
      error: 'Unauthorized',
      message: 'Token is not an OAuth2 access token',
    });
    return;
  }

  const tokenHash = sha256Hex(rawToken);
  const prisma = getPrisma();

  const record = await prisma.oAuth2Token.findUnique({ where: { tokenHash } });

  if (!record || record.tokenType !== 'access') {
    await reply
      .status(401)
      .send({ error: 'Unauthorized', message: 'Invalid or unknown access token' });
    return;
  }

  if (record.revokedAt !== null) {
    await reply.status(401).send({ error: 'Unauthorized', message: 'Token has been revoked' });
    return;
  }

  if (record.expiresAt < new Date()) {
    await reply.status(401).send({ error: 'Unauthorized', message: 'Token has expired' });
    return;
  }

  request.oauth2Session = {
    clientId: record.clientId,
    walletAddress: record.walletAddress,
    scopes: record.scopes.split(' ').filter(Boolean),
    tokenId: record.id,
    expiresAt: record.expiresAt,
  };
}

/**
 * Returns a Fastify preHandler that verifies the request has an OAuth2
 * session (via `verifyOAuth2Token`) AND that the session carries ALL of
 * the specified scopes.
 *
 * Usage:
 *   app.get('/api/billing', { preHandler: requireScopes('billing:read') }, handler)
 */
export function requireScopes(
  ...requiredScopes: string[]
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // First verify the token itself
    await verifyOAuth2Token(request, reply);
    // If verifyOAuth2Token sent a reply, reply.sent is true — bail out
    if (reply.sent) return;

    const session = request.oauth2Session;
    if (!session) {
      await reply.status(401).send({ error: 'Unauthorized', message: 'No OAuth2 session' });
      return;
    }

    const missing = requiredScopes.filter((s) => !session.scopes.includes(s));
    if (missing.length > 0) {
      await reply.status(403).send({
        error: 'Forbidden',
        message: `Insufficient scope. Required: ${missing.join(', ')}`,
      });
    }
  };
}
