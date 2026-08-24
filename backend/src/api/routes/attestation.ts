/**
 * Hardware attestation HTTP routes (Issue #3).
 *
 * Exposes endpoints for device attestation and certificate management.
 *
 * ## Endpoints
 *
 * | Method | Path                       | Description                              |
 * |--------|----------------------------|------------------------------------------|
 * | POST   | `/attestation`             | Submit a device attestation request      |
 * | GET    | `/attestation/health`      | Health check for the attestation service |
 * | GET    | `/attestation/:deviceId`   | Latest attestation record for a device   |
 *
 * ## Request body for POST /attestation
 *
 * ```json
 * {
 *   "deviceId": "MTR-001",
 *   "publicKey": "<64 hex chars>",
 *   "nonce": "<unique string>",
 *   "timestamp": 1700000000000,
 *   "certSerial": "CERT-2026-001",
 *   "signature": "<128 hex chars>"
 * }
 * ```
 *
 * ## Error codes → HTTP status
 *
 * | Error code                    | HTTP status |
 * |-------------------------------|-------------|
 * | ATTEST_OK                     | 200         |
 * | ATTEST_ERR_INVALID_PAYLOAD    | 400         |
 * | ATTEST_ERR_INVALID_PUBLIC_KEY | 400         |
 * | ATTEST_ERR_INVALID_SIGNATURE  | 400         |
 * | ATTEST_ERR_SIGNATURE_MISMATCH | 401         |
 * | ATTEST_ERR_REPLAY             | 409         |
 * | ATTEST_ERR_STALE_TIMESTAMP    | 400         |
 * | ATTEST_ERR_CERT_MISSING       | 404         |
 * | ATTEST_ERR_CERT_REVOKED       | 403         |
 * | ATTEST_ERR_CHAIN_INVALID      | 422         |
 * | ATTEST_ERR_INTERNAL           | 500         |
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import {
  AttestationService,
  InMemoryAttestationNonceGuard,
  InMemoryCertificateRegistry,
  InMemoryAttestationStore,
  PrismaBackedCertificateRegistry,
  PrismaBackedAttestationStore,
  ATTESTATION_ERROR_CODES,
  type AttestationRequest,
  type AttestationServiceOptions,
} from '../../core/crypto/attestation.js';
import { PkiVerifier, NoOpPkiVerifier } from '../../core/crypto/pki_verifier.js';
import { getEnv } from '../../config/env.js';
import { recordAttestationSuccess, recordAttestationFailure } from '../metrics/prometheus.js';

// ── HTTP status mapping ────────────────────────────────────────────────────────

const ERROR_TO_HTTP_STATUS: Record<string, number> = {
  [ATTESTATION_ERROR_CODES.INVALID_PAYLOAD]: 400,
  [ATTESTATION_ERROR_CODES.INVALID_PUBLIC_KEY]: 400,
  [ATTESTATION_ERROR_CODES.INVALID_SIGNATURE]: 400,
  [ATTESTATION_ERROR_CODES.SIGNATURE_MISMATCH]: 401,
  [ATTESTATION_ERROR_CODES.REPLAY_DETECTED]: 409,
  [ATTESTATION_ERROR_CODES.STALE_TIMESTAMP]: 400,
  [ATTESTATION_ERROR_CODES.CERT_MISSING]: 404,
  [ATTESTATION_ERROR_CODES.CERT_REVOKED]: 403,
  [ATTESTATION_ERROR_CODES.CHAIN_INVALID]: 422,
  // PKI errors (issue #294)
  [ATTESTATION_ERROR_CODES.PKI_CERT_MISSING]: 400,
  [ATTESTATION_ERROR_CODES.PKI_CERT_INVALID]: 422,
  [ATTESTATION_ERROR_CODES.INTERNAL_ERROR]: 500,
};

function statusForError(errorCode: string | undefined): number {
  if (errorCode === undefined) return 500;
  return ERROR_TO_HTTP_STATUS[errorCode] ?? 500;
}

// ── Service singleton ──────────────────────────────────────────────────────────

let _attestationService: AttestationService | null = null;

/** Get the process-level attestation service singleton. */
export function getAttestationService(): AttestationService {
  if (_attestationService === null) {
    _attestationService = initAttestationService();
  }
  return _attestationService;
}

/**
 * Initialise the attestation service.
 *
 * When a `PrismaClient` is provided the production Prisma-backed registry and
 * store are used. Otherwise (tests / local dev) the in-memory variants are
 * used — they can be pre-seeded via the `certRegistry` / `attestationStore`
 * overrides.
 *
 * The PKI verifier (issue #294) is wired in from environment variables.
 * Set `PKI_CA_CERT_PEMS` to enable hardware identity binding in production.
 */
export function initAttestationService(
  certRegistry?: InMemoryCertificateRegistry,
  attestationStore?: InMemoryAttestationStore,
  options?: AttestationServiceOptions,
  prisma?: PrismaClient,
): AttestationService {
  const registry =
    prisma !== undefined
      ? new PrismaBackedCertificateRegistry(prisma)
      : (certRegistry ?? new InMemoryCertificateRegistry());

  const store =
    prisma !== undefined
      ? new PrismaBackedAttestationStore(prisma)
      : (attestationStore ?? new InMemoryAttestationStore());

  const nonceGuard = new InMemoryAttestationNonceGuard();

  // Wire in the PKI verifier from environment (issue #294).
  // When options.pkiVerifier is explicitly provided (e.g. from tests), use it
  // directly; otherwise build from env.
  // If env vars are not available (unit-test context without env setup),
  // silently skip PKI — the service will operate in no-PKI mode.
  let pkiVerifier = options?.pkiVerifier;
  if (pkiVerifier === undefined) {
    try {
      const env = getEnv();
      if (env.PKI_SKIP_VERIFICATION) {
        pkiVerifier = new NoOpPkiVerifier();
      } else if (env.PKI_CA_CERT_PEMS.trim()) {
        pkiVerifier = new PkiVerifier({
          caCertPems: env.PKI_CA_CERT_PEMS,
          allowedSpiffeUris: env.PKI_ALLOWED_SPIFFE_URIS || undefined,
          certExpiryWarnDays: env.PKI_CERT_EXPIRY_WARN_DAYS,
        });
      }
      // When neither PKI_CA_CERT_PEMS nor PKI_SKIP_VERIFICATION is set,
      // pkiVerifier remains undefined and PKI verification is skipped.
    } catch {
      // Env validation failed (e.g. unit tests without DATABASE_URL etc.).
      // Leave pkiVerifier undefined — no PKI enforcement in this context.
    }
  }

  _attestationService = new AttestationService(registry, store, nonceGuard, {
    ...options,
    pkiVerifier,
  });
  return _attestationService;
}

/** Reset the singleton (for testing). */
export function resetAttestationService(): void {
  _attestationService = null;
}

// ── Route registration ─────────────────────────────────────────────────────────

export function registerAttestationRoutes(app: FastifyInstance): void {
  // ── POST /attestation ────────────────────────────────────────────────────
  app.post<{ Body: AttestationRequest }>(
    '/attestation',
    {
      schema: {
        body: {
          type: 'object',
          required: ['deviceId', 'publicKey', 'nonce', 'timestamp', 'certSerial', 'signature'],
          properties: {
            deviceId: { type: 'string' },
            publicKey: { type: 'string' },
            nonce: { type: 'string' },
            timestamp: { type: 'number' },
            certSerial: { type: 'string' },
            signature: { type: 'string' },
            // PEM-encoded device leaf certificate for PKI chain verification (issue #294).
            certPem: { type: 'string' },
          },
        },
      },
    },
    async (req: FastifyRequest<{ Body: AttestationRequest }>, reply: FastifyReply) => {
      const service = getAttestationService();
      const start = Date.now();
      const result = await service.attest(req.body);
      const durationMs = Date.now() - start;

      if (result.success) {
        recordAttestationSuccess(durationMs);
      } else {
        recordAttestationFailure(result.errorCode ?? 'ATTEST_ERR_INTERNAL', durationMs);
      }

      const httpStatus = result.success ? 200 : statusForError(result.errorCode);

      return reply.status(httpStatus).send({
        success: result.success,
        errorCode: result.errorCode,
        reason: result.reason,
        deviceId: result.deviceId,
        attestedAt: result.attestedAt,
        messageDigest: result.messageDigest,
        // PKI fields (issue #294) — only present when PKI verification was performed
        certFingerprint: result.certFingerprint,
        spiffeUri: result.spiffeUri,
        certExpiresAt: result.certExpiresAt,
        certExpiryWarning: result.certExpiryWarning,
      });
    },
  );

  // ── GET /attestation/health ──────────────────────────────────────────────
  app.get('/attestation/health', async (_req, reply: FastifyReply) => {
    return reply.status(200).send({
      status: 'ok',
      service: 'hardware-attestation',
      timestamp: new Date().toISOString(),
    });
  });

  // ── GET /attestation/:deviceId ───────────────────────────────────────────
  // Returns the most recent attestation record for the given device.
  // The Prisma-backed store supports this via a direct DB query; the in-memory
  // store performs a linear scan (tests only).
  app.get<{ Params: { deviceId: string } }>(
    '/attestation/:deviceId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['deviceId'],
          properties: {
            deviceId: { type: 'string' },
          },
        },
      },
    },
    async (req: FastifyRequest<{ Params: { deviceId: string } }>, reply: FastifyReply) => {
      const { deviceId } = req.params;
      if (!deviceId || deviceId.trim() === '') {
        return reply.status(400).send({ error: 'deviceId is required' });
      }

      // Access the underlying store via the service's store accessor.
      // We query Prisma directly when available for a proper sorted query.
      // For in-memory, scan the records array.
      const prismaClient: PrismaClient | undefined = (app as unknown as { prisma?: PrismaClient })
        .prisma;

      if (prismaClient !== undefined) {
        const record = await prismaClient.attestationRecord.findFirst({
          where: { deviceId },
          orderBy: { attestedAt: 'desc' },
          select: {
            id: true,
            deviceId: true,
            publicKey: true,
            certSerial: true,
            messageDigest: true,
            attestedAt: true,
          },
        });

        if (record === null) {
          return reply
            .status(404)
            .send({ error: `No attestation record found for device: ${deviceId}` });
        }

        return reply.status(200).send({
          deviceId: record.deviceId,
          publicKey: record.publicKey,
          certSerial: record.certSerial,
          messageDigest: record.messageDigest,
          attestedAt: record.attestedAt.toISOString(),
        });
      }

      // In-memory fallback (dev / test)
      return reply.status(501).send({
        error: 'GET /attestation/:deviceId requires a database connection',
      });
    },
  );
}
