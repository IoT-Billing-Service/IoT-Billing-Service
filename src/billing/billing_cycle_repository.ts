import { BillingCycleState, isBillingCycleState } from './state_machine.js';

/**
 * Persistence for the billing-cycle state machine (issue #42).
 *
 * The contention-safety guarantee lives here:
 *
 *   - `applyTransition` is an optimistic compare-and-set. It only mutates the
 *     row when BOTH the current state and `lock_version` are unchanged, then
 *     bumps the version. Two callers racing the same transition therefore can
 *     never both succeed — the loser's write matches 0 rows. This holds across
 *     pods/connections, which is exactly the scale-out scenario the issue hits.
 *   - `recordFinalization` is an idempotency gate: a duplicate idempotency key
 *     is silently ignored, so a replayed finalization is a no-op.
 *
 * Two implementations are provided: {@link PgBillingCycleStore} (production,
 * raw SQL) and {@link InMemoryBillingCycleStore} (tests / local / dev).
 */

export interface BillingCycleRow {
  id: string;
  state: BillingCycleState;
  lockVersion: number;
}

export interface BillingCycleStore {
  getCycle(id: string): Promise<BillingCycleRow | null>;
  /**
   * Optimistic, guarded transition. Returns `true` iff THIS call applied it
   * (current state === `from` AND lock_version === `expectedLockVersion`).
   */
  applyTransition(
    id: string,
    from: BillingCycleState,
    to: BillingCycleState,
    expectedLockVersion: number,
  ): Promise<boolean>;
  /** Returns `true` iff the key was newly recorded; `false` on duplicate replay. */
  recordFinalization(cycleId: string, idempotencyKey: string): Promise<boolean>;
}

// --- In-memory implementation ----------------------------------------------

interface InMemoryCycle {
  state: BillingCycleState;
  lockVersion: number;
}

/**
 * In-process {@link BillingCycleStore}. `applyTransition` is a synchronous
 * compare-and-set, so it is atomic with respect to the JS event loop — exactly
 * mirroring Postgres's guarded `UPDATE ... WHERE state=? AND lock_version=?`
 * (a lost update collapses to 0 rows). `getCycle` resolves on a microtask so a
 * realistic read-then-write race window exists between concurrent callers.
 */
export class InMemoryBillingCycleStore implements BillingCycleStore {
  private readonly cycles = new Map<string, InMemoryCycle>();
  private readonly idempotencyKeys = new Set<string>();

  seed(id: string, state: BillingCycleState = BillingCycleState.OPEN, lockVersion = 1): void {
    this.cycles.set(id, { state, lockVersion });
  }

  async getCycle(id: string): Promise<BillingCycleRow | null> {
    await Promise.resolve();
    const cycle = this.cycles.get(id);
    return cycle ? { id, state: cycle.state, lockVersion: cycle.lockVersion } : null;
  }

  applyTransition(
    id: string,
    from: BillingCycleState,
    to: BillingCycleState,
    expectedLockVersion: number,
  ): Promise<boolean> {
    const cycle = this.cycles.get(id);
    if (cycle === undefined) {
      return Promise.resolve(false);
    }
    if (cycle.state !== from || cycle.lockVersion !== expectedLockVersion) {
      return Promise.resolve(false);
    }
    cycle.state = to;
    cycle.lockVersion += 1;
    return Promise.resolve(true);
  }

  recordFinalization(_cycleId: string, idempotencyKey: string): Promise<boolean> {
    if (this.idempotencyKeys.has(idempotencyKey)) {
      return Promise.resolve(false);
    }
    this.idempotencyKeys.add(idempotencyKey);
    return Promise.resolve(true);
  }
}

// --- Postgres implementation -----------------------------------------------

/** Minimal subset of `pg`'s Pool/Client query surface used by this store. */
export interface PgClientLike {
  query(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

/** A pool that can also hand out a dedicated client for transactions. */
export interface PgPoolLike extends PgClientLike {
  connect(): Promise<PgClientLike & { release: () => void }>;
}

interface CycleQueryRow {
  id: string;
  state: string;
  lock_version: number;
}

function toRow(row: CycleQueryRow): BillingCycleRow {
  if (!isBillingCycleState(row.state)) {
    throw new Error(`Unknown billing-cycle state in DB: "${row.state}"`);
  }
  return { id: row.id, state: row.state, lockVersion: row.lock_version };
}

export class PgBillingCycleStore implements BillingCycleStore {
  constructor(private readonly db: PgClientLike) {}

  async getCycle(id: string): Promise<BillingCycleRow | null> {
    const res = await this.db.query(
      `SELECT id, state, lock_version FROM billing_cycles WHERE id = $1`,
      [id],
    );
    const row = res.rows[0] as CycleQueryRow | undefined;
    return row ? toRow(row) : null;
  }

  /**
   * Read a cycle under a pessimistic `FOR NO KEY UPDATE` lock (issue #42,
   * blueprint item 2). Must be called on a transaction-scoped client (see
   * {@link withCycleLock}); the lock is held until that transaction ends. This
   * blocks concurrent state writers while leaving foreign-key reads unblocked,
   * reducing the wasted work of optimistic retries under heavy contention.
   */
  async getCycleForUpdate(id: string): Promise<BillingCycleRow | null> {
    const res = await this.db.query(
      `SELECT id, state, lock_version FROM billing_cycles WHERE id = $1 FOR NO KEY UPDATE`,
      [id],
    );
    const row = res.rows[0] as CycleQueryRow | undefined;
    return row ? toRow(row) : null;
  }

  async applyTransition(
    id: string,
    from: BillingCycleState,
    to: BillingCycleState,
    expectedLockVersion: number,
  ): Promise<boolean> {
    const res = await this.db.query(
      `UPDATE billing_cycles
         SET state = $1, lock_version = lock_version + 1, updated_at = now()
       WHERE id = $2 AND state = $3 AND lock_version = $4`,
      [to, id, from, expectedLockVersion],
    );
    return (res.rowCount ?? 0) === 1;
  }

  async recordFinalization(cycleId: string, idempotencyKey: string): Promise<boolean> {
    const res = await this.db.query(
      `INSERT INTO billing_finalization_log (id, cycle_id, idempotency_key)
       VALUES ($1, $2, $3)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [idempotencyKey, cycleId, idempotencyKey],
    );
    return (res.rowCount ?? 0) === 1;
  }
}

/**
 * Run `fn` inside a transaction that holds a `FOR NO KEY UPDATE` lock on the
 * cycle row, passing a transaction-scoped {@link PgBillingCycleStore} so every
 * query inside the critical section runs on the locked connection. Combines the
 * pessimistic lock (item 2) with the optimistic guard (item 1).
 */
export async function withCycleLock<T>(
  pool: PgPoolLike,
  cycleId: string,
  fn: (store: PgBillingCycleStore, locked: BillingCycleRow | null) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const scoped = new PgBillingCycleStore(client);
    const locked = await scoped.getCycleForUpdate(cycleId);
    const result = await fn(scoped, locked);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
