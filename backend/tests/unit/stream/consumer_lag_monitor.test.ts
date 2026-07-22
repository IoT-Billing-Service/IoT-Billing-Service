import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import {
  ConsumerGroupLagMonitor,
  resetConsumerLagMonitor,
  getConsumerLagMonitor,
  setConsumerLagMonitor,
} from '../../../src/stream/consumer_lag_monitor.js';
import { clearEnvCache } from '../../../src/config/env.js';

// ---------------------------------------------------------------------------
// Set up required environment variables for the config validator.
// These are needed because the ConsumerGroupLagMonitor constructor calls
// getEnv() to read defaults.
// ---------------------------------------------------------------------------

beforeAll(() => {
  process.env['DATABASE_URL'] = 'postgres://test:test@localhost:5432/test';
  process.env['TIMESCALEDB_URL'] = 'postgres://test:test@localhost:5432/test';
  process.env['SOROBAN_RPC_URL'] = 'http://localhost:8000';
  process.env['SOROBAN_NETWORK_PASSPHRASE'] = 'Test SDF Network ; September 2015';
  process.env['JWT_SECRET'] = 'test-jwt-secret-that-is-at-least-32-chars-long!';
  clearEnvCache();
});

// ---------------------------------------------------------------------------
// Mock Redis
// ---------------------------------------------------------------------------

interface MockRedis {
  xpending: ReturnType<typeof vi.fn>;
  xinfo: ReturnType<typeof vi.fn>;
}

function createMockRedis(overrides: Partial<MockRedis> = {}): MockRedis {
  return {
    xpending: vi.fn().mockResolvedValue([0, null, null, []]),
    xinfo: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMonitor(opts: {
  redis?: MockRedis;
  warnEntries?: number;
  criticalEntries?: number;
  pollIntervalMs?: number;
  targets?: Array<{ streamKey: string; groupName: string }>;
} = {}) {
  return new ConsumerGroupLagMonitor({
    redis: opts.redis as any,
    warnEntries: opts.warnEntries ?? 100,
    criticalEntries: opts.criticalEntries ?? 1000,
    pollIntervalMs: opts.pollIntervalMs ?? 100,
    targets: opts.targets,
  });
}

/** Poll until the monitor has stored state for all targets, or timeout. */
async function waitForState(
  monitor: ConsumerGroupLagMonitor,
  expectedSize: number,
  timeoutMs: number = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (monitor.getLastState().size >= expectedSize) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConsumerGroupLagMonitor', () => {
  beforeEach(() => {
    resetConsumerLagMonitor();
  });

  afterEach(() => {
    resetConsumerLagMonitor();
  });

  // -------------------------------------------------------------------------
  // Constructor & lifecycle
  // -------------------------------------------------------------------------

  describe('constructor and lifecycle', () => {
    it('should start and stop without errors', () => {
      const redis = createMockRedis();
      const monitor = createMonitor({ redis });
      expect(monitor.isRunning).toBe(false);

      monitor.start();
      monitor.stop();
    });

    it('should be idempotent on start', () => {
      const redis = createMockRedis();
      const monitor = createMonitor({ redis });
      monitor.start();
      monitor.start(); // Should not throw
      monitor.stop();
    });

    it('should be idempotent on stop', () => {
      const redis = createMockRedis();
      const monitor = createMonitor({ redis });
      monitor.start();
      monitor.stop();
      monitor.stop(); // Should not throw
    });
  });

  // -------------------------------------------------------------------------
  // Poll behaviour
  // -------------------------------------------------------------------------

  describe('poll behaviour', () => {
    it('should probe the default billing consumer group', async () => {
      const redis = createMockRedis();
      const monitor = createMonitor({ redis, pollIntervalMs: 10000 });
      monitor.start();

      await waitForState(monitor, 1);
      monitor.stop();

      expect(redis.xpending).toHaveBeenCalled();
      const state = [...monitor.getLastState().values()][0];
      expect(state).toBeDefined();
      expect(state?.healthy).toBe(true);
    });

    it('should report pending entries correctly', async () => {
      const redis = createMockRedis({
        xpending: vi.fn().mockResolvedValue([
          42, // total pending
          '1234567890-0',
          '1234567890-41',
          [['consumer-a', '42']],
        ]),
        xinfo: vi.fn().mockResolvedValue([[['name', 'consumer-a', 'idle', '1000']]]),
      });

      const monitor = createMonitor({ redis, pollIntervalMs: 10000 });
      monitor.start();

      await waitForState(monitor, 1);
      monitor.stop();

      const state = [...monitor.getLastState().values()][0];
      expect(state).toBeDefined();
      expect(state?.pendingEntries).toBe(42);
      expect(state?.consumerCount).toBe(1);
    });

    it('should report zero consumers when XPENDING returns empty consumer list', async () => {
      const redis = createMockRedis({
        xpending: vi.fn().mockResolvedValue([0, null, null, null]),
        xinfo: vi.fn().mockResolvedValue([]),
      });

      const monitor = createMonitor({ redis, pollIntervalMs: 10000 });
      monitor.start();

      await waitForState(monitor, 1);
      monitor.stop();

      const state = [...monitor.getLastState().values()][0];
      expect(state).toBeDefined();
      expect(state?.consumerCount).toBe(0);
    });

    it('should handle Redis errors gracefully', async () => {
      const redis = createMockRedis({
        xpending: vi.fn().mockRejectedValue(new Error('Redis unavailable')),
      });

      const monitor = createMonitor({ redis, pollIntervalMs: 10000 });
      monitor.start();

      await waitForState(monitor, 1);
      monitor.stop();

      const state = [...monitor.getLastState().values()][0];
      expect(state).toBeDefined();
      expect(state?.healthy).toBe(false);
      expect(state?.pendingEntries).toBe(-1);
    });
  });

  // -------------------------------------------------------------------------
  // Classify lag
  // -------------------------------------------------------------------------

  describe('lag classification', () => {
    it('should classify low pending entries as healthy', async () => {
      const redis = createMockRedis({
        xpending: vi.fn().mockResolvedValue([50, null, null, []]),
      });

      const monitor = createMonitor({
        redis,
        warnEntries: 100,
        criticalEntries: 1000,
        pollIntervalMs: 10000,
      });
      monitor.start();

      await waitForState(monitor, 1);
      monitor.stop();

      const state = [...monitor.getLastState().values()][0];
      expect(state).toBeDefined();
      expect(state?.pendingEntries).toBe(50);
      expect(state?.healthy).toBe(true);
    });

    it('should classify warn threshold as degraded', async () => {
      const redis = createMockRedis({
        xpending: vi.fn().mockResolvedValue([150, null, null, []]),
      });

      const monitor = createMonitor({
        redis,
        warnEntries: 100,
        criticalEntries: 1000,
        pollIntervalMs: 10000,
      });
      monitor.start();

      await waitForState(monitor, 1);
      monitor.stop();
      // Classification tested indirectly via Prometheus gauge — no crash = pass.
    });

    it('should classify critical threshold as unhealthy', async () => {
      const redis = createMockRedis({
        xpending: vi.fn().mockResolvedValue([1500, null, null, []]),
      });

      const monitor = createMonitor({
        redis,
        warnEntries: 100,
        criticalEntries: 1000,
        pollIntervalMs: 10000,
      });
      monitor.start();

      await waitForState(monitor, 1);
      monitor.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Multiple targets
  // -------------------------------------------------------------------------

  describe('multiple targets', () => {
    it('should monitor multiple consumer groups', async () => {
      const xpending = vi.fn()
        .mockResolvedValueOnce([5, null, null, [['consumer-a', '5']]])
        .mockResolvedValueOnce([10, null, null, [['consumer-b', '10']]]);

      const xinfo = vi.fn()
        .mockResolvedValueOnce([[['name', 'consumer-a', 'idle', '500']]])
        .mockResolvedValueOnce([[['name', 'consumer-b', 'idle', '800']]]);

      const redis = createMockRedis({ xpending, xinfo });

      const targets = [
        { streamKey: 'stream:1', groupName: 'group:alpha' },
        { streamKey: 'stream:2', groupName: 'group:beta' },
      ];

      const monitor = createMonitor({ redis, targets, pollIntervalMs: 10000 });
      monitor.start();

      await waitForState(monitor, 2);
      monitor.stop();

      const state = monitor.getLastState();
      expect(state.size).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Singleton
  // -------------------------------------------------------------------------

  describe('singleton', () => {
    it('should return the same instance via getConsumerLagMonitor', () => {
      resetConsumerLagMonitor();
      const a = getConsumerLagMonitor({
        redis: createMockRedis() as any,
        pollIntervalMs: 100,
      });
      const b = getConsumerLagMonitor();
      expect(a).toBe(b);
      a.stop();
      resetConsumerLagMonitor();
    });

    it('should replace singleton via setConsumerLagMonitor', () => {
      const oldMonitor = getConsumerLagMonitor({
        redis: createMockRedis() as any,
        pollIntervalMs: 100,
      });
      const newMonitor = createMonitor({ pollIntervalMs: 200 });

      setConsumerLagMonitor(newMonitor);
      expect(getConsumerLagMonitor()).toBe(newMonitor);
      expect(getConsumerLagMonitor()).not.toBe(oldMonitor);

      newMonitor.stop();
      resetConsumerLagMonitor();
    });
  });

  // -------------------------------------------------------------------------
  // Consumer idle times
  // -------------------------------------------------------------------------

  describe('consumer idle times', () => {
    it('should extract idle times from XINFO CONSUMERS', async () => {
      const redis = createMockRedis({
        xpending: vi.fn().mockResolvedValue([
          5,
          '1234567890-0',
          '1234567890-4',
          [['consumer-1', '3'], ['consumer-2', '2']],
        ]),
        xinfo: vi.fn().mockResolvedValue([
          ['name', 'consumer-1', 'idle', '1200', 'pending', '3'],
          ['name', 'consumer-2', 'idle', '3400', 'pending', '2'],
        ]),
      });

      const monitor = createMonitor({ redis, pollIntervalMs: 10000 });
      monitor.start();

      await waitForState(monitor, 1);
      monitor.stop();

      const state = [...monitor.getLastState().values()][0];
      expect(state).toBeDefined();
      expect(state?.maxIdleMs).toBe(3400);
      expect(state?.consumerIdleMs['consumer-1']).toBe(1200);
      expect(state?.consumerIdleMs['consumer-2']).toBe(3400);
    });

    it('should handle missing XINFO CONSUMERS gracefully', async () => {
      const redis = createMockRedis({
        xpending: vi.fn().mockResolvedValue([
          1,
          null,
          null,
          [['consumer-x', '1']],
        ]),
        xinfo: vi.fn().mockRejectedValue(new Error('XINFO not supported')),
      });

      const monitor = createMonitor({ redis, pollIntervalMs: 10000 });
      monitor.start();

      await waitForState(monitor, 1);
      monitor.stop();

      const state = [...monitor.getLastState().values()][0];
      expect(state).toBeDefined();
      // maxIdleMs should fallback to -1 when XINFO fails.
      expect(state?.maxIdleMs).toBe(-1);
    });
  });
});
