/**
 * Ingestion orchestration service.
 *
 * Ties together the full ingestion pipeline:
 *
 * ```
 * Ingest payload
 *   ├── 1. Quick-reject malformed proof buffers
 *   ├── 2. Verify PoW solution (anti-spam / computational cost)
 *   ├── 3. Verify Ed25519 signature (authenticity)
 *   ├── 4. Verify ZK range proof (privacy)
 *   ├── 5. Enforce metric bounds (privacy violation check)
 *   ├── 6. Write telemetry to DB via Prisma (transactional)
 *   └── 7. Return result
 * ```
 *
 * Every step is kept synchronous where possible to stay under the 10ms
 * ingestion budget.  Only the Prisma write and nonce cache touch async I/O.
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import nacl from 'tweetnacl';
import { ZkRangeProofVerifier } from '../crypto/zk_verifier.js';
import { PowVerifier, type PowSolution, DEFAULT_DIFFICULTY } from '../crypto/pow_verifier.js';
import { decryptSensitiveFields, type EncryptionKey } from '../crypto/e2e_encryption.js';
import { MetricBoundsEnforcer, PRIVACY_VIOLATION_ERROR_CODE } from '../../config/metric_ranges.js';
import {
  validateSignature,
  buildSignedMessage,
  type SignedPayload,
  type NonceCache,
} from './validator.js';
import type { IngestionRetryQueue, IngestionRetryJob, StoredIngestRequest } from './retry_queue.js';
import {
  DeviceDisabledError,
  DeviceNotFoundError,
  PayloadIntegrityError,
  isPermanentIngestionError,
} from './errors.js';
import { incrementIngestionRetryJobsEnqueued } from '../../api/metrics/prometheus.js';

// ── Error codes ────────────────────────────────────────────────────────────────

/**
 * Machine-readable error codes returned by the ingestion service.
 * These are the logical codes; the HTTP layer maps them to appropriate statuses.
 */
export const INGESTION_ERROR_CODES = {
  SUCCESS: 'SUCCESS',
  INVALID_PROOF: 'ERR_INVALID_PROOF',
  SIGNATURE_MISMATCH: 'ERR_SIGNATURE_MISMATCH',
  REPLAY_DETECTED: 'ERR_REPLAY_DETECTED',
  PRIVACY_VIOLATION: PRIVACY_VIOLATION_ERROR_CODE,
  DEVICE_NOT_FOUND: 'ERR_DEVICE_NOT_FOUND',
  DEVICE_DISABLED: 'ERR_DEVICE_DISABLED',
  STALE_TIMESTAMP: 'ERR_STALE_TIMESTAMP',
  INVALID_PAYLOAD: 'ERR_INVALID_PAYLOAD',
  POW_VERIFICATION_FAILED: 'ERR_POW_VERIFICATION_FAILED',
  INTERNAL_ERROR: 'ERR_INTERNAL',
} as const;

export type IngestionErrorCode = (typeof INGESTION_ERROR_CODES)[keyof typeof INGESTION_ERROR_CODES];

// ── Types ──────────────────────────────────────────────────────────────────────

export interface IngestMetricsRequest {
  /** Signed telemetry payload (Ed25519). */
  payload: SignedPayload;
  /** Device's Ed25519 public key as a hex string or raw bytes. */
  publicKey: string | Uint8Array;
  /** 64-byte ZK range proof buffer base64-encoded or raw. */
  proof: string | Buffer;
  /** Proof-of-work solution demonstrating computational work. */
  powSolution: PowSolution;
}

export interface TelemetryEntry {
  metricId: number;
  metricValue: number;
}

export interface IngestMetricsResult {
  success: boolean;
  /** True when the payload passed verification but persistence was deferred
   *  to the durable retry queue (issue #292). The client should treat this as
   *  an acceptance, not an error. */
  accepted?: boolean;
  /** Durable retry job id, present when `accepted` is true. */
  jobId?: string;
  /** Hint (ms) before the client should consider the job still in flight. */
  retryAfterMs?: number;
  errorCode?: IngestionErrorCode;
  reason?: string;
  /** Number of telemetry records persisted. */
  recordsWritten?: number;
  /** Parsed device ID from the payload. */
  deviceId?: string;
}

// ── Options ────────────────────────────────────────────────────────────────────

export interface IngestionServiceOptions {
  /** If true, skip the optional ZK proof verification (not recommended). */
  skipProofVerification?: boolean;
  /** If true, skip the PoW verification (not recommended for production). */
  skipPowVerification?: boolean;
  /** Override the default PoW difficulty level. */
  powDifficulty?: number;
  /**
   * End-to-end encryption key for decrypting sensitive payload fields
   * (issue #89). When set, the ingestion service will decrypt encrypted
   * metric values after signature verification. Optional — without this
   * key, encrypted fields are left as-is.
   */
  encryptionKey?: EncryptionKey;
  /**
   * Durable retry queue (issue #292). When set, a transient persistence
   * failure that survives the fast in-flight retries is enqueued and the
   * request is accepted (HTTP 202) instead of failing with ERR_INTERNAL.
   */
  retryQueue?: IngestionRetryQueue;
  /**
   * Number of fast in-flight persistence retries before falling back to the
   * durable queue. Default 2. Kept small so the ingest hot path stays well
   * under the 200 ms P99 budget.
   */
  maxFastRetries?: number;
  /** Base delay (ms) between fast in-flight retries. Default 10. */
  fastRetryBaseDelayMs?: number;
  /** Maximum delay (ms) for a fast in-flight retry. Default 100. */
  fastRetryMaxDelayMs?: number;
}

// ── Service ────────────────────────────────────────────────────────────────────

/** Default number of fast in-flight persistence retries (issue #292). */
const DEFAULT_MAX_FAST_RETRIES = 2;
/** Default base delay (ms) between fast in-flight persistence retries. */
const DEFAULT_FAST_RETRY_BASE_MS = 10;
/** Default cap (ms) for a single fast in-flight persistence retry delay. */
const DEFAULT_FAST_RETRY_MAX_MS = 100;

/**
 * Main ingestion orchestrator.
 *
 * Every public method is fully synchronous except for the Prisma write step.
 * The verification pipeline short-circuits at the first failure to minimise
 * CPU waste.
 *
 * ## Fault tolerance (issue #292)
 *
 * The persistence step is wrapped in a small fast-retry loop (default 2
 * retries, sub-100 ms backoff) that absorbs short-lived DB blips on the hot
 * path. When the durable {@link IngestionRetryQueue} is configured and the
 * fast retries are exhausted, the fully-verified request is enqueued and the
 * call returns `accepted: true` so nothing is lost — the background worker
 * re-persists it with exponential backoff.
 */
export class IngestionService {
  private readonly verifier = new ZkRangeProofVerifier();
  private readonly powVerifier: PowVerifier;
  private readonly boundsEnforcer = new MetricBoundsEnforcer();

  /** Cached encryption key bytes for rapid decryption on the hot path. */
  private readonly encryptionKeyRaw: Uint8Array | null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly nonceCache: NonceCache,
    private readonly options: IngestionServiceOptions = {},
  ) {
    this.powVerifier = new PowVerifier(options.powDifficulty ?? DEFAULT_DIFFICULTY);
    this.encryptionKeyRaw = options.encryptionKey?.raw ?? null;
  }

  /**
   * Ingest a single telemetry payload.
   *
   * Steps:
   * 1. **Quick-reject** malformed proof buffers (< 1 µs)
   * 2. **Resolve public key** from hex / raw bytes
   * 3. **Verify PoW solution** — validates computational work (anti-spam)
   * 4. **Verify Ed25519 signature** (authenticity + nonce replay)
   * 5. **Verify ZK range proof** — validates value commitment
   * 6. **Enforce metric bounds** — short-circuit on PRIVACY_VIOLATION
   * 7. **Persist telemetry** via Prisma transaction
   */
  async ingestTelemetry(request: IngestMetricsRequest): Promise<IngestMetricsResult> {
    try {
      // ── Step 0: Resolve proof buffer ───────────────────────────────────
      let proofBuffer: Buffer;
      if (typeof request.proof === 'string') {
        proofBuffer = Buffer.from(request.proof, 'base64');
      } else {
        proofBuffer = request.proof;
      }

      // ── Step 1: Quick-reject malformed proofs ──────────────────────────
      const quickCheck = this.verifier.quickReject(proofBuffer);
      if (!quickCheck.valid) {
        return {
          success: false,
          errorCode: INGESTION_ERROR_CODES.INVALID_PROOF,
          reason: quickCheck.reason,
        };
      }

      // ── Step 2: Resolve public key ──────────────────────────────────────
      const publicKeyBytes: Uint8Array =
        typeof request.publicKey === 'string'
          ? Buffer.from(request.publicKey, 'hex')
          : request.publicKey;

      if (publicKeyBytes.length !== 32) {
        return {
          success: false,
          errorCode: INGESTION_ERROR_CODES.INVALID_PAYLOAD,
          reason: `Invalid public key length: expected 32 bytes, got ${String(publicKeyBytes.length)}`,
        };
      }

      // ── Step 3: Verify PoW solution ───────────────────────────────────────
      // PoW is checked early to reject spam before performing expensive
      // cryptographic operations (signature, ZK proof verification).
      if (this.options.skipPowVerification !== true) {
        const powResult = this.powVerifier.quickReject(request.powSolution);
        if (!powResult.valid) {
          return {
            success: false,
            errorCode: INGESTION_ERROR_CODES.POW_VERIFICATION_FAILED,
            reason: powResult.reason,
            deviceId: request.payload.deviceId,
          };
        }

        const powVerifyResult = this.powVerifier.verify(
          request.payload.deviceId,
          request.payload.timestamp,
          request.powSolution,
        );
        if (!powVerifyResult.valid) {
          return {
            success: false,
            errorCode: INGESTION_ERROR_CODES.POW_VERIFICATION_FAILED,
            reason: powVerifyResult.reason,
            deviceId: request.payload.deviceId,
          };
        }
      }

      // ── Step 4: Verify Ed25519 signature + nonce replay ────────────────
      const sigResult = validateSignature(publicKeyBytes, request.payload);
      if (!sigResult.valid) {
        const errorCode =
          sigResult.reason?.includes('replay') === true
            ? INGESTION_ERROR_CODES.REPLAY_DETECTED
            : sigResult.reason?.includes('signature') === true
              ? INGESTION_ERROR_CODES.SIGNATURE_MISMATCH
              : sigResult.reason?.includes('Timestamp') === true
                ? INGESTION_ERROR_CODES.STALE_TIMESTAMP
                : INGESTION_ERROR_CODES.INVALID_PAYLOAD;

        return {
          success: false,
          errorCode,
          reason: sigResult.reason,
          deviceId: request.payload.deviceId,
        };
      }

      // ── Step 5: Decrypt E2E-encrypted fields ────────────────────────────
      // After signature verification (which proves the payload hasn't been
      // tampered with), we decrypt any sensitive fields that were encrypted
      // by the device. This happens before ZK verification so the proofs
      // are checked against the decrypted plaintext values.
      const metrics = request.payload.metrics as Record<string, number>;

      if (this.encryptionKeyRaw !== null && request.payload.encrypted !== undefined) {
        const encryptedFields = request.payload.encrypted;
        const { decrypted, failures } = decryptSensitiveFields(
          encryptedFields,
          this.encryptionKeyRaw,
        );

        if (Object.keys(failures).length > 0) {
          const failSummary = Object.entries(failures)
            .map(([k, v]) => `${k}: ${v}`)
            .join('; ');
          return {
            success: false,
            errorCode: INGESTION_ERROR_CODES.INVALID_PAYLOAD,
            reason: `E2E decryption failed: ${failSummary}`,
            deviceId: request.payload.deviceId,
          };
        }

        // Merge decrypted values into metrics, overwriting any placeholders.
        for (const [key, value] of Object.entries(decrypted)) {
          const parsed = Number(value);
          if (!Number.isNaN(parsed)) {
            metrics[key] = parsed;
          }
        }
      }

      // ── Step 6: Verify ZK range proof ───────────────────────────────────
      // We verify against the metric_ranges bounds.  Each metric value in the
      // payload is checked on a per-key basis against the relevant range.
      if (this.options.skipProofVerification !== true) {
        for (const [metricName, metricValue] of Object.entries(metrics)) {
          const boundary = this.boundsEnforcer.getBoundary(metricName);
          if (boundary === undefined) continue; // skip unknown metrics

          const lowerBound = boundary.lowerBound;
          const upperBound = boundary.upperBound;
          const bigValue = BigInt(Math.round(metricValue));

          const proofResult = this.verifier.verifyRangeProofStrict(
            proofBuffer,
            request.payload.deviceId,
            lowerBound,
            upperBound,
            bigValue,
          );

          if (!proofResult.valid) {
            return {
              success: false,
              errorCode: INGESTION_ERROR_CODES.INVALID_PROOF,
              reason: `ZK range proof failed for "${metricName}" (${String(metricValue)}): ${proofResult.reason ?? 'unknown verification error'}`,
              deviceId: request.payload.deviceId,
            };
          }
        }
      }

      // ── Step 7: Enforce metric bounds (privacy violation gate) ──────────
      const boundsResult = this.boundsEnforcer.enforceBatch(metrics);
      if (!boundsResult.allowed) {
        return {
          success: false,
          errorCode: INGESTION_ERROR_CODES.PRIVACY_VIOLATION,
          reason: boundsResult.reason,
          deviceId: request.payload.deviceId,
        };
      }

      // ── Step 8: Persist telemetry via Prisma transaction ────────────────
      // Fault-tolerant (issue #292): transient DB failures are retried a few
      // times in-flight; if they persist and a durable queue is configured,
      // the verified request is enqueued and the call is accepted (202).
      try {
        const recordsWritten = await this.persistWithFastRetry(request.payload.deviceId, metrics);
        return {
          success: true,
          deviceId: request.payload.deviceId,
          recordsWritten,
        };
      } catch (persistErr) {
        if (persistErr instanceof DeviceNotFoundError) {
          return {
            success: false,
            errorCode: INGESTION_ERROR_CODES.DEVICE_NOT_FOUND,
            reason: persistErr.message,
            deviceId: request.payload.deviceId,
          };
        }
        if (persistErr instanceof DeviceDisabledError) {
          return {
            success: false,
            errorCode: INGESTION_ERROR_CODES.DEVICE_DISABLED,
            reason: persistErr.message,
            deviceId: request.payload.deviceId,
          };
        }
        // Permanent failures other than device state must not be enqueued.
        if (isPermanentIngestionError(persistErr)) {
          return {
            success: false,
            errorCode: INGESTION_ERROR_CODES.INTERNAL_ERROR,
            reason: `Ingestion internal error: ${String(persistErr)}`,
          };
        }

        // Transient failure that survived the fast retries.
        if (this.options.retryQueue !== undefined) {
          const jobId = await this.enqueueVerifiedRequest(request, proofBuffer, metrics);
          return {
            success: true,
            accepted: true,
            jobId,
            retryAfterMs: this.options.fastRetryMaxDelayMs ?? DEFAULT_FAST_RETRY_MAX_MS,
            deviceId: request.payload.deviceId,
            recordsWritten: 0,
          };
        }

        // No durable queue configured — preserve the legacy hard-fail path.
        throw persistErr;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        errorCode: INGESTION_ERROR_CODES.INTERNAL_ERROR,
        reason: `Ingestion internal error: ${message}`,
      };
    }
  }

  /**
   * Re-persist a queued ingestion job (issue #292). Called by the retry
   * worker. The queued request is re-verified cheaply before the DB write:
   *
   * 1. **Integrity** — the stored payload digest must match a fresh digest of
   *    the stored request; JSONB key reordering is neutralised by canonical
   *    serialisation.
   * 2. **Authenticity** — the Ed25519 signature must still verify over the
   *    exact signed message bytes captured at enqueue time.
   * 3. **Bounds** — the (re-checked) metric values must still be in range.
   *
   * The sliding-window nonce/timestamp checks are intentionally NOT re-run:
   * the payload already passed them on the hot path, and a delayed retry
   * would fail the timestamp window for legitimate reasons.
   *
   * @returns the number of telemetry records persisted.
   */
  async persistVerifiedJob(job: IngestionRetryJob): Promise<number> {
    const stored = job.stateData;

    const freshDigest = sha256Hex(
      canonicalJson({
        payload: stored.payload,
        publicKey: stored.publicKey,
        proof: stored.proof,
        powSolution: stored.powSolution,
        metrics: stored.metrics,
        signedMessage: stored.signedMessage,
        verifiedAt: stored.verifiedAt,
      }),
    );
    if (freshDigest !== stored.payloadDigest) {
      throw new PayloadIntegrityError(job.id);
    }

    const publicKeyBytes = Buffer.from(stored.publicKey, 'hex');
    if (publicKeyBytes.length !== 32) {
      throw new PayloadIntegrityError(job.id);
    }

    const sigBytes = Buffer.from(stored.payload.signature, 'hex');
    const signatureValid = nacl.sign.detached.verify(
      Buffer.from(stored.signedMessage, 'utf-8'),
      sigBytes,
      publicKeyBytes,
    );
    if (!signatureValid) {
      throw new PayloadIntegrityError(job.id);
    }

    // Defense-in-depth: re-enforce metric bounds on the stored plaintext.
    const boundsResult = this.boundsEnforcer.enforceBatch(stored.metrics);
    if (!boundsResult.allowed) {
      throw new PayloadIntegrityError(job.id);
    }

    return this.persistTelemetry(stored.payload.deviceId, stored.metrics);
  }

  // ── Private fault-tolerant persistence (issue #292) ──────────────────────

  /**
   * Persist with a small number of fast in-flight retries for transient
   * failures. Permanent failures (device not found / disabled) propagate
   * immediately; transient failures retry with capped exponential backoff
   * and re-throw once the budget is exhausted.
   */
  private async persistWithFastRetry(
    deviceId: string,
    metrics: Record<string, number>,
  ): Promise<number> {
    const maxFastRetries = this.options.maxFastRetries ?? DEFAULT_MAX_FAST_RETRIES;
    const baseDelayMs = this.options.fastRetryBaseDelayMs ?? DEFAULT_FAST_RETRY_BASE_MS;
    const maxDelayMs = this.options.fastRetryMaxDelayMs ?? DEFAULT_FAST_RETRY_MAX_MS;

    let attempt = 0;
    for (;;) {
      try {
        return await this.persistTelemetry(deviceId, metrics);
      } catch (err) {
        if (isPermanentIngestionError(err)) {
          throw err;
        }
        attempt += 1;
        if (attempt > maxFastRetries) {
          throw err;
        }
        const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
        await this.sleep(delayMs);
      }
    }
  }

  /**
   * Persist the fully-verified request to the durable retry queue. The
   * exact signed message bytes and the final verified metrics are captured
   * so the retry worker can re-verify and re-persist without re-running the
   * expensive checks or re-deriving decrypted values.
   */
  private async enqueueVerifiedRequest(
    request: IngestMetricsRequest,
    proofBuffer: Buffer,
    metrics: Record<string, number>,
  ): Promise<string> {
    const queue = this.options.retryQueue;
    if (queue === undefined) {
      throw new Error('retryQueue is not configured');
    }

    const publicKeyHex =
      typeof request.publicKey === 'string'
        ? request.publicKey
        : Buffer.from(request.publicKey).toString('hex');

    const signedMessage = buildSignedMessage(request.payload).toString('utf-8');
    const stored: StoredIngestRequest = {
      payload: request.payload,
      publicKey: publicKeyHex,
      proof: proofBuffer.toString('base64'),
      powSolution: request.powSolution,
      metrics,
      signedMessage,
      verifiedAt: Date.now(),
      payloadDigest: '',
    };
    stored.payloadDigest = sha256Hex(
      canonicalJson({
        payload: stored.payload,
        publicKey: stored.publicKey,
        proof: stored.proof,
        powSolution: stored.powSolution,
        metrics: stored.metrics,
        signedMessage: stored.signedMessage,
        verifiedAt: stored.verifiedAt,
      }),
    );

    const jobId = await queue.enqueue(stored);
    incrementIngestionRetryJobsEnqueued();
    return jobId;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ── Private persistence ──────────────────────────────────────────────────

  /**
   * Persist metrics as telemetry records inside a single Prisma transaction.
   * Uses `metricId` derived from the metric name hash (simplified mapping).
   */
  private async persistTelemetry(
    deviceId: string,
    metrics: Record<string, number>,
  ): Promise<number> {
    // Look up the device to ensure it exists and is enabled.
    const device = await this.prisma.device.findUnique({
      where: { serial: deviceId },
    });

    if (!device) {
      throw new DeviceNotFoundError(deviceId);
    }

    if (!device.enabled) {
      throw new DeviceDisabledError(deviceId);
    }

    const entries = Object.entries(metrics).map(([metricName, metricValue]) => {
      // Derive a stable metric ID from the name (1-based).
      const metricId = this.metricNameToId(metricName);
      return { deviceId: device.id, metricId, metricValue };
    });

    // Batch insert telemetry data in a transaction.
    await this.prisma.$transaction(
      entries.map((entry) =>
        this.prisma.telemetryData.create({
          data: {
            deviceId: entry.deviceId,
            metricId: entry.metricId,
            metricValue: entry.metricValue,
          },
        }),
      ),
    );

    return entries.length;
  }

  /**
   * Derive a stable positive integer ID from a metric name.
   * Uses FNV-1a 32-bit hash, masked to positive range.
   */
  private metricNameToId(name: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < name.length; i++) {
      hash ^= name.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    // Ensure positive int32
    return (hash & 0x7fffffff) % 10000;
  }
}

/**
 * Serialise an arbitrary JSON value with keys sorted recursively.
 *
 * Postgres JSONB does not preserve object key order, so a digest computed
 * over `JSON.stringify` would change after a round-trip through the store.
 * Sorting keys makes the digest stable regardless of JSONB normalisation.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const body = keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 hex digest of a UTF-8 string. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex');
}

/**
 * Convenience function to extract typed metrics from a SignedPayload.
 * Returns `{}` if the `metrics` field is missing or not a record.
 */
export function extractMetrics(payload: SignedPayload): Record<string, number> {
  const raw = payload.metrics as Record<string, number | string> | undefined;
  const result: Record<string, number> = {};
  for (const [key, val] of Object.entries(raw ?? {})) {
    if (typeof val === 'number') {
      result[key] = val;
    } else if (typeof val === 'string') {
      const parsed = Number(val);
      if (!Number.isNaN(parsed)) {
        result[key] = parsed;
      }
    }
  }
  return result;
}
