import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import nacl from 'tweetnacl';
import { IngestionService } from '../../../src/core/ingestion/ingestion_service.js';
import { InMemoryNonceCache, type SignedPayload } from '../../../src/core/ingestion/validator.js';
import { encryptField, generateEncryptionKey } from '../../../src/core/crypto/e2e_encryption.js';
import type { PowSolution } from '../../../src/core/crypto/pow_verifier.js';
import type { PrismaClient } from '@prisma/client';

function createMockPrisma(): PrismaClient {
  return {
    device: {
      findUnique: vi.fn().mockResolvedValue({ id: 'dev-1', serial: 'MTR-001', enabled: true }),
    },
    telemetryData: {
      create: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn().mockImplementation(async (cb: unknown) => {
      if (typeof cb === 'function') return cb(createMockPrisma());
      return Promise.all(cb as unknown[]);
    }),
  } as unknown as PrismaClient;
}

function makeKeyPair(): nacl.SignKeyPair {
  return nacl.sign.keyPair();
}

function makePayload(
  overrides: Partial<SignedPayload> & { keyPair?: nacl.SignKeyPair } = {},
): { payload: SignedPayload; publicKey: string } {
  const kp = overrides.keyPair ?? makeKeyPair();
  const deviceId = 'MTR-001';
  const timestamp = Date.now();
  const nonce = 'test-nonce-' + String(Math.random()).slice(2, 8);
  const metrics: Record<string, number | string> = { voltage: 220, temperature: 25 };

  const message = { deviceId, timestamp, nonce, metrics };
  const signature = Buffer.from(
    nacl.sign.detached(Buffer.from(JSON.stringify(message)), kp.secretKey),
  ).toString('hex');

  return {
    payload: {
      deviceId,
      timestamp,
      nonce,
      metrics,
      signature,
    },
    publicKey: Buffer.from(kp.publicKey).toString('hex'),
  };
}

function makePowSolution(): PowSolution {
  return { nonce: '0000000000000001', difficulty: 4 };
}

describe('IngestionService with E2E Encryption', () => {
  let service: IngestionService;
  let prisma: PrismaClient;
  let nonceCache: InMemoryNonceCache;
  let encryptionKey: ReturnType<typeof generateEncryptionKey>;

  beforeEach(() => {
    prisma = createMockPrisma();
    nonceCache = new InMemoryNonceCache(60000);
    encryptionKey = generateEncryptionKey();
  });

  afterEach(() => {
    nonceCache.dispose();
  });

  describe('without encryption key configured', () => {
    beforeEach(() => {
      service = new IngestionService(prisma, nonceCache, {
        skipPowVerification: true,
        skipProofVerification: true,
      });
    });

    it('processes plaintext payload normally', async () => {
      const { payload, publicKey } = makePayload();
      const result = await service.ingestTelemetry({
        payload,
        publicKey,
        proof: Buffer.alloc(64),
        powSolution: makePowSolution(),
      });

      expect(result.success).toBe(true);
    });

    it('processes payload with encrypted fields when no key is set', async () => {
      const timestamp = Date.now();
      const encryptedMetric = encryptField('25', nacl.randomBytes(32));
      const metrics: Record<string, number | string> = { voltage: 220, temperature: 25 };
      const encrypted = { temperature: encryptedMetric };

      const kp = nacl.sign.keyPair();
      const message = { deviceId: 'MTR-001', timestamp, nonce: 'test-nonce-xxx', metrics, encrypted };
      const signature = Buffer.from(
        nacl.sign.detached(Buffer.from(JSON.stringify(message)), kp.secretKey),
      ).toString('hex');

      const payload: SignedPayload = {
        deviceId: 'MTR-001',
        timestamp,
        nonce: 'test-nonce-xxx',
        metrics,
        encrypted,
        signature,
      };

      const result = await service.ingestTelemetry({
        payload,
        publicKey: Buffer.from(kp.publicKey).toString('hex'),
        proof: Buffer.alloc(64),
        powSolution: makePowSolution(),
      });

      // Without an encryption key, encrypted fields are not decrypted
      // but the pipeline should process the plaintext metrics normally
      expect(result.success).toBe(true);
    });
  });

  describe('with encryption key configured', () => {
    beforeEach(() => {
      service = new IngestionService(prisma, nonceCache, {
        skipPowVerification: true,
        skipProofVerification: true,
        encryptionKey,
      });
    });

    it('decrypts an encrypted metric field in the payload', async () => {
      const keyPair = nacl.sign.keyPair();
      const encryptedMetric = encryptField('25', encryptionKey.raw);
      const timestamp = Date.now();

      const metrics: Record<string, number | string> = {
        temperature: 0,
        voltage: 220,
      };
      const encrypted = { temperature: encryptedMetric };

      const message = {
        deviceId: 'MTR-001',
        timestamp,
        nonce: 'test-nonce-e2e-1',
        metrics,
        encrypted,
      };
      const signature = Buffer.from(
        nacl.sign.detached(Buffer.from(JSON.stringify(message)), keyPair.secretKey),
      ).toString('hex');

      const payload: SignedPayload = {
        deviceId: 'MTR-001',
        timestamp,
        nonce: 'test-nonce-e2e-1',
        metrics,
        encrypted,
        signature,
      };

      const result = await service.ingestTelemetry({
        payload,
        publicKey: Buffer.from(keyPair.publicKey).toString('hex'),
        proof: Buffer.alloc(64),
        powSolution: makePowSolution(),
      });

      expect(result.success).toBe(true);
      expect(result.recordsWritten).toBe(2);
    });

    it('rejects payload when decryption of a field fails', async () => {
      const keyPair = nacl.sign.keyPair();
      const timestamp = Date.now();
      const metrics: Record<string, number | string> = { voltage: 0 };
      const encrypted = { voltage: { v: 'e2e:v1', d: 'AAAA' } as const };

      const message = {
        deviceId: 'MTR-001',
        timestamp,
        nonce: 'test-nonce-e2e-2',
        metrics,
        encrypted,
      };
      const signature = Buffer.from(
        nacl.sign.detached(Buffer.from(JSON.stringify(message)), keyPair.secretKey),
      ).toString('hex');

      const payload: SignedPayload = {
        deviceId: 'MTR-001',
        timestamp,
        nonce: 'test-nonce-e2e-2',
        metrics,
        encrypted,
        signature,
      };

      const result = await service.ingestTelemetry({
        payload,
        publicKey: Buffer.from(keyPair.publicKey).toString('hex'),
        proof: Buffer.alloc(64),
        powSolution: makePowSolution(),
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('ERR_INVALID_PAYLOAD');
      expect(result.reason).toContain('E2E decryption failed');
    });

    it('processes payload without encrypted fields normally', async () => {
      const { payload, publicKey } = makePayload();
      const result = await service.ingestTelemetry({
        payload,
        publicKey,
        proof: Buffer.alloc(64),
        powSolution: makePowSolution(),
      });

      expect(result.success).toBe(true);
    });
  });
});
