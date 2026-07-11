import { describe, it, expect, vi } from 'vitest';
import {
  validateSignature,
  createValidator,
  InMemoryNonceCache,
  RedisNonceCache,
  type NonceCache,
  type SignedPayload,
} from '../../src/core/ingestion/validator.js';
import nacl from 'tweetnacl';
import { Buffer } from 'node:buffer';

function createSignedPayload(overrides: Partial<SignedPayload> = {}): {
  payload: SignedPayload;
  publicKey: Uint8Array;
} {
  const keyPair = nacl.sign.keyPair();
  const base: Omit<SignedPayload, 'signature'> = {
    deviceId: 'dev-001',
    timestamp: Date.now(),
    nonce: crypto.randomUUID(),
    metrics: { energy_kwh: 1.5, water_l: 3.2 },
    ...overrides,
  };
  const message = Buffer.from(JSON.stringify(base), 'utf-8');
  const signature = Buffer.from(nacl.sign.detached(message, keyPair.secretKey)).toString('hex');
  return { payload: { ...base, signature }, publicKey: keyPair.publicKey };
}

describe('validateSignature', () => {
  it('should accept a valid signed payload', () => {
    const { payload, publicKey } = createSignedPayload();
    const result = validateSignature(publicKey, payload);
    expect(result.valid).toBe(true);
  });

  it('should reject payload with invalid signature', () => {
    const { payload, publicKey } = createSignedPayload();
    payload.signature = 'a'.repeat(128);
    const result = validateSignature(publicKey, payload);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('signature');
  });

  it('should reject stale timestamp outside sliding window', () => {
    const { payload, publicKey } = createSignedPayload({ timestamp: Date.now() - 10000 });
    const result = validateSignature(publicKey, payload);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('sliding window');
  });

  it('should reject replayed nonce', () => {
    const { payload, publicKey } = createSignedPayload();
    const first = validateSignature(publicKey, payload);
    expect(first.valid).toBe(true);
    const replay = validateSignature(publicKey, payload);
    expect(replay.valid).toBe(false);
    expect(replay.reason).toContain('replay');
  });

  it('should reject invalid signature length', () => {
    const { payload, publicKey } = createSignedPayload();
    payload.signature = 'too-short';
    const result = validateSignature(publicKey, payload);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('signature length');
  });
});

/** Minimal in-test {@link NonceCache} with CAS semantics, recording every claim. */
class MockNonceCache implements NonceCache {
  readonly consumed = new Set<string>();
  readonly calls: string[] = [];

  tryConsume(nonce: string): boolean {
    this.calls.push(nonce);
    if (this.consumed.has(nonce)) {
      return false;
    }
    this.consumed.add(nonce);
    return true;
  }
}

describe('createValidator (injected NonceCache)', () => {
  it('accepts a valid payload and claims the nonce exactly once', async () => {
    const cache = new MockNonceCache();
    const validate = createValidator(cache);
    const { payload, publicKey } = createSignedPayload();

    const result = await validate(publicKey, payload);

    expect(result.valid).toBe(true);
    expect(cache.calls).toEqual([payload.nonce]);
  });

  it('rejects a replayed nonce reported by the cache', async () => {
    const cache = new MockNonceCache();
    const validate = createValidator(cache);
    const { payload, publicKey } = createSignedPayload();

    expect((await validate(publicKey, payload)).valid).toBe(true);
    const replay = await validate(publicKey, payload);

    expect(replay.valid).toBe(false);
    expect(replay.reason).toContain('replay');
  });

  it('does not consume a nonce when the signature is invalid', async () => {
    const cache = new MockNonceCache();
    const validate = createValidator(cache);
    const { payload, publicKey } = createSignedPayload();
    payload.signature = 'a'.repeat(128);

    const result = await validate(publicKey, payload);

    expect(result.valid).toBe(false);
    expect(cache.consumed.size).toBe(0);
  });

  it('supports an async cache backend', async () => {
    const tryConsume = vi.fn().mockResolvedValue(true);
    const asyncCache: NonceCache = { tryConsume };
    const validate = createValidator(asyncCache);
    const { payload, publicKey } = createSignedPayload();

    const result = await validate(publicKey, payload);

    expect(result.valid).toBe(true);
    expect(tryConsume).toHaveBeenCalledWith(payload.nonce);
  });

  it('rejects 10,000 rapid replays of a single nonce while accepting unique ones', async () => {
    // Exercise CAS throughput, not crypto: bypass the (slow) Ed25519 verify so
    // 10k iterations stay within the sliding window. The nonce is held constant
    // to model a replay; the timestamp is refreshed so only the replay gate fires.
    const verifySpy = vi.spyOn(nacl.sign.detached, 'verify').mockReturnValue(true);
    try {
      const cache = new MockNonceCache();
      const validate = createValidator(cache);

      const { payload: seed, publicKey } = createSignedPayload();
      seed.timestamp = Date.now();
      expect((await validate(publicKey, seed)).valid).toBe(true);

      let replays = 0;
      for (let i = 0; i < 10000; i++) {
        seed.timestamp = Date.now();
        const result = await validate(publicKey, seed);
        if (!result.valid && result.reason?.includes('replay') === true) {
          replays++;
        }
      }

      expect(replays).toBe(10000);
      // The nonce was stored once; every subsequent claim was a CAS miss.
      expect(cache.consumed.size).toBe(1);
    } finally {
      verifySpy.mockRestore();
    }
  });
});

describe('InMemoryNonceCache', () => {
  it('claims a nonce once and reports replays via CAS', () => {
    const cache = new InMemoryNonceCache();
    try {
      expect(cache.tryConsume('n1')).toBe(true);
      expect(cache.tryConsume('n1')).toBe(false);
      expect(cache.tryConsume('n2')).toBe(true);
    } finally {
      cache.dispose();
    }
  });

  it('handles 10,000 unique nonces without false replays', () => {
    const cache = new InMemoryNonceCache();
    try {
      for (let i = 0; i < 10000; i++) {
        expect(cache.tryConsume(`unique-${i.toString()}`)).toBe(true);
      }
    } finally {
      cache.dispose();
    }
  });
});

describe('RedisNonceCache', () => {
  it('uses SET ... EX <ttl> NX and accepts only when the key is newly set', async () => {
    const set = vi.fn().mockResolvedValue('OK');
    const redis = { set } as unknown as ConstructorParameters<typeof RedisNonceCache>[0];
    const cache = new RedisNonceCache(redis);

    await expect(cache.tryConsume('abc')).resolves.toBe(true);
    expect(set).toHaveBeenCalledWith('nonce:abc', '1', 'EX', 5, 'NX');
  });

  it('reports a replay when Redis returns null (key already exists)', async () => {
    const set = vi.fn().mockResolvedValue(null);
    const redis = { set } as unknown as ConstructorParameters<typeof RedisNonceCache>[0];
    const cache = new RedisNonceCache(redis);

    await expect(cache.tryConsume('abc')).resolves.toBe(false);
  });
});
