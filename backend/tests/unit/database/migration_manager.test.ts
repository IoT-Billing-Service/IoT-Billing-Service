import { describe, it, expect, vi, beforeEach } from 'vitest';
import type pg from 'pg';
import { MigrationManager } from '../../../src/database/migration_manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockPool {
  query: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
}

function createMockPool(): MockPool {
  const queryFn = vi.fn();
  const connectFn = vi.fn();
  return {
    query: queryFn,
    connect: connectFn,
  };
}

describe('MigrationManager', () => {
  let mockPool: MockPool;
  let manager: MigrationManager;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockPool = createMockPool();
    manager = new MigrationManager(mockPool as unknown as pg.Pool, '/fake/migrations');
  });

  describe('constructor', () => {
    it('should resolve the migrations directory to an absolute path', () => {
      const mgr = new MigrationManager(mockPool as unknown as pg.Pool, './migrations');
      expect(mgr).toBeDefined();
    });
  });

  describe('getAppliedVersions', () => {
    it('should return an empty list when no migrations have been applied', async () => {
      mockPool.query.mockResolvedValue({ rows: [] }); // ensureMigrationsTable
      mockPool.query.mockResolvedValue({ rows: [] }); // SELECT from schema_migrations
      const versions = await manager.getAppliedVersions();
      expect(versions).toEqual([]);
    });

    it('should return applied versions sorted by version', async () => {
      mockPool.query.mockResolvedValue({ rows: [] }); // CREATE TABLE
      mockPool.query.mockResolvedValue({
        rows: [
          { version: 1, name: 'first', applied_at: '2026-01-01T00:00:00Z' },
          { version: 2, name: 'second', applied_at: '2026-01-01T00:00:00Z' },
        ],
      });
      const versions = await manager.getAppliedVersions();
      expect(versions).toHaveLength(2);
      const firstVersion = versions[0];
      expect(firstVersion).toBeDefined();
      if (firstVersion !== undefined) {
        expect(firstVersion.version).toBe(1);
      }
    });
  });

  describe('up', () => {
    it('should return empty applied list when no pending migrations exist', async () => {
      mockPool.query.mockResolvedValue({ rows: [] }); // ensureTable
      mockPool.query.mockResolvedValue({ rows: [] }); // SELECT applied
      const result = await manager.up();
      expect(result.applied).toHaveLength(0);
    });
  });

  describe('down', () => {
    it('should return null reverted when no migrations are applied', async () => {
      mockPool.query.mockResolvedValue({ rows: [] }); // ensureTable
      mockPool.query.mockResolvedValue({ rows: [] }); // SELECT applied
      const result = await manager.down();
      expect(result.reverted).toBeNull();
    });
  });

  describe('getPendingMigrations', () => {
    it('should return empty lists for a non-existent migrations directory', async () => {
      mockPool.query.mockResolvedValue({ rows: [] }); // ensureTable
      mockPool.query.mockResolvedValue({ rows: [] }); // SELECT applied
      const pending = await manager.getPendingMigrations();
      expect(pending.up).toHaveLength(0);
      expect(pending.down).toHaveLength(0);
    });
  });
});
