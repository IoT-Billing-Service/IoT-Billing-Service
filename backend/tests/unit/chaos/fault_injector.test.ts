/**
 * Unit tests for FaultInjector.
 *
 * These tests run entirely in-process with no infrastructure dependencies.
 * Every test sets `CHAOS_ENABLED=true` in its setup and restores the env
 * value afterwards.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  activateFault,
  clearAllFaults,
  getActiveFaults,
  isFaultActive,
  getActiveLatencyMs,
  getCorruptionRate,
  isBlockingFaultActive,
} from '../../../src/chaos/fault_injector.js';

// ---------------------------------------------------------------------------
// Env setup
// ---------------------------------------------------------------------------

const originalEnv = process.env['CHAOS_ENABLED'];

beforeEach(() => {
  process.env['CHAOS_ENABLED'] = 'true';
  clearAllFaults();
});

afterEach(() => {
  clearAllFaults();
  if (originalEnv === undefined) {
    delete process.env['CHAOS_ENABLED'];
  } else {
    process.env['CHAOS_ENABLED'] = originalEnv;
  }
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Guard tests
// ---------------------------------------------------------------------------

describe('CHAOS_ENABLED guard', () => {
  it('throws when CHAOS_ENABLED is not set', () => {
    delete process.env['CHAOS_ENABLED'];
    expect(() =>
      activateFault({ type: 'network_latency', durationMs: 100, params: { addedLatencyMs: 50 } }),
    ).toThrow('CHAOS_ENABLED');
  });

  it('throws when CHAOS_ENABLED is "false"', () => {
    process.env['CHAOS_ENABLED'] = 'false';
    expect(() =>
      activateFault({ type: 'network_latency', durationMs: 100, params: { addedLatencyMs: 50 } }),
    ).toThrow('CHAOS_ENABLED');
  });
});

// ---------------------------------------------------------------------------
// Activation and deactivation
// ---------------------------------------------------------------------------

describe('activateFault / clearAllFaults', () => {
  it('marks a fault as active immediately after activation', () => {
    activateFault({ type: 'network_latency', durationMs: 5_000, params: { addedLatencyMs: 100 } });
    expect(isFaultActive('network_latency')).toBe(true);
  });

  it('stop() deactivates the fault before natural expiry', () => {
    const handle = activateFault({
      type: 'redis_latency',
      durationMs: 10_000,
      params: { delayMs: 200 },
    });
    expect(isFaultActive('redis_latency')).toBe(true);
    handle.stop();
    expect(isFaultActive('redis_latency')).toBe(false);
  });

  it('stop() resolves the expired promise', async () => {
    const handle = activateFault({
      type: 'db_slow_query',
      durationMs: 10_000,
      params: { delayMs: 50 },
    });
    const resolved = handle.expired.then(() => true);
    handle.stop();
    expect(await resolved).toBe(true);
  });

  it('clearAllFaults() removes all active faults', () => {
    activateFault({ type: 'network_latency', durationMs: 9_000, params: { addedLatencyMs: 10 } });
    activateFault({ type: 'redis_latency', durationMs: 9_000, params: { delayMs: 20 } });
    expect(getActiveFaults()).toHaveLength(2);
    clearAllFaults();
    expect(getActiveFaults()).toHaveLength(0);
  });

  it('activating the same fault type twice replaces the first', () => {
    activateFault({ type: 'network_latency', durationMs: 9_000, params: { addedLatencyMs: 10 } });
    activateFault({ type: 'network_latency', durationMs: 9_000, params: { addedLatencyMs: 50 } });
    expect(getActiveFaults()).toHaveLength(1);
    expect(getActiveLatencyMs('network_latency')).toBe(50);
  });

  it('getActiveFaults() returns a snapshot, not a live reference', () => {
    activateFault({ type: 'network_latency', durationMs: 9_000, params: { addedLatencyMs: 5 } });
    const snap1 = getActiveFaults();
    activateFault({ type: 'redis_latency', durationMs: 9_000, params: { delayMs: 5 } });
    const snap2 = getActiveFaults();
    expect(snap1).toHaveLength(1);
    expect(snap2).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Latency helpers
// ---------------------------------------------------------------------------

describe('getActiveLatencyMs', () => {
  it('returns 0 when no fault is active', () => {
    expect(getActiveLatencyMs('network_latency')).toBe(0);
    expect(getActiveLatencyMs('db_slow_query')).toBe(0);
    expect(getActiveLatencyMs('redis_latency')).toBe(0);
    expect(getActiveLatencyMs('billing_compute_delay')).toBe(0);
  });

  it('returns addedLatencyMs for network_latency fault', () => {
    activateFault({ type: 'network_latency', durationMs: 9_000, params: { addedLatencyMs: 123 } });
    expect(getActiveLatencyMs('network_latency')).toBe(123);
  });

  it('returns delayMs for db_slow_query fault', () => {
    activateFault({ type: 'db_slow_query', durationMs: 9_000, params: { delayMs: 77 } });
    expect(getActiveLatencyMs('db_slow_query')).toBe(77);
  });

  it('returns delayMs for billing_compute_delay fault', () => {
    activateFault({ type: 'billing_compute_delay', durationMs: 9_000, params: { delayMs: 45 } });
    expect(getActiveLatencyMs('billing_compute_delay')).toBe(45);
  });
});

// ---------------------------------------------------------------------------
// Blocking fault helpers
// ---------------------------------------------------------------------------

describe('isBlockingFaultActive', () => {
  it('returns false when neither blocking fault is active', () => {
    expect(isBlockingFaultActive('network_partition')).toBe(false);
    expect(isBlockingFaultActive('redis_unavailable')).toBe(false);
  });

  it('returns true for network_partition when active', () => {
    activateFault({ type: 'network_partition', durationMs: 9_000, params: {} });
    expect(isBlockingFaultActive('network_partition')).toBe(true);
  });

  it('returns true for redis_unavailable when active', () => {
    activateFault({ type: 'redis_unavailable', durationMs: 9_000, params: {} });
    expect(isBlockingFaultActive('redis_unavailable')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Corruption rate helper
// ---------------------------------------------------------------------------

describe('getCorruptionRate', () => {
  it('returns 0 when no payload_corruption fault is active', () => {
    expect(getCorruptionRate()).toBe(0);
  });

  it('returns the configured rate when fault is active', () => {
    activateFault({
      type: 'payload_corruption',
      durationMs: 9_000,
      params: { corruptionRate: 0.15 },
    });
    expect(getCorruptionRate()).toBeCloseTo(0.15);
  });

  it('clamps rate to [0, 1]', () => {
    activateFault({
      type: 'payload_corruption',
      durationMs: 9_000,
      params: { corruptionRate: 5 },
    });
    expect(getCorruptionRate()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Natural expiry (uses fake timers)
// ---------------------------------------------------------------------------

describe('natural fault expiry', () => {
  it('fault deactivates after durationMs elapses', async () => {
    vi.useFakeTimers();
    activateFault({ type: 'process_cpu_spike', durationMs: 500, params: {} });
    expect(isFaultActive('process_cpu_spike')).toBe(true);
    vi.advanceTimersByTime(600);
    // Allow the microtask queue to drain so the timer callback fires.
    await Promise.resolve();
    expect(isFaultActive('process_cpu_spike')).toBe(false);
  });
});
