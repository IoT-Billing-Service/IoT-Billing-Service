import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const SCHEMA_SQLITE = `
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS meter_events (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id       TEXT UNIQUE,
    contract_id    TEXT,
    ledger         INTEGER,
    device_id      TEXT NOT NULL,
    operator       TEXT,
    units          INTEGER NOT NULL DEFAULT 0,
    rate_per_unit  INTEGER NOT NULL DEFAULT 0,
    cost           INTEGER NOT NULL DEFAULT 0,
    balance_after  INTEGER,
    seq            INTEGER,
    ledger_ts      INTEGER,
    emitted_at     TEXT,
    raw            TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_events_device_ledger
    ON meter_events (device_id, ledger);
  CREATE INDEX IF NOT EXISTS idx_events_emitted
    ON meter_events (emitted_at);

  CREATE TABLE IF NOT EXISTS pending_readings (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id      TEXT NOT NULL,
    device_pubkey  TEXT NOT NULL,
    seq            INTEGER NOT NULL,
    delta_units    INTEGER NOT NULL,
    timestamp_ms   INTEGER NOT NULL,
    tx_hash        TEXT,
    accepted_at    TEXT NOT NULL
  );
`;

const SCHEMA_PG = `
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS meter_events (
    id             BIGSERIAL PRIMARY KEY,
    event_id       TEXT UNIQUE,
    contract_id    TEXT,
    ledger         BIGINT,
    device_id      TEXT NOT NULL,
    operator       TEXT,
    units          BIGINT NOT NULL DEFAULT 0,
    rate_per_unit  BIGINT NOT NULL DEFAULT 0,
    cost           BIGINT NOT NULL DEFAULT 0,
    balance_after  BIGINT,
    seq            BIGINT,
    ledger_ts      BIGINT,
    emitted_at     TEXT,
    raw            TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_events_device_ledger
    ON meter_events (device_id, ledger);
  CREATE INDEX IF NOT EXISTS idx_events_emitted
    ON meter_events (emitted_at);

  CREATE TABLE IF NOT EXISTS pending_readings (
    id             BIGSERIAL PRIMARY KEY,
    device_id      TEXT NOT NULL,
    device_pubkey  TEXT NOT NULL,
    seq            BIGINT NOT NULL,
    delta_units    BIGINT NOT NULL,
    timestamp_ms   BIGINT NOT NULL,
    tx_hash        TEXT,
    accepted_at    TEXT NOT NULL
  );
`;

/**
 * Relational event cache used by the indexer and the REST/WS API.
 *
 * Backends:
 *  - SQLite (default) when only `dbPath` is set — `better-sqlite3`.
 *  - PostgreSQL when `databaseUrl` is set — `pg` (production deployments).
 *
 * Every method is async and dialected internally; callers never branch.
 */
export class CacheStore {
  constructor({ dbPath, databaseUrl } = {}) {
    this.kind = databaseUrl ? 'postgres' : 'sqlite';

    if (this.kind === 'sqlite') {
      if (dbPath && dbPath !== ':memory:') {
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      }
      this.db = new Database(dbPath || ':memory:');
      this.db.pragma('journal_mode = WAL');
      this.db.exec(SCHEMA_SQLITE);
      this.migrateCompat();
      this._ready = Promise.resolve(this);
    } else {
      pg.types.setTypeParser(20, (v) => Number(v)); // int8 -> JS number
      pg.types.setTypeParser(1700, (v) => Number(v)); // numeric -> JS number
      this.pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
      this._ready = this.pool.query(SCHEMA_PG).then(() => this);
    }
  }

  /** Resolves once the backing store is connected and migrated. */
  async ready() {
    return this._ready;
  }

  migrateCompat() {
    // Older SQLite caches predate the ledger_ts column.
    const cols = this.db.prepare('PRAGMA table_info(meter_events)').all();
    if (!cols.some((c) => c.name === 'ledger_ts')) {
      this.db.exec('ALTER TABLE meter_events ADD COLUMN ledger_ts INTEGER');
    }
  }

  /** @private dialect-aware positional placeholder. */
  _ph(n) {
    return this.kind === 'sqlite' ? '?' : `$${n}`;
  }

  _run(query, params = []) {
    if (this.kind === 'sqlite') {
      return this.db.prepare(query).run(...params);
    }
    return this.pool.query(query, params);
  }

  async _all(query, params = []) {
    if (this.kind === 'sqlite') {
      return this.db.prepare(query).all(...params);
    }
    const res = await this.pool.query(query, params);
    return res.rows;
  }

  async _get(query, params = []) {
    const rows = await this._all(query, params);
    return rows[0] ?? null;
  }

  recordPendingReading({
    device_id,
    device_pubkey,
    seq,
    delta_units,
    timestamp_ms,
    tx_hash,
  }) {
    const ph = (n) => this._ph(n);
    return this._run(
      `INSERT INTO pending_readings
         (device_id, device_pubkey, seq, delta_units, timestamp_ms, tx_hash, accepted_at)
       VALUES (${ph(1)}, ${ph(2)}, ${ph(3)}, ${ph(4)}, ${ph(5)}, ${ph(6)}, ${ph(7)})`,
      [
        device_id,
        device_pubkey,
        seq,
        delta_units,
        timestamp_ms,
        tx_hash ?? null,
        new Date().toISOString(),
      ],
    );
  }

  async pendingReadings(deviceId = null) {
    if (deviceId) {
      return this._all(
        `SELECT * FROM pending_readings WHERE device_id = ${this._ph(1)} ORDER BY id`,
        [deviceId],
      );
    }
    return this._all('SELECT * FROM pending_readings ORDER BY id');
  }

  async getLastLedger() {
    const row = await this._get(
      "SELECT value FROM meta WHERE key = 'last_ledger'",
    );
    return row ? Number(row.value) : 0;
  }

  async setLastLedger(ledger) {
    const sql =
      this.kind === 'sqlite'
        ? "INSERT INTO meta (key, value) VALUES ('last_ledger', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        : `INSERT INTO meta (key, value) VALUES ('last_ledger', ${this._ph(
            1,
          )}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    await this._run(sql, [String(ledger)]);
  }

  async ingest(row) {
    const ctx = {
      ...row,
      contract_id: row.contract_id ?? null,
      ledger: row.ledger ?? null,
      operator: row.operator ?? null,
      units: row.units ?? 0,
      rate_per_unit: row.rate_per_unit ?? 0,
      cost: row.cost ?? 0,
      balance_after: row.balance_after ?? null,
      seq: row.seq ?? null,
      ledger_ts: row.ledger_ts ?? null,
      emitted_at: row.emitted_at ?? null,
      raw: row.raw ?? null,
    };

    if (this.kind === 'sqlite') {
      return this.db
        .prepare(
          `INSERT OR IGNORE INTO meter_events
             (event_id, contract_id, ledger, device_id, operator, units,
              rate_per_unit, cost, balance_after, seq, ledger_ts, emitted_at, raw)
           VALUES
             (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ctx.event_id,
          ctx.contract_id,
          ctx.ledger,
          ctx.device_id,
          ctx.operator,
          ctx.units,
          ctx.rate_per_unit,
          ctx.cost,
          ctx.balance_after,
          ctx.seq,
          ctx.ledger_ts,
          ctx.emitted_at,
          ctx.raw,
        );
    }

    return this.pool.query(
      `INSERT INTO meter_events
         (event_id, contract_id, ledger, device_id, operator, units,
          rate_per_unit, cost, balance_after, seq, ledger_ts, emitted_at, raw)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        ctx.event_id,
        ctx.contract_id,
        ctx.ledger,
        ctx.device_id,
        ctx.operator,
        ctx.units,
        ctx.rate_per_unit,
        ctx.cost,
        ctx.balance_after,
        ctx.seq,
        ctx.ledger_ts,
        ctx.emitted_at,
        ctx.raw,
      ],
    );
  }

  async metricsFor(deviceId, { from, to } = {}) {
    const where = [`device_id = ${this._ph(1)}`];
    const args = [deviceId];
    if (from) {
      where.push(`emitted_at >= ${this._ph(args.length + 1)}`);
      args.push(from);
    }
    if (to) {
      where.push(`emitted_at <= ${this._ph(args.length + 1)}`);
      args.push(to);
    }
    return this._all(
      `SELECT device_id, units, cost, rate_per_unit, balance_after, seq, emitted_at
         FROM meter_events
        WHERE ${where.join(' AND ')}
        ORDER BY seq ASC`,
      args,
    );
  }

  async aggregate(deviceId, { from, to, granularity = 'day' } = {}) {
    const where = [`device_id = ${this._ph(1)}`];
    const args = [deviceId];
    if (from) {
      where.push(`emitted_at >= ${this._ph(args.length + 1)}`);
      args.push(from);
    }
    if (to) {
      where.push(`emitted_at <= ${this._ph(args.length + 1)}`);
      args.push(to);
    }
    const hourBucket =
      this.kind === 'sqlite'
        ? "strftime('%Y-%m-%dT%H:00:00', emitted_at)"
        : "left(emitted_at, 13) || ':00:00'";
    const dayBucket =
      this.kind === 'sqlite' ? 'date(emitted_at)' : 'left(emitted_at, 10)';
    const bucket = granularity === 'hour' ? hourBucket : dayBucket;
    return this._all(
      `SELECT ${bucket} AS bucket,
              SUM(units)        AS total_units,
              SUM(cost)         AS total_cost,
              COUNT(*)          AS event_count,
              MIN(balance_after) AS min_balance,
              MAX(balance_after) AS max_balance
         FROM meter_events
        WHERE ${where.join(' AND ')}
        GROUP BY bucket
        ORDER BY bucket ASC`,
      args,
    );
  }

  async latestSequence(deviceId) {
    const row = await this._get(
      `SELECT MAX(seq) AS seq FROM meter_events WHERE device_id = ${this._ph(1)}`,
      [deviceId],
    );
    return row?.seq ?? 0;
  }

  async listDevices() {
    return this._all(
      `SELECT device_id,
              COUNT(*)        AS event_count,
              SUM(units)      AS total_units,
              SUM(cost)       AS total_cost,
              MAX(ledger)     AS last_ledger,
              MAX(ledger_ts)  AS last_activity
         FROM meter_events
        GROUP BY device_id
        ORDER BY last_ledger DESC`,
    );
  }

  async close() {
    if (this.kind === 'sqlite') {
      this.db.close();
      return;
    }
    await this.pool.end();
  }
}
