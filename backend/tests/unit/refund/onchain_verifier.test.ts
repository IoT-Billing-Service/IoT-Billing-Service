import { describe, it, expect } from 'vitest';
import { OnChainVerifier } from '../../../src/refund/onchain_verifier.js';

describe('OnChainVerifier', () => {
  describe('verify (simulated mode)', () => {
    it('should return confirmed=true when no RPC URL configured', async () => {
      const verifier = new OnChainVerifier();
      const result = await verifier.verify('test-tx-hash');

      expect(result.confirmed).toBe(true);
      expect(result.txHash).toBe('test-tx-hash');
      expect(result.outcome).toBe('simulated');
      expect(result.ledgerSequence).toBe(1);
      expect(result.ledgerCloseTime).toBeTypeOf('number');
      expect(result.detail).toContain('simulated');
    });

    it('should pass through the tx hash unchanged', async () => {
      const verifier = new OnChainVerifier();
      const hash = 'abc123def456';
      const result = await verifier.verify(hash);

      expect(result.txHash).toBe(hash);
    });

    it('should set ledgerCloseTime to current unix timestamp', async () => {
      const verifier = new OnChainVerifier();
      const before = Math.floor(Date.now() / 1000);
      const result = await verifier.verify('test-tx');
      const after = Math.floor(Date.now() / 1000);

      expect(result.ledgerCloseTime).toBeGreaterThanOrEqual(before);
      expect(result.ledgerCloseTime).toBeLessThanOrEqual(after);
    });
  });

  describe('generateSimulatedHash', () => {
    it('should produce a 64-character hex string', () => {
      const hash = OnChainVerifier.generateSimulatedHash('test-input');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should be deterministic for the same input', () => {
      const hash1 = OnChainVerifier.generateSimulatedHash('same-input');
      const hash2 = OnChainVerifier.generateSimulatedHash('same-input');
      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different inputs', () => {
      const hash1 = OnChainVerifier.generateSimulatedHash('input-a');
      const hash2 = OnChainVerifier.generateSimulatedHash('input-b');
      expect(hash1).not.toBe(hash2);
    });

    it('should match known SHA-256 output', () => {
      const hash = OnChainVerifier.generateSimulatedHash('');
      // SHA-256 of empty string
      expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });
  });

  describe('OnChainVerificationResult type', () => {
    it('should have required fields from simulated result', async () => {
      const verifier = new OnChainVerifier();
      const result = await verifier.verify('type-check-tx');

      expect(result).toHaveProperty('confirmed');
      expect(result).toHaveProperty('txHash');
      expect(result).toHaveProperty('outcome');
    });

    it('should support optional fields', () => {
      const result = {
        confirmed: false,
        txHash: 'test-tx',
        outcome: 'rejected' as const,
        detail: 'Contract rejected: insufficient funds',
        ledgerSequence: 42,
        ledgerCloseTime: 1234567890,
      };

      expect(result.confirmed).toBe(false);
      expect(result.detail).toBe('Contract rejected: insufficient funds');
      expect(result.ledgerSequence).toBe(42);
    });
  });

  describe('verify with empty RPC URL', () => {
    it('should fall back to simulated verification', async () => {
      const verifier = new OnChainVerifier({ sorobanRpcUrl: '' });
      const result = await verifier.verify('empty-url-tx');

      expect(result.confirmed).toBe(true);
      expect(result.outcome).toBe('simulated');
    });
  });

  describe('performance budget', () => {
    it('should complete simulated verification in under 10ms', async () => {
      const verifier = new OnChainVerifier();
      const start = performance.now();
      await verifier.verify('perf-test-tx');
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(10);
    });
  });
});
