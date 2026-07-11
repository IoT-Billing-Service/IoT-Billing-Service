import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import { Keypair } from '@stellar/stellar-sdk';
import {
  generateNonce,
  isValidStellarAddress,
  decodeStellarPublicKey,
  verifyEd25519Signature,
} from '../../src/api/auth/session.js';

describe('generateNonce', () => {
  it('should return a 64-character hex string (32 bytes)', () => {
    const nonce = generateNonce();
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(nonce).toHaveLength(64);
  });

  it('should produce unique nonces on each call', () => {
    const a = generateNonce();
    const b = generateNonce();
    const c = generateNonce();
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
  });

  it('should decode to exactly 32 bytes', () => {
    const nonce = generateNonce();
    const bytes = Buffer.from(nonce, 'hex');
    expect(bytes).toHaveLength(32);
  });
});

describe('isValidStellarAddress', () => {
  it('should accept a valid Stellar Ed25519 public key (G...)', () => {
    const kp = Keypair.random();
    expect(isValidStellarAddress(kp.publicKey())).toBe(true);
  });

  it('should reject a clearly invalid string', () => {
    expect(isValidStellarAddress('NOT_A_STELLAR_ADDRESS')).toBe(false);
    expect(isValidStellarAddress('')).toBe(false);
    expect(isValidStellarAddress('G')).toBe(false);
  });

  it('should reject an address with an invalid checksum', () => {
    const kp = Keypair.random();
    const valid = kp.publicKey();
    const tampered = valid.startsWith('G') ? 'H' + valid.slice(1) : 'G' + valid.slice(1);
    expect(isValidStellarAddress(tampered)).toBe(false);
  });

  it('should reject a valid-shaped but wrong-length string', () => {
    expect(isValidStellarAddress('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBe(
      false,
    );
  });
});

describe('decodeStellarPublicKey', () => {
  it('should decode a valid public key to a 32-byte Uint8Array', () => {
    const kp = Keypair.random();
    const decoded = decodeStellarPublicKey(kp.publicKey());
    expect(decoded).toBeInstanceOf(Uint8Array);
    expect(decoded).toHaveLength(32);
  });

  it('should match the raw public key bytes of the keypair', () => {
    const kp = Keypair.random();
    const decoded = decodeStellarPublicKey(kp.publicKey());
    const expected = kp.rawPublicKey();
    expect(Buffer.from(decoded).equals(Buffer.from(expected))).toBe(true);
  });

  it('should throw on an invalid address', () => {
    expect(() => decodeStellarPublicKey('INVALID')).toThrow();
  });
});

describe('verifyEd25519Signature', () => {
  it('should verify a valid signature over the raw 32 nonce bytes', () => {
    const kp = Keypair.random();
    const nonce = generateNonce();
    const nonceBytes = Buffer.from(nonce, 'hex');
    const sig = kp.sign(nonceBytes);
    const sigHex = sig.toString('hex');
    const pubBytes = decodeStellarPublicKey(kp.publicKey());
    expect(verifyEd25519Signature(nonce, sigHex, pubBytes)).toBe(true);
  });

  it('should reject a tampered signature', () => {
    const kp = Keypair.random();
    const nonce = generateNonce();
    const nonceBytes = Buffer.from(nonce, 'hex');
    const sig = kp.sign(nonceBytes);
    const sigHex = sig.toString('hex');
    // flip a hex char
    const tamperedHex = sigHex.startsWith('a') ? 'b' + sigHex.slice(1) : 'a' + sigHex.slice(1);
    const pubBytes = decodeStellarPublicKey(kp.publicKey());
    expect(verifyEd25519Signature(nonce, tamperedHex, pubBytes)).toBe(false);
  });

  it('should reject a signature made over a different nonce', () => {
    const kp = Keypair.random();
    const nonceA = generateNonce();
    const nonceB = generateNonce();
    const sig = kp.sign(Buffer.from(nonceA, 'hex'));
    const sigHex = sig.toString('hex');
    const pubBytes = decodeStellarPublicKey(kp.publicKey());
    expect(verifyEd25519Signature(nonceB, sigHex, pubBytes)).toBe(false);
  });

  it('should reject a signature from a different keypair', () => {
    const signer = Keypair.random();
    const claimed = Keypair.random();
    const nonce = generateNonce();
    const sig = signer.sign(Buffer.from(nonce, 'hex'));
    const sigHex = sig.toString('hex');
    const claimedPub = decodeStellarPublicKey(claimed.publicKey());
    expect(verifyEd25519Signature(nonce, sigHex, claimedPub)).toBe(false);
  });

  it('should reject a malformed (non-hex) signature', () => {
    const kp = Keypair.random();
    const nonce = generateNonce();
    const pubBytes = decodeStellarPublicKey(kp.publicKey());
    expect(verifyEd25519Signature(nonce, 'not-hex', pubBytes)).toBe(false);
    expect(verifyEd25519Signature(nonce, 'aa', pubBytes)).toBe(false);
  });

  it('should reject an empty/missing nonce', () => {
    const kp = Keypair.random();
    const sig = kp.sign(Buffer.alloc(32));
    const sigHex = sig.toString('hex');
    const pubBytes = decodeStellarPublicKey(kp.publicKey());
    expect(verifyEd25519Signature('', sigHex, pubBytes)).toBe(false);
    expect(verifyEd25519Signature('zz', sigHex, pubBytes)).toBe(false);
  });

  it('should be consistent with raw tweetnacl verify on the same inputs', () => {
    const kp = Keypair.random();
    const nonce = generateNonce();
    const nonceBytes = Buffer.from(nonce, 'hex');
    const sig = kp.sign(nonceBytes);
    const sigBytes = Buffer.from(sig.toString('hex'), 'hex');
    const pubBytes = decodeStellarPublicKey(kp.publicKey());
    const direct = nacl.sign.detached.verify(nonceBytes, sigBytes, pubBytes);
    expect(verifyEd25519Signature(nonce, sig.toString('hex'), pubBytes)).toBe(direct);
  });
});
