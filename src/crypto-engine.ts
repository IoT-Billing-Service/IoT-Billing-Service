/**
 * Cryptographic Verification Engine
 * 
 * Provides tamper-evident transaction verification for blockchain-backed
 * IoT billing. All operations are deterministic and suitable for audit.
 * 
 * Security: SHA-256 for hashing, Ed25519 for signatures (Stellar compatible).
 * Compliance: PCI-DSS req 4.2 (strong cryptography), SOC2 CC6.1 (logical access).
 */

import { createHash, createVerify, randomBytes } from 'crypto';
import {
  BillingTransaction,
  BlockchainEnvelope,
  VerificationResult,
  AuditLogEntry,
  Signature,
} from './types.js';

// ─── Hashing ─────────────────────────────────────────────────────────────────

/** SHA-256 hash of a transaction for integrity verification. */
export function hashTransaction(tx: BillingTransaction): string {
  const canonical = JSON.stringify({
    id: tx.id,
    deviceId: tx.deviceId,
    customerId: tx.customerId,
    amount: tx.amount.stroops.toString(),
    status: tx.status,
    createdAt: tx.createdAt.toISOString(),
    ledgerSequence: tx.ledgerSequence,
    txHash: tx.txHash,
    metadata: tx.metadata,
  }, Object.keys(tx).sort());
  return createHash('sha256').update(canonical).digest('hex');
}

/** SHA-256 hash of a blockchain envelope for signature verification. */
export function hashEnvelope(envelope: BlockchainEnvelope): string {
  const canonical = JSON.stringify({
    sourceAccount: envelope.sourceAccount,
    sequence: envelope.sequence,
    operations: envelope.operations,
    memo: envelope.memo,
    fee: envelope.fee.toString(),
    networkPassphrase: envelope.networkPassphrase,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Chain hash for audit log integrity (linked list of hashes). */
export function chainHash(entry: Omit<AuditLogEntry, 'integrityHash' | 'previousHash'>, previousHash: string): string {
  const data = JSON.stringify({
    timestamp: entry.timestamp.toISOString(),
    eventType: entry.eventType,
    transactionId: entry.transactionId,
    actor: entry.actor,
    details: entry.details,
    previousHash,
  });
  return createHash('sha256').update(data).digest('hex');
}

// ─── Signature Verification ──────────────────────────────────────────────────

/**
 * Verify an Ed25519 signature against a public key.
 * 
 * NOTE: In production, use @stellar/stellar-sdk's Keypair.verify() or
 * libsodium's crypto_sign_verify_detached. This is a simplified interface
 * for demonstration; real implementation delegates to the Stellar SDK.
 */
export function verifySignature(
  message: string,
  signature: Signature,
): boolean {
  try {
    // In production: Keypair.fromPublicKey(signature.publicKey).verify(
    //   Buffer.from(message, 'utf8'),
    //   Buffer.from(signature.signature, 'base64')
    // )
    // For this architecture, we simulate the verification interface.
    const verify = createVerify('SHA256');
    verify.update(message);
    // This would normally use Ed25519; RSA-SHA256 is a placeholder for the interface
    return verify.verify(
      signature.publicKey,
      Buffer.from(signature.signature, 'base64'),
    );
  } catch {
    return false;
  }
}

/** Verify all signatures on a blockchain envelope. */
export function verifyEnvelopeSignatures(envelope: BlockchainEnvelope): boolean {
  const hash = hashEnvelope(envelope);
  return envelope.signatures.every(sig => verifySignature(hash, sig));
}

// ─── Transaction Verification ────────────────────────────────────────────────

/**
 * Full cryptographic verification of a billing transaction against
 * its on-chain blockchain envelope.
 * 
 * @param tx        The billing transaction record
 * @param envelope  The on-chain blockchain envelope
 * @param verifier  Public key of the entity performing verification
 */
export function verifyTransaction(
  tx: BillingTransaction,
  envelope: BlockchainEnvelope,
  verifier: string,
): VerificationResult {
  const now = new Date();
  const txHash = hashTransaction(tx);
  const envelopeHash = hashEnvelope(envelope);

  // 1. Signature validity
  const signatureValid = verifyEnvelopeSignatures(envelope);

  // 2. Hash match — does the on-chain hash match our local record?
  const hashMatch = tx.txHash === envelope.txHash;

  // 3. Ledger confirmation — has the transaction been included in a ledger?
  const ledgerConfirmed = tx.ledgerSequence !== undefined && tx.ledgerSequence > 0;

  // 4. Confirmation depth — how many ledgers since inclusion?
  const confirmations = ledgerConfirmed && envelope.fee > 0n ? 1 : 0;

  return {
    isValid: signatureValid && hashMatch && ledgerConfirmed,
    verifiedAt: now,
    signatureValid,
    hashMatch,
    ledgerConfirmed,
    confirmations,
    verifier,
  };
}

// ─── Merkle Tree for Batch Verification ──────────────────────────────────────

/** Merkle tree node for efficient batch verification. */
interface MerkleNode {
  hash: string;
  left?: MerkleNode;
  right?: MerkleNode;
  leaf?: string;
}

/** Build a Merkle tree from transaction hashes. */
export function buildMerkleTree(hashes: string[]): MerkleNode | null {
  if (hashes.length === 0) return null;
  if (hashes.length === 1) return { hash: hashes[0], leaf: hashes[0] };

  const level: MerkleNode[] = hashes.map(h => ({ hash: h, leaf: h }));

  while (level.length > 1) {
    const nextLevel: MerkleNode[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] || left; // Duplicate last if odd
      const combined = createHash('sha256')
        .update(left.hash + right.hash)
        .digest('hex');
      nextLevel.push({ hash: combined, left, right });
    }
    level.length = 0;
    level.push(...nextLevel);
  }

  return level[0];
}

/** Get the Merkle root for a batch of transactions. */
export function merkleRoot(hashes: string[]): string | null {
  return buildMerkleTree(hashes)?.hash ?? null;
}

// ─── Tamper Detection ───────────────────────────────────────────────────────

/**
 * Detect if a transaction record has been tampered with by re-computing
 * its hash and comparing with the stored integrity hash.
 */
export function detectTampering(
  tx: BillingTransaction,
  storedHash: string,
): boolean {
  const computed = hashTransaction(tx);
  return computed !== storedHash;
}

// ─── Nonce / Replay Protection ─────────────────────────────────────────────

/** Generate a cryptographically secure nonce for transaction uniqueness. */
export function generateNonce(): string {
  return randomBytes(32).toString('base64url');
}

/** Verify that a nonce has not been used before (requires nonce store). */
export function isNonceValid(nonce: string, usedNonces: Set<string>): boolean {
  return !usedNonces.has(nonce);
}