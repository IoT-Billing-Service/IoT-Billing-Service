import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NoncePool } from '../../src/core/blockchain/nonce_pool.js';
import { SorobanRpcClient, CircuitState } from '../../src/core/blockchain/rpc_client.js';
import { IngestionStateMachine, IngestionState } from '../../src/core/ingestion/state_machine.js';
import { TransactionManager } from '../../src/core/blockchain/tx_manager.js';

describe('NoncePool', () => {
  let pool: NoncePool;

  beforeEach(() => {
    pool = new NoncePool();
  });

  it('should acquire sequential nonces', async () => {
    const a = await pool.acquire('worker-a');
    const b = await pool.acquire('worker-b');
    expect(b).toBe(a + 1);
  });

  it('should release nonce', async () => {
    await pool.acquire('worker-a');
    await pool.release('worker-a');
    expect(pool.getActiveCount()).toBe(0);
  });

  it('should support stress testing with 50 concurrent acquire calls and verify contiguous sequences', async () => {
    const promises = Array.from({ length: 50 }, (_, i) => pool.acquire(`worker-${String(i)}`));
    const results = await Promise.all(promises);

    expect(results).toHaveLength(50);
    for (let i = 1; i < results.length; i++) {
      const prev = results[i - 1];
      expect(prev).toBeDefined();
      if (typeof prev === 'number') {
        expect(results[i]).toBe(prev + 1);
      }
    }
  });

  it('should seed counter from on-ledger value on construction and synchronize', async () => {
    const mockHorizonClient = {
      fetchAccountSequence: (address: string): Promise<bigint> => {
        globalThis.console.log(`fetching account sequence for ${address}`);
        return Promise.resolve(42n);
      },
    };
    const syncPool = new NoncePool('GABCDEF', mockHorizonClient);
    const seq = await syncPool.acquire('worker-a');
    expect(seq).toBe(43); // 42 + 1
    syncPool.cleanup();
  });

  it('should synchronize only if drift is > 1', async () => {
    const ledgerSeq = 100n;
    const mockHorizonClient = {
      fetchAccountSequence: (address: string): Promise<bigint> => {
        globalThis.console.log(`fetching account sequence for ${address}`);
        return Promise.resolve(ledgerSeq);
      },
    };
    const syncPool = new NoncePool('GABCDEF', mockHorizonClient);
    await syncPool.acquire('worker-init');

    // Drift = 1, should not sync
    await syncPool.resetCounter(101);
    await syncPool.synchronize();
    expect(syncPool.getCurrentSequence()).toBe(101);

    // Drift = 2, should sync
    await syncPool.resetCounter(102);
    await syncPool.synchronize();
    expect(syncPool.getCurrentSequence()).toBe(100);

    // Ledger ahead, should sync
    await syncPool.resetCounter(98);
    await syncPool.synchronize();
    expect(syncPool.getCurrentSequence()).toBe(100);

    syncPool.cleanup();
  });

  it('should retry once on tx_bad_seq and succeed if the second attempt succeeds', async () => {
    const rpcClient = new SorobanRpcClient('https://rpc.example.com');
    let calls = 0;
    vi.spyOn(rpcClient, 'submitTransaction').mockImplementation(() => {
      calls++;
      if (calls === 1) {
        return Promise.reject(new Error('tx_bad_seq: sequence number mismatch'));
      }
      return Promise.resolve({ hash: 'tx-hash', status: 'success' });
    });

    const mockHorizonClient = {
      fetchAccountSequence: (address: string): Promise<bigint> => {
        globalThis.console.log(`fetching account sequence for ${address}`);
        return Promise.resolve(100n);
      },
    };
    const syncPool = new NoncePool('GABCDEF', mockHorizonClient);
    const txManager = new TransactionManager(rpcClient, syncPool);

    const record = await txManager.submitChargeUsage('worker-1', 'dev-001', 100n, 'contract-1');
    expect(calls).toBe(2);
    expect(record.status).toBe('submitted');
    syncPool.cleanup();
  });
});

describe('SorobanRpcClient', () => {
  it('should initialize with CLOSED circuit', () => {
    const client = new SorobanRpcClient('https://rpc.example.com');
    expect(client.getState()).toBe(CircuitState.CLOSED);
  });
});

describe('IngestionStateMachine', () => {
  it('should transition PENDING -> TENTATIVE -> SETTLED', () => {
    const sm = new IngestionStateMachine('dev-1', IngestionState.PENDING);
    expect(sm.transition(IngestionState.TENTATIVE, 'starting processing')).toBe(true);
    expect(sm.getState()).toBe(IngestionState.TENTATIVE);
    expect(sm.transition(IngestionState.SETTLED, 'on-chain confirmed')).toBe(true);
    expect(sm.getState()).toBe(IngestionState.SETTLED);
  });

  it('should reject invalid transition', () => {
    const sm = new IngestionStateMachine('dev-1', IngestionState.PENDING);
    expect(sm.transition(IngestionState.SETTLED, 'skip tentative')).toBe(false);
  });

  it('should allow rollback from tentative', () => {
    const sm = new IngestionStateMachine('dev-1', IngestionState.TENTATIVE);
    expect(sm.transition(IngestionState.ROLLED_BACK, 'tx rejected')).toBe(true);
  });
});

import { RedisReorderBuffer } from '../../src/core/ingestion/validator.js';

describe('RedisReorderBuffer Property Tests', () => {
  it('should not drop frames when reordering depth is within window', async () => {
    // Simple mock
    const store = new Map<string, string>();
    const zsets = new Map<string, { score: number; member: string }[]>();

    /* eslint-disable @typescript-eslint/require-await, @typescript-eslint/strict-boolean-expressions, @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-non-null-assertion */
    const mockRedis = {
      get: async (k: string) => store.get(k) || null,
      set: async (k: string, v: string) => {
        store.set(k, v);
        return 'OK';
      },
      incr: async (k: string) => {
        const val = parseInt(store.get(k) || '0', 10) + 1;
        store.set(k, val.toString());
        return val;
      },
      zadd: async (k: string, score: number, member: string) => {
        const arr = zsets.get(k) || [];
        arr.push({ score, member });
        arr.sort((a, b) => a.score - b.score);
        zsets.set(k, arr);
        return 1;
      },
      zcard: async (k: string) => (zsets.get(k) || []).length,
      zrangebyscore: async (k: string, min: number, max: number) => {
        const arr = zsets.get(k) || [];
        return arr.filter((x) => x.score >= min && x.score <= max).map((x) => x.member);
      },
      zremrangebyscore: async (k: string, min: number, max: number) => {
        let arr = zsets.get(k) || [];
        const originalLen = arr.length;
        arr = arr.filter((x) => x.score < min || x.score > max);
        zsets.set(k, arr);
        return originalLen - arr.length;
      },
      zpopmax: async (k: string) => {
        const arr = zsets.get(k) || [];
        if (arr.length === 0) return [];
        const popped = arr.pop()!;
        zsets.set(k, arr);
        return [popped.member, popped.score.toString()];
      },
    };
    /* eslint-enable @typescript-eslint/require-await, @typescript-eslint/strict-boolean-expressions, @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-non-null-assertion */

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
    const buffer = new RedisReorderBuffer(mockRedis as any, 256);
    const deviceId = 'prop-dev';
    let submitCount = 0;
    let deliverCount = 0;

    // Generate 1000 frames with random reordering within a depth of 50
    const frames = Array.from({ length: 1000 }, (_, i) => i + 1);

    // Shuffle chunks of 50
    for (let i = 0; i < frames.length; i += 50) {
      const chunk = frames.slice(i, i + 50);
      for (let j = chunk.length - 1; j > 0; j--) {
        const k = Math.floor(Math.random() * (j + 1));
        const temp = chunk[j];
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        chunk[j] = chunk[k]!;
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        chunk[k] = temp!;
      }
      frames.splice(i, 50, ...chunk);
    }

    for (const seq of frames) {
      submitCount++;
      const delivered = await buffer.submit(deviceId, seq, {
        deviceId,
        timestamp: 0,
        nonce: '',
        metrics: {},
        signature: '',
      });
      deliverCount += delivered.length;
    }

    const dropCount = parseInt(store.get(`reorder:drops:${deviceId}`) ?? '0', 10);
    expect(dropCount).toBe(0);
    expect(deliverCount).toBe(submitCount);
  });
});
