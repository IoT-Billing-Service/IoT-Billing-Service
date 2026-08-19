/**
 * Unit tests for the service mesh mTLS Fastify middleware (issue #277)
 *
 * Coverage
 * ─────────
 * • XFCC header extraction and cert evaluation
 * • TLS socket cert fallback
 * • Policy denial → 401 response
 * • Policy success → request.meshIdentity populated
 * • X-Mesh-Spiffe-Uri response header set on success
 * • `registerServiceMeshMiddleware` global hook
 * • PERMISSIVE mode with no cert passes through
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Registry } from 'prom-client';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import {
  buildServiceMeshPreHandler,
  registerServiceMeshMiddleware,
} from '../../../src/api/middleware/service_mesh_middleware.js';
import { resetServiceMeshPolicy } from '../../../src/api/gateway/service_mesh.js';

// ─── Test constants ───────────────────────────────────────────────────────────

/**
 * Valid PEM certificate with SPIFFE URI SAN.
 * Same cert used in service_mesh.test.ts.
 */
const VALID_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDhTCCAm2gAwIBAgIUZhgXd/Crc3ADw5s1+jZstX9HI3YwDQYJKoZIhvcNAQEL
BQAwLDEUMBIGA1UEAwwLYmlsbGluZy1hcGkxFDASBgNVBAoMC0lvVCBCaWxsaW5n
MB4XDTI2MDgxOTA2NTIxNFoXDTM2MDgxNjA2NTIxNFowLDEUMBIGA1UEAwwLYmls
bGluZy1hcGkxFDASBgNVBAoMC0lvVCBCaWxsaW5nMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAwVSMtUVbM5QaJi6zRzQjE+kcruVp7UGN8WHTirvGkRQ3
LVY16/8K2b8xzAOoa2Qu6Bwk3mgEJzSo9okg9aHE3zaWOsgxgXueeJNnclhczv4X
m8SN90ljWkppEL06pDLWlTPfbqC9HIIqtcNp8Lw6Xrw9iscRL4j9hfQrYwMMDyO8
4aoXVR18Ue+BzP+BwmMAvRkeqqSQOHNEXyA9q6uFY25Smtt2dhZKmHnYHgJoCDS1
9IO4OBmBs4Xu1pZoca+sPRJgMwTkE9KKjTBmMHKpSElLK0XoxLfKYrSFwsEOhXs8
PwV96tX2sWTYHOySOnp1/IQcbzkZYZc/T26DNhbMqwIDAQABo4GeMIGbMB0GA1Ud
DgQWBBRxEq22FEqcUVdSBLsNXqQyuUg/1jAfBgNVHSMEGDAWgBRxEq22FEqcUVdS
BLsNXqQyuUg/1jAPBgNVHRMBAf8EBTADAQH/MEgGA1UdEQRBMD+GMHNwaWZmZTov
L2NsdXN0ZXIubG9jYWwvbnMvYmlsbGluZy9zYS9iaWxsaW5nLWFwaYILYmlsbGlu
Zy1hcGkwDQYJKoZIhvcNAQELBQADggEBAGML/rULpbMPYbPXrLhp2EHFl5BAoD1a
p4eXsJuEo/VmzyPVjapzR2jOtQ9Um64BTlDTCpkF7b46gHG0EcqJ6uMUMwwvrEzh
MfYQNLV7ZaddQoXML0hdI62ed4dxB9s7vTkDFJ8DTVaooOpqB/WjTXFYJO93ZePR
s0F9eGPcsTS6yuRr37lRPCyiLv8DGANR5MRhwYEoSIC57Q2NW7nVdp8eZMZy4SUm
sjiUjBpMscIWVCkSlmBMYot1x7KlOUP1SL2/wiF5NXx8b8MczqgsukPq+tQvF20k
/PK0ilIBg1mP7vBm3qHecQC7i8uF2g34X2OFiCAASjohjLLkgBt3p20=
-----END CERTIFICATE-----`;

const VALID_SPIFFE_URI = 'spiffe://cluster.local/ns/billing/sa/billing-api';

// URL-encoded PEM for XFCC header
const VALID_CERT_XFCC_ENCODED = encodeURIComponent(VALID_CERT_PEM);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildTestApp(options?: Parameters<typeof buildServiceMeshPreHandler>[0]): FastifyInstance {
  const app = Fastify({ logger: false });
  const reg = new Registry();
  const preHandler = buildServiceMeshPreHandler({ ...(options ?? {}), registry: reg });
  app.addHook('preHandler', preHandler);
  app.get('/test', (request, _reply) => {
    return { identity: request.meshIdentity };
  });
  return app;
}

function buildRegisteredApp(
  options?: Parameters<typeof registerServiceMeshMiddleware>[1],
): FastifyInstance {
  const app = Fastify({ logger: false });
  const reg = new Registry();
  registerServiceMeshMiddleware(app, { ...(options ?? {}), registry: reg });
  app.get('/test', (request, _reply) => {
    return { identity: request.meshIdentity };
  });
  return app;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('buildServiceMeshPreHandler', () => {
  afterEach(() => {
    resetServiceMeshPolicy();
  });

  describe('STRICT mode – no cert', () => {
    it('returns 401 when no cert is provided and no XFCC header', async () => {
      const app = buildTestApp({ policy: { mode: 'STRICT', allowedSpiffeUris: [] } });
      const res = await app.inject({ method: 'GET', url: '/test' });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body) as { error: string; code: string };
      expect(body.error).toBe('Unauthorized');
      expect(body.code).toBe('MTLS_POLICY_DENIED');
    });
  });

  describe('PERMISSIVE mode – no cert', () => {
    it('returns 200 when no cert is provided in PERMISSIVE mode', async () => {
      const app = buildTestApp({ policy: { mode: 'PERMISSIVE', allowedSpiffeUris: [] } });
      const res = await app.inject({ method: 'GET', url: '/test' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { identity: { allowed: boolean } };
      expect(body.identity.allowed).toBe(true);
    });
  });

  describe('XFCC header (Envoy/Istio sidecar TLS termination)', () => {
    it('extracts cert from quoted XFCC Cert= field and allows valid cert', async () => {
      const app = buildTestApp({
        policy: { mode: 'STRICT', allowedSpiffeUris: [] },
        trustXfccHeader: true,
      });
      const xfcc = `By=spiffe://cluster.local/ns/billing/sa/billing-api,Hash=abc123,Cert="${VALID_CERT_XFCC_ENCODED}"`;

      const res = await app.inject({
        method: 'GET',
        url: '/test',
        headers: { 'x-forwarded-client-cert': xfcc },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { identity: { allowed: boolean; commonName: string } };
      expect(body.identity.allowed).toBe(true);
      expect(body.identity.commonName).toBe('billing-api');
    });

    it('attaches SPIFFE URI to X-Mesh-Spiffe-Uri response header', async () => {
      const app = buildTestApp({
        policy: { mode: 'STRICT', allowedSpiffeUris: [] },
        trustXfccHeader: true,
      });
      const xfcc = `By=spiffe://cluster.local/ns/billing/sa/billing-api,Hash=abc123,Cert="${VALID_CERT_XFCC_ENCODED}"`;

      const res = await app.inject({
        method: 'GET',
        url: '/test',
        headers: { 'x-forwarded-client-cert': xfcc },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['x-mesh-spiffe-uri']).toBe(VALID_SPIFFE_URI);
    });

    it('ignores XFCC header when trustXfccHeader=false', async () => {
      const app = buildTestApp({
        policy: { mode: 'STRICT', allowedSpiffeUris: [] },
        trustXfccHeader: false,
      });
      const xfcc = `By=spiffe://...,Hash=abc123,Cert="${VALID_CERT_XFCC_ENCODED}"`;

      const res = await app.inject({
        method: 'GET',
        url: '/test',
        headers: { 'x-forwarded-client-cert': xfcc },
      });

      // Without XFCC trust and no TLS socket cert, STRICT mode should deny
      expect(res.statusCode).toBe(401);
    });

    it('denies when XFCC header is present but contains invalid cert data', async () => {
      const app = buildTestApp({
        policy: { mode: 'STRICT', allowedSpiffeUris: [] },
        trustXfccHeader: true,
      });
      const xfcc = `By=spiffe://...,Hash=abc123,Cert="JUNK_CERT_DATA"`;

      const res = await app.inject({
        method: 'GET',
        url: '/test',
        headers: { 'x-forwarded-client-cert': xfcc },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('SPIFFE URI allow-list enforcement', () => {
    it('allows cert when SPIFFE URI matches allow-list', async () => {
      const app = buildTestApp({
        policy: { mode: 'STRICT', allowedSpiffeUris: [VALID_SPIFFE_URI] },
        trustXfccHeader: true,
      });
      const xfcc = `By=spiffe://...,Hash=abc123,Cert="${VALID_CERT_XFCC_ENCODED}"`;

      const res = await app.inject({
        method: 'GET',
        url: '/test',
        headers: { 'x-forwarded-client-cert': xfcc },
      });

      expect(res.statusCode).toBe(200);
    });

    it('rejects cert when SPIFFE URI is not in allow-list', async () => {
      const app = buildTestApp({
        policy: {
          mode: 'STRICT',
          allowedSpiffeUris: ['spiffe://cluster.local/ns/other/sa/other-service'],
        },
        trustXfccHeader: true,
      });
      const xfcc = `By=spiffe://...,Hash=abc123,Cert="${VALID_CERT_XFCC_ENCODED}"`;

      const res = await app.inject({
        method: 'GET',
        url: '/test',
        headers: { 'x-forwarded-client-cert': xfcc },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body) as { message: string };
      expect(body.message).toContain('not in the allowed list');
    });
  });

  describe('meshIdentity request property', () => {
    it('populates request.meshIdentity with policy result on allowed connection', async () => {
      const app = buildTestApp({ policy: { mode: 'PERMISSIVE', allowedSpiffeUris: [] } });
      const res = await app.inject({ method: 'GET', url: '/test' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        identity: { allowed: boolean; commonName: string; expiringSoon: boolean };
      };
      expect(body.identity).toBeDefined();
      expect(typeof body.identity.allowed).toBe('boolean');
    });

    it('populates commonName and serialNumber for cert-authenticated requests', async () => {
      const app = buildTestApp({
        policy: { mode: 'STRICT', allowedSpiffeUris: [] },
        trustXfccHeader: true,
      });
      const xfcc = `Cert="${VALID_CERT_XFCC_ENCODED}"`;

      const res = await app.inject({
        method: 'GET',
        url: '/test',
        headers: { 'x-forwarded-client-cert': xfcc },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        identity: { commonName: string; serialNumber: string; spiffeUri: string };
      };
      expect(body.identity.commonName).toBe('billing-api');
      expect(body.identity.serialNumber).toBeTruthy();
      expect(body.identity.spiffeUri).toBe(VALID_SPIFFE_URI);
    });
  });
});

describe('registerServiceMeshMiddleware', () => {
  afterEach(() => {
    resetServiceMeshPolicy();
  });

  it('registers a global preHandler hook on the Fastify instance', async () => {
    const app = buildRegisteredApp({ policy: { mode: 'STRICT', allowedSpiffeUris: [] } });
    // No cert → 401 due to global hook
    const res = await app.inject({ method: 'GET', url: '/test' });
    expect(res.statusCode).toBe(401);
  });

  it('allows all routes through when mode is PERMISSIVE', async () => {
    const app = buildRegisteredApp({ policy: { mode: 'PERMISSIVE', allowedSpiffeUris: [] } });
    const res = await app.inject({ method: 'GET', url: '/test' });
    expect(res.statusCode).toBe(200);
  });
});

describe('XFCC header parsing edge cases', () => {
  afterEach(() => {
    resetServiceMeshPolicy();
  });

  it('handles XFCC with Cert field as first entry', async () => {
    const app = buildTestApp({
      policy: { mode: 'STRICT', allowedSpiffeUris: [] },
      trustXfccHeader: true,
    });
    const xfcc = `Cert="${VALID_CERT_XFCC_ENCODED}",By=spiffe://...`;

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { 'x-forwarded-client-cert': xfcc },
    });

    expect(res.statusCode).toBe(200);
  });

  it('handles XFCC with only Cert= field (minimal format)', async () => {
    const app = buildTestApp({
      policy: { mode: 'STRICT', allowedSpiffeUris: [] },
      trustXfccHeader: true,
    });
    const xfcc = `Cert="${VALID_CERT_XFCC_ENCODED}"`;

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { 'x-forwarded-client-cert': xfcc },
    });

    expect(res.statusCode).toBe(200);
  });

  it('falls back to deny when XFCC Cert= field is malformed', async () => {
    const app = buildTestApp({
      policy: { mode: 'STRICT', allowedSpiffeUris: [] },
      trustXfccHeader: true,
    });
    const xfcc = 'By=spiffe://...,Hash=abc123'; // No Cert= field

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { 'x-forwarded-client-cert': xfcc },
    });

    expect(res.statusCode).toBe(401);
  });
});
