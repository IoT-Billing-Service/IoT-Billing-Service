/**
 * High-level E2E encryption service for the IoT billing platform (issue #89).
 *
 * Provides convenience methods for encrypting/decrypting sensitive fields
 * in billing records, refund records, and telemetry payloads.
 *
 * ## Usage
 *
 * ```ts
 * const svc = new E2eEncryptionService(encryptionKey);
 *
 * // Encrypt sensitive fields before persistence
 * const encrypted = svc.encryptBillingPayload({ amount: '1000', accountId: 'acc_123' });
 *
 * // Decrypt sensitive fields after reading
 * const decrypted = svc.decryptTelemetryPayload(encryptedPayload);
 * ```
 *
 * ## Performance
 *
 * | Operation           | Expected latency | Notes                                |
 * |---------------------|------------------|--------------------------------------|
 * | encryptField        | < 5 µs           | NaCl secretbox, fully synchronous    |
 * | decryptField        | < 5 µs           | NaCl secretbox open, fully sync      |
 * | encrypt batch (10)  | < 50 µs          | Bulk encryption, no I/O              |
 * | decrypt batch (10)  | < 50 µs          | Bulk decryption, no I/O              |
 *
 * All operations stay well under the 200ms P99 billing budget.
 */

import {
  encryptField,
  decryptField,
  encryptSensitiveFields,
  decryptSensitiveFields,
  generateEncryptionKey,
  encryptionKeyFromHex,
  type EncryptionKey,
  type EncryptedField,
} from './e2e_encryption.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface BillingSensitiveFields {
  /** Billing amount as a decimal string (e.g. "1000"). */
  amount?: string;
  /** Account identifier. */
  accountId?: string;
}

export interface TelemetrySensitiveFields {
  /** Map of metric names to their numeric values. */
  [metricName: string]: string;
}

// ── Service ────────────────────────────────────────────────────────────────────

export class E2eEncryptionService {
  private readonly key: EncryptionKey;

  constructor(key?: EncryptionKey) {
    this.key = key ?? generateEncryptionKey();
  }

  /**
   * The raw encryption key bytes.
   */
  get keyRaw(): Uint8Array {
    return this.key.raw;
  }

  /**
   * The hex-encoded encryption key.
   */
  get keyHex(): string {
    return this.key.hex;
  }

  /**
   * Create an instance from a hex-encoded key string.
   */
  static fromHex(hex: string): E2eEncryptionService {
    return new E2eEncryptionService(encryptionKeyFromHex(hex));
  }

  /**
   * Encrypt a single billing field.
   */
  encryptBillingField(plaintext: string): EncryptedField {
    return encryptField(plaintext, this.key.raw);
  }

  /**
   * Decrypt a single billing field.
   */
  decryptBillingField(field: EncryptedField): string {
    return decryptField(field, this.key.raw);
  }

  /**
   * Encrypt sensitive billing payload fields.
   *
   * @param fields — the sensitive billing data to encrypt
   * @returns map of field names to encrypted values
   */
  encryptBillingPayload(fields: BillingSensitiveFields): Record<string, EncryptedField> {
    const toEncrypt: Record<string, string> = {};
    if (fields.amount !== undefined) toEncrypt['amount'] = fields.amount;
    if (fields.accountId !== undefined) toEncrypt['accountId'] = fields.accountId;
    const result = encryptSensitiveFields(toEncrypt, this.key.raw);
    return result.encrypted;
  }

  /**
   * Decrypt sensitive billing payload fields.
   *
   * @param encrypted — map of field names to encrypted values
   * @returns the decrypted billing fields
   */
  decryptBillingPayload(encrypted: Record<string, EncryptedField>): BillingSensitiveFields {
    const result = decryptSensitiveFields(encrypted, this.key.raw);
    return {
      amount: result.decrypted['amount'],
      accountId: result.decrypted['accountId'],
    };
  }

  /**
   * Encrypt sensitive telemetry metric values.
   *
   * @param metrics — map of metric names to plaintext string values
   * @returns map of metric names to encrypted values
   */
  encryptTelemetryMetrics(metrics: TelemetrySensitiveFields): Record<string, EncryptedField> {
    const result = encryptSensitiveFields(metrics, this.key.raw);
    return result.encrypted;
  }

  /**
   * Decrypt sensitive telemetry metric values.
   *
   * @param encrypted — map of metric names to encrypted values
   * @returns the decrypted metric values as strings
   */
  decryptTelemetryMetrics(
    encrypted: Record<string, EncryptedField>,
  ): DecryptTelemetryResult {
    const result = decryptSensitiveFields(encrypted, this.key.raw);
    return {
      metrics: result.decrypted,
      failures: result.failures,
      count: result.count,
    };
  }
}

export interface DecryptTelemetryResult {
  metrics: Record<string, string>;
  failures: Record<string, string>;
  count: number;
}
