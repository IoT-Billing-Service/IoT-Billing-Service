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
 * ## Fault tolerance (issue #292)
 *
 * When the database write fails transiently, the verified request is enqueued
 * on a durable retry queue and the endpoint answers `202 Accepted` with a
 * `Retry-After` hint. A background worker (see {@link IngestionRetryWorker})
 * re-persists the payload with exponential backoff and publishes it to the
 * real-time stream once persisted.
 *
 * ## Error mapping
 *
 * | Error code              | HTTP status | Description                         |
 * |-------------------------|-------------|-------------------------------------|
 * | `SUCCESS`               | 200         | Telemetry ingested successfully     |
 * | `ACCEPTED`              | 202         | Queued for durable async retry      |
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
import {
  IngestionService,
  INGESTION_ERROR_CODES,
  type IngestionServiceOptions,
} from '../../core/ingestion/ingestion_service.js';
import { InMemoryNonceCache, type SignedPayload } from '../../core/ingestion/validator.js';
import { IngestionRetryQueue, type StoredIngestRequest } from '../../core/ingestion/retry_queue.js';
import { IngestionRetryWorker } from '../../core/ingestion/retry_worker.js';
import { DlqManager } from '../../core/dlq_manager.js';
import type { PowSolution } from '../../core/crypto/pow_verifier.js';
import { encryptionKeyFromHex } from '../../core/crypto/e2e_encryption.js';
import { getEnv } from '../../config/env.js';
import {
  TelemetryStreamBus,
  incrementStreamPublished,
  incrementStreamDelivered,
  incrementStreamErrors,
} from '../../core/ingestion/telemetry_stream.js';

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
let retryQueue: IngestionRetryQueue | null = null;
let retryWorker: IngestionRetryWorker | null = null;
let retryDlq: DlqManager | null = null;

function getIngestionService(): IngestionService {
  if (ingestionService === null) {
    throw new Error('Ingestion service not initialized. Call initIngestionService first.');
  }
  return ingestionService;
}

// ── Retry pipeline configuration (issue #292) ─────────────────────────────────

export interface IngestionRetryConfig {
  /** Enable the durable retry pipeline. Default true. */
  enabled?: boolean;
  /** Poll interval (ms) of the retry worker. Default 5000. */
  pollIntervalMs?: number;
  /** Maximum jobs claimed per poll. Default 20. */
  batchSize?: number;
  /** Retry budget (retries after the initial attempt). Default 3. */
  maxRetries?: number;
}

/**
 * Initialise the ingestion service and its dependencies.
 * Call this once during server startup.
 *
 * When the retry pipeline is enabled (default), a durable
 * {@link IngestionRetryQueue} is created, a {@link DlqManager} handler for
 * dead-lettered telemetry is registered, and the {@link IngestionRetryWorker}
 * is constructed (but not started — call `startIngestionRetryWorker` after
 * the server is listening).
 */
export function initIngestionService(
  prisma: PrismaClient,
  nonceCache?: InMemoryNonceCache,
  options: IngestionServiceOptions = {},
  retryConfig: IngestionRetryConfig = {},
): IngestionService {
  const cache = nonceCache ?? new InMemoryNonceCache();
  const env = getEnv();
  const encryptionKey =
    env.E2E_ENCRYPTION_KEY != null && env.E2E_ENCRYPTION_KEY !== ''
      ? encryptionKeyFromHex(env.E2E_ENCRYPTION_KEY)
      : undefined;

  const retryEnabled = retryConfig.enabled ?? true;
  if (retryEnabled) {
    retryQueue = new IngestionRetryQueue(prisma, {
      maxRetries: retryConfig.maxRetries,
    });

    retryDlq = new DlqManager(prisma);
    // Operators can replay dead-lettered telemetry back into the queue.
    retryDlq.registerHandler('telemetry_ingestion', async (payload: unknown): Promise<void> => {
      const stored = (payload as { request?: StoredIngestRequest }).request;
      if (stored === undefined) {
        throw new Error('telemetry_ingestion DLQ payload is missing the request');
      }
      await retryQueue?.enqueue(stored);
    });

    retryWorker = new IngestionRetryWorker(
      retryQueue,
      (job) => getIngestionService().persistVerifiedJob(job),
      {
        pollIntervalMs: retryConfig.pollIntervalMs,
        batchSize: retryConfig.batchSize,
        dlq: retryDlq,
        onCompleted: (job, recordsWritten) => {
          publishTelemetryEvent(job.deviceId, job.stateData.metrics, recordsWritten);
        },
      },
    );
  } else {
    retryQueue = null;
    retryWorker = null;
    retryDlq = null;
  }

  ingestionService = new IngestionService(prisma, cache, {
    ...options,
    encryptionKey,
    // An explicitly injected queue (tests / custom wiring) wins over the
    // module-level pipeline queue.
    retryQueue: options.retryQueue ?? retryQueue ?? undefined,
  });
  return ingestionService;
}

/** Start the retry worker poll loop (after the server is listening). */
export function startIngestionRetryWorker(): void {
  retryWorker?.start();
}

/** Stop the retry worker poll loop. */
export function stopIngestionRetryWorker(): void {
  retryWorker?.stop();
}

/**
 * Reset the ingestion service singleton and the retry pipeline (for testing).
 */
export function resetIngestionService(): void {
  retryWorker?.stop();
  retryWorker = null;
  retryQueue = null;
  retryDlq = null;
  ingestionService = null;
}

/**
 * Publish a validated telemetry event to the real-time stream bus (issue #1).
 * Stream failures are counted but must never surface as ingestion errors.
 */
function publishTelemetryEvent(
  deviceId: string,
  metrics: Record<string, number>,
  recordsWritten: number,
): void {
  try {
    const bus = TelemetryStreamBus.getInstance();
    bus.publish({
      serverTs: new Date().toISOString(),
      deviceId,
      metrics,
      recordsWritten,
    });
    incrementStreamPublished();
    incrementStreamDelivered(recordsWritten);
  } catch {
    incrementStreamErrors();
  }
}

export function registerIngestionRoutes(
  app: FastifyInstance,
  tenantRateLimitMiddleware?: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  /**
   * POST /ingest
   *
   * Ingest a signed telemetry payload with ZK range proof.
   */
  app.post<{ Body: IngestBody }>(
    '/ingest',
    {
      preHandler: tenantRateLimitMiddleware ? [tenantRateLimitMiddleware] : [],
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

      if (result.accepted === true) {
        // Persistence deferred to the durable retry queue (issue #292).
        const retryAfterSeconds = Math.max(1, Math.ceil((result.retryAfterMs ?? 100) / 1000));
        void reply.header('Retry-After', String(retryAfterSeconds));
        return reply.status(202).send({
          success: true,
          accepted: true,
          jobId: result.jobId,
          retryAfterMs: result.retryAfterMs,
          deviceId: result.deviceId,
          recordsWritten: 0,
        });
      }

      // Publish validated telemetry to the real-time stream bus (Issue #1).
      // Only successful ingestion events are forwarded to SSE clients;
      // validation failures are counted but not streamed.
      if (result.success && result.deviceId !== undefined) {
        const metrics: Record<string, number> = {};
        for (const [k, v] of Object.entries(payload.metrics ?? {})) {
          const n = typeof v === 'number' ? v : Number(v);
          if (!Number.isNaN(n)) metrics[k] = n;
        }
        publishTelemetryEvent(result.deviceId, metrics, result.recordsWritten ?? 0);
      }

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
