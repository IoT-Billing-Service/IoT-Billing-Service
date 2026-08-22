/**
 * Unit tests for MeterReadingValidator (Issue #293)
 *
 * Tests cover:
 *  - buildSignatureMessage: canonical JSON determinism
 *  - createMeterValidatorMetrics: registry isolation
 *  - MeterReadingValidator.validate:
 *      happy path (valid sig + valid proof)
 *      invalid range bounds (lower >= upper)
 *      value out of range
 *      invalid public key length
 *      bad signature length
 *      signature mismatch
 *      tampered ZK proof (commitment, challenge, response mutations)
 *      proof decode failure (invalid base64)
 *  - MeterReadingValidator.validateBatch:
 *      all valid, mixed valid/invalid, length mismatch
 *  - Prometheus metrics emission
 */

import { describe, it, expect, beforeEach } from 'vitest';
import nacl from 'tweetnacl';
import { Buffer } from 'node:buffer';
import { Registry } from 'prom-client';
import {
  buildSignatureMessage,
  createMeterValidatorMetrics,
  MeterReadingValidator,
  METER_VALIDATION_ERROR_CODES,
  type MeterReading,
} from '../../../src/core/crypto/meter_reading_validator.js';
import { RangeProofGenerator } from '../../../src/core/crypto/zk_verifier.js';

// ── Test fixtures ─────────────────────────────────────────────────────────────

/** Generate a fresh Ed25519 key pair for each test that needs one. */
function makeKeyPair(): nacl.SignKeyPair {
  return nacl.sign.keyPair();
}

/**
 * Build a fully valid, signed MeterReading.
 * The returned `keyPair.publicKey` is the key to pass to the validator.
 */
function buildValidReading(opts?: {
  value?: bigint;
  lowerBound?: bigint;
  upperBound?: bigint;
  deviceId?: string;
}): { reading: MeterReading; keyPair: nacl.SignKeyPair } {
  const keyPair = makeKeyPair();
  const deviceId = opts?.deviceId ?? 'device-abc';
  const value = opts?.value ?? 500n;
  const lowerBound = opts?.lowerBound ?? 0n;
  const upperBound = opts?.upperBound ?? 10_000n;
  const timestamp = Date.now();
  const metricId = 'energy_kwh';

  // Build the canonical message and sign it
  const message = buildSignatureMessage({ deviceId, metricId, value, timestamp, lowerBound, upperBound });
  const sigBytes = nacl.sign.detached(message, keyPair.secretKey);
  const signature = Buffer.from(sigBytes).toString('hex');

  // Generate a valid ZK range proof
  const proofBuffer = RangeProofGenerator.generate(value, deviceId, lowerBound, upperBound);
  const rangeProof = proofBuffer.toString('base64');

  return {
    keyPair,
    reading: { deviceId, metricId, value, timestamp, lowerBound, upperBound, signature, rangeProof },
  };
}

// ── buildSignatureMessage ─────────────────────────────────────────────────────

describe('buildSignatureMessage', () => {
  it('produces identical bytes for the same input (deterministic)', () => {
    const params = {
      deviceId: 'dev-1',
      metricId: 'kwh',
      value: 100n,
      timestamp: 1_000_000,
      lowerBound: 0n,
      upperBound: 1000n,
    };
    const a = buildSignatureMessage(params);
    const b = buildSignatureMessage(params);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('produces different bytes when any field changes', () => {
    const base = {
      deviceId: 'dev-1',
      metricId: 'kwh',
      value: 100n,
      timestamp: 1_000_000,
      lowerBound: 0n,
      upperBound: 1000n,
    };
    const changed = { ...base, value: 101n };
    expect(Buffer.from(buildSignatureMessage(base)).equals(Buffer.from(buildSignatureMessage(changed)))).toBe(false);
  });

  it('includes all six required fields', () => {
    const msg = buildSignatureMessage({
      deviceId: 'dev-1',
      metricId: 'kwh',
      value: 42n,
      timestamp: 9999,
      lowerBound: 0n,
      upperBound: 100n,
    });
    const parsed = JSON.parse(Buffer.from(msg).toString('utf-8')) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(
      ['deviceId', 'lowerBound', 'metricId', 'timestamp', 'upperBound', 'value'].sort(),
    );
  });

  it('serialises bigint fields as strings', () => {
    const msg = buildSignatureMessage({
      deviceId: 'dev',
      metricId: 'm',
      value: 999999999999999n,
      timestamp: 0,
      lowerBound: 0n,
      upperBound: 9999999999999999n,
    });
    const parsed = JSON.parse(Buffer.from(msg).toString('utf-8')) as Record<string, unknown>;
    expect(parsed['value']).toBe('999999999999999');
    expect(parsed['lowerBound']).toBe('0');
    expect(parsed['upperBound']).toBe('9999999999999999');
  });
});

// ── createMeterValidatorMetrics ───────────────────────────────────────────────

describe('createMeterValidatorMetrics', () => {
  it('creates metrics without throwing', () => {
    expect(() => createMeterValidatorMetrics(new Registry())).not.toThrow();
  });

  it('does not collide across separate registries', () => {
    expect(() => {
      createMeterValidatorMetrics(new Registry());
      createMeterValidatorMetrics(new Registry());
    }).not.toThrow();
  });

  it('returns histogram and counter objects', () => {
    const m = createMeterValidatorMetrics(new Registry());
    expect(m.validationDuration).toBeDefined();
    expect(m.validationTotal).toBeDefined();
  });
});

// ── MeterReadingValidator.validate — happy path ───────────────────────────────

describe('MeterReadingValidator.validate — happy path', () => {
  let validator: MeterReadingValidator;

  beforeEach(() => {
    validator = new MeterReadingValidator();
  });

  it('returns valid=true for a correctly signed reading with valid proof', () => {
    const { reading, keyPair } = buildValidReading();
    const result = validator.validate(reading, keyPair.publicKey);
    expect(result.valid).toBe(true);
    expect(result.signatureValid).toBe(true);
    expect(result.zkResult?.valid).toBe(true);
  });

  it('accepts a hex string public key', () => {
    const { reading, keyPair } = buildValidReading();
    const hexKey = Buffer.from(keyPair.publicKey).toString('hex');
    const result = validator.validate(reading, hexKey);
    expect(result.valid).toBe(true);
  });

  it('accepts a raw Buffer range proof', () => {
    const { reading, keyPair } = buildValidReading();
    const bufProof = Buffer.from(reading.rangeProof as string, 'base64');
    const result = validator.validate({ ...reading, rangeProof: bufProof }, keyPair.publicKey);
    expect(result.valid).toBe(true);
  });
});

// ── MeterReadingValidator.validate — range bound checks ──────────────────────

describe('MeterReadingValidator.validate — range bound checks', () => {
  let validator: MeterReadingValidator;

  beforeEach(() => {
    validator = new MeterReadingValidator();
  });

  it('rejects when lowerBound equals upperBound', () => {
    const { reading, keyPair } = buildValidReading({ lowerBound: 100n, upperBound: 100n });
    const result = validator.validate(reading, keyPair.publicKey);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(METER_VALIDATION_ERROR_CODES.INVALID_RANGE_BOUNDS);
  });

  it('rejects when lowerBound is greater than upperBound', () => {
    const { reading, keyPair } = buildValidReading({ lowerBound: 500n, upperBound: 100n });
    const result = validator.validate(reading, keyPair.publicKey);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(METER_VALIDATION_ERROR_CODES.INVALID_RANGE_BOUNDS);
  });

  it('rejects when value is below lowerBound', () => {
    const keyPair = makeKeyPair();
    const deviceId = 'dev-range';
    const value = 5n;
    const lowerBound = 10n;
    const upperBound = 1000n;
    const timestamp = Date.now();
    const message = buildSignatureMessage({ deviceId, metricId: 'm', value, timestamp, lowerBound, upperBound });
    const sig = Buffer.from(nacl.sign.detached(message, keyPair.secretKey)).toString('hex');
    const proof = RangeProofGenerator.generate(value, deviceId, lowerBound, upperBound).toString('base64');
    const reading: MeterReading = { deviceId, metricId: 'm', value, timestamp, lowerBound, upperBound, signature: sig, rangeProof: proof };
    const result = validator.validate(reading, keyPair.publicKey);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(METER_VALIDATION_ERROR_CODES.OUT_OF_RANGE);
  });

  it('rejects when value is above upperBound', () => {
    const keyPair = makeKeyPair();
    const deviceId = 'dev-range2';
    const value = 2000n;
    const lowerBound = 0n;
    const upperBound = 1000n;
    const timestamp = Date.now();
    const message = buildSignatureMessage({ deviceId, metricId: 'm', value, timestamp, lowerBound, upperBound });
    const sig = Buffer.from(nacl.sign.detached(message, keyPair.secretKey)).toString('hex');
    const proof = RangeProofGenerator.generate(value, deviceId, lowerBound, upperBound).toString('base64');
    const reading: MeterReading = { deviceId, metricId: 'm', value, timestamp, lowerBound, upperBound, signature: sig, rangeProof: proof };
    const result = validator.validate(reading, keyPair.publicKey);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(METER_VALIDATION_ERROR_CODES.OUT_OF_RANGE);
  });
});

// ── MeterReadingValidator.validate — public key errors ───────────────────────

describe('MeterReadingValidator.validate — public key errors', () => {
  let validator: MeterReadingValidator;

  beforeEach(() => {
    validator = new MeterReadingValidator();
  });

  it('rejects a public key shorter than 32 bytes', () => {
    const { reading } = buildValidReading();
    const shortKey = new Uint8Array(16);
    const result = validator.validate(reading, shortKey);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(METER_VALIDATION_ERROR_CODES.INVALID_PUBLIC_KEY);
  });

  it('rejects a public key longer than 32 bytes', () => {
    const { reading } = buildValidReading();
    const longKey = new Uint8Array(64);
    const result = validator.validate(reading, longKey);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(METER_VALIDATION_ERROR_CODES.INVALID_PUBLIC_KEY);
  });
});

// ── MeterReadingValidator.validate — signature errors ────────────────────────

describe('MeterReadingValidator.validate — signature errors', () => {
  let validator: MeterReadingValidator;

  beforeEach(() => {
    validator = new MeterReadingValidator();
  });

  it('rejects a signature that is too short (bad hex, not 64 bytes)', () => {
    const { reading, keyPair } = buildValidReading();
    const result = validator.validate({ ...reading, signature: 'deadbeef' }, keyPair.publicKey);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(METER_VALIDATION_ERROR_CODES.INVALID_SIGNATURE_LENGTH);
  });

  it('rejects a valid-length but wrong signature', () => {
    const { reading, keyPair } = buildValidReading();
    // Generate a signature with a different key pair
    const otherKp = makeKeyPair();
    const msg = buildSignatureMessage(reading);
    const badSig = Buffer.from(nacl.sign.detached(msg, otherKp.secretKey)).toString('hex');
    const result = validator.validate({ ...reading, signature: badSig }, keyPair.publicKey);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(METER_VALIDATION_ERROR_CODES.SIGNATURE_MISMATCH);
  });

  it('rejects a signature over tampered payload fields', () => {
    const { reading, keyPair } = buildValidReading();
    // Change value without re-signing — signature now covers old value
    const result = validator.validate({ ...reading, value: reading.value + 1n }, keyPair.publicKey);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(METER_VALIDATION_ERROR_CODES.SIGNATURE_MISMATCH);
  });

  it('rejects when signing key does not match public key', () => {
    const { reading } = buildValidReading();
    const otherKp = makeKeyPair();
    const result = validator.validate(reading, otherKp.publicKey);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(METER_VALIDATION_ERROR_CODES.SIGNATURE_MISMATCH);
  });
});

// ── MeterReadingValidator.validate — ZK proof errors ─────────────────────────

describe('MeterReadingValidator.validate — ZK proof errors', () => {
  let validator: MeterReadingValidator;

  beforeEach(() => {
    validator = new MeterReadingValidator();
  });

  it('rejects a proof with wrong byte length (too short)', () => {
    const { reading, keyPair } = buildValidReading();
    const shortProof = Buffer.alloc(32).toString('base64');
    const result = validator.validate({ ...reading, rangeProof: shortProof }, keyPair.publicKey);
    expect(result.valid).toBe(false);
    expect(result.signatureValid).toBe(true); // sig passed, proof failed
  });

  it('rejects a tampered commitment segment', () => {
    const { reading, keyPair } = buildValidReading({ value: 500n });
    const proofBuf = Buffer.from(reading.rangeProof as string, 'base64');
    const tampered = RangeProofGenerator.generateTampered(proofBuf, 'commitment');
    const result = validator.validate({ ...reading, rangeProof: tampered.toString('base64') }, keyPair.publicKey);
    // rangeProof is excluded from the signature message, so the Ed25519 check
    // passes and only the ZK proof fails.
    expect(result.valid).toBe(false);
    expect(result.zkResult?.valid).toBe(false);
    expect(result.signatureValid).toBe(true);
  });

  it('rejects a tampered challenge segment', () => {
    const { reading, keyPair } = buildValidReading({ value: 500n });
    const proofBuf = Buffer.from(reading.rangeProof as string, 'base64');
    const tampered = RangeProofGenerator.generateTampered(proofBuf, 'challenge');
    const result = validator.validate({ ...reading, rangeProof: tampered.toString('base64') }, keyPair.publicKey);
    expect(result.valid).toBe(false);
    expect(result.zkResult?.valid).toBe(false);
  });

  it('rejects a tampered response segment', () => {
    const { reading, keyPair } = buildValidReading({ value: 500n });
    const proofBuf = Buffer.from(reading.rangeProof as string, 'base64');
    const tampered = RangeProofGenerator.generateTampered(proofBuf, 'response');
    const result = validator.validate({ ...reading, rangeProof: tampered.toString('base64') }, keyPair.publicKey);
    expect(result.valid).toBe(false);
    expect(result.zkResult?.valid).toBe(false);
  });

  it('rejects a completely random 64-byte buffer as proof', () => {
    const { reading, keyPair } = buildValidReading({ value: 500n });
    // Random 64 bytes will fail the challenge or response check
    const randomProof = Buffer.from(nacl.randomBytes(64)).toString('base64');
    const result = validator.validate({ ...reading, rangeProof: randomProof }, keyPair.publicKey);
    expect(result.valid).toBe(false);
  });

  it('rejects a proof generated for a different device', () => {
    const { reading, keyPair } = buildValidReading({ deviceId: 'dev-A' });
    // Proof generated for dev-B — challenge will mismatch
    const wrongProof = RangeProofGenerator.generate(
      reading.value,
      'dev-B',
      reading.lowerBound,
      reading.upperBound,
    ).toString('base64');
    const result = validator.validate({ ...reading, rangeProof: wrongProof }, keyPair.publicKey);
    expect(result.valid).toBe(false);
  });
});

// ── MeterReadingValidator.validateBatch ──────────────────────────────────────

describe('MeterReadingValidator.validateBatch', () => {
  let validator: MeterReadingValidator;

  beforeEach(() => {
    validator = new MeterReadingValidator();
  });

  it('returns allValid=true when all readings pass', () => {
    const a = buildValidReading({ value: 100n });
    const b = buildValidReading({ value: 200n });
    const result = validator.validateBatch(
      [a.reading, b.reading],
      [a.keyPair.publicKey, b.keyPair.publicKey],
    );
    expect(result.allValid).toBe(true);
    expect(result.failedIndices).toHaveLength(0);
    expect(result.results).toHaveLength(2);
  });

  it('identifies the failing reading by index', () => {
    const good = buildValidReading({ value: 100n });
    const bad = buildValidReading({ value: 100n });
    // Corrupt the good reading's signature for the bad slot
    const result = validator.validateBatch(
      [good.reading, { ...bad.reading, signature: 'ff'.repeat(64) }],
      [good.keyPair.publicKey, bad.keyPair.publicKey],
    );
    expect(result.allValid).toBe(false);
    expect(result.failedIndices).toEqual([1]);
    expect(result.results[0]?.valid).toBe(true);
    expect(result.results[1]?.valid).toBe(false);
  });

  it('throws RangeError when readings and publicKeys lengths differ', () => {
    const { reading, keyPair } = buildValidReading();
    expect(() => validator.validateBatch([reading], [keyPair.publicKey, keyPair.publicKey])).toThrow(
      RangeError,
    );
  });

  it('handles an empty batch', () => {
    const result = validator.validateBatch([], []);
    expect(result.allValid).toBe(true);
    expect(result.results).toHaveLength(0);
    expect(result.failedIndices).toHaveLength(0);
  });

  it('collects all failures, not just the first', () => {
    const items = Array.from({ length: 3 }, () => buildValidReading());
    // Corrupt all three
    const readings = items.map((item) => ({ ...item.reading, signature: 'aa'.repeat(64) }));
    const keys = items.map((item) => item.keyPair.publicKey);
    const result = validator.validateBatch(readings, keys);
    expect(result.allValid).toBe(false);
    expect(result.failedIndices).toHaveLength(3);
  });
});

// ── Prometheus metrics ────────────────────────────────────────────────────────

describe('MeterReadingValidator Prometheus metrics', () => {
  it('increments validation counter on success', async () => {
    const reg = new Registry();
    const metrics = createMeterValidatorMetrics(reg);
    const validator = new MeterReadingValidator(metrics);
    const { reading, keyPair } = buildValidReading();

    validator.validate(reading, keyPair.publicKey);

    const metricValues = await reg.getMetricsAsJSON();
    const counter = metricValues.find((m) => m.name === 'meter_reading_validations_total');
    expect(counter).toBeDefined();
    const okSample = counter?.values.find((v) => v.labels['result'] === 'ok');
    expect(okSample?.value).toBeGreaterThanOrEqual(1);
  });

  it('increments fail counter on validation failure', async () => {
    const reg = new Registry();
    const metrics = createMeterValidatorMetrics(reg);
    const validator = new MeterReadingValidator(metrics);
    const { reading, keyPair } = buildValidReading();

    validator.validate({ ...reading, signature: 'bad'.repeat(1) }, keyPair.publicKey);

    const metricValues = await reg.getMetricsAsJSON();
    const counter = metricValues.find((m) => m.name === 'meter_reading_validations_total');
    const failSample = counter?.values.find((v) => v.labels['result'] === 'fail');
    expect(failSample?.value).toBeGreaterThanOrEqual(1);
  });

  it('records validation duration histogram', async () => {
    const reg = new Registry();
    const metrics = createMeterValidatorMetrics(reg);
    const validator = new MeterReadingValidator(metrics);
    const { reading, keyPair } = buildValidReading();

    validator.validate(reading, keyPair.publicKey);

    const metricValues = await reg.getMetricsAsJSON();
    const histogram = metricValues.find(
      (m) => m.name === 'meter_reading_validation_duration_seconds',
    );
    expect(histogram).toBeDefined();
  });
});
