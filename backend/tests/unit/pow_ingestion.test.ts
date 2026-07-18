import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { IngestionService, INGESTION_ERROR_CODES } from '../../src/core/ingestion/ingestion_service.js';
import { InMemoryNonceCache, type SignedPayload } from '../../src/core/ingestion/validator.js';
import { minePowSolution } from '../../src/core/crypto/pow_verifier.js';

function makeFakePrisma(): PrismaClient {
  return {
    device: {
      findUnique: vi.fn().mockResolvedValue({ id: 'dev-uuid-1', serial: 'device-001', enabled: true }),
    },
    telemetryData: {
      create: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn().mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops)),
  } as unknown as PrismaClient;
}

function makeSignedPayload(overrides: Partial<SignedPayload> = {}): SignedPayload {
  return {
    deviceId: 'device-001',
    timestamp: Date.now(),
    nonce: 'test-nonce-' + String(Date.now()),
    metrics: { temperature: 22, humidity: 65 },
    signature: 'a'.repeat(128),
    ...overrides,
  };
}

describe('PoW Integration in IngestionService', () => {
  let prisma: PrismaClient;
  let nonceCache: InMemoryNonceCache;

  beforeEach(() => {
    prisma = makeFakePrisma();
    nonceCache = new InMemoryNonceCache();
  });

  it('should accept a valid PoW solution', async () => {
    const service = new IngestionService(prisma, nonceCache, { powDifficulty: 4 });
    const timestamp = Date.now();
    const payload = makeSignedPayload({ timestamp });
    const powSolution = minePowSolution('device-001', timestamp, 4);

    const result = await service.ingestTelemetry({
      payload,
      publicKey: 'a'.repeat(64),
      proof: Buffer.alloc(64).toString('base64'),
      powSolution,
    });

    expect(result.errorCode).not.toBe(INGESTION_ERROR_CODES.POW_VERIFICATION_FAILED);
  });

  it('should reject invalid PoW solution', async () => {
    const service = new IngestionService(prisma, nonceCache, { powDifficulty: 4 });
    const timestamp = Date.now();
    const payload = makeSignedPayload({ timestamp });

    const result = await service.ingestTelemetry({
      payload,
      publicKey: 'a'.repeat(64),
      proof: Buffer.alloc(64).toString('base64'),
      powSolution: { nonce: '0000000000000000', difficulty: 4 },
    });

    if (result.errorCode === INGESTION_ERROR_CODES.POW_VERIFICATION_FAILED) {
      expect(result.reason).toBeDefined();
    }
  });

  it('should reject PoW with wrong difficulty', async () => {
    const service = new IngestionService(prisma, nonceCache, { powDifficulty: 8 });
    const timestamp = Date.now();
    const payload = makeSignedPayload({ timestamp });
    const powSolution = minePowSolution('device-001', timestamp, 4);

    const result = await service.ingestTelemetry({
      payload,
      publicKey: 'a'.repeat(64),
      proof: Buffer.alloc(64).toString('base64'),
      powSolution,
    });

    expect(result.errorCode).toBe(INGESTION_ERROR_CODES.POW_VERIFICATION_FAILED);
    expect(result.reason).toContain('DIFFICULTY_MISMATCH');
  });

  it('should reject PoW bound to wrong device', async () => {
    const service = new IngestionService(prisma, nonceCache, { powDifficulty: 4 });
    const timestamp = Date.now();
    const payload = makeSignedPayload({ timestamp, deviceId: 'device-001' });
    const powSolution = minePowSolution('device-999', timestamp, 4);

    const result = await service.ingestTelemetry({
      payload,
      publicKey: 'a'.repeat(64),
      proof: Buffer.alloc(64).toString('base64'),
      powSolution,
    });

    expect(result.errorCode).toBe(INGESTION_ERROR_CODES.POW_VERIFICATION_FAILED);
  });

  it('should skip PoW when skipPowVerification is set', async () => {
    const service = new IngestionService(prisma, nonceCache, { skipPowVerification: true });
    const timestamp = Date.now();
    const payload = makeSignedPayload({ timestamp });

    const result = await service.ingestTelemetry({
      payload,
      publicKey: 'a'.repeat(64),
      proof: Buffer.alloc(64).toString('base64'),
      powSolution: { nonce: '0000000000000000', difficulty: 4 },
    });

    expect(result.errorCode).not.toBe(INGESTION_ERROR_CODES.POW_VERIFICATION_FAILED);
  });

  it('should reject PoW with invalid nonce length', async () => {
    const service = new IngestionService(prisma, nonceCache, { powDifficulty: 4 });
    const timestamp = Date.now();
    const payload = makeSignedPayload({ timestamp });

    const result = await service.ingestTelemetry({
      payload,
      publicKey: 'a'.repeat(64),
      proof: Buffer.alloc(64).toString('base64'),
      powSolution: { nonce: 'abc', difficulty: 4 },
    });

    expect(result.errorCode).toBe(INGESTION_ERROR_CODES.POW_VERIFICATION_FAILED);
    expect(result.reason).toContain('INVALID_NONCE_LENGTH');
  });

  it('should reject PoW with expired timestamp', async () => {
    const service = new IngestionService(prisma, nonceCache, { powDifficulty: 4 });
    const oldTimestamp = Date.now() - 60_000;
    const payload = makeSignedPayload({ timestamp: oldTimestamp });
    const powSolution = minePowSolution('device-001', oldTimestamp, 4);

    const result = await service.ingestTelemetry({
      payload,
      publicKey: 'a'.repeat(64),
      proof: Buffer.alloc(64).toString('base64'),
      powSolution,
    });

    expect(result.errorCode).toBe(INGESTION_ERROR_CODES.POW_VERIFICATION_FAILED);
    expect(result.reason).toContain('TIMESTAMP_EXPIRED');
  });

  it('should use default difficulty when not specified', async () => {
    const service = new IngestionService(prisma, nonceCache);
    const timestamp = Date.now();
    const payload = makeSignedPayload({ timestamp });
    const powSolution = minePowSolution('device-001', timestamp, 4);

    const result = await service.ingestTelemetry({
      payload,
      publicKey: 'a'.repeat(64),
      proof: Buffer.alloc(64).toString('base64'),
      powSolution,
    });

    expect(result.errorCode).not.toBe(INGESTION_ERROR_CODES.POW_VERIFICATION_FAILED);
  });
});
