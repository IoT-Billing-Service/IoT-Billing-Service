import { describe, it, expect } from 'vitest';
import { finalizeBillingCycle, type FinalizationResult } from '../../../src/billing/finalizer.js';
import {
  InMemoryBillingCycleStore,
  type BillingCycleStore,
  type BillingCycleRow,
} from '../../../src/billing/billing_cycle_repository.js';
import { BillingCycleState } from '../../../src/billing/state_machine.js';

/** Deterministic LCG so the "random" client scheduling is reproducible. */
function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

describe('finalizeBillingCycle — single-call behavior', () => {
  it('finalizes an OPEN cycle exactly once and runs the computation', async () => {
    const store = new InMemoryBillingCycleStore();
    store.seed('cycle-1');
    let computeCalls = 0;

    const res = await finalizeBillingCycle(store, 'cycle-1', {
      computeFinalization: () => {
        computeCalls += 1;
      },
    });

    expect(res.outcome).toBe('finalized');
    expect(res.finalized).toBe(true);
    expect(res.state).toBe(BillingCycleState.FINALIZED);
    expect(res.idempotencyKey).toBeTruthy();
    expect(computeCalls).toBe(1);
    expect((await store.getCycle('cycle-1'))?.state).toBe(BillingCycleState.FINALIZED);
  });

  it('returns not_found for an unknown cycle', async () => {
    const store = new InMemoryBillingCycleStore();
    const res = await finalizeBillingCycle(store, 'missing');
    expect(res.outcome).toBe('not_found');
    expect(res.finalized).toBe(false);
  });

  it('returns not_open when the cycle is already past OPEN', async () => {
    const store = new InMemoryBillingCycleStore();
    store.seed('cycle-2', BillingCycleState.FINALIZED, 3);
    let computeCalls = 0;
    const res = await finalizeBillingCycle(store, 'cycle-2', {
      computeFinalization: () => {
        computeCalls += 1;
      },
    });
    expect(res.outcome).toBe('not_open');
    expect(computeCalls).toBe(0);
  });

  it('treats a replayed idempotency key as a no-op (no second computation)', async () => {
    const store = new InMemoryBillingCycleStore();
    store.seed('cycle-3');
    // Pre-record the key as if a prior attempt already logged it.
    await store.recordFinalization('cycle-3', 'key-abc');

    let computeCalls = 0;
    const res = await finalizeBillingCycle(store, 'cycle-3', {
      idempotencyKey: 'key-abc',
      computeFinalization: () => {
        computeCalls += 1;
      },
    });

    expect(res.outcome).toBe('duplicate_replay');
    expect(computeCalls).toBe(0);
  });
});

describe('finalizeBillingCycle — concurrency (issue #42)', () => {
  it('20 concurrent finalizers on one cycle => exactly one computation', async () => {
    const store = new InMemoryBillingCycleStore();
    store.seed('hot-cycle');
    let computeCalls = 0;

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        finalizeBillingCycle(store, 'hot-cycle', {
          computeFinalization: () => {
            computeCalls += 1;
          },
        }),
      ),
    );

    // Exactly one caller wins the OPEN -> FINALIZING CAS and computes.
    expect(computeCalls).toBe(1);
    expect(results.filter((r) => r.finalized)).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'lost_race')).toHaveLength(19);
    expect((await store.getCycle('hot-cycle'))?.state).toBe(BillingCycleState.FINALIZED);
  });

  it('negative control: a store WITHOUT the optimistic guard double-charges', async () => {
    // A buggy store whose applyTransition ignores state + lock_version (the
    // pre-fix behavior) lets multiple racers finalize the same cycle.
    class UnguardedStore implements BillingCycleStore {
      private state = BillingCycleState.OPEN;
      getCycle(id: string): Promise<BillingCycleRow | null> {
        return Promise.resolve({ id, state: this.state, lockVersion: 1 });
      }
      applyTransition(
        _id: string,
        _from: BillingCycleState,
        to: BillingCycleState,
      ): Promise<boolean> {
        this.state = to; // no guard: always "succeeds"
        return Promise.resolve(true);
      }
      recordFinalization(): Promise<boolean> {
        return Promise.resolve(true); // no idempotency either
      }
    }

    const store = new UnguardedStore();
    let computeCalls = 0;
    await Promise.all(
      Array.from({ length: 20 }, () =>
        finalizeBillingCycle(store, 'hot-cycle', {
          computeFinalization: () => {
            computeCalls += 1;
          },
        }),
      ),
    );

    // Demonstrates the bug the fix prevents: more than one finalization ran.
    expect(computeCalls).toBeGreaterThan(1);
  });
});

describe('finalizeBillingCycle — linearizability sweep (issue #42, item 5)', () => {
  it('100 cycles x 20 concurrent clients => each cycle finalized exactly once', async () => {
    const CYCLES = 100;
    const CLIENTS = 20;
    const store = new InMemoryBillingCycleStore();
    const cycleIds = Array.from({ length: CYCLES }, (_, i) => `cycle-${String(i)}`);
    for (const id of cycleIds) {
      store.seed(id);
    }

    const computeCounts = new Map<string, number>();
    const onCompute = (id: string): void => {
      computeCounts.set(id, (computeCounts.get(id) ?? 0) + 1);
    };

    // Each client attempts every cycle once, in its own shuffled order, so the
    // 20 clients race each cycle ~20x with realistic interleaving.
    const clients = Array.from(
      { length: CLIENTS },
      (_, c) => async (): Promise<FinalizationResult[]> => {
        const rng = makePrng(0x9e3779b9 ^ (c + 1));
        const order = shuffle(cycleIds, rng);
        const out: FinalizationResult[] = [];
        for (const id of order) {
          out.push(
            await finalizeBillingCycle(store, id, {
              computeFinalization: () => {
                onCompute(id);
              },
            }),
          );
        }
        return out;
      },
    );

    const allResults = (await Promise.all(clients.map((run) => run()))).flat();

    // Linearizable outcome: every cycle ends FINALIZED, computed exactly once,
    // and across all clients exactly CYCLES finalizations "won".
    for (const id of cycleIds) {
      expect(computeCounts.get(id)).toBe(1);
      expect((await store.getCycle(id))?.state).toBe(BillingCycleState.FINALIZED);
    }
    // Exactly CYCLES finalizations "won"; every other attempt was a safe
    // no-op (lost the CAS race, or arrived after the cycle was finalized).
    expect(allResults.filter((r) => r.finalized)).toHaveLength(CYCLES);
    expect(allResults.filter((r) => !r.finalized)).toHaveLength(CYCLES * CLIENTS - CYCLES);
    expect(allResults.filter((r) => r.outcome === 'not_found')).toHaveLength(0);
    for (const r of allResults.filter((r) => !r.finalized)) {
      expect(['lost_race', 'not_open']).toContain(r.outcome);
    }
  }, 30_000);
});
