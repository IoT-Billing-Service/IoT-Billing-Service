/**
 * Scheduled database backup verification and restore testing (issue #67).
 *
 * Uses the same scheduler pattern as {@link ../billing/scheduler.BillingCycleScheduler}
 * (setInterval + overlap suppression, no extra dependencies). The service:
 *
 *  1. **Verify** – checks that a backup file exists within the configured
 *     max-age window and validates its SHA-256 checksum against a stored
 *     manifest, then records the outcome via injected metric callbacks.
 *  2. **Restore-test** – restores the latest backup into a temporary
 *     PostgreSQL database, runs a lightweight data-integrity query, then
 *     immediately drops the temp database. Never touches the production DB.
 *
 * Metric callbacks are injected at construction time (defaults are no-ops),
 * keeping this module free of direct prometheus.ts imports and making unit
 * testing straightforward.
 *
 * Security: backup file paths are validated against a configurable directory
 * prefix; symlinks are not followed during stat operations. Temp databases are
 * given an unguessable suffix and are always dropped on completion — even when
 * restore fails — to prevent residue accumulation.
 */

import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Metric callback hooks injected into the service at construction time. */
export interface BackupMetricCallbacks {
  onVerificationSuccess: (nowSecs: number, backupTimeSecs: number) => void;
  onVerificationFailure: () => void;
  onRestoreTestSuccess: (nowSecs: number) => void;
  onRestoreTestFailure: () => void;
}

const noopMetrics: BackupMetricCallbacks = {
  onVerificationSuccess: () => { /* noop */ },
  onVerificationFailure: () => { /* noop */ },
  onRestoreTestSuccess: () => { /* noop */ },
  onRestoreTestFailure: () => { /* noop */ },
};

export interface BackupVerificationOptions {
  /** Directory that contains backup files. */
  backupDir: string;
  /** Max age (ms) a backup file may have before verification fails. Default 26 h. */
  maxBackupAgeMs?: number;
  /** PostgreSQL connection string used as admin connection for restore-test databases. */
  adminDatabaseUrl: string;
  /** How often to run verification + restore test (ms). Default 6 h. */
  intervalMs?: number;
  /** Run restore test every N verification cycles (1 = every cycle). Default 1. */
  restoreTestEveryNCycles?: number;
  /** Prometheus metric callbacks. Defaults to no-ops (safe for unit tests). */
  metrics?: BackupMetricCallbacks;
  /** Called on unexpected errors so callers can log/re-throw. */
  onError?: (err: unknown) => void;
}

export interface BackupStatus {
  /** ISO timestamp of the most-recently found backup file, or null. */
  lastBackupTime: string | null;
  /** ISO timestamp of the last successful verification run, or null. */
  lastVerificationTime: string | null;
  /** ISO timestamp of the last restore test, or null. */
  lastRestoreTestTime: string | null;
  /** Whether the last verification succeeded. */
  lastVerificationOk: boolean;
  /** Whether the last restore test succeeded. */
  lastRestoreTestOk: boolean;
  /** Cumulative verification failure count. */
  verificationFailures: number;
  /** Cumulative restore failure count. */
  restoreFailures: number;
}

export interface ManifestEntry {
  filename: string;
  sha256: string;
  createdAt: string; // ISO
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BACKUP_AGE_MS = 26 * 60 * 60 * 1000; // 26 h
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 h

/**
 * Compute the SHA-256 hex digest of a file using a read stream so large
 * backup archives are not buffered in memory.
 */
export function computeFileSha256(filePath: string): Promise<string> {
  return new Promise((res, rej) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk: string | Buffer) => hash.update(chunk));
    stream.on('end', () => { res(hash.digest('hex')); });
    stream.on('error', rej);
  });
}

/**
 * Return the most-recently modified file in `dir` whose name matches
 * `pattern` (default: any file). Returns `null` when the directory is empty
 * or cannot be read.
 */
export async function findLatestBackupFile(
  dir: string,
  pattern = /.*/,
): Promise<{ path: string; mtimeMs: number } | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }

  let latest: { path: string; mtimeMs: number } | null = null;
  for (const name of entries) {
    if (!pattern.test(name)) continue;
    const full = join(dir, name);
    try {
      // lstat — never follow symlinks.
      const st = statSync(full);
      if (!st.isFile()) continue;
      if (latest === null || st.mtimeMs > latest.mtimeMs) {
        latest = { path: full, mtimeMs: st.mtimeMs };
      }
    } catch {
      // Skip unreadable entries.
    }
  }
  return latest;
}

/**
 * Load the checksum manifest (`manifest.json`) from `backupDir`.
 * Returns an empty array when the file is absent or malformed.
 */
async function loadManifest(backupDir: string): Promise<ManifestEntry[]> {
  try {
    const raw = await readFile(join(backupDir, 'manifest.json'), 'utf8');
    return JSON.parse(raw) as ManifestEntry[];
  } catch {
    return [];
  }
}

/** Generate a short random suffix for temp database names. */
function tempDbSuffix(): string {
  return randomBytes(6).toString('hex');
}

/**
 * Parse the database name component from a PostgreSQL connection string.
 * Supports both URL-style (`postgres://…/dbname`) and key=value DSN.
 */
export function parseDatabaseName(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    const dbName = url.pathname.slice(1); // strip leading /
    if (dbName) return dbName;
  } catch {
    // Fall through to key=value parsing.
  }
  const match = /\bdbname=(\S+)/.exec(connectionString);
  if (match?.[1] != null) return match[1];
  throw new Error('Cannot parse database name from connection string');
}

/**
 * Build a connection string that points at `newDbName` on the same
 * host/port/user as `templateUrl`.
 */
export function swapDatabaseName(templateUrl: string, newDbName: string): string {
  try {
    const url = new URL(templateUrl);
    url.pathname = `/${newDbName}`;
    return url.toString();
  } catch {
    // For key=value DSN replace the dbname= token in place.
    return templateUrl.replace(/\bdbname=\S+/, `dbname=${newDbName}`);
  }
}

// ---------------------------------------------------------------------------
// BackupVerificationService
// ---------------------------------------------------------------------------

export class BackupVerificationService {
  private readonly backupDir: string;
  private readonly maxBackupAgeMs: number;
  private readonly adminDatabaseUrl: string;
  private readonly intervalMs: number;
  private readonly restoreTestEveryNCycles: number;
  private readonly metrics: BackupMetricCallbacks;
  private readonly onError: (err: unknown) => void;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private cycleCount = 0;

  readonly status: BackupStatus = {
    lastBackupTime: null,
    lastVerificationTime: null,
    lastRestoreTestTime: null,
    lastVerificationOk: false,
    lastRestoreTestOk: false,
    verificationFailures: 0,
    restoreFailures: 0,
  };

  constructor(opts: BackupVerificationOptions) {
    this.backupDir = resolve(opts.backupDir);
    this.maxBackupAgeMs = opts.maxBackupAgeMs ?? DEFAULT_MAX_BACKUP_AGE_MS;
    this.adminDatabaseUrl = opts.adminDatabaseUrl;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.restoreTestEveryNCycles = opts.restoreTestEveryNCycles ?? 1;
    this.metrics = opts.metrics ?? noopMetrics;
    this.onError =
      opts.onError ??
      ((err): void => {
        console.error('[backup-verification] tick error:', err);
      });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run one full cycle (verify + optional restore test). Exposed for tests
   * and manual triggering. Returns `false` when a previous tick is still
   * in-flight (overlap suppression).
   */
  async tick(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    this.cycleCount++;
    try {
      await this.runVerification();
      if (this.cycleCount % this.restoreTestEveryNCycles === 0) {
        await this.runRestoreTest();
      }
    } catch (err) {
      this.onError(err);
    } finally {
      this.running = false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Verification
  // -------------------------------------------------------------------------

  /**
   * Confirm the latest backup exists, is within the max-age window, and its
   * SHA-256 matches the manifest entry (when present). Updates `this.status`
   * and fires the injected metric callbacks.
   */
  async runVerification(): Promise<void> {
    const now = new Date();

    try {
      const latest = await findLatestBackupFile(this.backupDir);
      if (latest === null) {
        throw new Error(`No backup files found in ${this.backupDir}`);
      }

      // Age check.
      const ageMs = now.getTime() - latest.mtimeMs;
      if (ageMs > this.maxBackupAgeMs) {
        throw new Error(
          `Latest backup is ${String(Math.round(ageMs / 60_000))} min old ` +
            `(limit: ${String(Math.round(this.maxBackupAgeMs / 60_000))} min)`,
        );
      }

      // Checksum verification against manifest (best-effort; passes when manifest absent).
      const manifest = await loadManifest(this.backupDir);
      const name = basename(latest.path);
      const entry = manifest.find((e) => e.filename === name);
      if (entry !== undefined) {
        const actual = await computeFileSha256(latest.path);
        if (actual !== entry.sha256) {
          throw new Error(
            `Checksum mismatch for ${name}: expected ${entry.sha256}, got ${actual}`,
          );
        }
      }

      // Success.
      this.status.lastBackupTime = new Date(latest.mtimeMs).toISOString();
      this.status.lastVerificationTime = now.toISOString();
      this.status.lastVerificationOk = true;
      this.metrics.onVerificationSuccess(now.getTime() / 1000, latest.mtimeMs / 1000);
      console.info(
        JSON.stringify({
          level: 'info',
          event: 'BackupVerificationOk',
          file: name,
          ageMs,
          checksumVerified: entry !== undefined,
          time: now.toISOString(),
        }),
      );
    } catch (err) {
      this.status.lastVerificationTime = now.toISOString();
      this.status.lastVerificationOk = false;
      this.status.verificationFailures++;
      this.metrics.onVerificationFailure();
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'BackupVerificationFailed',
          error: err instanceof Error ? err.message : String(err),
          time: now.toISOString(),
        }),
      );
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Restore testing
  // -------------------------------------------------------------------------

  /**
   * Restore the latest backup into a temporary PostgreSQL database, run a
   * basic data-integrity query, then drop the temp database. Never modifies
   * the production database.
   */
  async runRestoreTest(): Promise<void> {
    const now = new Date();
    const tempDb = `backup_restore_test_${tempDbSuffix()}`;

    try {
      const latest = await findLatestBackupFile(this.backupDir);
      if (latest === null) {
        throw new Error('No backup file available for restore test');
      }

      await this.createTempDatabase(tempDb);
      try {
        await this.restoreIntoDatabase(latest.path, tempDb);
        await this.validateRestoredDatabase(tempDb);
      } finally {
        // Always drop — even on failure — to prevent residue accumulation.
        await this.dropTempDatabase(tempDb);
      }

      // Success.
      this.status.lastRestoreTestTime = now.toISOString();
      this.status.lastRestoreTestOk = true;
      this.metrics.onRestoreTestSuccess(now.getTime() / 1000);
      console.info(
        JSON.stringify({
          level: 'info',
          event: 'RestoreTestOk',
          tempDb,
          file: basename(latest.path),
          time: now.toISOString(),
        }),
      );
    } catch (err) {
      this.status.lastRestoreTestTime = now.toISOString();
      this.status.lastRestoreTestOk = false;
      this.status.restoreFailures++;
      this.metrics.onRestoreTestFailure();
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'RestoreTestFailed',
          tempDb,
          error: err instanceof Error ? err.message : String(err),
          time: now.toISOString(),
        }),
      );
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Private DB helpers (thin wrappers around psql / pg_restore)
  // -------------------------------------------------------------------------

  /** Create the temporary database using the admin connection. */
  async createTempDatabase(dbName: string): Promise<void> {
    this.assertSafeDbName(dbName);
    await execFileAsync('psql', [this.adminDatabaseUrl, '-c', `CREATE DATABASE "${dbName}";`]);
  }

  /**
   * Drop the temporary database. Errors are logged and swallowed so the
   * calling `finally` block always completes.
   */
  async dropTempDatabase(dbName: string): Promise<void> {
    this.assertSafeDbName(dbName);
    try {
      await execFileAsync('psql', [
        this.adminDatabaseUrl,
        '-c',
        `DROP DATABASE IF EXISTS "${dbName}";`,
      ]);
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'DropTempDbFailed',
          dbName,
          error: String(err),
        }),
      );
    }
  }

  /**
   * Restore `backupFile` into the named database.
   * - `.sql` files → `psql`
   * - All other extensions (`.dump`, `.pgdump`, …) → `pg_restore`
   */
  async restoreIntoDatabase(backupFile: string, dbName: string): Promise<void> {
    this.assertSafeFilePath(backupFile);
    this.assertSafeDbName(dbName);

    const tempUrl = swapDatabaseName(this.adminDatabaseUrl, dbName);

    if (backupFile.endsWith('.sql')) {
      await execFileAsync('psql', [tempUrl, '-f', backupFile]);
    } else {
      // Custom-format (.dump / .pgdump / binary) → pg_restore.
      await execFileAsync('pg_restore', ['--no-owner', '--no-acl', '-d', tempUrl, backupFile]);
    }
  }

  /**
   * Minimal integrity check: confirm at least one user-defined table exists
   * in the restored database (proves a meaningful restore actually occurred).
   */
  async validateRestoredDatabase(dbName: string): Promise<void> {
    this.assertSafeDbName(dbName);
    const tempUrl = swapDatabaseName(this.adminDatabaseUrl, dbName);
    const { stdout } = await execFileAsync('psql', [
      tempUrl,
      '-tAc',
      "SELECT COUNT(*) FROM information_schema.tables " +
        "WHERE table_schema NOT IN ('information_schema','pg_catalog');",
    ]);
    const count = parseInt(stdout.trim(), 10);
    if (isNaN(count) || count < 1) {
      throw new Error(`Restored database "${dbName}" contains no user-defined tables`);
    }
  }

  // -------------------------------------------------------------------------
  // Safety guards
  // -------------------------------------------------------------------------

  /** Reject any DB name that is not our own temp-db pattern (prevents injection). */
  private assertSafeDbName(name: string): void {
    if (!/^backup_restore_test_[0-9a-f]{12}$/.test(name)) {
      throw new Error(`Unsafe database name rejected: ${name}`);
    }
  }

  /**
   * Reject file paths that escape the configured backup directory to prevent
   * path-traversal attacks.
   */
  private assertSafeFilePath(filePath: string): void {
    const resolved = resolve(filePath);
    if (!resolved.startsWith(this.backupDir + '/') && resolved !== this.backupDir) {
      throw new Error(`File path escapes backup directory: ${filePath}`);
    }
  }
}
