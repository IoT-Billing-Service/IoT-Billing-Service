import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  decodeEventRecord,
  canonicalJson,
  RecordRejectedError,
  verifySignature,
  ENVELOPE_VERSION,
} from '../../../../src/stream/kafka_connect/record_codec.js';

function envelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: ENVELOPE_VERSION,
    sequence: 10,
    event: { type: 'PaymentFinalized', hash: '0xabc', amount: '42' },
    ...overrides,
  });
}

describe('record_codec', () => {
  describe('valid records', () => {
    it('decodes a valid envelope into a BlockchainEventRecord', () => {
      const rec = decodeEventRecord(envelope());
      expect(rec.sequence).toBe(10);
      expect(rec.eventType).toBe('PaymentFinalized');
      expect(rec.payload['hash']).toBe('0xabc');
      expect(rec.payload['amount']).toBe('42');
      expect(rec.verified).toBe(false);
      expect(rec.contentHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('accepts a Buffer value as well as a string', () => {
      const rec = decodeEventRecord(Buffer.from(envelope(), 'utf8'));
      expect(rec.sequence).toBe(10);
    });

    it('computes canonical hash independent of object key order', () => {
      const a = canonicalJson({ b: 1, a: 2 });
      const b = canonicalJson({ a: 2, b: 1 });
      expect(a).toBe(b);
    });
  });

  describe('rejected records', () => {
    it('rejects empty input', () => {
      expect(() => decodeEventRecord(null)).toThrow(RecordRejectedError);
      expect(() => decodeEventRecord('')).toThrow(RecordRejectedError);
    });

    it('rejects non-JSON', () => {
      expect(() => decodeEventRecord('not json {')).toThrowError(/not-json/);
    });

    it('rejects unsupported version', () => {
      expect(() => decodeEventRecord(envelope({ v: 2 }))).toThrowError(/unsupported-version/);
    });

    it('rejects missing sequence', () => {
      expect(() => decodeEventRecord(envelope({ sequence: undefined }))).toThrowError(
        /missing-sequence/,
      );
    });

    it('rejects negative or non-integer sequence', () => {
      expect(() => decodeEventRecord(envelope({ sequence: -1 }))).toThrowError(/invalid-sequence/);
      expect(() => decodeEventRecord(envelope({ sequence: 1.5 }))).toThrowError(/invalid-sequence/);
    });

    it('rejects missing event object', () => {
      expect(() => decodeEventRecord(envelope({ event: undefined }))).toThrowError(/missing-event/);
      expect(() => decodeEventRecord(envelope({ event: [1, 2] }))).toThrowError(/invalid-event/);
    });

    it('rejects event without a type', () => {
      expect(() => decodeEventRecord(envelope({ event: { hash: '0x' } }))).toThrowError(
        /invalid-event/,
      );
    });

    it('rejects a mismatching contentHash as tampering', () => {
      expect(() => decodeEventRecord(envelope({ contentHash: '0'.repeat(64) }))).toThrowError(
        /hash-mismatch/,
      );
    });

    it('returns a structured reason on each rejection', () => {
      try {
        decodeEventRecord('junk');
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(RecordRejectedError);
        expect((err as RecordRejectedError).reason).toBe('not-json');
      }
    });
  });

  describe('signature verification', () => {
    it('passes a correctly-signed envelope when a public key is configured', () => {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
      const event = { type: 'PaymentFinalized', hash: '0xabc' };
      const canonical = canonicalJson(event);
      const sig = sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64');

      const value = JSON.stringify({ v: 1, sequence: 5, event, signature: sig });
      const rec = decodeEventRecord(value, { verifyPublicKeyPem: pubPem });
      expect(rec.verified).toBe(true);
    });

    it('rejects an envelope missing a signature when verification required', () => {
      const { publicKey } = generateKeyPairSync('ed25519');
      const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
      expect(() => decodeEventRecord(envelope(), { verifyPublicKeyPem: pubPem })).toThrowError(
        /signature-invalid/,
      );
    });

    it('rejects an envelope signed by a different key', () => {
      const keyA = generateKeyPairSync('ed25519');
      const pubPem = keyA.publicKey.export({ type: 'spki', format: 'pem' }).toString();
      // Sign with an unrelated key.
      const keyB = generateKeyPairSync('ed25519');
      const event = { type: 'PaymentFinalized', hash: '0xabc' };
      const sig = sign(null, Buffer.from(canonicalJson(event), 'utf8'), keyB.privateKey).toString(
        'base64',
      );
      const value = JSON.stringify({ v: 1, sequence: 5, event, signature: sig });
      expect(() => decodeEventRecord(value, { verifyPublicKeyPem: pubPem })).toThrowError(
        /signature-invalid/,
      );
    });

    it('verifySignature accepts hex-encoded signatures', () => {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
      const content = 'hello';
      const sig = sign(null, Buffer.from(content, 'utf8'), privateKey).toString('hex');
      expect(verifySignature(pubPem, content, sig)).toBe(true);
    });
  });
});
