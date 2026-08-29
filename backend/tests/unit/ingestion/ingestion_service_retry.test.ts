/**
 * Tests for fault-tolerant telemetry persistence (issue #292).
 *
 * Coverage:
 *  - transient persistence failures are retried in-flight
 *  - when fast retries are exhausted and a durable queue is configured, the
 *    verified request is enqueued and the call is accepted (202 semantics)
 *  - without a durable queue, exhausted fast retries hard-fail (legacy)
 *  - device not found / disabled surface as typed error codes, never retried
 *  - persistVerifiedJob re-verifies digest + signature before persisting and
 *    rejects tampered queued payloads
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import nacl from 'tweetnacl';
import type { PrismaClient } from '@prisma/client';
import {
  IngestionService,
  INGESTION_ERROR_CODES,
  canonicalJson,
  sha256Hex,
} from '../../../src/core/ingestion/ingestion_service.js';
import { InMemoryNonceCache, type SignedPayload } from '../../../src/core/ingestion/validator.js';
import type {
  IngestionRetryQueue,
  IngestionRetryJob,
  StoredIngestRequest,
} from '../../../src/core/ingestion/retry_queue.js';
import { PayloadIntegrityError } from '../../../src/core/ingestion/errors.js';
import type { PowSolution } from '../../../src/core/crypto/pow_verifier.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeKeyPair(): nacl.SignKeyPair {
  return nacl.sign.keyPair();
}

function makePayload(
  keyPair: nacl.SignKeyPair,
  overrides: Partial<SignedPayload> = {},
): { payload: SignedPayload; publicKey: string } {
  const deviceId = 'MTR-001';
  const timestamp = Date.now();
  const nonce = 'retry-test-nonce-' + String(Math.random()).slice(2, 8);
  const metrics: Record<string, number | string> = { voltage: 220, temperature: 25 };

  const message = { deviceId, timestamp, nonce, metrics };
  const signature = Buffer.from(
    nacl.sign.detached(Buffer.from(JSON.stringify(message)), keyPair.secretKey),
  ).toString('hex');

  return {
    payload: { deviceId, timestamp, nonce, metrics, signature, ...overrides },
    publicKey: Buffer.from(keyPair.publicKey).toString('hex'),
  };
}

function makePowSolution(): PowSolution {
  return { nonce: '0000000000000001', difficulty: 4 };
}

type CreateFn = ReturnType<typeof vi.fn>;

function createMockPrisma(opts: { createBehavior?: () => Promise<unknown> } = {}): {
  prisma: PrismaClient;
  create: CreateFn;
  findUnique: CreateFn;
} {
  const create = vi.fn(opts.createBehavior ?? (() => Promise.resolve({})));
  const findUnique = vi.fn().mockResolvedValue({ id: 'dev-1', serial: 'MTR-001', enabled: true });

  const prisma = {
    device: { findUnique },
    telemetryData: { create },
    $transaction: vi.fn().mockImplementation((ops: unknown) => {
      if (typeof ops === 'function') return ops(prisma);
      return Promise.all(ops as unknown[]);
    }),
  } as unknown as PrismaClient;

  return { prisma, create, findUnique };
}

function makeQueueMock() {
  const enqueue = vi.fn().mockResolvedValue('job-abc');
  return { enqueue } as unknown as {
    enqueue: ReturnType<typeof vi.fn>;
  };
}

function makeJob(
  keyPair: nacl.SignKeyPair,
  storedOverrides: Partial<StoredIngestRequest> = {},
): IngestionRetryJob {
  const { payload, publicKey } = makePayload(keyPair);
  const signedMessage = JSON.stringify({
    deviceId: payload.deviceId,
    timestamp: payload.timestamp,
    nonce: payload.nonce,
    metrics: payload.metrics,
  });
  const metrics: Record<string, number> = { voltage: 220, temperature: 25 };

  const stored: StoredIngestRequest = {
    payload,
    publicKey,
    proof: 'proof',
    powSolution: makePowSolution(),
    metrics,
    signedMessage,
    verifiedAt: Date.now(),
    payloadDigest: '',
    ...storedOverrides,
  };
  stored.payloadDigest = sha256Hex(
    canonicalJson({
      payload: stored.payload,
      publicKey: stored.publicKey,
      proof: stored.proof,
      powSolution: stored.powSolution,
      metrics: stored.metrics,
      signedMessage: stored.signedMessage,
      verifiedAt: stored.verifiedAt,
    }),
  );

  return {
    id: 'job-1',
    deviceId: 'MTR-001',
    status: 'processing',
    retryCount: 0,
    nextAttemptAt: new Date(),
    lastError: null,
    stateData: stored,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('IngestionService fault-tolerant persistence', () => {
  let nonceCache: InMemoryNonceCache;
  let keyPair: nacl.SignKeyPair;

  beforeEach(() => {
    nonceCache = new InMemoryNonceCache(60_000);
    keyPair = makeKeyPair();
  });

  afterEach(() => {
    nonceCache.dispose();
  });

  function makeService(
    prisma: PrismaClient,
    queue?: IngestionRetryQueue,
    fastRetry: {
      maxFastRetries?: number;
      fastRetryBaseDelayMs?: number;
      fastRetryMaxDelayMs?: number;
    } = {},
  ): IngestionService {
    return new IngestionService(prisma, nonceCache, {
      skipPowVerification: true,
      skipProofVerification: true,
      retryQueue: queue,
      maxFastRetries: fastRetry.maxFastRetries ?? 2,
      fastRetryBaseDelayMs: fastRetry.fastRetryBaseDelayMs ?? 1,
      fastRetryMaxDelayMs: fastRetry.fastRetryMaxDelayMs ?? 1,
    });
  }

  describe('in-flight fast retries', () => {
    it('retries a transient failure and succeeds', async () => {
      const { prisma, create, findUnique } = createMockPrisma();
      // Fail the first persistence attempt (both metric creates reject), then
      // let the fast retry succeed.
      create
        .mockRejectedValueOnce(new Error('connection reset'))
        .mockRejectedValueOnce(new Error('connection reset'));

      const service = makeService(prisma);
      const { payload, publicKey } = makePayload(keyPair);

      const result = await service.ingestTelemetry({
        payload,
        publicKey,
        proof: Buffer.alloc(64),
        powSolution: makePowSolution(),
      });

      expect(result.success).toBe(true);
      expect(result.recordsWritten).toBe(2);
      // One persistence attempt fails, the fast retry succeeds.
      expect(findUnique).toHaveBeenCalledTimes(2);
    });

    it('does not retry permanent device errors', async () => {
      const { prisma, findUnique } = createMockPrisma();
      findUnique.mockResolvedValue(null);
      const create = vi.fn();

      const service = makeService(prisma);
      const { payload, publicKey } = makePayload(keyPair);

      const result = await service.ingestTelemetry({
        payload,
        publicKey,
        proof: Buffer.alloc(64),
        powSolution: makePowSolution(),
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(INGESTION_ERROR_CODES.DEVICE_NOT_FOUND);
      expect(create).not.toHaveBeenCalled();
    });

    it('surfaces a disabled device as DEVICE_DISABLED', async () => {
      const { prisma, findUnique } = createMockPrisma();
      findUnique.mockResolvedValue({ id: 'dev-1', serial: 'MTR-001', enabled: false });

      const service = makeService(prisma);
      const { payload, publicKey } = makePayload(keyPair);

      const result = await service.ingestTelemetry({
        payload,
        publicKey,
        proof: Buffer.alloc(64),
        powSolution: makePowSolution(),
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(INGESTION_ERROR_CODES.DEVICE_DISABLED);
    });
  });

  describe('durable queue fallback', () => {
    it('enqueues the verified request and accepts when fast retries are exhausted', async () => {
      const { prisma } = createMockPrisma({
        createBehavior: () => Promise.reject(new Error('connection reset')),
      });
      const queue = makeQueueMock();

      const service = makeService(prisma, queue as unknown as IngestionRetryQueue, {
        maxFastRetries: 1,
      });
      const { payload, publicKey } = makePayload(keyPair);

      const result = await service.ingestTelemetry({
        payload,
        publicKey,
        proof: Buffer.alloc(64),
        powSolution: makePowSolution(),
      });

      expect(result.success).toBe(true);
      expect(result.accepted).toBe(true);
      expect(result.jobId).toBe('job-abc');
      expect(queue.enqueue).toHaveBeenCalledTimes(1);

      const stored = queue.enqueue.mock.calls[0]?.[0] as unknown as StoredIngestRequest;
      expect(stored.payload.deviceId).toBe('MTR-001');
      expect(stored.publicKey).toBe(publicKey);
      expect(stored.metrics).toEqual({ voltage: 220, temperature: 25 });
      expect(stored.signedMessage).toBe(
        JSON.stringify({
          deviceId: payload.deviceId,
          timestamp: payload.timestamp,
          nonce: payload.nonce,
          metrics: payload.metrics,
        }),
      );
      expect(stored.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
    });

    it('never enqueues permanent device errors', async () => {
      const { prisma, findUnique } = createMockPrisma();
      findUnique.mockResolvedValue(null);
      const queue = makeQueueMock();

      const service = makeService(prisma, queue as unknown as IngestionRetryQueue);
      const { payload, publicKey } = makePayload(keyPair);

      const result = await service.ingestTelemetry({
        payload,
        publicKey,
        proof: Buffer.alloc(64),
        powSolution: makePowSolution(),
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(INGESTION_ERROR_CODES.DEVICE_NOT_FOUND);
      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it('hard-fails with ERR_INTERNAL when no durable queue is configured', async () => {
      const { prisma } = createMockPrisma({
        createBehavior: () => Promise.reject(new Error('connection reset')),
      });

      const service = makeService(prisma, undefined, { maxFastRetries: 1 });
      const { payload, publicKey } = makePayload(keyPair);

      const result = await service.ingestTelemetry({
        payload,
        publicKey,
        proof: Buffer.alloc(64),
        powSolution: makePowSolution(),
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe(INGESTION_ERROR_CODES.INTERNAL_ERROR);
    });
  });

  describe('persistVerifiedJob', () => {
    it('re-verifies and persists a queued job', async () => {
      const { prisma, create } = createMockPrisma();
      const service = makeService(prisma);

      const records = await service.persistVerifiedJob(makeJob(keyPair));

      expect(records).toBe(2);
      expect(create).toHaveBeenCalledTimes(2);
    });

    it('rejects a queued job whose stored metrics were tampered with', async () => {
      const { prisma } = createMockPrisma();
      const service = makeService(prisma);

      const job = makeJob(keyPair);
      job.stateData.metrics = { voltage: 999_999 };

      await expect(service.persistVerifiedJob(job)).rejects.toBeInstanceOf(PayloadIntegrityError);
    });

    it('rejects a queued job with a forged signature', async () => {
      const { prisma } = createMockPrisma();
      const service = makeService(prisma);

      const job = makeJob(keyPair);
      job.stateData.payload = {
        ...job.stateData.payload,
        signature: 'ff'.repeat(64),
      };

      await expect(service.persistVerifiedJob(job)).rejects.toBeInstanceOf(PayloadIntegrityError);
    });

    it('throws DeviceNotFoundError when the device vanished while queued', async () => {
      const { prisma, findUnique } = createMockPrisma();
      findUnique.mockResolvedValue(null);
      const service = makeService(prisma);

      await expect(service.persistVerifiedJob(makeJob(keyPair))).rejects.toThrow(
        /Device not found/,
      );
    });
  });
});
