import { Buffer } from 'node:buffer';
import nacl from 'tweetnacl';

// ── Constants ──────────────────────────────────────────────────────────────────

/** Key length for NaCl secretbox (32 bytes). */
export const ENCRYPTION_KEY_LENGTH = nacl.secretbox.keyLength;

/** Nonce length for NaCl secretbox (24 bytes). */
export const NONCE_LENGTH = nacl.secretbox.nonceLength;

/** Overhead added by NaCl secretbox over the plaintext (16 bytes). */
export const ENCRYPTION_OVERHEAD = nacl.secretbox.overheadLength;

/** Minimum required key length in hex (64 hex chars). */
export const KEY_HEX_LENGTH = ENCRYPTION_KEY_LENGTH * 2;

/** Protocol version prefix for encrypted fields. */
const PROTOCOL_VERSION = 'e2e:v1';

// ── Error codes ────────────────────────────────────────────────────────────────

export const E2E_ERROR_CODES = {
  INVALID_KEY_LENGTH: 'ERR_E2E_INVALID_KEY_LENGTH',
  INVALID_NONCE_LENGTH: 'ERR_E2E_INVALID_NONCE_LENGTH',
  DECRYPTION_FAILED: 'ERR_E2E_DECRYPTION_FAILED',
  ENCRYPTION_FAILED: 'ERR_E2E_ENCRYPTION_FAILED',
  INVALID_CIPHERTEXT_FORMAT: 'ERR_E2E_INVALID_CIPHERTEXT_FORMAT',
} as const;

// ── Types ──────────────────────────────────────────────────────────────────────

export interface EncryptionKey {
  /** 32 raw bytes for NaCl secretbox. */
  raw: Uint8Array;
  /** Hex-encoded representation (64 chars). */
  hex: string;
}

/**
 * Encrypted payload field with nonce and metadata.
 *
 * Format (JSON): `{ "v": "e2e:v1", "d": "<base64-nonce>.<base64-ciphertext>" }`
 */
export interface EncryptedField {
  /** Protocol version. */
  v: string;
  /** Encrypted data: base64(nonce || ciphertext). */
  d: string;
}

/**
 * Result of encrypting a set of sensitive fields.
 */
export interface EncryptFieldsResult {
  /** Map of field names to their encrypted counterparts. */
  encrypted: Record<string, EncryptedField>;
  /** Number of fields encrypted. */
  count: number;
}

/**
 * Result of decrypting a set of encrypted fields.
 */
export interface DecryptFieldsResult {
  /** Map of field names to their decrypted string values. */
  decrypted: Record<string, string>;
  /** Number of fields successfully decrypted. */
  count: number;
  /** Fields that failed to decrypt (name -> error message). */
  failures: Record<string, string>;
}

// ── Key management ─────────────────────────────────────────────────────────────

/**
 * Generate a random 32-byte key for NaCl secretbox encryption.
 */
export function generateEncryptionKey(): EncryptionKey {
  const raw = nacl.randomBytes(ENCRYPTION_KEY_LENGTH);
  return {
    raw,
    hex: Buffer.from(raw).toString('hex'),
  };
}

/**
 * Parse an encryption key from a hex string.
 */
export function encryptionKeyFromHex(hex: string): EncryptionKey {
  if (hex.length !== KEY_HEX_LENGTH) {
    throw new Error(
      `${E2E_ERROR_CODES.INVALID_KEY_LENGTH}: expected ${String(KEY_HEX_LENGTH)} hex chars, got ${String(hex.length)}`,
    );
  }
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== ENCRYPTION_KEY_LENGTH) {
    throw new Error(
      `${E2E_ERROR_CODES.INVALID_KEY_LENGTH}: expected ${String(ENCRYPTION_KEY_LENGTH)} bytes, got ${String(buf.length)}`,
    );
  }
  // Copy into a plain Uint8Array so the returned raw is not a Buffer
  const raw = new Uint8Array(buf);
  return { raw, hex };
}

// ── Field encryption / decryption ──────────────────────────────────────────────

/**
 * Encrypt a single sensitive field value.
 *
 * @param plaintext — the string value to encrypt
 * @param key       — the 32-byte encryption key
 * @returns {@link EncryptedField} containing the nonce and ciphertext
 */
export function encryptField(plaintext: string, key: Uint8Array): EncryptedField {
  if (key.length !== ENCRYPTION_KEY_LENGTH) {
    throw new Error(
      `${E2E_ERROR_CODES.INVALID_KEY_LENGTH}: expected ${String(ENCRYPTION_KEY_LENGTH)} bytes, got ${String(key.length)}`,
    );
  }

  const nonce = nacl.randomBytes(NONCE_LENGTH);
  const plainBytes = Buffer.from(plaintext, 'utf-8');
  const ciphertext = nacl.secretbox(plainBytes, nonce, key);

  if (ciphertext === null) {
    throw new Error(`${E2E_ERROR_CODES.ENCRYPTION_FAILED}: secretbox returned null`);
  }

  // Bundle: nonce + ciphertext as a single base64 string
  const bundle = Buffer.concat([nonce, ciphertext]);
  const d = Buffer.from(bundle).toString('base64');

  return { v: PROTOCOL_VERSION, d };
}

/**
 * Decrypt a single encrypted field.
 *
 * @param field — the {@link EncryptedField} containing nonce and ciphertext
 * @param key   — the 32-byte encryption key
 * @returns the decrypted plaintext string
 */
export function decryptField(field: EncryptedField, key: Uint8Array): string {
  if (key.length !== ENCRYPTION_KEY_LENGTH) {
    throw new Error(
      `${E2E_ERROR_CODES.INVALID_KEY_LENGTH}: expected ${String(ENCRYPTION_KEY_LENGTH)} bytes, got ${String(key.length)}`,
    );
  }

  if (field.v !== PROTOCOL_VERSION) {
    throw new Error(
      `${E2E_ERROR_CODES.INVALID_CIPHERTEXT_FORMAT}: unsupported protocol version "${field.v}"`,
    );
  }

  const bundle = Buffer.from(field.d, 'base64');
  if (bundle.length < NONCE_LENGTH + 1) {
    throw new Error(
      `${E2E_ERROR_CODES.INVALID_NONCE_LENGTH}: bundle too short (${String(bundle.length)} bytes)`,
    );
  }

  const nonce = bundle.subarray(0, NONCE_LENGTH);
  const ciphertext = bundle.subarray(NONCE_LENGTH);

  const decrypted = nacl.secretbox.open(ciphertext, nonce, key);
  if (decrypted === null) {
    throw new Error(`${E2E_ERROR_CODES.DECRYPTION_FAILED}: authentication failed`);
  }

  return Buffer.from(decrypted).toString('utf-8');
}

// ── Batch operations ───────────────────────────────────────────────────────────

/**
 * Encrypt a map of sensitive fields.
 *
 * @param fields — map of field name -> string value to encrypt
 * @param key    — the 32-byte encryption key
 * @returns {@link EncryptFieldsResult}
 */
export function encryptSensitiveFields(
  fields: Record<string, string>,
  key: Uint8Array,
): EncryptFieldsResult {
  const encrypted: Record<string, EncryptedField> = {};
  for (const [name, value] of Object.entries(fields)) {
    encrypted[name] = encryptField(value, key);
  }
  return { encrypted, count: Object.keys(encrypted).length };
}

/**
 * Decrypt a map of encrypted fields, collecting failures per field.
 *
 * @param encrypted — map of field name -> {@link EncryptedField}
 * @param key       — the 32-byte encryption key
 * @returns {@link DecryptFieldsResult}
 */
export function decryptSensitiveFields(
  encrypted: Record<string, EncryptedField>,
  key: Uint8Array,
): DecryptFieldsResult {
  const decrypted: Record<string, string> = {};
  const failures: Record<string, string> = {};

  for (const [name, field] of Object.entries(encrypted)) {
    try {
      decrypted[name] = decryptField(field, key);
    } catch (err) {
      failures[name] = err instanceof Error ? err.message : String(err);
    }
  }

  return { decrypted, count: Object.keys(decrypted).length, failures };
}

// ── Payload-level helpers ──────────────────────────────────────────────────────

/**
 * Parse a potential encrypted field value. Returns the parsed {@link EncryptedField}
 * if the value looks like an encrypted payload, or `null` for plaintext values.
 */
export function tryParseEncryptedField(value: unknown): EncryptedField | null {
  if (typeof value !== 'object' || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (obj['v'] === PROTOCOL_VERSION && typeof obj['d'] === 'string') {
    return { v: obj['v'] as string, d: obj['d'] as string };
  }
  return null;
}

/**
 * Attempt to decrypt a single metric value that may be encrypted.
 * Falls back to returning the original value as-is if it's not encrypted.
 *
 * @param value — the raw metric value (could be a number or an EncryptedField)
 * @param key   — the 32-byte encryption key
 * @returns the decrypted number, or the original number if not encrypted
 */
export function decryptMetricValue(value: number | EncryptedField, key: Uint8Array): number {
  if (typeof value === 'number') {
    return value; // plaintext — no decryption needed
  }
  const decrypted = decryptField(value, key);
  const parsed = Number(decrypted);
  if (Number.isNaN(parsed)) {
    throw new Error(`Decrypted value is not a valid number: "${decrypted}"`);
  }
  return parsed;
}

/**
 * Encrypt a single metric value into an {@link EncryptedField}.
 *
 * @param value — the numeric metric value to encrypt
 * @param key   — the 32-byte encryption key
 * @returns {@link EncryptedField}
 */
export function encryptMetricValue(value: number, key: Uint8Array): EncryptedField {
  return encryptField(value.toString(), key);
}
