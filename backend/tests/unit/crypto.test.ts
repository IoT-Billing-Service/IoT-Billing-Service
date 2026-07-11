import { describe, it, expect } from 'vitest';
import {
  ZkRangeProofVerifier,
  RangeProofGenerator,
  VERIFIER_ERROR_CODES,
} from '../../src/core/crypto/zk_verifier.js';
import { Buffer } from 'node:buffer';
import { SafeMath } from '../../src/core/utils/math.js';

describe('ZkRangeProofVerifier', () => {
  const verifier = new ZkRangeProofVerifier();

  it('should verify a valid generated proof', () => {
    const proof = RangeProofGenerator.generate(50n, 'device-123', 0n, 100n);
    const result = verifier.verifyRangeProof(proof, 'device-123', 0n, 100n);
    expect(result.valid).toBe(true);
  });

  it('should reject invalid range (lower >= upper)', () => {
    const proof = Buffer.alloc(64);
    const result = verifier.verifyRangeProof(proof, 'device-123', 100n, 50n);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain(VERIFIER_ERROR_CODES.INVALID_RANGE);
  });

  it('should reject invalid proof length', () => {
    const proof = Buffer.alloc(32); // short proof
    const result = verifier.verifyRangeProof(proof, 'device-123', 0n, 100n);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain(VERIFIER_ERROR_CODES.INVALID_LENGTH);
  });

  it('should reject invalid proof length (too long)', () => {
    const proof = Buffer.alloc(128); // long proof
    const result = verifier.verifyRangeProof(proof, 'device-123', 0n, 100n);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain(VERIFIER_ERROR_CODES.INVALID_LENGTH);
  });

  it('should reject proof bound to wrong device', () => {
    const proof = RangeProofGenerator.generate(50n, 'device-123', 0n, 100n);
    const result = verifier.verifyRangeProof(proof, 'wrong-device', 0n, 100n);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain(VERIFIER_ERROR_CODES.CHALLENGE_MISMATCH);
  });
});

describe('SafeMath', () => {
  it('should convert precision correctly', () => {
    const result = SafeMath.toSorobanPrecision(123456n, 4);
    expect(result).toBe(123456000n);
  });

  it('should throw on overflow in addition', () => {
    expect(() => SafeMath.safeAdd(SafeMath.MAX_SOROBAN_VALUE, 1n)).toThrow('overflow');
  });

  it('should multiply with precision', () => {
    const result = SafeMath.multiplyWithPrecision(100n, 50n, 2);
    expect(result).toBe(50n);
  });

  it('should detect overflow', () => {
    expect(SafeMath.checkOverflow(SafeMath.MAX_SOROBAN_VALUE)).toBe(false);
    expect(SafeMath.checkOverflow(SafeMath.MAX_SOROBAN_VALUE + 1n)).toBe(true);
  });
});

describe('StreamParser', () => {
  it('should be importable', async () => {
    const mod = await import('../../src/core/ingestion/stream_parser.js');
    expect(mod.TelemetryStreamParser).toBeDefined();
  });
});
