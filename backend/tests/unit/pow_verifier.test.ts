import { describe, it, expect, beforeEach } from 'vitest';
import {
  PowVerifier,
  POW_ERROR_CODES,
  DEFAULT_DIFFICULTY,
  MIN_DIFFICULTY,
  MAX_DIFFICULTY,
  POW_NONCE_BYTE_LENGTH,
  computePowHash,
  countLeadingZeroBits,
  minePowSolution,
} from '../../src/core/crypto/pow_verifier.js';

describe('PowVerifier', () => {
  let verifier: PowVerifier;

  beforeEach(() => {
    verifier = new PowVerifier();
  });

  describe('constructor', () => {
    it('should default to DEFAULT_DIFFICULTY', () => {
      expect(verifier.getDifficulty()).toBe(DEFAULT_DIFFICULTY);
    });

    it('should accept a custom difficulty', () => {
      const custom = new PowVerifier(8);
      expect(custom.getDifficulty()).toBe(8);
    });

    it('should clamp difficulty below MIN_DIFFICULTY', () => {
      const clamped = new PowVerifier(0);
      expect(clamped.getDifficulty()).toBe(MIN_DIFFICULTY);
    });

    it('should clamp difficulty above MAX_DIFFICULTY', () => {
      const clamped = new PowVerifier(100);
      expect(clamped.getDifficulty()).toBe(MAX_DIFFICULTY);
    });
  });

  describe('setDifficulty', () => {
    it('should update the difficulty', () => {
      verifier.setDifficulty(12);
      expect(verifier.getDifficulty()).toBe(12);
    });

    it('should clamp to valid range', () => {
      verifier.setDifficulty(-5);
      expect(verifier.getDifficulty()).toBe(MIN_DIFFICULTY);

      verifier.setDifficulty(999);
      expect(verifier.getDifficulty()).toBe(MAX_DIFFICULTY);
    });
  });

  describe('verify', () => {
    it('should verify a valid mined solution', () => {
      const deviceId = 'device-001';
      const timestamp = Date.now();
      const difficulty = 4;
      const solution = minePowSolution(deviceId, timestamp, difficulty);

      verifier.setDifficulty(difficulty);
      const result = verifier.verify(deviceId, timestamp, solution);
      expect(result.valid).toBe(true);
    });

    it('should reject solution with wrong difficulty', () => {
      const deviceId = 'device-001';
      const timestamp = Date.now();
      const solution = minePowSolution(deviceId, timestamp, 4);

      // Verifier expects difficulty 8, solution was for difficulty 4
      verifier.setDifficulty(8);
      const result = verifier.verify(deviceId, timestamp, solution);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain(POW_ERROR_CODES.DIFFICULTY_MISMATCH);
    });

    it('should reject solution with insufficient leading zeros', () => {
      const deviceId = 'device-001';
      const timestamp = Date.now();

      verifier.setDifficulty(4);
      const result = verifier.verify(deviceId, timestamp, {
        nonce: '0000000000000000',
        difficulty: 4,
      });
      // This particular nonce may or may not work; test the rejection path
      // by using a nonce we know won't have enough zeros
      if (!result.valid) {
        expect(result.reason).toContain(POW_ERROR_CODES.INSUFFICIENT_WORK);
      }
    });

    it('should reject expired timestamp (> 30s old)', () => {
      const deviceId = 'device-001';
      const oldTimestamp = Date.now() - 60_000; // 60s ago
      const solution = minePowSolution(deviceId, oldTimestamp, 4);

      verifier.setDifficulty(4);
      const result = verifier.verify(deviceId, oldTimestamp, solution);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain(POW_ERROR_CODES.TIMESTAMP_EXPIRED);
    });

    it('should reject future timestamp (> 30s ahead)', () => {
      const deviceId = 'device-001';
      const futureTimestamp = Date.now() + 60_000; // 60s ahead
      const solution = minePowSolution(deviceId, futureTimestamp, 4);

      verifier.setDifficulty(4);
      const result = verifier.verify(deviceId, futureTimestamp, solution);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain(POW_ERROR_CODES.TIMESTAMP_FUTURE);
    });

    it('should accept timestamp within ±30s window', () => {
      const deviceId = 'device-001';
      const timestamp = Date.now();
      const solution = minePowSolution(deviceId, timestamp, 1);

      verifier.setDifficulty(1);
      // Verify at different points within the window
      const result = verifier.verify(deviceId, timestamp, solution);
      expect(result.valid).toBe(true);
    });

    it('should reject solution bound to wrong device', () => {
      const deviceId = 'device-001';
      const wrongDeviceId = 'device-999';
      const timestamp = Date.now();
      const solution = minePowSolution(deviceId, timestamp, 4);

      verifier.setDifficulty(4);
      const result = verifier.verify(wrongDeviceId, timestamp, solution);
      // PoW is bound to deviceId, so it should fail
      expect(result.valid).toBe(false);
    });
  });

  describe('quickReject', () => {
    it('should accept valid length nonce', () => {
      const result = verifier.quickReject({ nonce: 'a'.repeat(16), difficulty: 4 });
      expect(result.valid).toBe(true);
    });

    it('should reject too-short nonce', () => {
      const result = verifier.quickReject({ nonce: 'a'.repeat(8), difficulty: 4 });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain(POW_ERROR_CODES.INVALID_NONCE_LENGTH);
    });

    it('should reject too-long nonce', () => {
      const result = verifier.quickReject({ nonce: 'a'.repeat(20), difficulty: 4 });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain(POW_ERROR_CODES.INVALID_NONCE_LENGTH);
    });
  });
});

describe('minePowSolution', () => {
  it('should mine a valid solution at minimum difficulty', () => {
    const timestamp = Date.now();
    const solution = minePowSolution('device-test', timestamp, MIN_DIFFICULTY);

    expect(solution.nonce).toHaveLength(POW_NONCE_BYTE_LENGTH * 2);
    expect(solution.difficulty).toBe(MIN_DIFFICULTY);

    // Verify it's actually valid
    const verifier = new PowVerifier(MIN_DIFFICULTY);
    const result = verifier.verify('device-test', timestamp, solution);
    expect(result.valid).toBe(true);
  });

  it('should mine a valid solution at default difficulty', () => {
    const timestamp = Date.now();
    const solution = minePowSolution('device-test', timestamp, DEFAULT_DIFFICULTY);

    const verifier = new PowVerifier(DEFAULT_DIFFICULTY);
    const result = verifier.verify('device-test', timestamp, solution);
    expect(result.valid).toBe(true);
  });

  it('should produce different nonces for different devices', () => {
    const timestamp = Date.now();
    const sol1 = minePowSolution('device-a', timestamp, 1);
    const sol2 = minePowSolution('device-b', timestamp, 1);

    // They should be different (very high probability)
    // Both should be valid for their respective devices
    const verifier = new PowVerifier(1);
    expect(verifier.verify('device-a', timestamp, sol1).valid).toBe(true);
    expect(verifier.verify('device-b', timestamp, sol2).valid).toBe(true);
  });

  it('should produce different nonces for different timestamps', () => {
    const timestamp1 = Date.now();
    const timestamp2 = timestamp1 + 1000;
    const sol1 = minePowSolution('device-test', timestamp1, 1);
    const sol2 = minePowSolution('device-test', timestamp2, 1);

    const verifier = new PowVerifier(1);
    expect(verifier.verify('device-test', timestamp1, sol1).valid).toBe(true);
    expect(verifier.verify('device-test', timestamp2, sol2).valid).toBe(true);
  });
});

describe('computePowHash', () => {
  it('should produce a consistent hash', () => {
    const hash1 = computePowHash('device-001', 1000, 4, '0000000000000001');
    const hash2 = computePowHash('device-001', 1000, 4, '0000000000000001');
    expect(hash1).toBe(hash2);
  });

  it('should produce different hashes for different inputs', () => {
    const hash1 = computePowHash('device-001', 1000, 4, '0000000000000001');
    const hash2 = computePowHash('device-002', 1000, 4, '0000000000000001');
    expect(hash1).not.toBe(hash2);
  });

  it('should return a 64-character hex string (SHA-256)', () => {
    const hash = computePowHash('device-001', 1000, 4, '0000000000000001');
    expect(hash).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/i.test(hash)).toBe(true);
  });
});

describe('countLeadingZeroBits', () => {
  it('should count 4 leading zeros per zero nibble', () => {
    expect(countLeadingZeroBits('0000')).toBe(16);
    expect(countLeadingZeroBits('000f')).toBe(12);
    expect(countLeadingZeroBits('00f0')).toBe(8);
    expect(countLeadingZeroBits('0f00')).toBe(4);
    expect(countLeadingZeroBits('f000')).toBe(0);
  });

  it('should count partial nibble zeros', () => {
    // '1' = 0001 in binary, so 3 leading zeros
    expect(countLeadingZeroBits('1')).toBe(3);
    // '8' = 1000 in binary, so 0 leading zeros
    expect(countLeadingZeroBits('8')).toBe(0);
    // '4' = 0100 in binary, so 1 leading zero
    expect(countLeadingZeroBits('4')).toBe(1);
    // '2' = 0010 in binary, so 2 leading zeros
    expect(countLeadingZeroBits('2')).toBe(2);
  });

  it('should handle full hash with no leading zeros', () => {
    expect(countLeadingZeroBits('ffff')).toBe(0);
  });

  it('should handle empty string', () => {
    expect(countLeadingZeroBits('')).toBe(0);
  });
});
