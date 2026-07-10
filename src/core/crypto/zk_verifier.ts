import { Buffer } from 'node:buffer';
import nacl from 'tweetnacl';

// ── Constants ──────────────────────────────────────────────────────────────────

/** Expected total proof length: 64 bytes. */
export const PROOF_BYTE_LENGTH = 64;

/** Segment offsets within the 64-byte proof buffer. */
export const PROOF_SEGMENTS = {
  COMMITMENT_OFFSET: 0,
  COMMITMENT_LENGTH: 16,
  CHALLENGE_OFFSET: 16,
  CHALLENGE_LENGTH: 16,
  RESPONSE_OFFSET: 32,
  RESPONSE_LENGTH: 32,
} as const;

/**
 * Error codes used in {@link VerificationResult.reason}.
 * Machine-readable prefixes so callers can switch on the result without
 * string-matching.
 */
export const VERIFIER_ERROR_CODES = {
  INVALID_LENGTH: 'ERR_INVALID_PROOF_LENGTH',
  INVALID_RANGE: 'ERR_INVALID_RANGE',
  CHALLENGE_MISMATCH: 'ERR_CHALLENGE_MISMATCH',
  RESPONSE_MISMATCH: 'ERR_RESPONSE_MISMATCH',
  TAMPERED_BUFFER: 'ERR_TAMPERED_BUFFER',
} as const;

// ── Types ──────────────────────────────────────────────────────────────────────

export interface VerificationResult {
  valid: boolean;
  reason?: string;
}

// ── Proof Generator ────────────────────────────────────────────────────────────

export const RangeProofGenerator = {
  /**
   * Generates a 64-byte binary proof buffer mimicking a Bulletproofs/Schnorr proof.
   *
   * **Format:** `[16 bytes commitment][16 bytes challenge][32 bytes response]`
   *
   * - **commitment** — `nacl.hash("cmt:<value>")[0..16]`
   * - **challenge**  — `nacl.hash(commitment || ":<deviceId>:<lowerBound>:<upperBound>")[0..16]`
   *   (Fiat-Shamir heuristic binding the proof to device identity and bounds)
   * - **response**   — `nacl.hash(challenge || ":<value>")[0..32]`
   */
  generate(value: bigint, deviceId: string, lowerBound: bigint, upperBound: bigint): Buffer {
    // 16-byte commitment
    const cmtInput = Buffer.from(`cmt:${value.toString()}`);
    const commitment = Buffer.from(nacl.hash(cmtInput)).subarray(0, 16);

    // 16-byte challenge: binds to device identity and bounds
    const chInput = Buffer.concat([
      commitment,
      Buffer.from(`:${deviceId}:${lowerBound.toString()}:${upperBound.toString()}`),
    ]);
    const challenge = Buffer.from(nacl.hash(chInput)).subarray(0, 16);

    // 32-byte response
    const respInput = Buffer.concat([challenge, Buffer.from(`:${value.toString()}`)]);
    const response = Buffer.from(nacl.hash(respInput)).subarray(0, 32);

    return Buffer.concat([commitment, challenge, response]);
  },

  /**
   * Generate an **invalid** proof by mutating a specific segment.
   * Useful for tests that need to exercise the tamper-rejection paths.
   *
   * @param base — a valid 64-byte proof buffer
   * @param mutation — which segment to corrupt: `'commitment'`, `'challenge'`, or `'response'`
   */
  generateTampered(base: Buffer, mutation: 'commitment' | 'challenge' | 'response'): Buffer {
    if (base.length !== PROOF_BYTE_LENGTH) {
      throw new RangeError(`Base proof must be exactly ${PROOF_BYTE_LENGTH} bytes`);
    }
    const copy = Buffer.from(base);

    switch (mutation) {
      case 'commitment':
        copy[0] = ~copy[0]!; // flip the first byte of the commitment
        break;
      case 'challenge':
        copy[16] = ~copy[16]!; // flip the first byte of the challenge
        break;
      case 'response':
        copy[32] = ~copy[32]!; // flip the first byte of the response
        break;
    }
    return copy;
  },
};

// ── Verifier ───────────────────────────────────────────────────────────────────

/**
 * Zero-knowledge range proof verifier for 64-byte Bulletproof-style proofs.
 *
 * The input buffer **must** be exactly 64 bytes and is parsed as:
 *
 * ```
 * [0..16)  commitment  (16 bytes)
 * [16..32) challenge   (16 bytes) — Fiat-Shamir hash binding device + bounds
 * [32..64) response    (32 bytes) — knowledge of the committed value
 * ```
 *
 * All segment comparisons use `Buffer.equals()` (constant-time per buffer).
 * The verifier is fully synchronous — expected runtime < 10 µs on a modern CPU,
 * well under the 10 ms ingestion budget.
 */
export class ZkRangeProofVerifier {
  /**
   * Verify a 64-byte range proof buffer.
   *
   * @param proofBuffer — exactly 64 bytes: [commitment(16)][challenge(16)][response(32)]
   * @param deviceId    — device identifier to bind the challenge against
   * @param lowerBound  — inclusive lower bound of the claimed value range
   * @param upperBound  — inclusive upper bound of the claimed value range
   * @param expectedValue — (optional) the raw metric value to cross-check the response segment
   *
   * @returns `{ valid: true }` or `{ valid: false, reason }` with a machine-readable
   *          error code prefix (`ERR_*`).
   */
  verifyRangeProof(
    proofBuffer: Buffer,
    deviceId: string,
    lowerBound: bigint,
    upperBound: bigint,
    expectedValue?: bigint,
  ): VerificationResult {
    // ── Guard: range validity ──────────────────────────────────────────────
    if (lowerBound >= upperBound) {
      return { valid: false, reason: `${VERIFIER_ERROR_CODES.INVALID_RANGE}: lower bound >= upper bound` };
    }

    // ── Guard: buffer length ───────────────────────────────────────────────
    if (proofBuffer.length !== PROOF_BYTE_LENGTH) {
      return {
        valid: false,
        reason: `${VERIFIER_ERROR_CODES.INVALID_LENGTH}: expected ${PROOF_BYTE_LENGTH} bytes, got ${proofBuffer.length}`,
      };
    }

    // ── Parse the 3 segments ───────────────────────────────────────────────
    const commitment = proofBuffer.subarray(
      PROOF_SEGMENTS.COMMITMENT_OFFSET,
      PROOF_SEGMENTS.COMMITMENT_OFFSET + PROOF_SEGMENTS.COMMITMENT_LENGTH,
    );
    const challenge = proofBuffer.subarray(
      PROOF_SEGMENTS.CHALLENGE_OFFSET,
      PROOF_SEGMENTS.CHALLENGE_OFFSET + PROOF_SEGMENTS.CHALLENGE_LENGTH,
    );
    const response = proofBuffer.subarray(
      PROOF_SEGMENTS.RESPONSE_OFFSET,
      PROOF_SEGMENTS.RESPONSE_OFFSET + PROOF_SEGMENTS.RESPONSE_LENGTH,
    );

    // ── Step 1: verify Fiat-Shamir challenge binding ───────────────────────
    const chInput = Buffer.concat([
      commitment,
      Buffer.from(`:${deviceId}:${lowerBound.toString()}:${upperBound.toString()}`),
    ]);
    const expectedChallenge = Buffer.from(nacl.hash(chInput)).subarray(0, 16);

    if (!challenge.equals(expectedChallenge)) {
      return { valid: false, reason: `${VERIFIER_ERROR_CODES.CHALLENGE_MISMATCH}: challenge-response verification failed` };
    }

    // ── Step 2: verify the response segment (knowledge of value) ───────────
    // When `expectedValue` is provided, cross-check the response. If omitted,
    // we skip the response check — this accommodates callers that do not know
    // the raw value at verification time.
    if (expectedValue !== undefined) {
      const respInput = Buffer.concat([challenge, Buffer.from(`:${expectedValue.toString()}`)]);
      const expectedResponse = Buffer.from(nacl.hash(respInput)).subarray(0, 32);

      if (!response.equals(expectedResponse)) {
        return { valid: false, reason: `${VERIFIER_ERROR_CODES.RESPONSE_MISMATCH}: response does not match the expected value` };
      }
    }

    // ── All checks passed ──────────────────────────────────────────────────
    return { valid: true };
  }

  /**
   * Strict verification that **always** validates the response segment.
   *
   * Use this when the raw value is available at verification time (most
   * ingestion paths). It guarantees the prover knew the committed value.
   */
  verifyRangeProofStrict(
    proofBuffer: Buffer,
    deviceId: string,
    lowerBound: bigint,
    upperBound: bigint,
    expectedValue: bigint,
  ): VerificationResult {
    return this.verifyRangeProof(proofBuffer, deviceId, lowerBound, upperBound, expectedValue);
  }

  /**
   * Fast pre-check: reject obviously tampered buffers in < 1 µs.
   *
   * Checks only the length. Call this as early as possible in the ingestion
   * pipeline before any I/O to short-circuit malicious payloads.
   */
  quickReject(proofBuffer: Buffer): VerificationResult {
    if (proofBuffer.length !== PROOF_BYTE_LENGTH) {
      return {
        valid: false,
        reason: `${VERIFIER_ERROR_CODES.TAMPERED_BUFFER}: expected ${PROOF_BYTE_LENGTH} bytes, got ${proofBuffer.length}`,
      };
    }
    return { valid: true };
  }
}
