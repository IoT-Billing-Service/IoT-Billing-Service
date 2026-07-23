/**
 * Database Migration Versioning with Rollback Support (issue #75).
 *
 * Tracks applied migrations in a `schema_migrations` table and supports
 * forward (up) and reverse (down) execution. Raw SQL migration files live in
 * `migrations/` as versioned up/down pairs:
 *
 *   migrations/001_add_geo_pricing.up.sql
 *   migrations/001_add_geo_pricing.down.sql
 *
 * The naming convention is `<version>_<name>.up.sql` / `<version>_<name>.down.sql`
 * where `version` is a zero-padded 3-digit integer.
 *
 * ## Integration
 *
 * The manager is invoked from `pool_manager.ts`'s `runMigrationWithDistributedLock`
 * AFTER `prisma migrate deploy` so raw SQL migrations that Prisma cannot express
 * (e.g. hypertable creation, continuous aggregates, non-standard DDL) are applied
 * under the same distributed Redis lock, guaranteeing a single-node migration.
 *
 * ## Rollback
 *
 * Expose `down()` publicly so an admin CLI command can roll back the most-recently
 * applied batch. Each down invocation drops exactly the highest version that is
 * currently recorded in `schema_migrations`.
 *
 * ## Performance
 *
 * The `schema_migrations` table is tiny (one row per applied version).  The
 * check for pending migrations is a simple SELECT vs. file-system readdir and
 * costs < 1 ms for typical installs.
 */

import { readdir, readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type pg from 'pg';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Table that records every applied migration version. */
const MIGRATIONS_TABLE = 'schema_migrations';
/** Regex matching migration files: `001_any_name.up.sql` or `001_any_name.down.sql`. */
const MIGRATION_FILE_RE = /^(\d{3})_(.+)\.(up|down)\.sql$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MigrationDirection = 'up' | 'down';

export interface MigrationRecord {
  version: number;
  name: string;
  appliedAt: string; // ISO 8601
}

export interface MigrationFile {
  /** Numeric version extracted from the filename. */
  version: number;
  /** Human-readable name (e.g. "add_geo_pricing"). */
  name: string;
  /** Full absolute path to the SQL file. */
  path: string;
  direction: MigrationDirection;
}

export interface MigrationExecutionResult {
  version: number;
  name: string;
  direction: MigrationDirection;
  success: boolean;
  error?: string;
}

export interface UpResult {
  applied: MigrationExecutionResult[];
  /** Set when there are pending migrations but a lock cannot be acquired. */
  locked?: boolean;
}

export interface DownResult {
  reverted: MigrationExecutionResult | null;
}

// ---------------------------------------------------------------------------
// MigrationManager
// ---------------------------------------------------------------------------

export class MigrationManager {
  private readonly migrationsDir: string;
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool, migrationsDir: string) {
    this.pool = pool;
    this.migrationsDir = resolve(migrationsDir);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Ensure the `schema_migrations` table exists (CREATE IF NOT EXISTS), then
   * list unapplied migration files from disk, execute them in version order,
   * and record each successful migration. Wraps the batch in a transaction so
   * a mid-batch failure leaves the DB in a consistent state (no half-applied
   * migrations).
   */
  async up(): Promise<UpResult> {
    await this.ensureMigrationsTable();

    const unapplied = await this.getUnappliedMigrations();
    if (unapplied.up.length === 0) {
      return { applied: [] };
    }

    const applied: MigrationExecutionResult[] = [];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const file of unapplied.up) {
        try {
          const sql = await readFile(file.path, 'utf8');
          await client.query(sql);
          await client.query(
            `INSERT INTO ${MIGRATIONS_TABLE} (version, name) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING`,
            [file.version, file.name],
          );
          applied.push({
            version: file.version,
            name: file.name,
            direction: 'up',
            success: true,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          applied.push({
            version: file.version,
            name: file.name,
            direction: 'up',
            success: false,
            error: msg,
          });
          await client.query('ROLLBACK');
          return { applied };
        }
      }
      await client.query('COMMIT');
      return { applied };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore rollback errors */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Roll back the most-recently applied migration version. Reads the highest
   * version from `schema_migrations`, finds the corresponding `.down.sql` on
   * disk, executes it, and deletes the version record.
   *
   * Returns `null` when there is nothing to roll back.
   */
  async down(): Promise<DownResult> {
    const current = await this.getAppliedVersions();
    if (current.length === 0) {
      return { reverted: null };
    }

    const highest = current[current.length - 1];
    if (highest === undefined) {
      return { reverted: null };
    }
    const downFile = await this.findDownFile(highest.version, highest.name);
    if (downFile === null) {
      return {
        reverted: {
          version: highest.version,
          name: highest.name,
          direction: 'down',
          success: false,
          error: `No .down.sql file found for version ${String(highest.version)} (${highest.name})`,
        },
      };
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const sql = await readFile(downFile.path, 'utf8');
      await client.query(sql);
      await client.query(
        `DELETE FROM ${MIGRATIONS_TABLE} WHERE version = $1`,
        [highest.version],
      );
      await client.query('COMMIT');

      return {
        reverted: {
          version: highest.version,
          name: highest.name,
          direction: 'down',
          success: true,
        },
      };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        reverted: {
          version: highest.version,
          name: highest.name,
          direction: 'down',
          success: false,
          error: msg,
        },
      };
    } finally {
      client.release();
    }
  }

  /**
   * Returns the sorted list of applied migration versions from the
   * `schema_migrations` table.  The returned list is immutable (copied).
   */
  async getAppliedVersions(): Promise<MigrationRecord[]> {
    await this.ensureMigrationsTable();
    const res = await this.pool.query<{ version: number; name: string; applied_at: string }>(
      `SELECT version, name, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY version ASC`,
    );
    return res.rows.map((r) => ({
      version: r.version,
      name: r.name,
      appliedAt: r.applied_at,
    }));
  }

  /**
   * Return the list of pending up-migration files and available down-migration
   * files, keyed by direction.  The up list is restricted to versions NOT
   * already recorded in `schema_migrations`.
   */
  async getPendingMigrations(): Promise<{ up: MigrationFile[]; down: MigrationFile[] }> {
    const applied = new Set((await this.getAppliedVersions()).map((r) => r.version));
    const all = await this.scanMigrationFiles();

    return {
      up: all.filter((f) => f.direction === 'up' && !applied.has(f.version)),
      down: all.filter((f) => f.direction === 'down' && applied.has(f.version)),
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async getUnappliedMigrations(): Promise<{ up: MigrationFile[] }> {
    const pending = await this.getPendingMigrations();
    return { up: pending.up.sort((a, b) => a.version - b.version) };
  }

  private async ensureMigrationsTable(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
        version    INTEGER     NOT NULL PRIMARY KEY,
        name       TEXT        NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  }

  private async scanMigrationFiles(): Promise<MigrationFile[]> {
    const files: MigrationFile[] = [];
    let entries: string[];
    try {
      entries = await readdir(this.migrationsDir);
    } catch {
      return files;
    }

    for (const entry of entries) {
      const match = MIGRATION_FILE_RE.exec(entry);
      if (match === null) continue;
      const [, versionStr, name, direction] = match;
      if (versionStr === undefined || name === undefined) continue;
      const version = parseInt(versionStr, 10);
      files.push({
        version,
        name,
        direction: direction as MigrationDirection,
        path: join(this.migrationsDir, entry),
      });
    }
    return files.sort((a, b) => a.version - b.version);
  }

  private async findDownFile(
    version: number,
    name: string,
  ): Promise<MigrationFile | null> {
    const padded = String(version).padStart(3, '0');
    const downName = `${padded}_${name}.down.sql`;
    const downPath = join(this.migrationsDir, downName);
    try {
      await access(downPath);
      return { version, name, path: downPath, direction: 'down' };
    } catch {
      return null;
    }
  }
}
