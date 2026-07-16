/**
 * Ingestion HTTP route.
 *
 * `POST /ingest` — the primary entry point for device telemetry.
 *
 * Accepts a signed payload with a ZK range proof, runs the full ingestion
 * pipeline (signature verification, proof verification, bounds enforcement,
 * database persistence), and returns a structured response.
 *
 * ## Rate limiting
 *
 * This endpoint should be placed behind the rate limiter middleware.  Devices
 * that exceed their rate budget receive a 429 and should back off.
 *
 * ## Error mapping
 *
 * | Error code              | HTTP status | Description                         |
 * |-------------------------|-------------|-------------------------------------|
 * | `SUCCESS`               | 200         | Telemetry ingested successfully     |
 * | `ERR_INVALID_PROOF`     | 400         | Malformed or tampered proof buffer  |
 * | `ERR_SIGNATURE_MISMATCH`| 401         | Ed25519 signature verification fail |
 * | `ERR_REPLAY_DETECTED`   | 409         | Nonce already consumed (replay)     |
 * | `PRIVACY_VIOLATION`     | 422         | Metric value outside physical range |
 * | `DEVICE_NOT_FOUND`      | 404         | Device serial not registered        |
 * | `DEVICE_DISABLED`       | 403         | Device is disabled                  |
 * | `INVALID_PAYLOAD`       | 400         | Payload schema validation failure   |
 * | `ERR_POW_VERIFICATION_FAILED` | 400 | Proof-of-work verification failed  |
 * | `ERR_INTERNAL`          | 500         | Unexpected server error             |
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { IngestionService, INGESTION_ERROR_CODES } from '../../core/ingestion/ingestion_service.js';
import { InMemoryNonceCache, type SignedPayload } from '../../core/ingestion/validator.js';
import type { PowSolution } from '../../core/crypto/pow_verifier.js';

// ── Schema ─────────────────────────────────────────────────────────────────────

interface IngestBody {
  /** Signed telemetry payload. */
  payload: SignedPayload;
  /** Device Ed25519 public key (hex-encoded, 64 hex chars = 32 bytes). */
  publicKey: string;
  /** 64-byte ZK range proof buffer (base64-encoded, 88 base64 chars). */
  proof: string;
  /** Proof-of-work solution (nonce + difficulty). */
  powSolution: PowSolution;
}

// ── HTTP status mapping ────────────────────────────────────────────────────────

const ERROR_TO_HTTP_STATUS: Record<string, number> = {
  [INGESTION_ERROR_CODES.INVALID_PROOF]: 400,
  [INGESTION_ERROR_CODES.SIGNATURE_MISMATCH]: 401,
  [INGESTION_ERROR_CODES.REPLAY_DETECTED]: 409,
  [INGESTION_ERROR_CODES.STALE_TIMESTAMP]: 400,
  [INGESTION_ERROR_CODES.PRIVACY_VIOLATION]: 422,
  [INGESTION_ERROR_CODES.DEVICE_NOT_FOUND]: 404,
  [INGESTION_ERROR_CODES.DEVICE_DISABLED]: 403,
  [INGESTION_ERROR_CODES.INVALID_PAYLOAD]: 400,
  [INGESTION_ERROR_CODES.POW_VERIFICATION_FAILED]: 400,
  [INGESTION_ERROR_CODES.INTERNAL_ERROR]: 500,
};

function statusForError(errorCode: string | undefined): number {
  if (errorCode === undefined) return 500;
  return ERROR_TO_HTTP_STATUS[errorCode] ?? 500;
}

// ── Route registration ─────────────────────────────────────────────────────────

let ingestionService: IngestionService | null = null;

function getIngestionService(): IngestionService {
  if (ingestionService === null) {
    throw new Error('Ingestion service not initialized. Call initIngestionService first.');
  }
  return ingestionService;
}

/**
 * Initialise the ingestion service and its dependencies.
 * Call this once during server startup.
 */
export function initIngestionService(
  prisma: PrismaClient,
  nonceCache?: InMemoryNonceCache,
): IngestionService {
  const cache = nonceCache ?? new InMemoryNonceCache();
  ingestionService = new IngestionService(prisma, cache);
  return ingestionService;
}

/**
 * Reset the ingestion service singleton (for testing).
 */
export function resetIngestionService(): void {
  ingestionService = null;
}

export function registerIngestionRoutes(app: FastifyInstance): void {
  /**
   * POST /ingest
   *
   * Ingest a signed telemetry payload with ZK range proof.
   */
  app.post<{ Body: IngestBody }>(
    '/ingest',
    {
      schema: {
        body: {
          type: 'object',
          required: ['payload', 'publicKey', 'proof', 'powSolution'],
          properties: {
            payload: { type: 'object' },
            publicKey: { type: 'string' },
            proof: { type: 'string' },
            powSolution: {
              type: 'object',
              required: ['nonce', 'difficulty'],
              properties: {
                nonce: { type: 'string' },
                difficulty: { type: 'number' },
              },
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: IngestBody }>, reply: FastifyReply) => {
      const { payload, publicKey, proof, powSolution } = request.body;

      // Basic payload shape validation.
      if (typeof payload.deviceId !== 'string') {
        return reply.status(400).send({
          success: false,
          error: INGESTION_ERROR_CODES.INVALID_PAYLOAD,
          reason: 'Missing or invalid deviceId in payload',
        });
      }

      const svc = getIngestionService();
      const result = await svc.ingestTelemetry({
        payload,
        publicKey,
        proof,
        powSolution,
      });

      const httpStatus = result.success ? 200 : statusForError(result.errorCode);

      return reply.status(httpStatus).send({
        success: result.success,
        errorCode: result.errorCode,
        reason: result.reason,
        deviceId: result.deviceId,
        recordsWritten: result.recordsWritten,
      });
    },
  );
}
