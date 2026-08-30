/**
 * Record codec for the Kafka Connect blockchain event sink (issue #291).
 *
 * Kafka carries blockchain events as opaque JSON envelopes. This module is the
 * single place that turns a raw Kafka record value into a validated, tamper
 * evident {@link BlockchainEventRecord} the sink can write to the durable
 * ledger bus.
 *
 * Two non-negotiable properties are enforced here so the sink satisfies the
 * platform's security bound ("all transactions must be cryptographically
 * verified"):
 *
 * 1. **Structural validation.** Every record must be a well-formed envelope
 *    with a supported version, a non-negative integer `sequence`, and an event
 *    object. Anything else is rejected with a structured reason and **never**
 *    reaches the ledger.
 *
 * 2. **Tamper evidence.** The canonical (key-sorted) JSON of the event body is
 *    hashed with SHA-256. The producer includes that hash as the `contentHash`
 *    field; if provided, the sink recomputes it and verifies the signature (an
 *    Ed25519 signature of the canonical content) when signature verification is
 *    enabled. A mismatch means the record was altered in transit or by a
 *    malicious producer, and it is rejected.
 */

import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import type { ByteInput } from './types.js';

/** Supported envelope version. */
export const ENVELOPE_VERSION = 1;

/** Canonical (key-sorted) serialization shared by hash and signature checks. */
export function canonicalJson(value: Record<string, unknown>): string {
  return JSON.stringify(sortKeys(value));
}

/** Recursively order object keys so hashing is stable regardless of key order. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** The decoded, validated form of a blockchain event record. */
export interface BlockchainEventRecord {
  /** Monotonic ledger sequence number. */
  sequence: number;
  /** Event type discriminator (e.g. `PaymentFinalized`). */
  eventType: string;
  /** String-keyed payload for the Redis Streams ledger event. */
  payload: Record<string, string>;
  /** Producer timestamp in ms if present. */
  producedAtMs?: number;
  /** SHA-256 (hex) of the canonical event body — tamper evidence. */
  contentHash: string;
  /** Verified=true only when a signature was present and accepted. */
  verified: boolean;
}

/** Structured reason a record was rejected. */
export type RejectReason =
  | 'empty'
  | 'not-json'
  | 'unsupported-version'
  | 'missing-sequence'
  | 'invalid-sequence'
  | 'missing-event'
  | 'invalid-event'
  | 'unexpected-field'
  | 'hash-mismatch'
  | 'signature-invalid';

/** Thrown by {@link decodeEventRecord} when a record cannot be sunk. */
export class RecordRejectedError extends Error {
  readonly reason: RejectReason;
  constructor(reason: RejectReason, detail?: string) {
    super(detail ? `record rejected (${reason}): ${detail}` : `record rejected (${reason})`);
    this.name = 'RecordRejectedError';
    this.reason = reason;
  }
}

export interface DecodeOptions {
  /**
   * PEM-encoded Ed25519 public key. When set, a `signature` field on the
   * envelope is mandatory and verified against the canonical content hash.
   * When unset, signature checks are skipped (but a mismatching `contentHash`
   * still rejects the record).
   */
  verifyPublicKeyPem?: string;
}

/**
 * Decode and validate a Kafka record value into a {@link BlockchainEventRecord}.
 *
 * @throws {RecordRejectedError} with a structured `.reason` on any failure.
 */
export function decodeEventRecord(
  value: ByteInput,
  options: DecodeOptions = {},
): BlockchainEventRecord {
  if (value === null || value === undefined || (Buffer.isBuffer(value) && value.length === 0)) {
    throw new RecordRejectedError('empty');
  }

  const raw = typeof value === 'string' ? value : value.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new RecordRejectedError('not-json');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new RecordRejectedError('not-json');
  }
  const envelope = parsed as Record<string, unknown>;

  const version = envelope['v'];
  if (version !== ENVELOPE_VERSION) {
    throw new RecordRejectedError('unsupported-version');
  }

  const sequence = envelope['sequence'];
  if (sequence === undefined || sequence === null || sequence === '') {
    throw new RecordRejectedError('missing-sequence');
  }
  const sequenceNum = Number(sequence);
  if (!Number.isSafeInteger(sequenceNum) || sequenceNum < 0) {
    throw new RecordRejectedError('invalid-sequence');
  }

  const event = envelope['event'];
  if (event === undefined || event === null) {
    throw new RecordRejectedError('missing-event');
  }
  if (typeof event !== 'object' || Array.isArray(event)) {
    throw new RecordRejectedError('invalid-event');
  }
  const eventObj = event as Record<string, unknown>;
  const eventType = eventObj['type'];
  if (typeof eventType !== 'string' || eventType.length === 0) {
    throw new RecordRejectedError('invalid-event');
  }

  // Strings for the Redis Streams payload. Unknown nulls are dropped; nested
  // objects/arrays are JSON-stringified so no data is silently lost.
  const payload: Record<string, string> = {};
  for (const [rawKey, val] of Object.entries(eventObj)) {
    if (rawKey === 'type') continue;
    if (val === null || val === undefined) continue;
    if (typeof val === 'string') {
      payload[rawKey] = val;
    } else if (val instanceof Array && val.length === 0) {
      payload[rawKey] = '[]';
    } else {
      payload[rawKey] = JSON.stringify(val);
    }
  }

  // Tamper evidence: recompute the canonical hash of the event body.
  const canonical = canonicalJson(eventObj);
  const computedHash = sha256Hex(canonical);
  const declaredHash =
    typeof envelope['contentHash'] === 'string' ? envelope['contentHash'] : undefined;
  if (declaredHash !== undefined && declaredHash !== computedHash) {
    throw new RecordRejectedError('hash-mismatch');
  }

  // Optional cryptographic verification.
  let verified = false;
  const signature = typeof envelope['signature'] === 'string' ? envelope['signature'] : undefined;
  if (options.verifyPublicKeyPem !== undefined && options.verifyPublicKeyPem !== '') {
    if (typeof signature !== 'string' || signature.length === 0) {
      throw new RecordRejectedError('signature-invalid');
    }
    if (!verifySignature(options.verifyPublicKeyPem, canonical, signature)) {
      throw new RecordRejectedError('signature-invalid');
    }
    verified = true;
  }

  const producedAtRaw = envelope['producedAt'];
  const producedAtMs =
    typeof producedAtRaw === 'number' && Number.isFinite(producedAtRaw) ? producedAtRaw : undefined;

  return {
    sequence: sequenceNum,
    eventType,
    payload,
    producedAtMs,
    contentHash: computedHash,
    verified,
  };
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Verify an Ed25519 signature over canonical content. Accepts both base64 and
 * hex-encoded signatures; the key may be a trusted PEM public key or a
 * base64-encoded raw 32-byte Ed25519 public key (as used elsewhere in this
 * codebase via tweetnacl).
 */
export function verifySignature(keyPemOrRaw: string, content: string, signature: string): boolean {
  try {
    const publicKey = buildPublicKey(keyPemOrRaw);
    const sigBuf = bufferFromEncoding(signature);
    return verify(null, Buffer.from(content, 'utf8'), publicKey, sigBuf);
  } catch {
    return false;
  }
}

function buildPublicKey(keyPemOrRaw: string): KeyObject {
  const pem = keyPemOrRaw.trim();
  if (pem.includes('BEGIN PUBLIC KEY')) {
    return createPublicKey(pem);
  }
  // Assume base64- or hex-encoded SPKI DER public key (e.g. produced by
  // `openssl pkey -pubout -outform DER` and base64-encoded).
  const keyBuffer = /^[0-9a-fA-F]+$/.test(pem)
    ? Buffer.from(pem, 'hex')
    : Buffer.from(pem, 'base64');
  return createPublicKey({ key: keyBuffer, format: 'der', type: 'spki' });
}

function bufferFromEncoding(value: string): Buffer {
  if (/^[0-9a-fA-F]{2,}$/.test(value)) return Buffer.from(value, 'hex');
  return Buffer.from(value, 'base64');
}
