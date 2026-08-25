import { Buffer } from 'node:buffer';
import { randomBytes, createHash } from 'node:crypto';
import { RangeProofGenerator, ZkRangeProofVerifier } from './zk_verifier.js';

export interface CommitmentPair {
  commitment: string;
  opening: string;
}

export interface PrivateBillingData {
  encryptedAmount: string;
  proof: string;
  commitment: string;
  deviceId: string;
  rangeLower: string;
  rangeUpper: string;
}

export interface BillingRevelation {
  transactionId: string;
  amount: bigint;
  opening: string;
  commitment: string;
}

export class ZkBillingEngine {
  private verifier = new ZkRangeProofVerifier();

  createBillingCommitment(
    amount: bigint,
    _deviceId: string,
    _lowerBound: bigint,
    _upperBound: bigint,
  ): CommitmentPair {
    const opening = randomBytes(32).toString('hex');
    const commitment = createHash('sha256').update(`${amount.toString()}:${opening}`).digest('hex');

    return { commitment, opening };
  }

  createRangeProof(
    amount: bigint,
    deviceId: string,
    lowerBound: bigint,
    upperBound: bigint,
  ): string {
    const proof = RangeProofGenerator.generate(amount, deviceId, lowerBound, upperBound);
    return proof.toString('base64');
  }

  verifyPrivateBilling(
    encryptedAmount: string,
    proofBase64: string,
    deviceId: string,
    lowerBound: bigint,
    upperBound: bigint,
  ): boolean {
    let proofBuffer: Buffer;
    try {
      proofBuffer = Buffer.from(proofBase64, 'base64');
    } catch {
      return false;
    }

    const quick = this.verifier.quickReject(proofBuffer);
    if (!quick.valid) return false;

    const result = this.verifier.verifyRangeProof(
      proofBuffer,
      deviceId,
      lowerBound,
      upperBound,
      BigInt(encryptedAmount),
    );

    return result.valid;
  }

  revealBillingAmount(commitment: string, opening: string, claimedAmount: bigint): boolean {
    const computed = createHash('sha256')
      .update(`${claimedAmount.toString()}:${opening}`)
      .digest('hex');
    return computed === commitment;
  }

  hashBillData(txId: string, deviceId: string, commitment: string, timestamp: number): string {
    return createHash('sha256')
      .update(`${txId}:${deviceId}:${commitment}:${timestamp.toString()}`)
      .digest('hex');
  }

  generateBillingProof(
    amount: bigint,
    deviceId: string,
    lowerBound: bigint,
    upperBound: bigint,
  ): PrivateBillingData {
    const pair = this.createBillingCommitment(amount, deviceId, lowerBound, upperBound);
    const proof = this.createRangeProof(amount, deviceId, lowerBound, upperBound);
    return {
      encryptedAmount: amount.toString(),
      proof,
      commitment: pair.commitment,
      deviceId,
      rangeLower: lowerBound.toString(),
      rangeUpper: upperBound.toString(),
    };
  }

  batchVerifyPrivateBillings(billings: PrivateBillingData[]): {
    valid: boolean[];
    allValid: boolean;
  } {
    const results = billings.map((b) =>
      this.verifyPrivateBilling(
        b.encryptedAmount,
        b.proof,
        b.deviceId,
        BigInt(b.rangeLower),
        BigInt(b.rangeUpper),
      ),
    );
    return { valid: results, allValid: results.every((r) => r) };
  }
}

export function generateBillingRangeTiers(): Array<{
  label: string;
  lower: bigint;
  upper: bigint;
}> {
  return [
    { label: 'micro', lower: 0n, upper: 100n },
    { label: 'small', lower: 101n, upper: 1000n },
    { label: 'medium', lower: 1001n, upper: 10000n },
    { label: 'large', lower: 10001n, upper: 100000n },
    { label: 'enterprise', lower: 100001n, upper: 10000000n },
  ];
}
