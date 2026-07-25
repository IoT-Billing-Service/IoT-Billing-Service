import { describe, it, expect } from 'vitest';
import { ZkBillingEngine, generateBillingRangeTiers } from '../../../src/core/crypto/zk_billing.js';

describe('ZkBillingEngine', () => {
  const engine = new ZkBillingEngine();
  const deviceId = 'device-001';
  const lower = 0n;
  const upper = 10000n;

  it('creates a valid commitment pair', () => {
    const pair = engine.createBillingCommitment(500n, deviceId, lower, upper);
    expect(pair.commitment).toBeTruthy();
    expect(pair.opening).toBeTruthy();
    expect(pair.commitment.length).toBe(64);
    expect(pair.opening.length).toBe(64);
  });

  it('creates a valid range proof', () => {
    const proof = engine.createRangeProof(500n, deviceId, lower, upper);
    expect(proof).toBeTruthy();
    expect(typeof proof).toBe('string');
  });

  it('verifies a valid proof', () => {
    const result = engine.verifyPrivateBilling('500', engine.createRangeProof(500n, deviceId, lower, upper), deviceId, lower, upper);
    expect(result).toBe(true);
  });

  it('rejects an invalid proof', () => {
    const result = engine.verifyPrivateBilling('99999', 'aW52YWxpZAA=', deviceId, lower, upper);
    expect(result).toBe(false);
  });

  it('rejects tampered proof', () => {
    const proof = engine.createRangeProof(500n, deviceId, lower, upper);
    const tampered = Buffer.from(proof, 'base64');
    tampered[0] ^= 0xff;
    const result = engine.verifyPrivateBilling('500', tampered.toString('base64'), deviceId, lower, upper);
    expect(result).toBe(false);
  });

  it('reveals billing amount correctly', () => {
    const pair = engine.createBillingCommitment(500n, deviceId, lower, upper);
    const revealed = engine.revealBillingAmount(pair.commitment, pair.opening, 500n);
    expect(revealed).toBe(true);
  });

  it('rejects wrong billing amount revelation', () => {
    const pair = engine.createBillingCommitment(500n, deviceId, lower, upper);
    const revealed = engine.revealBillingAmount(pair.commitment, pair.opening, 999n);
    expect(revealed).toBe(false);
  });

  it('generates a complete billing proof', () => {
    const billingData = engine.generateBillingProof(500n, deviceId, lower, upper);
    expect(billingData.encryptedAmount).toBe('500');
    expect(billingData.commitment).toBeTruthy();
    expect(billingData.proof).toBeTruthy();
    expect(billingData.deviceId).toBe(deviceId);
  });

  it('hashes bill data deterministically', () => {
    const hash1 = engine.hashBillData('tx-1', deviceId, 'cmt-1', 1000);
    const hash2 = engine.hashBillData('tx-1', deviceId, 'cmt-1', 1000);
    expect(hash1).toBe(hash2);
  });

  it('batch verifies all billings', () => {
    const billings = [
      engine.generateBillingProof(100n, deviceId, lower, upper),
      engine.generateBillingProof(500n, deviceId, lower, upper),
      engine.generateBillingProof(1000n, deviceId, lower, upper),
    ];
    const result = engine.batchVerifyPrivateBillings(billings);
    expect(result.allValid).toBe(true);
    expect(result.valid).toHaveLength(3);
    expect(result.valid.every((v) => v)).toBe(true);
  });

  it('batch detects invalid billing', () => {
    const billings = [
      engine.generateBillingProof(100n, deviceId, lower, upper),
      { encryptedAmount: '99999', proof: 'aW52YWxpZAA=', commitment: 'x', deviceId, rangeLower: '0', rangeUpper: '10000' },
    ];
    const result = engine.batchVerifyPrivateBillings(billings);
    expect(result.allValid).toBe(false);
    expect(result.valid[0]).toBe(true);
    expect(result.valid[1]).toBe(false);
  });
});

describe('generateBillingRangeTiers', () => {
  it('returns 5 tiers', () => {
    const tiers = generateBillingRangeTiers();
    expect(tiers).toHaveLength(5);
  });

  it('has valid bounds', () => {
    const tiers = generateBillingRangeTiers();
    for (const tier of tiers) {
      expect(tier.lower).toBeLessThan(tier.upper);
    }
  });
});
