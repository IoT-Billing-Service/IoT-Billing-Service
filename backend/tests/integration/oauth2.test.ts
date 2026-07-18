/**
 * Integration tests — OAuth2 endpoints (Issue #57)
 *
 * Tests the full HTTP layer using Fastify's inject() API.
 * Requires: Redis on localhost:6379, PostgreSQL on localhost:5432.
 * All tests are skipped gracefully when Redis is unavailable (CI without
 * services just skips rather than failing).
 *
 * Coverage:
 *   POST /api/oauth2/clients       — register client (admin-only)
 *   GET  /api/oauth2/authorize     — authorisation redirect
 *   POST /api/oauth2/token         — code exchange + refresh
 *   POST /api/oauth2/revoke        — revocation (RFC 7009)
 *   POST /api/oauth2/introspect    — introspection (RFC 7662)
 *   Scope enforcement, PKCE failure, replay rejection
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Redis } from 'ioredis';
import { Keypair } from '@stellar/stellar-sdk';
import type { FastifyInstance } from 'fastify';
import { clearEnvCache } from '../../src/config/env.js';
import { buildApp } from '../../src/api/index.js';
import { closeRedis } from '../../src/database/redis.js';
import { computeS256Challenge } from '../../src/api/oauth2/oauth2_service.js';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Environment + app bootstrap (mirrors existing integration/auth.test.ts)
// ---------------------------------------------------------------------------

const REQUIRED_ENV: Record<string, string> = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/iot_billing',
  TIMESCALEDB_URL: 'postgresql://postgres:postgres@localhost:5432/iot_billing',
  SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
  SOROBAN_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
  JWT_SECRET: 'integration-test-secret-that-is-at-least-32-characters-long',
  REDIS_URL: 'redis://localhost:6379',
  ADMIN_SECRET_KEY: 'test-admin-key-for-oauth2-integration-tests',
};

const ADMIN_KEY = REQUIRED_ENV['ADMIN_SECRET_KEY']!;
const REDIRECT_URI = 'https://third-party.example.com/callback';

let app: FastifyInstance | null = null;
let redisAvailable = false;
let redisUrl = '';

beforeAll(async () => {
  for (const [key, value] of Object.entries(REQUIRED_ENV)) {
    process.env[key] ??= value;
  }
  clearEnvCache();
  redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

  const probe = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 1000,
  });
  try {
    await probe.connect();
    await probe.ping();
    redisAvailable = true;
  } catch {
    redisAvailable = false;
  } finally {
    probe.disconnect();
  }

  if (redisAvailable) {
    app = await buildApp();
    await app.ready();
  }
});

afterAll(async () => {
  try { if (app) await app.close(); } catch { /* ignore */ }
  try { await closeRedis(); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: computeS256Challenge(verifier) };
}

/** Register a public test client and return its clientId. */
async function registerClient(name = 'Test Client'): Promise<string> {
  const res = await app!.inject({
    method: 'POST',
    url: '/api/oauth2/clients',
    headers: { 'x-admin-key': ADMIN_KEY },
    payload: {
      name,
      redirectUris: [REDIRECT_URI],
      allowedScopes: 'billing:read billing:write devices:read',
      isPublic: true,
    },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { clientId: string }).clientId;
}

/**
 * Run the full authorise → token exchange flow and return the token response.
 * Authenticate the resource owner via the Stellar challenge/verify flow first.
 */
async function fullFlow(clientId: string, scope = 'billing:read'): Promise<{
  accessToken: string;
  refreshToken: string;
  scope: string;
}> {
  // 1. Get a Stellar JWT for the resource owner
  const kp = Keypair.random();

  await app!.inject({
    method: 'POST',
    url: '/api/auth/challenge',
    payload: { walletAddress: kp.publicKey() },
  });

  const challengeRes = await app!.inject({
    method: 'POST',
    url: '/api/auth/challenge',
    payload: { walletAddress: kp.publicKey() },
  });

  // May be 409 if challenge already pending — re-use existing nonce in that case
  let nonce: string;
  if (challengeRes.statusCode === 200) {
    nonce = (challengeRes.json() as { nonce: string }).nonce;
  } else {
    // Flush and retry
    const retry = await app!.inject({
      method: 'POST',
      url: '/api/auth/challenge',
      payload: { walletAddress: kp.publicKey() },
    });
    nonce = (retry.json() as { nonce: string }).nonce;
  }

  const sig = kp.sign(Buffer.from(nonce, 'hex')).toString('hex');
  const verifyRes = await app!.inject({
    method: 'POST',
    url: '/api/auth/verify',
    headers: { 'x-test-bypass': 'true' },
    payload: { walletAddress: kp.publicKey(), signature: sig, deviceId: 'oauth2-test' },
  });
  const { accessToken: stellarJwt } = verifyRes.json() as { accessToken: string };

  // 2. Authorise (resource owner grants consent)
  const { verifier, challenge } = makePkce();
  const authRes = await app!.inject({
    method: 'GET',
    url: `/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(scope)}&code_challenge=${challenge}&code_challenge_method=S256`,
    headers: { authorization: `Bearer ${stellarJwt}` },
  });

  // Expect a redirect
  expect([301, 302]).toContain(authRes.statusCode);
  const location = authRes.headers['location'] as string;
  const url = new URL(location);
  const code = url.searchParams.get('code');
  expect(code).toBeTruthy();

  // 3. Exchange code for tokens
  const tokenRes = await app!.inject({
    method: 'POST',
    url: '/api/oauth2/token',
    headers: { 'x-test-bypass': 'true' },
    payload: {
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    },
  });
  expect(tokenRes.statusCode).toBe(200);
  const body = tokenRes.json() as {
    access_token: string;
    refresh_token: string;
    scope: string;
  };
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    scope: body.scope,
  };
}

// ---------------------------------------------------------------------------
// POST /api/oauth2/clients
// ---------------------------------------------------------------------------

describe('POST /api/oauth2/clients', () => {
  it('registers a public client and returns clientId', async () => {
    if (!redisAvailable || !app) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/oauth2/clients',
      headers: { 'x-admin-key': ADMIN_KEY },
      payload: {
        name: 'My IoT Dashboard',
        redirectUris: [REDIRECT_URI],
        allowedScopes: 'billing:read devices:read',
        isPublic: true,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(typeof body['clientId']).toBe('string');
    expect(body['name']).toBe('My IoT Dashboard');
    expect(body['isPublic']).toBe(true);
    expect(body['clientSecret']).toBeUndefined();
  });

  it('registers a confidential client and returns a one-time client secret', async () => {
    if (!redisAvailable || !app) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/oauth2/clients',
      headers: { 'x-admin-key': ADMIN_KEY },
      payload: {
        name: 'Server-Side App',
        redirectUris: [REDIRECT_URI],
        allowedScopes: 'billing:read billing:write',
        isPublic: false,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(typeof body['clientSecret']).toBe('string');
    expect((body['clientSecret'] as string)).toMatch(/^cs_[0-9a-f]+$/);
  });

  it('returns 401 without a valid admin key', async () => {
    if (!redisAvailable || !app) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/oauth2/clients',
      headers: { 'x-admin-key': 'wrong-key' },
      payload: { name: 'x', redirectUris: [REDIRECT_URI], allowedScopes: 'billing:read' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 when required fields are missing', async () => {
    if (!redisAvailable || !app) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/oauth2/clients',
      headers: { 'x-admin-key': ADMIN_KEY },
      payload: { name: 'No URIs' },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /api/oauth2/authorize
// ---------------------------------------------------------------------------

describe('GET /api/oauth2/authorize', () => {
  it('redirects with a code for a valid authorisation request', async () => {
    if (!redisAvailable || !app) return;
    const clientId = await registerClient('Auth Test Client A');
    const { verifier: _, challenge } = makePkce();
    void _;

    // Get a valid Stellar JWT first
    const kp = Keypair.random();
    const cRes = await app.inject({
      method: 'POST', url: '/api/auth/challenge',
      payload: { walletAddress: kp.publicKey() },
    });
    const { nonce } = cRes.json() as { nonce: string };
    const sig = kp.sign(Buffer.from(nonce, 'hex')).toString('hex');
    const vRes = await app.inject({
      method: 'POST', url: '/api/auth/verify',
      headers: { 'x-test-bypass': 'true' },
      payload: { walletAddress: kp.publicKey(), signature: sig, deviceId: 'dev-1' },
    });
    const { accessToken: jwt } = vRes.json() as { accessToken: string };

    const res = await app.inject({
      method: 'GET',
      url: `/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=billing%3Aread&code_challenge=${challenge}&code_challenge_method=S256`,
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect([301, 302]).toContain(res.statusCode);
    const loc = new URL(res.headers['location'] as string);
    expect(loc.searchParams.get('code')).toBeTruthy();
    expect(loc.searchParams.get('error')).toBeNull();
  });

  it('returns 401 without a Stellar JWT', async () => {
    if (!redisAvailable || !app) return;
    const clientId = await registerClient('Auth Test Client B');
    const { challenge } = makePkce();
    const res = await app.inject({
      method: 'GET',
      url: `/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=billing%3Aread&code_challenge=${challenge}&code_challenge_method=S256`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('redirects with error=invalid_scope when scope exceeds allowlist', async () => {
    if (!redisAvailable || !app) return;
    const clientId = await registerClient('Auth Test Client C');
    const { challenge } = makePkce();

    const kp = Keypair.random();
    const cRes = await app.inject({
      method: 'POST', url: '/api/auth/challenge',
      payload: { walletAddress: kp.publicKey() },
    });
    const { nonce } = cRes.json() as { nonce: string };
    const sig = kp.sign(Buffer.from(nonce, 'hex')).toString('hex');
    const vRes = await app.inject({
      method: 'POST', url: '/api/auth/verify',
      headers: { 'x-test-bypass': 'true' },
      payload: { walletAddress: kp.publicKey(), signature: sig, deviceId: 'dev-2' },
    });
    const { accessToken: jwt } = vRes.json() as { accessToken: string };

    const res = await app.inject({
      method: 'GET',
      // account:read is NOT in the client's allowedScopes
      url: `/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=account%3Aread&code_challenge=${challenge}&code_challenge_method=S256`,
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect([301, 302]).toContain(res.statusCode);
    const loc = new URL(res.headers['location'] as string);
    expect(loc.searchParams.get('error')).toBe('invalid_scope');
  });
});

// ---------------------------------------------------------------------------
// POST /api/oauth2/token
// ---------------------------------------------------------------------------

describe('POST /api/oauth2/token — authorization_code grant', () => {
  it('issues access + refresh tokens with correct shape', async () => {
    if (!redisAvailable || !app) return;
    const clientId = await registerClient('Token Test Client A');
    const tokens = await fullFlow(clientId, 'billing:read');

    expect(tokens.accessToken).toMatch(/^oat_[0-9a-f]{64}$/);
    expect(tokens.refreshToken).toMatch(/^ort_[0-9a-f]{64}$/);
    expect(tokens.scope).toBe('billing:read');
  });

  it('rejects replay of the same auth code', async () => {
    if (!redisAvailable || !app) return;
    const clientId = await registerClient('Token Test Client B');

    const kp = Keypair.random();
    const cRes = await app.inject({
      method: 'POST', url: '/api/auth/challenge',
      payload: { walletAddress: kp.publicKey() },
    });
    const { nonce } = cRes.json() as { nonce: string };
    const sig = kp.sign(Buffer.from(nonce, 'hex')).toString('hex');
    const vRes = await app.inject({
      method: 'POST', url: '/api/auth/verify',
      headers: { 'x-test-bypass': 'true' },
      payload: { walletAddress: kp.publicKey(), signature: sig, deviceId: 'dev-3' },
    });
    const { accessToken: jwt } = vRes.json() as { accessToken: string };

    const { verifier, challenge } = makePkce();
    const authRes = await app.inject({
      method: 'GET',
      url: `/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=billing%3Aread&code_challenge=${challenge}&code_challenge_method=S256`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    const code = new URL(authRes.headers['location'] as string).searchParams.get('code')!;

    const payload = {
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    };

    const first = await app.inject({
      method: 'POST', url: '/api/oauth2/token',
      headers: { 'x-test-bypass': 'true' }, payload,
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST', url: '/api/oauth2/token',
      headers: { 'x-test-bypass': 'true' }, payload,
    });
    expect(second.statusCode).toBe(400);
    expect((second.json() as Record<string, unknown>)['error']).toBe('invalid_grant');
  });

  it('rejects wrong code_verifier (PKCE failure)', async () => {
    if (!redisAvailable || !app) return;
    const clientId = await registerClient('Token Test Client C');

    const kp = Keypair.random();
    const cRes = await app.inject({
      method: 'POST', url: '/api/auth/challenge',
      payload: { walletAddress: kp.publicKey() },
    });
    const { nonce } = cRes.json() as { nonce: string };
    const sig = kp.sign(Buffer.from(nonce, 'hex')).toString('hex');
    const vRes = await app.inject({
      method: 'POST', url: '/api/auth/verify',
      headers: { 'x-test-bypass': 'true' },
      payload: { walletAddress: kp.publicKey(), signature: sig, deviceId: 'dev-4' },
    });
    const { accessToken: jwt } = vRes.json() as { accessToken: string };

    const { challenge } = makePkce();
    const authRes = await app.inject({
      method: 'GET',
      url: `/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=billing%3Aread&code_challenge=${challenge}&code_challenge_method=S256`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    const code = new URL(authRes.headers['location'] as string).searchParams.get('code')!;

    const res = await app.inject({
      method: 'POST', url: '/api/oauth2/token',
      headers: { 'x-test-bypass': 'true' },
      payload: {
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: 'wrong-verifier-that-is-long-enough-to-look-valid-xxxxx',
      },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as Record<string, unknown>)['error']).toBe('invalid_grant');
  });

  it('returns 400 for unsupported grant_type', async () => {
    if (!redisAvailable || !app) return;
    const clientId = await registerClient('Token Test Client D');
    const res = await app.inject({
      method: 'POST', url: '/api/oauth2/token',
      headers: { 'x-test-bypass': 'true' },
      payload: { grant_type: 'client_credentials', client_id: clientId },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as Record<string, unknown>)['error']).toBe('unsupported_grant_type');
  });
});

describe('POST /api/oauth2/token — refresh_token grant', () => {
  it('rotates the refresh token and issues a new access token', async () => {
    if (!redisAvailable || !app) return;
    const clientId = await registerClient('Refresh Test Client A');
    const original = await fullFlow(clientId);

    const res = await app.inject({
      method: 'POST', url: '/api/oauth2/token',
      headers: { 'x-test-bypass': 'true' },
      payload: {
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: original.refreshToken,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { access_token: string; refresh_token: string };
    expect(body.access_token).not.toBe(original.accessToken);
    expect(body.refresh_token).not.toBe(original.refreshToken);
  });

  it('rejects replay of an already-rotated refresh token', async () => {
    if (!redisAvailable || !app) return;
    const clientId = await registerClient('Refresh Test Client B');
    const original = await fullFlow(clientId);

    await app.inject({
      method: 'POST', url: '/api/oauth2/token',
      headers: { 'x-test-bypass': 'true' },
      payload: { grant_type: 'refresh_token', client_id: clientId, refresh_token: original.refreshToken },
    });

    const replay = await app.inject({
      method: 'POST', url: '/api/oauth2/token',
      headers: { 'x-test-bypass': 'true' },
      payload: { grant_type: 'refresh_token', client_id: clientId, refresh_token: original.refreshToken },
    });
    expect(replay.statusCode).toBe(400);
    expect((replay.json() as Record<string, unknown>)['error']).toBe('invalid_grant');
  });
});

// ---------------------------------------------------------------------------
// POST /api/oauth2/revoke
// ---------------------------------------------------------------------------

describe('POST /api/oauth2/revoke', () => {
  it('returns 200 for a valid access token and makes it inactive', async () => {
    if (!redisAvailable || !app) return;
    const clientId = await registerClient('Revoke Test Client A');
    const { accessToken } = await fullFlow(clientId);

    const revokeRes = await app.inject({
      method: 'POST', url: '/api/oauth2/revoke',
      payload: { token: accessToken, client_id: clientId },
    });
    expect(revokeRes.statusCode).toBe(200);

    // Introspect should now return active:false
    const introRes = await app.inject({
      method: 'POST', url: '/api/oauth2/introspect',
      headers: { 'x-admin-key': ADMIN_KEY },
      payload: { token: accessToken },
    });
    expect((introRes.json() as { active: boolean }).active).toBe(false);
  });

  it('returns 200 even for an unknown/garbage token (RFC 7009)', async () => {
    if (!redisAvailable || !app) return;
    const clientId = await registerClient('Revoke Test Client B');
    const res = await app.inject({
      method: 'POST', url: '/api/oauth2/revoke',
      payload: { token: 'oat_' + '0'.repeat(64), client_id: clientId },
    });
    expect(res.statusCode).toBe(200);
  });

  it('is idempotent — second revocation also returns 200', async () => {
    if (!redisAvailable || !app) return;
    const clientId = await registerClient('Revoke Test Client C');
    const { accessToken } = await fullFlow(clientId);
    await app.inject({
      method: 'POST', url: '/api/oauth2/revoke',
      payload: { token: accessToken, client_id: clientId },
    });
    const second = await app.inject({
      method: 'POST', url: '/api/oauth2/revoke',
      payload: { token: accessToken, client_id: clientId },
    });
    expect(second.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST /api/oauth2/introspect
// ---------------------------------------------------------------------------

describe('POST /api/oauth2/introspect', () => {
  it('returns active:true with metadata for a valid access token', async () => {
    if (!redisAvailable || !app) return;
    const clientId = await registerClient('Introspect Test Client A');
    const { accessToken } = await fullFlow(clientId, 'billing:read');

    const res = await app.inject({
      method: 'POST', url: '/api/oauth2/introspect',
      headers: { 'x-admin-key': ADMIN_KEY },
      payload: { token: accessToken },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['active']).toBe(true);
    expect(body['scope']).toBe('billing:read');
    expect(body['clientId']).toBe(clientId);
    expect(typeof body['sub']).toBe('string');
    expect(typeof body['exp']).toBe('number');
  });

  it('returns active:false for an unknown token', async () => {
    if (!redisAvailable || !app) return;
    const res = await app.inject({
      method: 'POST', url: '/api/oauth2/introspect',
      headers: { 'x-admin-key': ADMIN_KEY },
      payload: { token: 'oat_' + 'f'.repeat(64) },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { active: boolean }).active).toBe(false);
  });

  it('returns 401 without admin key', async () => {
    if (!redisAvailable || !app) return;
    const res = await app.inject({
      method: 'POST', url: '/api/oauth2/introspect',
      payload: { token: 'oat_' + '0'.repeat(64) },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Security: response headers on token endpoint (RFC 6749 §5.1)
// ---------------------------------------------------------------------------

describe('Token endpoint security headers', () => {
  it('sets Cache-Control: no-store on the token response', async () => {
    if (!redisAvailable || !app) return;
    const clientId = await registerClient('Header Test Client');
    const kp = Keypair.random();
    const cRes = await app.inject({
      method: 'POST', url: '/api/auth/challenge',
      payload: { walletAddress: kp.publicKey() },
    });
    const { nonce } = cRes.json() as { nonce: string };
    const sig = kp.sign(Buffer.from(nonce, 'hex')).toString('hex');
    const vRes = await app.inject({
      method: 'POST', url: '/api/auth/verify',
      headers: { 'x-test-bypass': 'true' },
      payload: { walletAddress: kp.publicKey(), signature: sig, deviceId: 'dev-hdr' },
    });
    const { accessToken: jwt } = vRes.json() as { accessToken: string };

    const { verifier, challenge } = makePkce();
    const authRes = await app.inject({
      method: 'GET',
      url: `/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=billing%3Aread&code_challenge=${challenge}&code_challenge_method=S256`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    const code = new URL(authRes.headers['location'] as string).searchParams.get('code')!;

    const tokenRes = await app.inject({
      method: 'POST', url: '/api/oauth2/token',
      headers: { 'x-test-bypass': 'true' },
      payload: {
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      },
    });

    expect(tokenRes.headers['cache-control']).toBe('no-store');
    expect(tokenRes.headers['x-content-type-options']).toBe('nosniff');
  });
});
