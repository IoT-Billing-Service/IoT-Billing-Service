/**
 * OAuth2 Routes — Issue #57
 *
 * Implements the OAuth 2.0 Authorization Code + PKCE endpoints:
 *
 *   POST /api/oauth2/clients          — register a new client (admin-only)
 *   GET  /api/oauth2/authorize        — authorisation endpoint (resource owner consent)
 *   POST /api/oauth2/token            — token endpoint (code exchange + refresh)
 *   POST /api/oauth2/revoke           — revocation endpoint (RFC 7009)
 *   POST /api/oauth2/introspect       — introspection endpoint (RFC 7662, internal only)
 *
 * All error responses follow RFC 6749 §5.2 JSON format:
 *   { "error": "<code>", "error_description": "<human-readable text>" }
 *
 * Security headers (X-Content-Type-Options, Cache-Control: no-store) are set
 * on every token endpoint response per RFC 6749 §5.1.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { OAuth2Service, OAuth2Error } from '../oauth2/oauth2_service.js';
import { verifyJwt } from '../middleware/auth.js';
import { getEnv } from '../../config/env.js';
import { applyAuthRateLimiting } from '../middleware/rate_limiter.js';

// ---------------------------------------------------------------------------
// Route body / param shapes
// ---------------------------------------------------------------------------

interface RegisterClientBody {
  name: string;
  redirectUris: string[];
  allowedScopes: string;
  isPublic?: boolean;
}

interface AuthorizeQuery {
  client_id: string;
  redirect_uri: string;
  response_type: string;
  scope: string;
  code_challenge: string;
  code_challenge_method: string;
  state?: string;
}

interface TokenBody {
  grant_type: string;
  client_id: string;
  client_secret?: string;
  code?: string;
  redirect_uri?: string;
  code_verifier?: string;
  refresh_token?: string;
}

interface RevokeBody {
  token: string;
  client_id: string;
  client_secret?: string;
}

interface IntrospectBody {
  token: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function noStoreHeaders(reply: FastifyReply): void {
  void reply.header('Cache-Control', 'no-store');
  void reply.header('Pragma', 'no-cache');
  void reply.header('X-Content-Type-Options', 'nosniff');
}

function verifyAdminKey(request: FastifyRequest, reply: FastifyReply): boolean {
  const env = getEnv();
  const key = request.headers['x-admin-key'] as string | undefined;
  if (!env.ADMIN_SECRET_KEY || key !== env.ADMIN_SECRET_KEY) {
    void reply.status(401).send({ error: 'Unauthorized', message: 'Invalid or missing X-Admin-Key' });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerOAuth2Routes(app: FastifyInstance): void {
  const prisma = new PrismaClient();
  const service = new OAuth2Service(prisma);

  // -------------------------------------------------------------------------
  // POST /api/oauth2/clients — register a new third-party client (admin only)
  // -------------------------------------------------------------------------
  app.post<{ Body: RegisterClientBody }>(
    '/api/oauth2/clients',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'redirectUris', 'allowedScopes'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            redirectUris: { type: 'array', items: { type: 'string' }, minItems: 1 },
            allowedScopes: { type: 'string', minLength: 1 },
            isPublic: { type: 'boolean' },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: RegisterClientBody }>, reply: FastifyReply) => {
      if (!verifyAdminKey(request, reply)) return;

      try {
        const { name, redirectUris, allowedScopes, isPublic = false } = request.body;
        // The ownerWallet is the authenticated admin; in a real multi-tenant
        // setup this would come from the JWT. We use a sentinel here.
        const { client, rawSecret } = await service.registerClient({
          name,
          redirectUris,
          allowedScopes,
          ownerWallet: 'admin',
          isPublic,
        });

        return reply.status(201).send({
          clientId: client.id,
          name: client.name,
          allowedScopes: client.allowedScopes,
          redirectUris: client.redirectUris.split(','),
          isPublic,
          // Shown once; not stored in plaintext
          clientSecret: rawSecret ?? undefined,
        });
      } catch (err) {
        if (err instanceof OAuth2Error) {
          return reply.status(err.httpStatus).send(err.toJSON());
        }
        request.log.error(err);
        return reply.status(500).send({ error: 'server_error', error_description: 'Internal error' });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/oauth2/authorize — authorisation endpoint
  //
  // The resource owner (authenticated via their Stellar JWT) grants consent.
  // In a browser-based flow this would serve an HTML consent page; here we
  // auto-grant and redirect immediately (headless IoT device scenario).
  // -------------------------------------------------------------------------
  app.get<{ Querystring: AuthorizeQuery }>(
    '/api/oauth2/authorize',
    {
      preHandler: [applyAuthRateLimiting, verifyJwt],
      schema: {
        querystring: {
          type: 'object',
          required: [
            'client_id',
            'redirect_uri',
            'response_type',
            'scope',
            'code_challenge',
            'code_challenge_method',
          ],
          properties: {
            client_id: { type: 'string' },
            redirect_uri: { type: 'string' },
            response_type: { type: 'string' },
            scope: { type: 'string' },
            code_challenge: { type: 'string' },
            code_challenge_method: { type: 'string' },
            state: { type: 'string' },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Querystring: AuthorizeQuery }>,
      reply: FastifyReply,
    ) => {
      noStoreHeaders(reply);

      const {
        client_id,
        redirect_uri,
        response_type,
        scope,
        code_challenge,
        code_challenge_method,
        state,
      } = request.query;

      if (response_type !== 'code') {
        return reply.status(400).send({
          error: 'unsupported_response_type',
          error_description: 'Only response_type=code is supported',
        });
      }

      const walletAddress = request.session?.wallet;
      if (!walletAddress) {
        return reply.status(401).send({ error: 'access_denied', error_description: 'Not authenticated' });
      }

      try {
        const result = await service.authorise({
          clientId: client_id,
          redirectUri: redirect_uri,
          scope,
          codeChallenge: code_challenge,
          codeChallengeMethod: code_challenge_method,
          walletAddress,
        });

        // Build redirect with code (and optional state for CSRF protection)
        const url = new URL(result.redirectUri);
        url.searchParams.set('code', result.code);
        if (state) url.searchParams.set('state', state);

        return reply.redirect(url.toString(), 302);
      } catch (err) {
        if (err instanceof OAuth2Error) {
          // For authorise errors we redirect with error params (RFC 6749 §4.1.2.1)
          try {
            const url = new URL(redirect_uri);
            url.searchParams.set('error', err.code);
            url.searchParams.set('error_description', err.description);
            if (state) url.searchParams.set('state', state);
            return reply.redirect(url.toString(), 302);
          } catch {
            return reply.status(err.httpStatus).send(err.toJSON());
          }
        }
        request.log.error(err);
        return reply.status(500).send({ error: 'server_error', error_description: 'Internal error' });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/oauth2/token — token endpoint (code exchange + refresh)
  // -------------------------------------------------------------------------
  app.post<{ Body: TokenBody }>(
    '/api/oauth2/token',
    {
      preHandler: applyAuthRateLimiting,
      schema: {
        body: {
          type: 'object',
          required: ['grant_type', 'client_id'],
          properties: {
            grant_type: { type: 'string' },
            client_id: { type: 'string' },
            client_secret: { type: 'string' },
            code: { type: 'string' },
            redirect_uri: { type: 'string' },
            code_verifier: { type: 'string' },
            refresh_token: { type: 'string' },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: TokenBody }>, reply: FastifyReply) => {
      noStoreHeaders(reply);

      const { grant_type, client_id, client_secret, code, redirect_uri, code_verifier, refresh_token } =
        request.body;

      try {
        if (grant_type === 'authorization_code') {
          if (!code || !redirect_uri || !code_verifier) {
            return reply.status(400).send({
              error: 'invalid_request',
              error_description: 'code, redirect_uri, and code_verifier are required',
            });
          }

          const tokens = await service.exchangeCode({
            clientId: client_id,
            code,
            redirectUri: redirect_uri,
            codeVerifier: code_verifier,
            clientSecret: client_secret,
          });

          return reply.send({
            access_token: tokens.accessToken,
            refresh_token: tokens.refreshToken,
            token_type: tokens.tokenType,
            expires_in: tokens.expiresIn,
            scope: tokens.scope,
          });
        }

        if (grant_type === 'refresh_token') {
          if (!refresh_token) {
            return reply.status(400).send({
              error: 'invalid_request',
              error_description: 'refresh_token is required',
            });
          }

          const tokens = await service.refreshTokens({
            clientId: client_id,
            refreshToken: refresh_token,
            clientSecret: client_secret,
          });

          return reply.send({
            access_token: tokens.accessToken,
            refresh_token: tokens.refreshToken,
            token_type: tokens.tokenType,
            expires_in: tokens.expiresIn,
            scope: tokens.scope,
          });
        }

        return reply.status(400).send({
          error: 'unsupported_grant_type',
          error_description: `grant_type "${grant_type}" is not supported`,
        });
      } catch (err) {
        if (err instanceof OAuth2Error) {
          return reply.status(err.httpStatus).send(err.toJSON());
        }
        request.log.error(err);
        return reply.status(500).send({ error: 'server_error', error_description: 'Internal error' });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/oauth2/revoke — revocation endpoint (RFC 7009)
  // -------------------------------------------------------------------------
  app.post<{ Body: RevokeBody }>(
    '/api/oauth2/revoke',
    {
      schema: {
        body: {
          type: 'object',
          required: ['token', 'client_id'],
          properties: {
            token: { type: 'string' },
            client_id: { type: 'string' },
            client_secret: { type: 'string' },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: RevokeBody }>, reply: FastifyReply) => {
      noStoreHeaders(reply);

      const { token, client_id } = request.body;

      try {
        // RFC 7009: always 200, whether token was valid or not
        await service.revokeToken({ token, clientId: client_id });
        return reply.status(200).send({});
      } catch (err) {
        if (err instanceof OAuth2Error) {
          return reply.status(err.httpStatus).send(err.toJSON());
        }
        request.log.error(err);
        return reply.status(500).send({ error: 'server_error', error_description: 'Internal error' });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/oauth2/introspect — introspection endpoint (RFC 7662)
  // Internal resource-server use only; protected by X-Admin-Key.
  // -------------------------------------------------------------------------
  app.post<{ Body: IntrospectBody }>(
    '/api/oauth2/introspect',
    {
      schema: {
        body: {
          type: 'object',
          required: ['token'],
          properties: { token: { type: 'string' } },
        },
      },
    },
    async (request: FastifyRequest<{ Body: IntrospectBody }>, reply: FastifyReply) => {
      noStoreHeaders(reply);

      if (!verifyAdminKey(request, reply)) return;

      const { token } = request.body;

      try {
        const result = await service.introspect(token);
        return reply.send(result);
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ error: 'server_error', error_description: 'Internal error' });
      }
    },
  );
}
