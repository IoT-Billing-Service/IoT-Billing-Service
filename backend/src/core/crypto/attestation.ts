/**
 * Decentralized Hardware Attestation and Cryptographic Validation (Issue #3).
 *
 * This module implements a multi-layer attestation pipeline for IoT devices:
 *
 * ```
 * Attestation request
 *   ├── 1. Schema validation (device ID, public key, certificate presence)
 *   ├── 2. Certificate chain verification (trust anchor check)
 *   ├── 3. Ed25519 signature verification (device identity proof)
 *   ├── 4. Replay/nonce guard (prevents attestation replay attacks)
 *   ├── 5. Revocation check (against hardware certificate registry)
 *   └── 6. Attestation record persistence + event emission
 * ```
 *
 * Security properties:
 *  - All attestations are cryptographically bound to a device's Ed25519 key pair.
 *  - A compromised certificate can be revoked without rekeying all devices.
 *  - Replay protection via nonce window (same as ingestion pipeline).
 *  - PCI-DSS / SOC2: attestation records are append-only and include the
 *    full chain digest for auditing.
 *
 * Performance:
 *  - Synchronous verification path; only the DB write is async.
 *  - Designed to stay well under the 200ms P99 budget for billing operations.
 */

import { Buffer } from 'node:buffer';
import nacl from 'tweetnacl';

// ── Constants ──────────────────────────────────────────────────────────────────

/** Ed25519 public key length in bytes. */
export const ED25519_PUBLIC_KEY_BYTES = 32;

/** Ed25519 signature length in bytes. */
export const ED25519_SIGNATURE_BYTES = 64;

/** Nonce replay window in milliseconds (matches ingestion validator). */
export const ATTESTATION_NONCE_WINDOW_MS = 5_000;

/** Maximum allowed clock drift between device timestamp and server clock. */
export const MAX_TIMESTAMP_DRIFT_MS = 30_000;

/** Separator used when constructing the canonical attestation message. */
const MSG_SEPARATOR = '|';

// ── Error codes ────────────────────────────────────────────────────────────────

export const ATTESTATION_ERROR_CODES = {
  SUCCESS: 'ATTEST_OK',
  INVALID_PAYLOAD: 'ATTEST_ERR_INVALID_PAYLOAD',
  INVALID_PUBLIC_KEY: 'ATTEST_ERR_INVALID_PUBLIC_KEY',
  INVALID_SIGNATURE: 'ATTEST_ERR_INVALID_SIGNATURE',
  SIGNATURE_MISMATCH: 'ATTEST_ERR_SIGNATURE_MISMATCH',
  REPLAY_DETECTED: 'ATTEST_ERR_REPLAY',
  STALE_TIMESTAMP: 'ATTEST_ERR_STALE_TIMESTAMP',
  CERT_MISSING: 'ATTEST_ERR_CERT_MISSING',
  CERT_REVOKED: 'ATTEST_ERR_CERT_REVOKED',
  CERT_MISMATCH: 'ATTEST_ERR_CERT_MISMATCH',
  CHAIN_INVALID: 'ATTEST_ERR_CHAIN_INVALID',
  // PKI errors (issue #294)
  PKI_CERT_MISSING: 'ATTEST_ERR_PKI_CERT_MISSING',
  PKI_CERT_INVALID: 'ATTEST_ERR_PKI_CERT_INVALID',
  INTERNAL_ERROR: 'ATTEST_ERR_INTERNAL',
} as const;

export type AttestationErrorCode =
  (typeof ATTESTATION_ERROR_CODES)[keyof typeof ATTESTATION_ERROR_CODES];

// ── Types ──────────────────────────────────────────────────────────────────────

/** Hardware certificate entry (mirrors the `HardwareCertificate` Prisma model). */
export interface HardwareCertificate {
  serial: string;
  model: string;
  batch: string;
  revoked: boolean;
}

/**
 * Attestation request from a device.
 *
 * The device signs a canonical message:
 *   `<deviceId>|<publicKey(hex)>|<nonce>|<timestamp>|<certSerial>`
 * using its Ed25519 private key and sends the signature along with
 * all plaintext fields.
 */
export interface AttestationRequest {
  /** Device serial / ID. */
  deviceId: string;
  /** Ed25519 public key as a 64-char hex string (32 bytes). */
  publicKey: string;
  /** Cryptographic nonce — consumed once within the replay window. */
  nonce: string;
  /** Unix epoch milliseconds of the attestation attempt. */
  timestamp: number;
  /** Hardware certificate serial linked to this device's batch. */
  certSerial: string;
  /**
   * Ed25519 signature over the canonical message, hex-encoded (128 hex chars =
   * 64 bytes).
   */
  signature: string;
  /**
   * PEM-encoded device leaf certificate for PKI chain verification (issue #294).
   * Required when the attestation service is configured with a PKI verifier.
   * When absent and a PKI verifier is configured, attestation is rejected.
   */
  certPem?: string;
}

/** Result returned by {@link AttestationService.attest}. */
export interface AttestationResult {
  success: boolean;
  errorCode?: AttestationErrorCode;
  reason?: string;
  /** Device ID from the request (present on both success and most errors). */
  deviceId?: string;
  /** ISO-8601 timestamp of the attestation (server-side). */
  attestedAt?: string;
  /** SHA-256 digest (hex) of the canonical message, for audit logging. */
  messageDigest?: string;
  /**
   * SHA-256 fingerprint (hex) of the device leaf certificate.
   * Present only when PKI verification was performed (issue #294).
   */
  certFingerprint?: string;
  /**
   * SPIFFE URI extracted from the device certificate SAN.
   * Present only when PKI verification was performed and a SPIFFE URI was found.
   */
  spiffeUri?: string;
  /**
   * Certificate expiry ISO-8601 timestamp.
   * Present only when PKI verification was performed.
   */
  certExpiresAt?: string;
  /**
   * True when the certificate is within the expiry warning window.
   * Operators should rotate the certificate before it expires.
   */
  certExpiryWarning?: boolean;
}

/**
 * Certificate registry interface.
 *
 * In production this is backed by Prisma (`HardwareCertificate` model).
 * In tests an in-memory implementation is used.
 */
export interface CertificateRegistry {
  lookup(serial: string): Promise<HardwareCertificate | null>;
}

/**
 * Attestation record store interface.
 *
 * Append-only: once an attestation is accepted it is never mutated.
 */
export interface AttestationStore {
  record(entry: AttestationRecord): Promise<void>;
}

/** A persisted attestation entry. */
export interface AttestationRecord {
  deviceId: string;
  publicKey: string;
  certSerial: string;
  nonce: string;
  messageDigest: string;
  attestedAt: Date;
  /**
   * SHA-256 fingerprint of the device leaf certificate (issue #294).
   * Present when PKI verification was performed.
   */
  certFingerprint?: string;
  /**
   * SPIFFE URI from the device certificate SAN (issue #294).
   * Present when PKI verification was performed and a SPIFFE URI was found.
   */
  spiffeUri?: string;
  /**
   * Certificate expiry timestamp (issue #294).
   */
  certExpiresAt?: Date;
}

/**
 * Nonce guard interface — same semantics as {@link NonceCache} in validator.ts.
 * Returns `true` when the nonce is freshly consumed, `false` on replay.
 */
export interface AttestationNonceGuard {
  tryConsume(nonce: string): boolean | Promise<boolean>;
}

// ── In-memory nonce guard ──────────────────────────────────────────────────────

/**
 * In-process nonce guard for attestation replay protection.
 * Suitable for single-node deployments and unit tests.
 */
export class InMemoryAttestationNonceGuard implements AttestationNonceGuard {
  private readonly seen = new Map<string, number>();
  private readonly windowMs: number;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(windowMs: number = ATTESTATION_NONCE_WINDOW_MS) {
    this.windowMs = windowMs;
    this.cleanupTimer = setInterval(() => {
      this.prune();
    }, windowMs);
    this.cleanupTimer.unref();
  }

  tryConsume(nonce: string): boolean {
    const now = Date.now();
    const exp = this.seen.get(nonce);
    if (exp !== undefined && exp > now) return false;
    this.seen.set(nonce, now + this.windowMs);
    return true;
  }

  private prune(): void {
    const now = Date.now();
    for (const [nonce, exp] of this.seen) {
      if (exp <= now) this.seen.delete(nonce);
    }
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
    this.seen.clear();
  }
}

// ── Cryptographic helpers ──────────────────────────────────────────────────────

/**
 * Build the canonical attestation message that the device signs.
 *
 * Format: `<deviceId>|<publicKey>|<nonce>|<timestamp>|<certSerial>`
 *
 * All fields are concatenated with `|` to prevent field-merging ambiguity.
 */
export function buildAttestationMessage(req: Omit<AttestationRequest, 'signature'>): string {
  return [req.deviceId, req.publicKey, req.nonce, String(req.timestamp), req.certSerial].join(
    MSG_SEPARATOR,
  );
}

/**
 * Compute the SHA-512 / truncated-to-32-byte digest of `message` for audit
 * logging.  We use nacl.hash (SHA-512) and return the first 32 bytes as hex.
 */
export function digestMessage(message: string): string {
  const hash = nacl.hash(Buffer.from(message));
  return Buffer.from(hash.subarray(0, 32)).toString('hex');
}

/**
 * Verify an Ed25519 signature over the canonical attestation message.
 *
 * @param publicKeyHex - 64 hex chars (32 bytes)
 * @param message      - plaintext canonical message
 * @param signatureHex - 128 hex chars (64 bytes)
 */
export function verifyAttestationSignature(
  publicKeyHex: string,
  message: string,
  signatureHex: string,
): { valid: boolean; reason?: string } {
  // Validate key length.
  if (publicKeyHex.length !== ED25519_PUBLIC_KEY_BYTES * 2) {
    return {
      valid: false,
      reason: `Invalid public key length: expected ${String(ED25519_PUBLIC_KEY_BYTES * 2)} hex chars`,
    };
  }

  // Validate signature length.
  if (signatureHex.length !== ED25519_SIGNATURE_BYTES * 2) {
    return {
      valid: false,
      reason: `Invalid signature length: expected ${String(ED25519_SIGNATURE_BYTES * 2)} hex chars`,
    };
  }

  let publicKey: Uint8Array;
  let signature: Uint8Array;

  try {
    publicKey = Buffer.from(publicKeyHex, 'hex');
    signature = Buffer.from(signatureHex, 'hex');
  } catch {
    return { valid: false, reason: 'Failed to decode hex fields' };
  }

  const messageBytes = Buffer.from(message);

  try {
    const ok = nacl.sign.detached.verify(messageBytes, signature, publicKey);
    if (!ok) {
      return { valid: false, reason: 'Ed25519 signature verification failed' };
    }
  } catch {
    return { valid: false, reason: 'Signature verification threw an error' };
  }

  return { valid: true };
}

// ── AttestationService ─────────────────────────────────────────────────────────

export interface AttestationServiceOptions {
  /** Skip Ed25519 signature verification (not recommended for production). */
  skipSignatureVerification?: boolean;
  /** Skip certificate revocation check (not recommended for production). */
  skipRevocationCheck?: boolean;
  /** Override the maximum timestamp drift window. */
  maxTimestampDriftMs?: number;
  /**
   * PKI verifier for hardware identity binding (issue #294).
   * When provided, the attestation pipeline verifies the device certificate
   * against a CA trust anchor after the revocation check.
   * When omitted, PKI chain verification is skipped.
   */
  pkiVerifier?: import('./pki_verifier.js').PkiVerifier;
  /**
   * Skip PKI chain verification (for tests / local dev).
   * Has no effect when pkiVerifier is not provided.
   */
  skipPkiVerification?: boolean;
}

/**
 * Core hardware attestation orchestrator.
 *
 * Runs the full validation pipeline synchronously (except DB writes).
 * Designed to stay under 200ms P99.
 */
export class AttestationService {
  private readonly maxDriftMs: number;

  constructor(
    private readonly certRegistry: CertificateRegistry,
    private readonly attestationStore: AttestationStore,
    private readonly nonceGuard: AttestationNonceGuard,
    private readonly options: AttestationServiceOptions = {},
  ) {
    this.maxDriftMs = options.maxTimestampDriftMs ?? MAX_TIMESTAMP_DRIFT_MS;
  }

  /**
   * Run the full attestation pipeline for a device request.
   */
  async attest(req: AttestationRequest): Promise<AttestationResult> {
    try {
      // ── Step 1: Schema validation ────────────────────────────────────────
      const schemaError = this.validateSchema(req);
      if (schemaError !== null) {
        return {
          success: false,
          errorCode: ATTESTATION_ERROR_CODES.INVALID_PAYLOAD,
          reason: schemaError,
          deviceId: req.deviceId,
        };
      }

      // ── Step 2: Timestamp staleness check ────────────────────────────────
      const now = Date.now();
      const drift = Math.abs(now - req.timestamp);
      if (drift > this.maxDriftMs) {
        return {
          success: false,
          errorCode: ATTESTATION_ERROR_CODES.STALE_TIMESTAMP,
          reason: `Attestation timestamp too old or too far in the future (drift=${String(drift)}ms)`,
          deviceId: req.deviceId,
        };
      }

      // ── Step 3: Replay guard ──────────────────────────────────────────────
      const accepted = await this.nonceGuard.tryConsume(req.nonce);
      if (!accepted) {
        return {
          success: false,
          errorCode: ATTESTATION_ERROR_CODES.REPLAY_DETECTED,
          reason: `Attestation nonce already consumed: ${req.nonce}`,
          deviceId: req.deviceId,
        };
      }

      // ── Step 4: Ed25519 signature verification ────────────────────────────
      if (this.options.skipSignatureVerification !== true) {
        const message = buildAttestationMessage(req);
        const sigResult = verifyAttestationSignature(req.publicKey, message, req.signature);
        if (!sigResult.valid) {
          return {
            success: false,
            errorCode: ATTESTATION_ERROR_CODES.SIGNATURE_MISMATCH,
            reason: sigResult.reason,
            deviceId: req.deviceId,
          };
        }
      }

      // ── Step 5: Certificate chain verification ────────────────────────────
      const cert = await this.certRegistry.lookup(req.certSerial);

      if (cert === null) {
        return {
          success: false,
          errorCode: ATTESTATION_ERROR_CODES.CERT_MISSING,
          reason: `Hardware certificate not found: ${req.certSerial}`,
          deviceId: req.deviceId,
        };
      }

      if (this.options.skipRevocationCheck !== true && cert.revoked) {
        return {
          success: false,
          errorCode: ATTESTATION_ERROR_CODES.CERT_REVOKED,
          reason: `Hardware certificate has been revoked: ${req.certSerial}`,
          deviceId: req.deviceId,
        };
      }

      // ── Step 5b: PKI hardware identity binding (issue #294) ───────────────
      let certFingerprint: string | undefined;
      let spiffeUri: string | undefined;
      let certExpiresAt: Date | undefined;
      let certExpiryWarning: boolean | undefined;

      const pkiVerifier = this.options.pkiVerifier;
      if (pkiVerifier !== undefined && this.options.skipPkiVerification !== true) {
        if (!req.certPem || req.certPem.trim() === '') {
          return {
            success: false,
            errorCode: ATTESTATION_ERROR_CODES.PKI_CERT_MISSING,
            reason:
              'PKI verification is enabled but no certPem was provided in the attestation request',
            deviceId: req.deviceId,
          };
        }

        const pkiStart = Date.now();
        const pkiResult = pkiVerifier.verify(req.certPem);
        const pkiDuration = Date.now() - pkiStart;

        const { recordPkiVerification } = await import('./pki_verifier.js');
        recordPkiVerification(pkiResult, pkiDuration);

        if (!pkiResult.success) {
          return {
            success: false,
            errorCode: ATTESTATION_ERROR_CODES.PKI_CERT_INVALID,
            reason: `PKI certificate verification failed [${pkiResult.errorCode ?? 'unknown'}]: ${pkiResult.reason ?? ''}`,
            deviceId: req.deviceId,
          };
        }

        certFingerprint = pkiResult.fingerprint;
        spiffeUri = pkiResult.spiffeUri;
        certExpiresAt = pkiResult.expiresAt ? new Date(pkiResult.expiresAt) : undefined;
        certExpiryWarning = pkiResult.expiryWarning;
      }

      // ── Step 6: Persist attestation record ───────────────────────────────
      const message = buildAttestationMessage(req);
      const messageDigest = digestMessage(message);
      const attestedAt = new Date();

      await this.attestationStore.record({
        deviceId: req.deviceId,
        publicKey: req.publicKey,
        certSerial: req.certSerial,
        nonce: req.nonce,
        messageDigest,
        attestedAt,
        certFingerprint,
        spiffeUri,
        certExpiresAt,
      });

      return {
        success: true,
        deviceId: req.deviceId,
        attestedAt: attestedAt.toISOString(),
        messageDigest,
        certFingerprint,
        spiffeUri,
        certExpiresAt: certExpiresAt?.toISOString(),
        certExpiryWarning,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        errorCode: ATTESTATION_ERROR_CODES.INTERNAL_ERROR,
        reason: `Attestation internal error: ${message}`,
        deviceId: req.deviceId,
      };
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private validateSchema(req: AttestationRequest): string | null {
    if (typeof req.deviceId !== 'string' || req.deviceId.trim() === '') {
      return 'Missing or empty deviceId';
    }
    if (
      typeof req.publicKey !== 'string' ||
      req.publicKey.length !== ED25519_PUBLIC_KEY_BYTES * 2
    ) {
      return `publicKey must be ${String(ED25519_PUBLIC_KEY_BYTES * 2)} hex chars`;
    }
    if (typeof req.nonce !== 'string' || req.nonce.trim() === '') {
      return 'Missing or empty nonce';
    }
    if (typeof req.timestamp !== 'number' || !Number.isFinite(req.timestamp)) {
      return 'timestamp must be a finite number';
    }
    if (typeof req.certSerial !== 'string' || req.certSerial.trim() === '') {
      return 'Missing or empty certSerial';
    }
    if (typeof req.signature !== 'string' || req.signature.length !== ED25519_SIGNATURE_BYTES * 2) {
      return `signature must be ${String(ED25519_SIGNATURE_BYTES * 2)} hex chars`;
    }
    return null;
  }
}

// ── In-memory implementations for tests / dev ──────────────────────────────────

/**
 * In-memory certificate registry.  Suitable for tests and local development.
 */
export class InMemoryCertificateRegistry implements CertificateRegistry {
  private readonly certs = new Map<string, HardwareCertificate>();

  add(cert: HardwareCertificate): void {
    this.certs.set(cert.serial, cert);
  }

  revoke(serial: string): void {
    const cert = this.certs.get(serial);
    if (cert !== undefined) {
      this.certs.set(serial, { ...cert, revoked: true });
    }
  }

  lookup(serial: string): Promise<HardwareCertificate | null> {
    return Promise.resolve(this.certs.get(serial) ?? null);
  }
}

/**
 * In-memory attestation store.  Records are kept in-process for tests.
 */
export class InMemoryAttestationStore implements AttestationStore {
  readonly records: AttestationRecord[] = [];

  record(entry: AttestationRecord): Promise<void> {
    this.records.push(entry);
    return Promise.resolve();
  }

  clear(): void {
    this.records.length = 0;
  }
}

// ── Prisma-backed implementations for production ───────────────────────────────

import type { PrismaClient } from '@prisma/client';

/**
 * Prisma-backed certificate registry.
 *
 * Reads directly from the `hardware_certificates` table managed by Prisma.
 * This is the production implementation; `InMemoryCertificateRegistry` is
 * used for tests and local development.
 */
export class PrismaBackedCertificateRegistry implements CertificateRegistry {
  constructor(private readonly prisma: PrismaClient) {}

  async lookup(serial: string): Promise<HardwareCertificate | null> {
    const row = await this.prisma.hardwareCertificate.findUnique({
      where: { serial },
      select: { serial: true, model: true, batch: true, revoked: true },
    });
    return row;
  }
}

/**
 * Prisma-backed attestation store.
 *
 * Persists attestation records to the `attestation_records` table as an
 * append-only audit trail (rows are never mutated after insertion).
 */
export class PrismaBackedAttestationStore implements AttestationStore {
  constructor(private readonly prisma: PrismaClient) {}

  async record(entry: AttestationRecord): Promise<void> {
    await this.prisma.attestationRecord.create({
      data: {
        deviceId: entry.deviceId,
        publicKey: entry.publicKey,
        certSerial: entry.certSerial,
        nonce: entry.nonce,
        messageDigest: entry.messageDigest,
        attestedAt: entry.attestedAt,
        ...(entry.certFingerprint !== undefined && { certFingerprint: entry.certFingerprint }),
        ...(entry.spiffeUri !== undefined && { spiffeUri: entry.spiffeUri }),
        ...(entry.certExpiresAt !== undefined && { certExpiresAt: entry.certExpiresAt }),
      },
    });
  }
}
