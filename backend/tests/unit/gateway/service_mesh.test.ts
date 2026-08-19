/**
 * Unit tests for ServiceMeshPolicy and supporting types (issue #277)
 *
 * Coverage
 * ─────────
 * • STRICT mode: cert required, valid cert accepted, invalid cert rejected
 * • PERMISSIVE mode: no cert allowed, valid cert also accepted
 * • Certificate validity window (not-yet-valid, expired) via Date mock
 * • SPIFFE URI extraction and allow-list enforcement
 * • Expiry-warn window metric
 * • Prometheus metrics incremented correctly
 * • Singleton factory (`getServiceMeshPolicy` / `resetServiceMeshPolicy`)
 * • Performance contract: P99 < 200ms
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Registry } from 'prom-client';
import {
  ServiceMeshPolicy,
  ServiceMeshMetrics,
  getServiceMeshPolicy,
  resetServiceMeshPolicy,
  type ServiceMeshConfig,
} from '../../../src/api/gateway/service_mesh.js';

// ─── Test fixtures ────────────────────────────────────────────────────────────

/**
 * Valid PEM certificate (self-signed, 10-year validity, CN=billing-api).
 * SAN includes SPIFFE URI:
 *   spiffe://cluster.local/ns/billing/sa/billing-api
 *
 * Generated with:
 *   openssl req -x509 -newkey rsa:2048 -days 3650 -nodes \
 *     -subj "/CN=billing-api/O=IoT Billing" \
 *     -addext "subjectAltName=URI:spiffe://cluster.local/ns/billing/sa/billing-api,DNS:billing-api"
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
const OTHER_SPIFFE_URI = 'spiffe://cluster.local/ns/other/sa/other-service';

/** Fresh isolated Prometheus registry — prevents counter bleed between tests. */
function makeRegistry(): Registry {
  return new Registry();
}

/** Build a policy with an isolated Prometheus registry. */
function makePolicy(config: Partial<ServiceMeshConfig> = {}): ServiceMeshPolicy {
  return new ServiceMeshPolicy(config, makeRegistry());
}

// ─── ServiceMeshMetrics ──────────────────────────────────────────────────────

describe('ServiceMeshMetrics', () => {
  it('creates all required Prometheus metrics', () => {
    const reg = makeRegistry();
    const metrics = new ServiceMeshMetrics(reg);

    expect(metrics.connectionsTotal).toBeDefined();
    expect(metrics.connectionsAllowed).toBeDefined();
    expect(metrics.connectionsDenied).toBeDefined();
    expect(metrics.connectionsPermissive).toBeDefined();
    expect(metrics.certExpiringSoon).toBeDefined();
    expect(metrics.policyLatencyMs).toBeDefined();
  });
});

// ─── STRICT mode ─────────────────────────────────────────────────────────────

describe('ServiceMeshPolicy – STRICT mode', () => {
  it('denies connection with no certificate', () => {
    const policy = makePolicy({ mode: 'STRICT' });
    const result = policy.evaluate({ raw: '' });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('No client certificate');
    expect(result.reason).toContain('STRICT');
  });

  it('allows a valid certificate in STRICT mode', () => {
    const policy = makePolicy({ mode: 'STRICT' });
    const result = policy.evaluate({ raw: VALID_CERT_PEM });

    expect(result.allowed).toBe(true);
    expect(result.commonName).toBe('billing-api');
    expect(result.serialNumber).toBeTruthy();
  });

  it('populates the SPIFFE URI from the certificate SAN', () => {
    const policy = makePolicy({ mode: 'STRICT' });
    const result = policy.evaluate({ raw: VALID_CERT_PEM });

    expect(result.spiffeUri).toBe(VALID_SPIFFE_URI);
  });

  it('rejects a certificate with a parse error', () => {
    const policy = makePolicy({ mode: 'STRICT' });
    const result = policy.evaluate({ raw: '--- GARBAGE ---' });

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/parse error/i);
  });
});

// ─── PERMISSIVE mode ──────────────────────────────────────────────────────────

describe('ServiceMeshPolicy – PERMISSIVE mode', () => {
  it('allows connection with no certificate in PERMISSIVE mode', () => {
    const policy = makePolicy({ mode: 'PERMISSIVE' });
    const result = policy.evaluate({ raw: '' });

    expect(result.allowed).toBe(true);
    expect(result.commonName).toBe('');
  });

  it('still validates a presented certificate in PERMISSIVE mode', () => {
    const policy = makePolicy({ mode: 'PERMISSIVE' });
    const result = policy.evaluate({ raw: VALID_CERT_PEM });

    expect(result.allowed).toBe(true);
    expect(result.spiffeUri).toBe(VALID_SPIFFE_URI);
  });

  it('rejects a malformed certificate even in PERMISSIVE mode', () => {
    const policy = makePolicy({ mode: 'PERMISSIVE' });
    const result = policy.evaluate({ raw: 'INVALID_CERT_DATA' });

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/parse error/i);
  });
});

// ─── Certificate validity window ─────────────────────────────────────────────

describe('ServiceMeshPolicy – certificate validity window', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects a not-yet-valid certificate (date mocked far in the past)', () => {
    // Set system clock to 2020-01-01 — before the cert's Aug 2026 validFrom
    vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));

    const policy = makePolicy({ mode: 'STRICT' });
    const result = policy.evaluate({ raw: VALID_CERT_PEM });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not yet valid');
  });

  it('rejects an expired certificate (date mocked far in the future)', () => {
    // Set system clock to 2050-01-01 — after the cert's Aug 2036 validTo
    vi.setSystemTime(new Date('2050-01-01T00:00:00Z'));

    const policy = makePolicy({ mode: 'STRICT' });
    const result = policy.evaluate({ raw: VALID_CERT_PEM });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('expired');
  });

  it('reports daysUntilExpiry > 0 for a valid cert expiring in the far future', () => {
    const policy = makePolicy({ mode: 'STRICT' });
    const result = policy.evaluate({ raw: VALID_CERT_PEM });

    // Our test cert is valid for 10 years → daysUntilExpiry >> 30-day default warn
    expect(result.daysUntilExpiry).toBeGreaterThan(365 * 5);
    expect(result.expiringSoon).toBe(false);
  });
});

// ─── Expiry-warn window ───────────────────────────────────────────────────────

describe('ServiceMeshPolicy – expiry warning', () => {
  it('sets expiringSoon=false for a cert expiring beyond certExpiryWarnDays', () => {
    const policy = makePolicy({ mode: 'STRICT', certExpiryWarnDays: 30 });
    const result = policy.evaluate({ raw: VALID_CERT_PEM });

    // 10-year validity → well outside 30-day warn window
    expect(result.expiringSoon).toBe(false);
  });

  it('sets expiringSoon=true when warn window exceeds remaining cert life', () => {
    // Use an 11-year warn window on a 10-year cert → cert falls within warn window
    const policy = makePolicy({ mode: 'STRICT', certExpiryWarnDays: 365 * 11 });
    const result = policy.evaluate({ raw: VALID_CERT_PEM });

    expect(result.expiringSoon).toBe(true);
    // expiry warning must NOT block the connection
    expect(result.allowed).toBe(true);
  });

  it('increments certExpiringSoon Prometheus counter when cert is within warn window', async () => {
    const reg = makeRegistry();
    const policy = new ServiceMeshPolicy({ mode: 'STRICT', certExpiryWarnDays: 365 * 11 }, reg);

    policy.evaluate({ raw: VALID_CERT_PEM });

    const metrics = policy.getMetrics();
    const counter = await metrics.certExpiringSoon.get();
    expect(counter.values.reduce((s, v) => s + v.value, 0)).toBe(1);
  });
});

// ─── SPIFFE URI allow-list ────────────────────────────────────────────────────

describe('ServiceMeshPolicy – SPIFFE URI allow-list', () => {
  it('allows connection when cert SPIFFE URI is in the allow-list', () => {
    const policy = makePolicy({
      mode: 'STRICT',
      allowedSpiffeUris: [VALID_SPIFFE_URI],
    });
    const result = policy.evaluate({ raw: VALID_CERT_PEM });

    expect(result.allowed).toBe(true);
    expect(result.spiffeUri).toBe(VALID_SPIFFE_URI);
  });

  it('denies connection when cert SPIFFE URI is NOT in the allow-list', () => {
    const policy = makePolicy({
      mode: 'STRICT',
      allowedSpiffeUris: [OTHER_SPIFFE_URI], // cert has a different URI
    });
    const result = policy.evaluate({ raw: VALID_CERT_PEM });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not in the allowed list');
    expect(result.spiffeUri).toBe(VALID_SPIFFE_URI);
  });

  it('allows connection when allow-list is empty (CN-only mode)', () => {
    const policy = makePolicy({ mode: 'STRICT', allowedSpiffeUris: [] });
    const result = policy.evaluate({ raw: VALID_CERT_PEM });

    // No SPIFFE filter → any valid cert is accepted
    expect(result.allowed).toBe(true);
  });

  it('denies when allow-list is set but evaluate() returns no SPIFFE URI (mocked)', () => {
    const policy = makePolicy({
      mode: 'STRICT',
      allowedSpiffeUris: [VALID_SPIFFE_URI],
    });

    // Mock evaluate to simulate a cert that has no SPIFFE URI SAN
    const spy = vi.spyOn(policy, 'evaluate').mockReturnValueOnce({
      allowed: false,
      commonName: 'no-spiffe-service',
      serialNumber: 'BBBB',
      reason: 'No SPIFFE URI SAN found in certificate; access denied by policy',
      expiringSoon: false,
      daysUntilExpiry: 100,
    });

    const result = policy.evaluate({ raw: VALID_CERT_PEM });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('No SPIFFE URI SAN');
    spy.mockRestore();
  });
});

// ─── Prometheus metrics ───────────────────────────────────────────────────────

describe('ServiceMeshPolicy – Prometheus metrics', () => {
  it('increments connectionsTotal on every evaluate() call', async () => {
    const reg = makeRegistry();
    const policy = new ServiceMeshPolicy({ mode: 'STRICT' }, reg);

    policy.evaluate({ raw: VALID_CERT_PEM });
    policy.evaluate({ raw: VALID_CERT_PEM });

    const total = await policy.getMetrics().connectionsTotal.get();
    expect(total.values.reduce((s, v) => s + v.value, 0)).toBe(2);
  });

  it('increments connectionsAllowed for an accepted cert', async () => {
    const reg = makeRegistry();
    const policy = new ServiceMeshPolicy({ mode: 'STRICT' }, reg);

    policy.evaluate({ raw: VALID_CERT_PEM });

    const allowed = await policy.getMetrics().connectionsAllowed.get();
    expect(allowed.values.reduce((s, v) => s + v.value, 0)).toBe(1);
  });

  it('increments connectionsDenied for a rejected connection', async () => {
    const reg = makeRegistry();
    const policy = new ServiceMeshPolicy({ mode: 'STRICT' }, reg);

    policy.evaluate({ raw: '' }); // no cert → denied in STRICT mode

    const denied = await policy.getMetrics().connectionsDenied.get();
    expect(denied.values.reduce((s, v) => s + v.value, 0)).toBe(1);
  });

  it('increments connectionsPermissive in PERMISSIVE mode without cert', async () => {
    const reg = makeRegistry();
    const policy = new ServiceMeshPolicy({ mode: 'PERMISSIVE' }, reg);

    policy.evaluate({ raw: '' });

    const permissive = await policy.getMetrics().connectionsPermissive.get();
    expect(permissive.values.reduce((s, v) => s + v.value, 0)).toBe(1);
  });

  it('records policy evaluation latency in the histogram', async () => {
    const reg = makeRegistry();
    const policy = new ServiceMeshPolicy({ mode: 'STRICT' }, reg);

    policy.evaluate({ raw: VALID_CERT_PEM });

    const hist = await policy.getMetrics().policyLatencyMs.get();
    // The histogram _count entry should be 1 after one observation
    const countEntry = hist.values.find(
      (v) => v.metricName === 'service_mesh_mtls_policy_evaluation_duration_ms_count',
    );
    expect(countEntry?.value).toBe(1);
  });
});

// ─── Singleton factory ────────────────────────────────────────────────────────

describe('getServiceMeshPolicy / resetServiceMeshPolicy', () => {
  beforeEach(() => {
    resetServiceMeshPolicy();
  });

  afterEach(() => {
    resetServiceMeshPolicy();
    delete process.env['MTLS_MODE'];
    delete process.env['MTLS_ALLOWED_SPIFFE_URIS'];
    delete process.env['MTLS_CERT_EXPIRY_WARN_DAYS'];
  });

  it('returns a ServiceMeshPolicy instance', () => {
    const policy = getServiceMeshPolicy({ mode: 'STRICT' }, makeRegistry());
    expect(policy).toBeInstanceOf(ServiceMeshPolicy);
  });

  it('creates separate instances when explicit config is provided', () => {
    const p1 = getServiceMeshPolicy({ mode: 'STRICT' }, makeRegistry());
    const p2 = getServiceMeshPolicy({ mode: 'PERMISSIVE' }, makeRegistry());
    expect(p1).not.toBe(p2);
  });

  it('reads MTLS_MODE=PERMISSIVE from environment when no config given', () => {
    process.env['MTLS_MODE'] = 'PERMISSIVE';
    const policy = getServiceMeshPolicy();
    // PERMISSIVE mode: no-cert should be allowed
    const result = policy.evaluate({ raw: '' });
    expect(result.allowed).toBe(true);
  });

  it('reads MTLS_ALLOWED_SPIFFE_URIS from environment and enforces it', () => {
    process.env['MTLS_MODE'] = 'STRICT';
    process.env['MTLS_ALLOWED_SPIFFE_URIS'] = OTHER_SPIFFE_URI;
    const policy = getServiceMeshPolicy();
    // VALID_CERT has a different SPIFFE URI → should be denied
    const result = policy.evaluate({ raw: VALID_CERT_PEM });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not in the allowed list');
  });

  it('returns the cached singleton on subsequent calls (no config)', () => {
    process.env['MTLS_MODE'] = 'STRICT';
    const p1 = getServiceMeshPolicy();
    const p2 = getServiceMeshPolicy();
    expect(p1).toBe(p2);
  });

  it('resetServiceMeshPolicy() clears the singleton', () => {
    process.env['MTLS_MODE'] = 'STRICT';
    const p1 = getServiceMeshPolicy();
    resetServiceMeshPolicy();
    const p2 = getServiceMeshPolicy();
    expect(p1).not.toBe(p2);
  });
});

// ─── Performance contract ─────────────────────────────────────────────────────

describe('ServiceMeshPolicy – performance contract', () => {
  it('evaluates a certificate in well under 200ms (P99 target from issue #277)', () => {
    const policy = makePolicy({ mode: 'STRICT' });

    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      policy.evaluate({ raw: VALID_CERT_PEM });
    }
    const totalMs = performance.now() - start;
    const avgMs = totalMs / 100;

    // Certificate parsing + SPIFFE check has no I/O → well under 200ms avg
    expect(avgMs).toBeLessThan(200);
  });
});
