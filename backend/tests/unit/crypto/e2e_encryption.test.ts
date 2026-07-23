import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  generateEncryptionKey,
  encryptionKeyFromHex,
  encryptField,
  decryptField,
  encryptSensitiveFields,
  decryptSensitiveFields,
  tryParseEncryptedField,
  decryptMetricValue,
  encryptMetricValue,
  ENCRYPTION_KEY_LENGTH,
  NONCE_LENGTH,
  KEY_HEX_LENGTH,
} from '../../../src/core/crypto/e2e_encryption.js';

describe('E2E Encryption', () => {
  describe('generateEncryptionKey', () => {
    it('generates a 32-byte key', () => {
      const key = generateEncryptionKey();
      expect(key.raw).toHaveLength(ENCRYPTION_KEY_LENGTH);
      expect(key.hex).toHaveLength(KEY_HEX_LENGTH);
    });

    it('generates unique keys', () => {
      const key1 = generateEncryptionKey();
      const key2 = generateEncryptionKey();
      expect(key1.hex).not.toBe(key2.hex);
    });

    it('hex is the hex encoding of raw', () => {
      const key = generateEncryptionKey();
      expect(Buffer.from(key.raw).toString('hex')).toBe(key.hex);
    });
  });

  describe('encryptionKeyFromHex', () => {
    it('parses a valid hex key', () => {
      const key = generateEncryptionKey();
      const parsed = encryptionKeyFromHex(key.hex);
      expect(parsed.raw).toEqual(key.raw);
      expect(parsed.hex).toBe(key.hex);
    });

    it('throws on invalid hex length (too short)', () => {
      expect(() => encryptionKeyFromHex('aabb')).toThrow('ERR_E2E_INVALID_KEY_LENGTH');
    });

    it('throws on invalid hex length (too long)', () => {
      const longHex = 'a'.repeat(KEY_HEX_LENGTH + 2);
      expect(() => encryptionKeyFromHex(longHex)).toThrow('ERR_E2E_INVALID_KEY_LENGTH');
    });
  });

  describe('encryptField / decryptField', () => {
    const key = generateEncryptionKey();

    it('encrypts and decrypts a string field', () => {
      const original = 'sensitive-billing-data-12345';
      const encrypted = encryptField(original, key.raw);

      expect(encrypted.v).toBe('e2e:v1');
      expect(encrypted.d).toBeTruthy();
      expect(typeof encrypted.d).toBe('string');
      expect(encrypted.d).not.toContain(original);

      const decrypted = decryptField(encrypted, key.raw);
      expect(decrypted).toBe(original);
    });

    it('produces different ciphertexts for the same plaintext (nonce-based)', () => {
      const plaintext = 'same-value';
      const enc1 = encryptField(plaintext, key.raw);
      const enc2 = encryptField(plaintext, key.raw);
      expect(enc1.d).not.toBe(enc2.d);
    });

    it('handles empty string', () => {
      const encrypted = encryptField('', key.raw);
      const decrypted = decryptField(encrypted, key.raw);
      expect(decrypted).toBe('');
    });

    it('handles long strings', () => {
      const long = 'x'.repeat(10000);
      const encrypted = encryptField(long, key.raw);
      const decrypted = decryptField(encrypted, key.raw);
      expect(decrypted).toBe(long);
    });

    it('throws on decrypt with wrong key', () => {
      const encrypted = encryptField('secret', key.raw);
      const wrongKey = generateEncryptionKey();
      expect(() => decryptField(encrypted, wrongKey.raw)).toThrow(
        'ERR_E2E_DECRYPTION_FAILED',
      );
    });

    it('throws on encrypt with invalid key length', () => {
      expect(() => encryptField('test', new Uint8Array(16))).toThrow(
        'ERR_E2E_INVALID_KEY_LENGTH',
      );
    });

    it('throws on decrypt with invalid key length', () => {
      const encrypted = encryptField('test', key.raw);
      expect(() => decryptField(encrypted, new Uint8Array(16))).toThrow(
        'ERR_E2E_INVALID_KEY_LENGTH',
      );
    });

    it('throws on decrypt with unsupported version', () => {
      expect(() =>
        decryptField({ v: 'e2e:v0', d: 'AAAA' }, key.raw),
      ).toThrow('ERR_E2E_INVALID_CIPHERTEXT_FORMAT');
    });

    it('throws on decrypt with truncated bundle', () => {
      expect(() =>
        decryptField({ v: 'e2e:v1', d: Buffer.from('too-short').toString('base64') }, key.raw),
      ).toThrow('ERR_E2E_INVALID_NONCE_LENGTH');
    });

    it('throws on decrypt with tampered ciphertext', () => {
      const encrypted = encryptField('secret', key.raw);
      const bundle = Buffer.from(encrypted.d, 'base64');
      const byte = bundle[NONCE_LENGTH];
      if (byte !== undefined) bundle[NONCE_LENGTH] = byte ^ 0xff;
      const tampered: typeof encrypted = { v: encrypted.v, d: Buffer.from(bundle).toString('base64') };
      expect(() => decryptField(tampered, key.raw)).toThrow(
        'ERR_E2E_DECRYPTION_FAILED',
      );
    });

    it('throws on decrypt with tampered nonce', () => {
      const encrypted = encryptField('secret', key.raw);
      const bundle = Buffer.from(encrypted.d, 'base64');
      const byte = bundle[0];
      if (byte !== undefined) bundle[0] = byte ^ 0xff;
      const tampered: typeof encrypted = { v: encrypted.v, d: Buffer.from(bundle).toString('base64') };
      expect(() => decryptField(tampered, key.raw)).toThrow(
        'ERR_E2E_DECRYPTION_FAILED',
      );
    });
  });

  describe('encryptSensitiveFields / decryptSensitiveFields', () => {
    const key = generateEncryptionKey();

    it('encrypts and decrypts multiple fields', () => {
      const fields = {
        amount: '1000',
        accountId: 'acc_abc123',
        deviceSerial: 'SN-98765',
      };

      const { encrypted, count } = encryptSensitiveFields(fields, key.raw);
      expect(count).toBe(3);
      expect(Object.keys(encrypted)).toEqual(['amount', 'accountId', 'deviceSerial']);

      const result = decryptSensitiveFields(encrypted, key.raw);
      expect(result.count).toBe(3);
      expect(Object.keys(result.failures)).toHaveLength(0);
      expect(result.decrypted['amount']).toBe('1000');
      expect(result.decrypted['accountId']).toBe('acc_abc123');
      expect(result.decrypted['deviceSerial']).toBe('SN-98765');
    });

    it('handles empty fields map', () => {
      const { encrypted, count } = encryptSensitiveFields({}, key.raw);
      expect(count).toBe(0);
      expect(Object.keys(encrypted)).toHaveLength(0);
    });

    it('collects decryption failures per field', () => {
      const fields = { good: 'value' };
      const { encrypted } = encryptSensitiveFields(fields, key.raw);

      const broken: Record<string, unknown> = {
        good: encrypted['good'],
        bad: { v: 'e2e:v1', d: 'invalid-base64!!!' },
      };

      const result = decryptSensitiveFields(broken as Record<string, import('../../../src/core/crypto/e2e_encryption.js').EncryptedField>, key.raw);
      expect(result.count).toBe(1);
      expect(result.decrypted['good']).toBe('value');
      expect(Object.keys(result.failures)).toContain('bad');
    });
  });

  describe('tryParseEncryptedField', () => {
    const key = generateEncryptionKey();

    it('parses a valid encrypted field object', () => {
      const encrypted = encryptField('test', key.raw);
      const parsed = tryParseEncryptedField(encrypted);
      expect(parsed).not.toBeNull();
      expect(parsed!['v']).toBe('e2e:v1');
      expect(parsed!['d']).toBe(encrypted.d);
    });

    it('returns null for a plain number', () => {
      expect(tryParseEncryptedField(42)).toBeNull();
    });

    it('returns null for a plain string', () => {
      expect(tryParseEncryptedField('hello')).toBeNull();
    });

    it('returns null for null', () => {
      expect(tryParseEncryptedField(null)).toBeNull();
    });

    it('returns null for objects missing the protocol version', () => {
      expect(tryParseEncryptedField({ d: 'AAAA' })).toBeNull();
    });

    it('returns null for empty object', () => {
      expect(tryParseEncryptedField({})).toBeNull();
    });
  });

  describe('decryptMetricValue', () => {
    const key = generateEncryptionKey();

    it('passes through plain numbers', () => {
      expect(decryptMetricValue(42, key.raw)).toBe(42);
      expect(decryptMetricValue(0, key.raw)).toBe(0);
      expect(decryptMetricValue(-1, key.raw)).toBe(-1);
      expect(decryptMetricValue(3.14, key.raw)).toBe(3.14);
    });

    it('decrypts an encrypted field to a number', () => {
      const encrypted = encryptMetricValue(12345, key.raw);
      expect(decryptMetricValue(encrypted, key.raw)).toBe(12345);
    });

    it('throws on decrypting an encrypted non-numeric value', () => {
      const encrypted = encryptField('not-a-number', key.raw);
      expect(() => decryptMetricValue(encrypted, key.raw)).toThrow(
        'Decrypted value is not a valid number',
      );
    });
  });

  describe('encryptMetricValue', () => {
    const key = generateEncryptionKey();

    it('encrypts a number and produces a valid EncryptedField', () => {
      const encrypted = encryptMetricValue(98765, key.raw);
      expect(encrypted.v).toBe('e2e:v1');

      const decrypted = decryptField(encrypted, key.raw);
      expect(Number(decrypted)).toBe(98765);
    });

    it('encrypts zero', () => {
      const encrypted = encryptMetricValue(0, key.raw);
      const decrypted = decryptField(encrypted, key.raw);
      expect(Number(decrypted)).toBe(0);
    });

    it('encrypts negative numbers', () => {
      const encrypted = encryptMetricValue(-42, key.raw);
      const decrypted = decryptField(encrypted, key.raw);
      expect(Number(decrypted)).toBe(-42);
    });

    it('encrypts floating point numbers', () => {
      const encrypted = encryptMetricValue(3.14159, key.raw);
      const decrypted = decryptField(encrypted, key.raw);
      expect(Number(decrypted)).toBeCloseTo(3.14159, 5);
    });
  });

  it('round-trips through the full encrypt-decrypt cycle for billing data', () => {
    const key = generateEncryptionKey();
    const billingData = {
      amount: '250000',
      accountId: 'GABC123DEF456',
      deviceSerial: 'MTR-2024-001',
      timestamp: String(Date.now()),
    };

    const { encrypted } = encryptSensitiveFields(billingData, key.raw);
    expect(Object.keys(encrypted)).toHaveLength(4);

    const result = decryptSensitiveFields(encrypted, key.raw);
    expect(result.count).toBe(4);
    expect(result.failures).toEqual({});
    expect(result.decrypted['amount']).toBe('250000');
    expect(result.decrypted['accountId']).toBe('GABC123DEF456');
  });
});
