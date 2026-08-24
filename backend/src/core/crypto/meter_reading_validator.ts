/**
 * MeterReadingValidator — Issue #293: Meter Reading Validation Against Cryptographic Proofs
 *
 * Validates individual meter readings by combining two independent cryptographic
 * verification mechanisms:
 *
 *  1. **Ed25519 signature** — proves the reading was produced by the device that
 *     holds the corresponding private key. Uses tweetnacl's `nacl.sign.detached.verify`,
 *     the same primitive employed throughout the ingestion pipeline.
 *
 *  2. **ZK range proof** — proves the reading value lies within the declared
 *     [lowerBound, upperBound] interval without revealing the raw value beyond
 *     what's included in the payload. Uses the existing {@link ZkRangeProofVerifier}.
 *
 * Both checks are fully synchronous and complete in < 100 µs under typical
 * conditions, keeping the service within the 200 ms P99 billing-operations
 * budget with ample headroom.
 *
 * Prometheus metrics are emitted for validation latency, results, and totals
 * so SLO dashboards can track validation pass/fail rates per device.
 */

import { Buffer } from 'node:buffer';
import nacl from 'tweetnacl';
import { Counter, Histogram, type Registry } from 'prom-client';
import {
  ZkRangeProofVerifier,
  VERIFIER_ERROR_CODES,
  type VerificationResult,
} from './zk_verifier.js';

// ── Error codes ────────────────────────────────────────────────────────────────

/**
 * Machine-readable error codes for meter reading validation failures.
 * All codes are prefixed with `ERR_` for consistency with the rest of the
 * ingestion pipeline.
 */
export const METER_VALIDATION_ERROR_CODES = {
  /** Reading value is outside the declared [lowerBound, upperBound] interval. */
  OUT_OF_RANGE: 'ERR_METER_OUT_OF_RANGE',
  /** Ed25519 signature length is not 64 bytes. */
  INVALID_SIGNATURE_LENGTH: 'ERR_METER_INVALID_SIGNATURE_LENGTH',
  /** Public key length is not 32 bytes. */
  INVALID_PUBLIC_KEY: 'ERR_METER_INVALID_PUBLIC_KEY',
  /** Ed25519 signature verification failed. */
  SIGNATURE_MISMATCH: 'ERR_METER_SIGNATURE_MISMATCH',
  /** ZK range proof failed to decode (not valid base64 or raw buffer). */
  PROOF_DECODE_FAILED: 'ERR_METER_PROOF_DECODE_FAILED',
  /** ZK range proof quick-reject: wrong byte length. */
  PROOF_INVALID_LENGTH: VERIFIER_ERROR_CODES.INVALID_LENGTH,
  /** ZK range proof challenge segment mismatch. */
  PROOF_CHALLENGE_MISMATCH: VERIFIER_ERROR_CODES.CHALLENGE_MISMATCH,
  /** ZK range proof response segment mismatch. */
  PROOF_RESPONSE_MISMATCH: VERIFIER_ERROR_CODES.RESPONSE_MISMATCH,
  /** lowerBound >= upperBound in proof parameters. */
  INVALID_RANGE_BOUNDS: VERIFIER_ERROR_CODES.INVALID_RANGE,
  /** Both checks failed (should not normally occur — the first failure short-circuits). */
  COMBINED_FAILURE: 'ERR_METER_COMBINED_FAILURE',
} as const;

export type MeterValidationErrorCode =
  (typeof METER_VALIDATION_ERROR_CODES)[keyof typeof METER_VALIDATION_ERROR_CODES];

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * A single meter reading to be validated.
 *
 * The `signature` covers a canonical JSON serialisation of the reading fields
 * (excluding `signature` itself):
 *
 * ```json
 * {"deviceId":"<id>","metricId":"<id>","value":"<bigint string>",
 *  "timestamp":<unix ms>,"lowerBound":"<bigint>","upperBound":"<bigint>"}
 * ```
 *
 * The `rangeProof` is the 64-byte ZK proof buffer produced by
 * {@link RangeProofGenerator.generate}, encoded as base64 or supplied as a
 * raw Buffer.
 */
export interface MeterReading {
  /** Unique device identifier — bound into the ZK challenge. */
  deviceId: string;
  /** Metric identifier (e.g. `"energy_kwh"`, `"water_litres"`). */
  metricId: string;
  /**
   * The raw meter value. Use `bigint` for lossless representation of large
   * integer meter readings.
   */
  value: bigint;
  /** Unix epoch timestamp in milliseconds when the reading was recorded. */
  timestamp: number;
  /** Inclusive lower bound for the expected value range. */
  lowerBound: bigint;
  /** Inclusive upper bound for the expected value range. */
  upperBound: bigint;
  /**
   * Ed25519 signature over the canonical JSON fields (hex-encoded, 64 bytes
   * = 128 hex chars).
   */
  signature: string;
  /**
   * ZK range proof — either a base64-encoded string (as produced by
   * {@link ZkBillingEngine.createRangeProof}) or a raw 64-byte Buffer.
   */
  rangeProof: string | Buffer;
}

/** The outcome of validating a single reading. */
export interface MeterReadingValidationResult {
  valid: boolean;
  /** Set when `valid` is `false`. Machine-readable `ERR_*` prefix. */
  reason?: string;
  /** Error code for programmatic handling. */
  errorCode?: MeterValidationErrorCode;
  /** Sub-result from the ZK verifier (always present when the proof step ran). */
  zkResult?: VerificationResult;
  /** Sub-result from the signature step (always present when the sig step ran). */
  signatureValid?: boolean;
}

/** Result of validating a batch of meter readings. */
export interface BatchMeterValidationResult {
  allValid: boolean;
  results: MeterReadingValidationResult[];
  /** Indices of readings that failed validation. */
  failedIndices: number[];
}

// ── Prometheus metrics ─────────────────────────────────────────────────────────

export interface MeterValidatorMetrics {
  validationDuration: Histogram;
  validationTotal: Counter;
}

/**
 * Create and register Prometheus metrics for the meter reading validator.
 * Pass a custom `Registry` (or `prom-client`'s default `register`) to avoid
 * collisions between test runs.
 */
export function createMeterValidatorMetrics(registry: Registry): MeterValidatorMetrics {
  const validationDuration = new Histogram({
    name: 'meter_reading_validation_duration_seconds',
    help: 'Duration of meter reading validation in seconds',
    labelNames: ['device_id', 'result'],
    buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.2],
    registers: [registry],
  });

  const validationTotal = new Counter({
    name: 'meter_reading_validations_total',
    help: 'Total number of meter reading validations',
    labelNames: ['device_id', 'result', 'error_code'],
    registers: [registry],
  });

  return { validationDuration, validationTotal };
}

// ── Canonical message builder ──────────────────────────────────────────────────

/**
 * Build the canonical UTF-8 message that the device signs.
 *
 * The message is a deterministic JSON object with keys in a fixed order to
 * avoid signature mismatches from key-ordering differences across serialisers.
 *
 * Covered fields: `deviceId`, `metricId`, `value`, `timestamp`,
 * `lowerBound`, `upperBound`.
 *
 * `signature` and `rangeProof` are intentionally excluded — they are
 * appended *after* signing.
 */
export function buildSignatureMessage(
  reading: Omit<MeterReading, 'signature' | 'rangeProof'>,
): Uint8Array {
  const canonical = JSON.stringify({
    deviceId: reading.deviceId,
    metricId: reading.metricId,
    value: reading.value.toString(),
    timestamp: reading.timestamp,
    lowerBound: reading.lowerBound.toString(),
    upperBound: reading.upperBound.toString(),
  });
  return Buffer.from(canonical, 'utf-8');
}

// ── MeterReadingValidator ──────────────────────────────────────────────────────

/**
 * Stateless validator that checks each meter reading against:
 *
 * - An Ed25519 signature (proving device identity)
 * - A ZK range proof (proving the value lies within the declared bounds)
 *
 * Both checks must pass for a reading to be considered valid.
 *
 * The validator is fully synchronous (< 100 µs per reading) and safe to share
 * across multiple concurrent requests.
 */
export class MeterReadingValidator {
  private readonly zkVerifier: ZkRangeProofVerifier;
  private readonly metrics: MeterValidatorMetrics | null;

  constructor(metrics?: MeterValidatorMetrics) {
    this.zkVerifier = new ZkRangeProofVerifier();
    this.metrics = metrics ?? null;
  }

  /**
   * Validate a single meter reading.
   *
   * Steps (short-circuit on first failure):
   *  1. Validate range bounds (lowerBound < upperBound)
   *  2. Check the value is within [lowerBound, upperBound]
   *  3. Verify the Ed25519 signature
   *  4. Quick-reject the ZK proof buffer (length check)
   *  5. Verify the ZK range proof
   *
   * @param reading   — the reading to validate
   * @param publicKey — the device's Ed25519 public key (32 bytes, hex or raw)
   */
  validate(reading: MeterReading, publicKey: string | Uint8Array): MeterReadingValidationResult {
    const startMs = Date.now();
    const result = this._validate(reading, publicKey);
    const durationSec = (Date.now() - startMs) / 1000;

    if (this.metrics) {
      const status = result.valid ? 'ok' : 'fail';
      this.metrics.validationDuration.observe(
        { device_id: reading.deviceId, result: status },
        durationSec,
      );
      this.metrics.validationTotal.inc({
        device_id: reading.deviceId,
        result: status,
        error_code: result.errorCode ?? '',
      });
    }

    return result;
  }

  /**
   * Validate a batch of meter readings against their respective public keys.
   *
   * Each reading is validated independently. The batch result captures which
   * readings failed and their individual results.
   *
   * @param readings   — array of readings to validate
   * @param publicKeys — one public key per reading (must be the same length)
   */
  validateBatch(
    readings: MeterReading[],
    publicKeys: Array<string | Uint8Array>,
  ): BatchMeterValidationResult {
    if (readings.length !== publicKeys.length) {
      throw new RangeError(
        `readings.length (${String(readings.length)}) must equal publicKeys.length (${String(publicKeys.length)})`,
      );
    }

    const results: MeterReadingValidationResult[] = [];
    const failedIndices: number[] = [];

    for (let i = 0; i < readings.length; i++) {
      const r = this.validate(readings[i]!, publicKeys[i]!);
      results.push(r);
      if (!r.valid) failedIndices.push(i);
    }

    return {
      allValid: failedIndices.length === 0,
      results,
      failedIndices,
    };
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private _validate(
    reading: MeterReading,
    publicKey: string | Uint8Array,
  ): MeterReadingValidationResult {
    // ── Step 1: Validate range bounds ──────────────────────────────────────
    if (reading.lowerBound >= reading.upperBound) {
      return {
        valid: false,
        reason: `${METER_VALIDATION_ERROR_CODES.INVALID_RANGE_BOUNDS}: lowerBound must be strictly less than upperBound`,
        errorCode: METER_VALIDATION_ERROR_CODES.INVALID_RANGE_BOUNDS,
      };
    }

    // ── Step 2: Value range check ──────────────────────────────────────────
    if (reading.value < reading.lowerBound || reading.value > reading.upperBound) {
      return {
        valid: false,
        reason: `${METER_VALIDATION_ERROR_CODES.OUT_OF_RANGE}: value ${reading.value.toString()} is outside [${reading.lowerBound.toString()}, ${reading.upperBound.toString()}]`,
        errorCode: METER_VALIDATION_ERROR_CODES.OUT_OF_RANGE,
      };
    }

    // ── Step 3: Resolve public key bytes ───────────────────────────────────
    const publicKeyBytes: Uint8Array =
      typeof publicKey === 'string' ? Buffer.from(publicKey, 'hex') : publicKey;

    if (publicKeyBytes.length !== 32) {
      return {
        valid: false,
        reason: `${METER_VALIDATION_ERROR_CODES.INVALID_PUBLIC_KEY}: expected 32 bytes, got ${String(publicKeyBytes.length)}`,
        errorCode: METER_VALIDATION_ERROR_CODES.INVALID_PUBLIC_KEY,
      };
    }

    // ── Step 4: Verify Ed25519 signature ───────────────────────────────────
    const sigBytes = Buffer.from(reading.signature, 'hex');
    if (sigBytes.length !== 64) {
      return {
        valid: false,
        reason: `${METER_VALIDATION_ERROR_CODES.INVALID_SIGNATURE_LENGTH}: signature must be 64 bytes (128 hex chars), got ${String(sigBytes.length)}`,
        errorCode: METER_VALIDATION_ERROR_CODES.INVALID_SIGNATURE_LENGTH,
        signatureValid: false,
      };
    }

    const message = buildSignatureMessage(reading);
    const sigVerified = nacl.sign.detached.verify(message, sigBytes, publicKeyBytes);

    if (!sigVerified) {
      return {
        valid: false,
        reason: `${METER_VALIDATION_ERROR_CODES.SIGNATURE_MISMATCH}: Ed25519 signature does not match the reading payload`,
        errorCode: METER_VALIDATION_ERROR_CODES.SIGNATURE_MISMATCH,
        signatureValid: false,
      };
    }

    // ── Step 5: Decode ZK proof buffer ─────────────────────────────────────
    let proofBuffer: Buffer;
    try {
      proofBuffer =
        typeof reading.rangeProof === 'string'
          ? Buffer.from(reading.rangeProof, 'base64')
          : Buffer.from(reading.rangeProof);
    } catch {
      return {
        valid: false,
        reason: `${METER_VALIDATION_ERROR_CODES.PROOF_DECODE_FAILED}: failed to decode range proof`,
        errorCode: METER_VALIDATION_ERROR_CODES.PROOF_DECODE_FAILED,
        signatureValid: true,
      };
    }

    // ── Step 6: Quick-reject ZK proof (length check) ───────────────────────
    const quickReject = this.zkVerifier.quickReject(proofBuffer);
    if (!quickReject.valid) {
      return {
        valid: false,
        reason: quickReject.reason,
        errorCode: METER_VALIDATION_ERROR_CODES.PROOF_INVALID_LENGTH,
        signatureValid: true,
        zkResult: quickReject,
      };
    }

    // ── Step 7: Full ZK range proof verification ───────────────────────────
    const zkResult = this.zkVerifier.verifyRangeProofStrict(
      proofBuffer,
      reading.deviceId,
      reading.lowerBound,
      reading.upperBound,
      reading.value,
    );

    if (!zkResult.valid) {
      // Map the verifier reason prefix to our local error code
      const errorCode = zkResult.reason?.startsWith(VERIFIER_ERROR_CODES.CHALLENGE_MISMATCH)
        ? METER_VALIDATION_ERROR_CODES.PROOF_CHALLENGE_MISMATCH
        : METER_VALIDATION_ERROR_CODES.PROOF_RESPONSE_MISMATCH;

      return {
        valid: false,
        reason: zkResult.reason,
        errorCode,
        signatureValid: true,
        zkResult,
      };
    }

    // ── All checks passed ──────────────────────────────────────────────────
    return { valid: true, signatureValid: true, zkResult: { valid: true } };
  }
}
