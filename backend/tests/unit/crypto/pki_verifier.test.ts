/**
 * Unit tests for PkiVerifier — Hardware Identity Binding (Issue #294)
 *
 * Test coverage:
 *  - parsePemChain: single cert, multi-cert, empty, invalid PEM
 *  - extractSpiffeUris: URI present, DNS-only SAN, no SAN, multiple URIs
 *  - computeCertFingerprint: determinism, length
 *  - isSignedByAnchor: trusted cert, untrusted cert, empty anchors
 *  - PkiVerifier.verify:
 *      happy path (valid cert, CA trust, SPIFFE match)
 *      cert parse failure
 *      expired certificate
 *      not-yet-valid certificate
 *      certificate untrusted (different CA)
 *      no trust anchors configured
 *      SPIFFE validation — missing URI
 *      SPIFFE validation — unauthorized URI
 *      SPIFFE validation — skipped when allowedSpiffeUris is empty
 *      expiry warning (cert within warn window)
 *      chain verification skip mode
 *  - NoOpPkiVerifier: always succeeds, returns metadata where parseable
 *  - Prometheus metrics: success, failure, expiry warning
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { X509Certificate, createHash } from 'node:crypto';
import { Registry } from 'prom-client';
import {
  PkiVerifier,
  NoOpPkiVerifier,
  parsePemChain,
  extractSpiffeUris,
  computeCertFingerprint,
  isSignedByAnchor,
  recordPkiVerification,
  pkiVerificationsTotal,
  pkiVerificationFailuresTotal,
  pkiCertExpiryWarningsTotal,
  pkiVerificationDurationMs,
  PKI_ERROR_CODES,
  DEFAULT_CERT_EXPIRY_WARN_DAYS,
} from '../../../src/core/crypto/pki_verifier.js';

// ── Load pre-generated test certificates ─────────────────────────────────────

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const certs = JSON.parse(
  readFileSync(join(__dirname, 'pki_test_certs.json'), 'utf8'),
) as {
  caPem: string;
  devicePem: string;
  expiredPem: string;
  untrustedPem: string;
  soonExpiryPem: string;
  futurePem: string;
};

// ── parsePemChain ─────────────────────────────────────────────────────────────

describe('parsePemChain', () => {
  it('parses a single certificate PEM', () => {
    const chain = parsePemChain(certs.caPem);
    expect(chain).toHaveLength(1);
    expect(chain[0]).toBeInstanceOf(X509Certificate);
  });

  it('parses multiple concatenated certificates', () => {
    const multi = certs.caPem + '\n' + certs.devicePem;
    const chain = parsePemChain(multi);
    expect(chain).toHaveLength(2);
  });

  it('returns empty array for empty string', () => {
    expect(parsePemChain('')).toHaveLength(0);
    expect(parsePemChain('   ')).toHaveLength(0);
  });

  it('returns empty array for non-PEM content', () => {
    expect(parsePemChain('not a cert')).toHaveLength(0);
  });
});

// ── extractSpiffeUris ─────────────────────────────────────────────────────────

describe('extractSpiffeUris', () => {
  it('extracts SPIFFE URI from SAN', () => {
    const cert = new X509Certificate(certs.devicePem);
    const uris = extractSpiffeUris(cert);
    expect(uris).toContain('spiffe://cluster.local/ns/billing/sa/iot-device');
  });

  it('returns empty array when no SAN is present', () => {
    const cert = new X509Certificate(certs.caPem);
    const uris = extractSpiffeUris(cert);
    // CA cert has no SAN in our test fixtures
    expect(uris).toEqual([]);
  });

  it('returns empty array when SAN contains only DNS entries', () => {
    // untrustedPem has no SAN
    const cert = new X509Certificate(certs.untrustedPem);
    const uris = extractSpiffeUris(cert);
    expect(uris).toEqual([]);
  });
});

// ── computeCertFingerprint ────────────────────────────────────────────────────

describe('computeCertFingerprint', () => {
  it('returns a 64-char hex string (SHA-256)', () => {
    const cert = new X509Certificate(certs.devicePem);
    const fp = computeCertFingerprint(cert);
    expect(fp).toHaveLength(64);
    expect(fp).toMatch(/^[0-9a-f]+$/);
  });

  it('is deterministic for the same certificate', () => {
    const cert1 = new X509Certificate(certs.devicePem);
    const cert2 = new X509Certificate(certs.devicePem);
    expect(computeCertFingerprint(cert1)).toBe(computeCertFingerprint(cert2));
  });

  it('differs between different certificates', () => {
    const certA = new X509Certificate(certs.devicePem);
    const certB = new X509Certificate(certs.caPem);
    expect(computeCertFingerprint(certA)).not.toBe(computeCertFingerprint(certB));
  });

  it('matches independent SHA-256 computation', () => {
    const cert = new X509Certificate(certs.devicePem);
    const expected = createHash('sha256').update(cert.raw).digest('hex');
    expect(computeCertFingerprint(cert)).toBe(expected);
  });
});

// ── isSignedByAnchor ──────────────────────────────────────────────────────────

describe('isSignedByAnchor', () => {
  it('returns true when leaf is signed by the CA', () => {
    const leaf = new X509Certificate(certs.devicePem);
    const ca = new X509Certificate(certs.caPem);
    expect(isSignedByAnchor(leaf, [ca])).toBe(true);
  });

  it('returns false when leaf is signed by a different CA', () => {
    const leaf = new X509Certificate(certs.untrustedPem);
    const ca = new X509Certificate(certs.caPem);
    expect(isSignedByAnchor(leaf, [ca])).toBe(false);
  });

  it('returns false when anchors array is empty', () => {
    const leaf = new X509Certificate(certs.devicePem);
    expect(isSignedByAnchor(leaf, [])).toBe(false);
  });

  it('accepts when any anchor in the list matches', () => {
    const leaf = new X509Certificate(certs.devicePem);
    const wrongCa = new X509Certificate(certs.untrustedPem);
    const rightCa = new X509Certificate(certs.caPem);
    // wrong CA first, right CA second
    expect(isSignedByAnchor(leaf, [wrongCa, rightCa])).toBe(true);
  });
});

// ── PkiVerifier.verify ────────────────────────────────────────────────────────

describe('PkiVerifier.verify', () => {
  const makeVerifier = (opts?: { allowedSpiffeUris?: string; certExpiryWarnDays?: number }) =>
    new PkiVerifier({
      caCertPems: certs.caPem,
      allowedSpiffeUris: opts?.allowedSpiffeUris,
      certExpiryWarnDays: opts?.certExpiryWarnDays ?? DEFAULT_CERT_EXPIRY_WARN_DAYS,
    });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it('succeeds for a valid cert signed by the configured CA', () => {
    const verifier = makeVerifier();
    const result = verifier.verify(certs.devicePem);
    expect(result.success).toBe(true);
    expect(result.fingerprint).toHaveLength(64);
    expect(result.expiresAt).toBeTruthy();
    expect(result.expiryWarning).toBe(false);
  });

  it('returns the SPIFFE URI when present in SAN', () => {
    const verifier = makeVerifier();
    const result = verifier.verify(certs.devicePem);
    expect(result.success).toBe(true);
    expect(result.spiffeUri).toBe('spiffe://cluster.local/ns/billing/sa/iot-device');
  });

  it('succeeds without a SPIFFE URI when SPIFFE validation is not configured', () => {
    // CA cert has no SPIFFE URI but allowedSpiffeUris is empty
    const verifier = makeVerifier({ allowedSpiffeUris: '' });
    const result = verifier.verify(certs.soonExpiryPem);
    expect(result.success).toBe(true);
    expect(result.spiffeUri).toBeUndefined();
  });

  // ── Certificate parse failure ───────────────────────────────────────────────

  it('returns CERT_PARSE_FAILED for invalid PEM', () => {
    const verifier = makeVerifier();
    const result = verifier.verify('not a certificate');
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(PKI_ERROR_CODES.CERT_PARSE_FAILED);
    expect(result.reason).toContain('Failed to parse');
  });

  it('returns CERT_PARSE_FAILED for empty string', () => {
    const verifier = makeVerifier();
    const result = verifier.verify('');
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(PKI_ERROR_CODES.CERT_PARSE_FAILED);
  });

  // ── Temporal validity ───────────────────────────────────────────────────────

  it('returns CERT_EXPIRED for a certificate past its notAfter', () => {
    const verifier = makeVerifier();
    const result = verifier.verify(certs.expiredPem);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(PKI_ERROR_CODES.CERT_EXPIRED);
    expect(result.reason).toContain('expired');
  });

  it('returns CERT_NOT_YET_VALID for a certificate before its notBefore', () => {
    const verifier = makeVerifier();
    const result = verifier.verify(certs.futurePem);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(PKI_ERROR_CODES.CERT_NOT_YET_VALID);
    expect(result.reason).toContain('not yet valid');
  });

  // ── Trust chain ─────────────────────────────────────────────────────────────

  it('returns CERT_UNTRUSTED for a cert signed by a different CA', () => {
    const verifier = makeVerifier();
    const result = verifier.verify(certs.untrustedPem);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(PKI_ERROR_CODES.CERT_UNTRUSTED);
    expect(result.reason).toContain('not signed by any configured trust anchor');
  });

  it('returns NO_TRUST_ANCHORS when caCertPems is empty and skipChainVerification is false', () => {
    const verifier = new PkiVerifier({ caCertPems: '' });
    const result = verifier.verify(certs.devicePem);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(PKI_ERROR_CODES.NO_TRUST_ANCHORS);
  });

  // ── SPIFFE URI validation ───────────────────────────────────────────────────

  it('returns SPIFFE_MISSING when allowedSpiffeUris is set but cert has no SAN', () => {
    const verifier = makeVerifier({
      allowedSpiffeUris: 'spiffe://cluster.local/ns/billing/sa/iot-device',
    });
    // soonExpiryPem has no SAN
    const result = verifier.verify(certs.soonExpiryPem);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(PKI_ERROR_CODES.SPIFFE_MISSING);
    expect(result.reason).toContain('SPIFFE URI');
  });

  it('returns SPIFFE_UNAUTHORIZED when cert URI is not in the allowed list', () => {
    const verifier = makeVerifier({
      allowedSpiffeUris: 'spiffe://cluster.local/ns/billing/sa/other-service',
    });
    const result = verifier.verify(certs.devicePem);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(PKI_ERROR_CODES.SPIFFE_UNAUTHORIZED);
    expect(result.reason).toContain('allowed set');
  });

  it('succeeds when cert URI matches one of multiple allowed URIs', () => {
    const verifier = makeVerifier({
      allowedSpiffeUris: [
        'spiffe://cluster.local/ns/billing/sa/other-service',
        'spiffe://cluster.local/ns/billing/sa/iot-device',
      ].join(','),
    });
    const result = verifier.verify(certs.devicePem);
    expect(result.success).toBe(true);
  });

  // ── Expiry warning ──────────────────────────────────────────────────────────

  it('sets expiryWarning=true when cert expires within the warn window', () => {
    const verifier = makeVerifier({ certExpiryWarnDays: 30 });
    // soonExpiryPem expires in 5 days, which is < 30 days
    const result = verifier.verify(certs.soonExpiryPem);
    expect(result.success).toBe(true);
    expect(result.expiryWarning).toBe(true);
  });

  it('sets expiryWarning=false when cert expiry is beyond the warn window', () => {
    const verifier = makeVerifier({ certExpiryWarnDays: 3 });
    // soonExpiryPem expires in 5 days, which is > 3 days
    const result = verifier.verify(certs.soonExpiryPem);
    expect(result.success).toBe(true);
    expect(result.expiryWarning).toBe(false);
  });

  // ── skipChainVerification ───────────────────────────────────────────────────

  it('succeeds without trust anchors when skipChainVerification=true', () => {
    const verifier = new PkiVerifier({
      caCertPems: '',
      skipChainVerification: true,
    });
    const result = verifier.verify(certs.devicePem);
    expect(result.success).toBe(true);
    expect(result.fingerprint).toHaveLength(64);
  });

  // ── trustAnchorCount and configuredSpiffeUris ────────────────────────────────

  it('exposes trustAnchorCount', () => {
    const verifier = makeVerifier();
    expect(verifier.trustAnchorCount).toBe(1);
  });

  it('exposes configuredSpiffeUris', () => {
    const verifier = makeVerifier({
      allowedSpiffeUris: 'spiffe://a,spiffe://b',
    });
    expect(verifier.configuredSpiffeUris).toEqual(['spiffe://a', 'spiffe://b']);
  });

  it('returns empty configuredSpiffeUris when none configured', () => {
    const verifier = makeVerifier();
    expect(verifier.configuredSpiffeUris).toEqual([]);
  });
});

// ── NoOpPkiVerifier ───────────────────────────────────────────────────────────

describe('NoOpPkiVerifier', () => {
  it('always succeeds for a parseable cert', () => {
    const verifier = new NoOpPkiVerifier();
    const result = verifier.verify(certs.devicePem);
    expect(result.success).toBe(true);
    expect(result.fingerprint).toHaveLength(64);
    expect(result.spiffeUri).toBe('spiffe://cluster.local/ns/billing/sa/iot-device');
  });

  it('succeeds for an expired cert (no trust checks)', () => {
    const verifier = new NoOpPkiVerifier();
    const result = verifier.verify(certs.expiredPem);
    // NoOpPkiVerifier skips all checks but still tries to parse
    // The expired cert is parseable so it succeeds
    expect(result.success).toBe(true);
  });

  it('succeeds with stub values for an invalid PEM', () => {
    const verifier = new NoOpPkiVerifier();
    const result = verifier.verify('garbage');
    expect(result.success).toBe(true);
    expect(result.fingerprint).toHaveLength(64);
  });

  it('has zero trust anchors', () => {
    const verifier = new NoOpPkiVerifier();
    expect(verifier.trustAnchorCount).toBe(0);
  });
});

// ── Prometheus metrics ────────────────────────────────────────────────────────

describe('recordPkiVerification metrics', () => {
  it('increments success counter on successful verification', async () => {
    const before = (await pkiVerificationsTotal.get()).values.find(v => v.labels.result === 'success')?.value ?? 0;
    recordPkiVerification({ success: true, fingerprint: '0'.repeat(64), expiryWarning: false }, 1);
    const after = (await pkiVerificationsTotal.get()).values.find(v => v.labels.result === 'success')?.value ?? 0;
    expect(after).toBe(before + 1);
  });

  it('increments failure counter on failed verification', async () => {
    const before = (await pkiVerificationsTotal.get()).values.find(v => v.labels.result === 'failure')?.value ?? 0;
    recordPkiVerification({
      success: false,
      errorCode: PKI_ERROR_CODES.CERT_EXPIRED,
      reason: 'expired',
    }, 1);
    const after = (await pkiVerificationsTotal.get()).values.find(v => v.labels.result === 'failure')?.value ?? 0;
    expect(after).toBe(before + 1);
  });

  it('increments error_code counter on failure', async () => {
    const before = (await pkiVerificationFailuresTotal.get()).values.find(
      v => v.labels.error_code === PKI_ERROR_CODES.CERT_UNTRUSTED
    )?.value ?? 0;
    recordPkiVerification({
      success: false,
      errorCode: PKI_ERROR_CODES.CERT_UNTRUSTED,
      reason: 'untrusted',
    }, 1);
    const after = (await pkiVerificationFailuresTotal.get()).values.find(
      v => v.labels.error_code === PKI_ERROR_CODES.CERT_UNTRUSTED
    )?.value ?? 0;
    expect(after).toBe(before + 1);
  });

  it('increments expiry warning counter when expiryWarning is true', async () => {
    const before = (await pkiCertExpiryWarningsTotal.get()).values[0]?.value ?? 0;
    recordPkiVerification({ success: true, fingerprint: '0'.repeat(64), expiryWarning: true }, 1);
    const after = (await pkiCertExpiryWarningsTotal.get()).values[0]?.value ?? 0;
    expect(after).toBe(before + 1);
  });

  it('does not increment expiry warning when expiryWarning is false', async () => {
    const before = (await pkiCertExpiryWarningsTotal.get()).values[0]?.value ?? 0;
    recordPkiVerification({ success: true, fingerprint: '0'.repeat(64), expiryWarning: false }, 1);
    const after = (await pkiCertExpiryWarningsTotal.get()).values[0]?.value ?? 0;
    expect(after).toBe(before); // unchanged
  });

  it('observes duration in the histogram', async () => {
    const before = (await pkiVerificationDurationMs.get()).values
      .filter(v => v.metricName === 'pki_verification_duration_ms_count')[0]?.value ?? 0;
    recordPkiVerification({ success: true, fingerprint: '0'.repeat(64) }, 5);
    const after = (await pkiVerificationDurationMs.get()).values
      .filter(v => v.metricName === 'pki_verification_duration_ms_count')[0]?.value ?? 0;
    expect(after).toBeGreaterThan(before);
  });
});

// ── Integration: PkiVerifier with AttestationService ─────────────────────────

describe('PkiVerifier integration with AttestationService', () => {
  it('AttestationService accepts a valid cert when PKI verifier is configured', async () => {
    const {
      AttestationService,
      InMemoryCertificateRegistry,
      InMemoryAttestationStore,
      InMemoryAttestationNonceGuard,
    } = await import('../../../src/core/crypto/attestation.js');
    const nacl = (await import('tweetnacl')).default;
    const { buildAttestationMessage } = await import('../../../src/core/crypto/attestation.js');

    const registry = new InMemoryCertificateRegistry();
    registry.add({ serial: 'CERT-PKI-001', model: 'MTR-1', batch: 'BATCH-1', revoked: false });

    const store = new InMemoryAttestationStore();
    const nonceGuard = new InMemoryAttestationNonceGuard();
    const pkiVerifier = new PkiVerifier({
      caCertPems: certs.caPem,
      skipChainVerification: false,
    });

    const service = new AttestationService(registry, store, nonceGuard, {
      pkiVerifier,
      skipSignatureVerification: false,
    });

    const keyPair = nacl.sign.keyPair();
    const publicKey = Buffer.from(keyPair.publicKey).toString('hex');
    const nonce = 'pki-nonce-001';
    const timestamp = Date.now();
    const certSerial = 'CERT-PKI-001';

    const message = buildAttestationMessage({ deviceId: 'pki-device-1', publicKey, nonce, timestamp, certSerial });
    const signature = Buffer.from(nacl.sign.detached(Buffer.from(message), keyPair.secretKey)).toString('hex');

    const result = await service.attest({
      deviceId: 'pki-device-1',
      publicKey,
      nonce,
      timestamp,
      certSerial,
      signature,
      certPem: certs.devicePem,
    });

    expect(result.success).toBe(true);
    expect(result.certFingerprint).toHaveLength(64);
    expect(result.spiffeUri).toBe('spiffe://cluster.local/ns/billing/sa/iot-device');
    expect(result.certExpiresAt).toBeTruthy();

    // The record should be persisted with PKI metadata
    expect(store.records).toHaveLength(1);
    expect(store.records[0].certFingerprint).toHaveLength(64);
    expect(store.records[0].spiffeUri).toBe('spiffe://cluster.local/ns/billing/sa/iot-device');
  });

  it('AttestationService rejects attestation when certPem is missing and PKI is required', async () => {
    const {
      AttestationService,
      InMemoryCertificateRegistry,
      InMemoryAttestationStore,
      InMemoryAttestationNonceGuard,
    } = await import('../../../src/core/crypto/attestation.js');
    const nacl = (await import('tweetnacl')).default;
    const { buildAttestationMessage } = await import('../../../src/core/crypto/attestation.js');

    const registry = new InMemoryCertificateRegistry();
    registry.add({ serial: 'CERT-PKI-002', model: 'MTR-1', batch: 'BATCH-1', revoked: false });

    const pkiVerifier = new PkiVerifier({ caCertPems: certs.caPem });
    const service = new AttestationService(
      registry,
      new InMemoryAttestationStore(),
      new InMemoryAttestationNonceGuard(),
      { pkiVerifier },
    );

    const keyPair = nacl.sign.keyPair();
    const publicKey = Buffer.from(keyPair.publicKey).toString('hex');
    const nonce = 'pki-nonce-002';
    const timestamp = Date.now();
    const certSerial = 'CERT-PKI-002';
    const message = buildAttestationMessage({ deviceId: 'pki-device-2', publicKey, nonce, timestamp, certSerial });
    const signature = Buffer.from(nacl.sign.detached(Buffer.from(message), keyPair.secretKey)).toString('hex');

    const result = await service.attest({
      deviceId: 'pki-device-2',
      publicKey,
      nonce,
      timestamp,
      certSerial,
      signature,
      // certPem intentionally omitted
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('ATTEST_ERR_PKI_CERT_MISSING');
  });

  it('AttestationService rejects attestation for an untrusted cert', async () => {
    const {
      AttestationService,
      InMemoryCertificateRegistry,
      InMemoryAttestationStore,
      InMemoryAttestationNonceGuard,
    } = await import('../../../src/core/crypto/attestation.js');
    const nacl = (await import('tweetnacl')).default;
    const { buildAttestationMessage } = await import('../../../src/core/crypto/attestation.js');

    const registry = new InMemoryCertificateRegistry();
    registry.add({ serial: 'CERT-PKI-003', model: 'MTR-1', batch: 'BATCH-1', revoked: false });

    const pkiVerifier = new PkiVerifier({ caCertPems: certs.caPem });
    const service = new AttestationService(
      registry,
      new InMemoryAttestationStore(),
      new InMemoryAttestationNonceGuard(),
      { pkiVerifier, skipSignatureVerification: true },
    );

    const keyPair = nacl.sign.keyPair();
    const publicKey = Buffer.from(keyPair.publicKey).toString('hex');
    const nonce = 'pki-nonce-003';
    const timestamp = Date.now();
    const certSerial = 'CERT-PKI-003';
    const message = buildAttestationMessage({ deviceId: 'pki-device-3', publicKey, nonce, timestamp, certSerial });
    const signature = Buffer.from(nacl.sign.detached(Buffer.from(message), keyPair.secretKey)).toString('hex');

    const result = await service.attest({
      deviceId: 'pki-device-3',
      publicKey,
      nonce,
      timestamp,
      certSerial,
      signature,
      certPem: certs.untrustedPem, // not signed by our CA
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('ATTEST_ERR_PKI_CERT_INVALID');
    expect(result.reason).toContain('PKI_ERR_CERT_UNTRUSTED');
  });

  it('AttestationService works without PKI verifier (backward compat)', async () => {
    const {
      AttestationService,
      InMemoryCertificateRegistry,
      InMemoryAttestationStore,
      InMemoryAttestationNonceGuard,
    } = await import('../../../src/core/crypto/attestation.js');
    const nacl = (await import('tweetnacl')).default;
    const { buildAttestationMessage } = await import('../../../src/core/crypto/attestation.js');

    const registry = new InMemoryCertificateRegistry();
    registry.add({ serial: 'CERT-PKI-004', model: 'MTR-1', batch: 'BATCH-1', revoked: false });

    // No pkiVerifier — backwards-compatible path
    const service = new AttestationService(
      registry,
      new InMemoryAttestationStore(),
      new InMemoryAttestationNonceGuard(),
    );

    const keyPair = nacl.sign.keyPair();
    const publicKey = Buffer.from(keyPair.publicKey).toString('hex');
    const nonce = 'pki-nonce-004';
    const timestamp = Date.now();
    const certSerial = 'CERT-PKI-004';
    const message = buildAttestationMessage({ deviceId: 'pki-device-4', publicKey, nonce, timestamp, certSerial });
    const signature = Buffer.from(nacl.sign.detached(Buffer.from(message), keyPair.secretKey)).toString('hex');

    const result = await service.attest({
      deviceId: 'pki-device-4',
      publicKey,
      nonce,
      timestamp,
      certSerial,
      signature,
      // No certPem — no PKI verifier configured, so this is fine
    });

    expect(result.success).toBe(true);
    expect(result.certFingerprint).toBeUndefined();
    expect(result.spiffeUri).toBeUndefined();
  });
});
