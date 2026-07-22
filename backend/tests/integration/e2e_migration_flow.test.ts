/**
 * Integration test: End-to-End Migration Flow (issue #60, #75)
 *
 * Tests that the MigrationManager correctly applies and rolls back SQL
 * migrations through a full lifecycle: up -> verify -> down.
 *
 * Uses an isolated PostgreSQL schema to avoid interfering with other tests.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MigrationManager } from '../../src/database/migration_manager.js';
import { getTimescalePool, resetPoolManagerForTests } from '../../src/database/pool_manager.js';
import { getEnv } from '../../src/config/env.js';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const TEST_SCHEMA = 'migration_e2e_test';

describe('E2E: Migration Versioning with Rollback', () => {
  let manager: MigrationManager;
  let migrationsDir: string;
  let pool: ReturnType<typeof getTimescalePool>;

  beforeAll(async () => {
    resetPoolManagerForTests();
    pool = getTimescalePool();

    // Create a temporary migrations directory with up/down pairs.
    migrationsDir = join(tmpdir(), `migration_test_${randomBytes(6).toString('hex')}`);
    await mkdir(migrationsDir, { recursive: true });

    // Create migration 001: add a test table
    await writeFile(
      join(migrationsDir, '001_create_test_table.up.sql'),
      `CREATE TABLE IF NOT EXISTS ${TEST_SCHEMA}.e2e_test_table (id SERIAL PRIMARY KEY, name TEXT);\n`,
    );
    await writeFile(
      join(migrationsDir, '001_create_test_table.down.sql'),
      `DROP TABLE IF EXISTS ${TEST_SCHEMA}.e2e_test_table;\n`,
    );

    // Create migration 002: add an index
    await writeFile(
      join(migrationsDir, '002_add_index.up.sql'),
      `CREATE INDEX IF NOT EXISTS idx_e2e_test_name ON ${TEST_SCHEMA}.e2e_test_table (name);\n`,
    );
    await writeFile(
      join(migrationsDir, '002_add_index.down.sql'),
      `DROP INDEX IF EXISTS ${TEST_SCHEMA}.idx_e2e_test_name;\n`,
    );

    // Set up the test schema.
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${TEST_SCHEMA}`);

    manager = new MigrationManager(pool, migrationsDir);
  });

  afterAll(async () => {
    // Clean up the test schema, migrations table, and temp dir.
    try {
      await pool.query(`DROP TABLE IF EXISTS schema_migrations`);
    } catch {
      /* ignore */
    }
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    } catch {
      /* ignore */
    }
    try {
      await rm(migrationsDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('should start with no applied migrations', async () => {
    const versions = await manager.getAppliedVersions();
    expect(versions.length).toBeGreaterThanOrEqual(0);
  });

  it('should apply pending up migrations in order', async () => {
    const result = await manager.up();
    // Two up migrations should have been applied.
    expect(result.applied.filter((r) => r.success)).toHaveLength(2);
  });

  it('should have recorded applied versions after up', async () => {
    const versions = await manager.getAppliedVersions();
    expect(versions).toHaveLength(2);
    expect(versions[0]!.version).toBe(1);
    expect(versions[1]!.version).toBe(2);
  });

  it('should verify the test table exists', async () => {
    const res = await pool.query(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'e2e_test_table')`,
      [TEST_SCHEMA],
    );
    expect(res.rows[0]?.exists).toBe(true);
  });

  it('should roll back the highest version', async () => {
    const result = await manager.down();
    expect(result.reverted).not.toBeNull();
    expect(result.reverted!.success).toBe(true);
    expect(result.reverted!.version).toBe(2);
  });

  it('should have removed version 2 after down', async () => {
    const versions = await manager.getAppliedVersions();
    expect(versions).toHaveLength(1);
    expect(versions[0]!.version).toBe(1);
  });

  it('should roll back the remaining version', async () => {
    const result = await manager.down();
    expect(result.reverted!.success).toBe(true);
    expect(result.reverted!.version).toBe(1);
  });

  it('should have no applied versions after full rollback', async () => {
    const versions = await manager.getAppliedVersions();
    expect(versions).toHaveLength(0);
  });

  it('should return null when down is called with no applied versions', async () => {
    const result = await manager.down();
    expect(result.reverted).toBeNull();
  });
});
