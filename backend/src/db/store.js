import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Local relational cache for indexed contract events.
 *
 * Swaps to PostgreSQL in production; the query surface stays identical.
 */
export class CacheStore {
  constructor(dbPath) {
    if (dbPath && dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath || ':memory:');
    this.db.pragma('journal_mode = WAL');
    this.migrate();
    this.migrateCompat();
  }

  migrateCompat() {
    // Older local caches predate the ledger_ts column.
    const cols = this.db.prepare('PRAGMA table_info(meter_events)').all();
    if (!cols.some((c) => c.name === 'ledger_ts')) {
      this.db.exec('ALTER TABLE meter_events ADD COLUMN ledger_ts INTEGER');
    }
  }

  migrate() {
    this.db.exec(`
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
    `);
  }

  recordPendingReading({
    device_id,
    device_pubkey,
    seq,
    delta_units,
    timestamp_ms,
    tx_hash,
  }) {
    return this.db
      .prepare(
        `INSERT INTO pending_readings
           (device_id, device_pubkey, seq, delta_units, timestamp_ms, tx_hash, accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        device_id,
        device_pubkey,
        seq,
        delta_units,
        timestamp_ms,
        tx_hash ?? null,
        new Date().toISOString(),
      );
  }

  getLastLedger() {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = 'last_ledger'")
      .get();
    return row ? Number(row.value) : 0;
  }

  setLastLedger(ledger) {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES ('last_ledger', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(String(ledger));
  }

  ingest(row) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO meter_events
           (event_id, contract_id, ledger, device_id, operator, units,
            rate_per_unit, cost, balance_after, seq, ledger_ts, emitted_at, raw)
         VALUES
           (@event_id, @contract_id, @ledger, @device_id, @operator, @units,
            @rate_per_unit, @cost, @balance_after, @seq, @ledger_ts, @emitted_at, @raw)`,
      )
      .run({
        ...row,
        ledger_ts: row.ledger_ts ?? null,
        seq: row.seq ?? null,
        balance_after: row.balance_after ?? null,
        operator: row.operator ?? null,
        rate_per_unit: row.rate_per_unit ?? 0,
        emitted_at: row.emitted_at ?? null,
      });
  }

  metricsFor(deviceId, { from, to } = {}) {
    const where = ['device_id = ?'];
    const args = [deviceId];
    if (from) {
      where.push('emitted_at >= ?');
      args.push(from);
    }
    if (to) {
      where.push('emitted_at <= ?');
      args.push(to);
    }
    return this.db
      .prepare(
        `SELECT device_id, units, cost, rate_per_unit, balance_after, seq, emitted_at
           FROM meter_events
          WHERE ${where.join(' AND ')}
          ORDER BY seq ASC`,
      )
      .all(...args);
  }

  aggregate(deviceId, { from, to, granularity = 'day' } = {}) {
    const where = ['device_id = ?'];
    const args = [deviceId];
    if (from) {
      where.push('emitted_at >= ?');
      args.push(from);
    }
    if (to) {
      where.push('emitted_at <= ?');
      args.push(to);
    }
    const bucket =
      granularity === 'hour'
        ? "strftime('%Y-%m-%dT%H:00:00', emitted_at)"
        : 'date(emitted_at)';
    return this.db
      .prepare(
        `SELECT ${bucket} AS bucket,
                SUM(units)      AS total_units,
                SUM(cost)       AS total_cost,
                COUNT(*)        AS event_count,
                MIN(balance_after) AS min_balance,
                MAX(balance_after) AS max_balance
           FROM meter_events
          WHERE ${where.join(' AND ')}
          GROUP BY bucket
          ORDER BY bucket ASC`,
      )
      .all(...args);
  }

  latestSequence(deviceId) {
    const row = this.db
      .prepare('SELECT MAX(seq) AS seq FROM meter_events WHERE device_id = ?')
      .get(deviceId);
    return row?.seq ?? 0;
  }

  listDevices() {
    return this.db
      .prepare(
        `SELECT device_id,
                COUNT(*)        AS event_count,
                SUM(units)      AS total_units,
                SUM(cost)       AS total_cost,
                MAX(ledger)     AS last_ledger,
                MAX(ledger_ts)  AS last_activity
           FROM meter_events
          GROUP BY device_id
          ORDER BY last_ledger DESC`,
      )
      .all();
  }

  close() {
    this.db.close();
  }
}
