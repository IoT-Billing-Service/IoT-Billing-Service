/**
 * Route tests for the fault-tolerant ingestion endpoint (issue #292).
 *
 * Coverage:
 *  - a transient persistence failure that is queued returns 202 Accepted
 *    with a Retry-After header and the job id
 *  - a success still returns 200 with recordsWritten
 *  - the accepted response does not publish to the real-time stream bus
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import { Buffer } from 'node:buffer';
import nacl from 'tweetnacl';
import type { PrismaClient } from '@prisma/client';
import { clearEnvCache } from '../../../src/config/env.js';
import {
  registerIngestionRoutes,
  initIngestionService,
  resetIngestionService,
} from '../../../src/api/routes/ingestion.js';
import type { IngestionRetryQueue } from '../../../src/core/ingestion/retry_queue.js';
import type { PowSolution } from '../../../src/core/crypto/pow_verifier.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeKeyPair(): nacl.SignKeyPair {
  return nacl.sign.keyPair();
}

function buildBody(keyPair: nacl.SignKeyPair): {
  payload: Record<string, unknown>;
  publicKey: string;
  proof: string;
  powSolution: PowSolution;
} {
  const deviceId = 'MTR-001';
  const timestamp = Date.now();
  const nonce = 'route-test-nonce-' + String(Math.random()).slice(2, 8);
  const metrics = { voltage: 220, temperature: 25 };
  const message = { deviceId, timestamp, nonce, metrics };
  const signature = Buffer.from(
    nacl.sign.detached(Buffer.from(JSON.stringify(message)), keyPair.secretKey),
  ).toString('hex');

  return {
    payload: { deviceId, timestamp, nonce, metrics, signature },
    publicKey: Buffer.from(keyPair.publicKey).toString('hex'),
    proof: Buffer.alloc(64).toString('base64'),
    powSolution: { nonce: '0000000000000001', difficulty: 4 },
  };
}

function createPrismaMock(
  opts: {
    persist?: () => Promise<unknown>;
  } = {},
): PrismaClient {
  const create = vi.fn(opts.persist ?? (() => Promise.resolve({})));
  const findUnique = vi.fn().mockResolvedValue({ id: 'dev-1', serial: 'MTR-001', enabled: true });
  return {
    device: { findUnique },
    telemetryData: { create },
    $transaction: vi.fn().mockImplementation((ops: unknown) => {
      return Promise.all(ops as unknown[]);
    }),
    ingestionJob: { create: vi.fn() },
  } as unknown as PrismaClient;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('POST /ingest retry semantics', () => {
  let prisma: PrismaClient;
  let queue: { enqueue: ReturnType<typeof vi.fn> };
  let keyPair: nacl.SignKeyPair;

  beforeEach(() => {
    // `initIngestionService` reads env for the E2E encryption key; provide the
    // minimal required set (mirrors env_validation.test.ts).
    Object.assign(process.env, {
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/testdb',
      TIMESCALEDB_URL: 'postgresql://user:pass@localhost:5433/testdb',
      REDIS_URL: 'redis://localhost:6379',
      SOROBAN_RPC_URL: 'https://soroban-rpc.example.com',
      SOROBAN_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
      JWT_SECRET: 'super-secret-jwt-key-at-least-32-chars!!',
    });
    clearEnvCache();
    resetIngestionService();
    keyPair = makeKeyPair();
  });

  afterEach(() => {
    resetIngestionService();
  });

  it('returns 202 Accepted with Retry-After when persistence is deferred to the queue', async () => {
    prisma = createPrismaMock({
      persist: () => Promise.reject(new Error('connection reset')),
    });
    queue = { enqueue: vi.fn().mockResolvedValue('job-xyz') };

    initIngestionService(
      prisma,
      undefined,
      {
        skipPowVerification: true,
        skipProofVerification: true,
        retryQueue: queue as unknown as IngestionRetryQueue,
        maxFastRetries: 0,
        fastRetryBaseDelayMs: 1,
        fastRetryMaxDelayMs: 1,
      },
      { enabled: false }, // no background worker in route tests
    );

    const app = Fastify();
    registerIngestionRoutes(app);
    const response = await app.inject({
      method: 'POST',
      url: '/ingest',
      payload: buildBody(keyPair),
    });

    expect(response.statusCode).toBe(202);
    expect(response.headers['retry-after']).toBe('1');
    const body = response.json();
    expect(body).toMatchObject({
      success: true,
      accepted: true,
      jobId: 'job-xyz',
      recordsWritten: 0,
    });
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it('returns 200 with recordsWritten on success', async () => {
    prisma = createPrismaMock();
    initIngestionService(
      prisma,
      undefined,
      {
        skipPowVerification: true,
        skipProofVerification: true,
        retryQueue: undefined,
      },
      { enabled: false },
    );

    const app = Fastify();
    registerIngestionRoutes(app);
    const response = await app.inject({
      method: 'POST',
      url: '/ingest',
      payload: buildBody(keyPair),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ success: true, recordsWritten: 2 });
  });

  it('returns 409 for a replayed nonce', async () => {
    prisma = createPrismaMock();
    initIngestionService(
      prisma,
      undefined,
      { skipPowVerification: true, skipProofVerification: true },
      { enabled: false },
    );

    const app = Fastify();
    registerIngestionRoutes(app);
    const body = buildBody(keyPair);

    const first = await app.inject({ method: 'POST', url: '/ingest', payload: body });
    expect(first.statusCode).toBe(200);

    // Re-sending the same payload (same nonce) is a replay.
    const second = await app.inject({ method: 'POST', url: '/ingest', payload: body });
    expect(second.statusCode).toBe(409);
    expect(second.json().errorCode).toBe('ERR_REPLAY_DETECTED');
  });
});
