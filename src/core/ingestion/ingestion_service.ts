/**
 * Ingestion orchestration service.
 *
 * Ties together the full ingestion pipeline:
 *
 * ```
 * Ingest payload
 *   ├── 1. Quick-reject malformed proof buffers
 *   ├── 2. Verify Ed25519 signature (authenticity)
 *   ├── 3. Verify ZK range proof (privacy)
 *   ├── 4. Enforce metric bounds (privacy violation check)
 *   ├── 5. Write telemetry to DB via Prisma (transactional)
 *   └── 6. Return result
 * ```
 *
 * Every step is kept synchronous where possible to stay under the 10ms
 * ingestion budget.  Only the Prisma write and nonce cache touch async I/O.
 */

import { Buffer } from 'node:buffer';
import type { PrismaClient } from '@prisma/client';
import { ZkRangeProofVerifier } from '../crypto/zk_verifier.js';
import { MetricBoundsEnforcer, PRIVACY_VIOLATION_ERROR_CODE } from '../../config/metric_ranges.js';
import { validateSignature, type SignedPayload, type NonceCache } from './validator.js';

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
}

export interface TelemetryEntry {
  metricId: number;
  metricValue: number;
}

export interface IngestMetricsResult {
  success: boolean;
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
}

// ── Service ────────────────────────────────────────────────────────────────────

/**
 * Main ingestion orchestrator.
 *
 * Every public method is fully synchronous except for the Prisma write step.
 * The verification pipeline short-circuits at the first failure to minimise
 * CPU waste.
 */
export class IngestionService {
  private readonly verifier = new ZkRangeProofVerifier();
  private readonly boundsEnforcer = new MetricBoundsEnforcer();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly nonceCache: NonceCache,
    private readonly options: IngestionServiceOptions = {},
  ) {}

  /**
   * Ingest a single telemetry payload.
   *
   * Steps:
   * 1. **Quick-reject** malformed proof buffers (< 1 µs)
   * 2. **Resolve public key** from hex / raw bytes
   * 3. **Verify Ed25519 signature** (authenticity + nonce replay)
   * 4. **Verify ZK range proof** — validates value commitment
   * 5. **Enforce metric bounds** — short-circuit on PRIVACY_VIOLATION
   * 6. **Persist telemetry** via Prisma transaction
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

      // ── Step 3: Verify Ed25519 signature + nonce replay ────────────────
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

      // ── Step 4: Verify ZK range proof ───────────────────────────────────
      // We verify against the metric_ranges bounds.  Each metric value in the
      // payload is checked on a per-key basis against the relevant range.
      const metrics = request.payload.metrics as Record<string, number>;

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

      // ── Step 5: Enforce metric bounds (privacy violation gate) ──────────
      const boundsResult = this.boundsEnforcer.enforceBatch(metrics);
      if (!boundsResult.allowed) {
        return {
          success: false,
          errorCode: INGESTION_ERROR_CODES.PRIVACY_VIOLATION,
          reason: boundsResult.reason,
          deviceId: request.payload.deviceId,
        };
      }

      // ── Step 6: Persist telemetry via Prisma transaction ────────────────
      const recordsWritten = await this.persistTelemetry(request.payload.deviceId, metrics);

      return {
        success: true,
        deviceId: request.payload.deviceId,
        recordsWritten,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        errorCode: INGESTION_ERROR_CODES.INTERNAL_ERROR,
        reason: `Ingestion internal error: ${message}`,
      };
    }
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
      throw new Error(`Device not found: ${deviceId}`);
    }

    if (!device.enabled) {
      throw new Error(`Device disabled: ${deviceId}`);
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
