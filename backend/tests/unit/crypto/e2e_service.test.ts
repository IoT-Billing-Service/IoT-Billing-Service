import { describe, it, expect, beforeEach } from 'vitest';
import { E2eEncryptionService } from '../../../src/core/crypto/e2e_service.js';
import { generateEncryptionKey } from '../../../src/core/crypto/e2e_encryption.js';

describe('E2eEncryptionService', () => {
  let svc: E2eEncryptionService;

  beforeEach(() => {
    svc = new E2eEncryptionService();
  });

  describe('constructor', () => {
    it('generates a key when none is provided', () => {
      const s = new E2eEncryptionService();
      expect(s.keyRaw).toHaveLength(32);
      expect(s.keyHex).toHaveLength(64);
    });

    it('uses the provided key', () => {
      const key = generateEncryptionKey();
      const s = new E2eEncryptionService(key);
      expect(s.keyHex).toBe(key.hex);
      expect(s.keyRaw).toEqual(key.raw);
    });
  });

  describe('fromHex', () => {
    it('creates a service from a hex key', () => {
      const key = generateEncryptionKey();
      const s = E2eEncryptionService.fromHex(key.hex);
      expect(s.keyHex).toBe(key.hex);
    });

    it('throws on invalid hex', () => {
      expect(() => E2eEncryptionService.fromHex('invalid')).toThrow();
    });
  });

  describe('billing field encryption', () => {
    it('encrypts and decrypts a single billing field', () => {
      const encrypted = svc.encryptBillingField('1000');
      expect(encrypted.v).toBe('e2e:v1');

      const decrypted = svc.decryptBillingField(encrypted);
      expect(decrypted).toBe('1000');
    });
  });

  describe('billing payload encryption', () => {
    it('encrypts and decrypts billing payload fields', () => {
      const encrypted = svc.encryptBillingPayload({
        amount: '50000',
        accountId: 'GABCDEF123',
      });

      expect(Object.keys(encrypted)).toHaveLength(2);
      expect(encrypted['amount']).toBeDefined();
      expect(encrypted['accountId']).toBeDefined();

      const decrypted = svc.decryptBillingPayload(encrypted);
      expect(decrypted['amount']).toBe('50000');
      expect(decrypted['accountId']).toBe('GABCDEF123');
    });

    it('handles partial billing payload', () => {
      const encrypted = svc.encryptBillingPayload({ amount: '100' });
      expect(Object.keys(encrypted)).toHaveLength(1);
      expect(encrypted['amount']).toBeDefined();

      const decrypted = svc.decryptBillingPayload(encrypted);
      expect(decrypted['amount']).toBe('100');
      expect(decrypted['accountId']).toBeUndefined();
    });

    it('handles empty billing payload', () => {
      const encrypted = svc.encryptBillingPayload({});
      expect(Object.keys(encrypted)).toHaveLength(0);
    });
  });

  describe('telemetry metrics encryption', () => {
    it('encrypts and decrypts telemetry metrics', () => {
      const encrypted = svc.encryptTelemetryMetrics({
        power_usage: '1500',
        voltage: '220',
        current: '6.8',
      });

      expect(Object.keys(encrypted)).toHaveLength(3);

      const result = svc.decryptTelemetryMetrics(encrypted);
      expect(result.count).toBe(3);
      expect(result.metrics['power_usage']).toBe('1500');
      expect(result.metrics['voltage']).toBe('220');
      expect(result.metrics['current']).toBe('6.8');
      expect(Object.keys(result.failures)).toHaveLength(0);
    });

    it('handles empty metrics', () => {
      const encrypted = svc.encryptTelemetryMetrics({});
      expect(Object.keys(encrypted)).toHaveLength(0);
      const result = svc.decryptTelemetryMetrics(encrypted);
      expect(result.count).toBe(0);
    });

    it('collects failures for corrupted fields', () => {
      const original = svc.encryptTelemetryMetrics({ good: '123' });

      const corrupted: Record<string, unknown> = {
        good: original['good'],
        bad: { v: 'e2e:v1', d: 'AAAA' },
      };

      const result = svc.decryptTelemetryMetrics(corrupted as Record<string, import('../../../src/core/crypto/e2e_encryption.js').EncryptedField>);
      expect(result.count).toBe(1);
      expect(result.metrics['good']).toBe('123');
      expect(Object.keys(result.failures)).toContain('bad');
    });
  });

  describe('cross-service interoperability', () => {
    it('two services with the same key can exchange encrypted data', () => {
      const key = generateEncryptionKey();
      const svc1 = new E2eEncryptionService(key);
      const svc2 = new E2eEncryptionService(key);

      const encrypted = svc1.encryptBillingField('shared-secret');
      const decrypted = svc2.decryptBillingField(encrypted);
      expect(decrypted).toBe('shared-secret');
    });

    it('services with different keys cannot decrypt each other data', () => {
      const svc1 = new E2eEncryptionService();
      const svc2 = new E2eEncryptionService();

      const encrypted = svc1.encryptBillingField('my-secret');
      expect(() => svc2.decryptBillingField(encrypted)).toThrow();
    });
  });
});
