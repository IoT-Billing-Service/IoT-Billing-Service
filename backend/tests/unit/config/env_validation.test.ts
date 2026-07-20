/**
 * Tests for environment-variable schema validation (issue #74).
 *
 * Covers:
 * - loadEnv() validates required variables and throws clearly on failure
 * - loadEnv() caches the result (subsequent calls return the same object)
 * - clearEnvCache() forces re-validation on the next loadEnv() call
 * - getEnv() calls loadEnv() when the cache is empty
 * - formatEnvIssues() surfaces structured, path-keyed error records
 * - Default values are applied for optional fields
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { loadEnv, getEnv, clearEnvCache, formatEnvIssues } from '../../../src/config/env.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal set of process.env keys required to pass envSchema validation. */
const REQUIRED_ENV: Record<string, string> = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/testdb',
  TIMESCALEDB_URL: 'postgresql://user:pass@localhost:5433/testdb',
  REDIS_URL: 'redis://localhost:6379',
  SOROBAN_RPC_URL: 'https://soroban-rpc.example.com',
  SOROBAN_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
  JWT_SECRET: 'super-secret-jwt-key-at-least-32-chars!!',
};

function setEnv(overrides: Record<string, string | undefined> = {}): void {
  // Apply the full required set, then any overrides
  Object.assign(process.env, REQUIRED_ENV, overrides);
}

function deleteEnv(...keys: string[]): void {
  for (const key of keys) {
    delete process.env[key];
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

// Save original env to restore between tests
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  clearEnvCache();
});

afterEach(() => {
  // Restore to original, removing keys that were added
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnv);
  clearEnvCache();
});

// ---------------------------------------------------------------------------
// loadEnv
// ---------------------------------------------------------------------------

describe('loadEnv', () => {
  it('succeeds when all required environment variables are provided', () => {
    setEnv();
    expect(() => loadEnv()).not.toThrow();
  });

  it('returns an object with the expected validated fields', () => {
    setEnv();
    const env = loadEnv();
    expect(env.DATABASE_URL).toBe(REQUIRED_ENV['DATABASE_URL']);
    expect(env.REDIS_URL).toBe(REQUIRED_ENV['REDIS_URL']);
    expect(env.JWT_SECRET).toBe(REQUIRED_ENV['JWT_SECRET']);
  });

  it('applies default values for optional fields', () => {
    setEnv();
    const env = loadEnv();
    expect(env.PORT).toBe(3000);
    // NODE_ENV defaults to 'development' when unset; Vitest sets it to 'test'
    // so just assert the field is present and a valid enum value.
    expect(['development', 'production', 'test']).toContain(env.NODE_ENV);
    expect(env.OTEL_SERVICE_NAME).toBeTruthy();
  });

  it('coerces PORT from string to number', () => {
    setEnv({ PORT: '8080' });
    const env = loadEnv();
    expect(typeof env.PORT).toBe('number');
    expect(env.PORT).toBe(8080);
  });

  it('throws when DATABASE_URL is missing', () => {
    setEnv();
    deleteEnv('DATABASE_URL');
    expect(() => loadEnv()).toThrow(/DATABASE_URL|Environment validation failed/i);
  });

  it('throws when JWT_SECRET is shorter than 32 characters', () => {
    setEnv({ JWT_SECRET: 'too-short' });
    expect(() => loadEnv()).toThrow(/JWT_SECRET|Environment validation failed/i);
  });

  it('throws when NODE_ENV is set to an unrecognised value', () => {
    setEnv({ NODE_ENV: 'staging' });
    expect(() => loadEnv()).toThrow(/NODE_ENV|Environment validation failed/i);
  });

  it('throws when DATABASE_URL is not a valid URL', () => {
    setEnv({ DATABASE_URL: 'not-a-url' });
    expect(() => loadEnv()).toThrow(/Environment validation failed/i);
  });

  it('includes the failing field name in the error message', () => {
    setEnv();
    deleteEnv('DATABASE_URL');
    let message = '';
    try {
      loadEnv();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('DATABASE_URL');
  });

  describe('caching', () => {
    it('returns the same object on repeated calls', () => {
      setEnv();
      const first = loadEnv();
      const second = loadEnv();
      expect(first).toBe(second);
    });

    it('does NOT re-validate on subsequent calls (cache is hot)', () => {
      setEnv();
      loadEnv(); // warm the cache

      // Even if we delete a required var after first load, cache returns the same object
      deleteEnv('DATABASE_URL');
      expect(() => loadEnv()).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// clearEnvCache
// ---------------------------------------------------------------------------

describe('clearEnvCache', () => {
  it('forces re-validation on the next loadEnv() call', () => {
    setEnv();
    loadEnv(); // warm the cache

    clearEnvCache();
    deleteEnv('DATABASE_URL');

    // Now re-validation runs and must fail
    expect(() => loadEnv()).toThrow(/DATABASE_URL|Environment validation failed/i);
  });

  it('is idempotent – calling twice does not throw', () => {
    expect(() => {
      clearEnvCache();
      clearEnvCache();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getEnv
// ---------------------------------------------------------------------------

describe('getEnv', () => {
  it('loads the env when the cache is cold', () => {
    setEnv();
    expect(() => getEnv()).not.toThrow();
    expect(getEnv().PORT).toBe(3000);
  });

  it('returns the cached result when called after loadEnv', () => {
    setEnv();
    const fromLoad = loadEnv();
    const fromGet = getEnv();
    expect(fromLoad).toBe(fromGet);
  });
});

// ---------------------------------------------------------------------------
// formatEnvIssues
// ---------------------------------------------------------------------------

describe('formatEnvIssues', () => {
  it('returns one record per Zod issue', () => {
    const schema = z.object({ X: z.string(), Y: z.number() });
    const result = schema.safeParse({ X: 123, Y: 'not-a-number' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = formatEnvIssues(result.error);
      expect(issues.length).toBe(2);
    }
  });

  it('each record has path, code, and message fields', () => {
    const schema = z.object({ MISSING: z.string() });
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = formatEnvIssues(result.error);
      for (const issue of issues) {
        expect(typeof issue.path).toBe('string');
        expect(typeof issue.code).toBe('string');
        expect(typeof issue.message).toBe('string');
      }
    }
  });

  it('path is non-empty for named fields', () => {
    const schema = z.object({ FIELD_A: z.string() });
    const result = schema.safeParse({ FIELD_A: 42 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = formatEnvIssues(result.error);
      expect(issues[0]?.path).toContain('FIELD_A');
    }
  });
});
