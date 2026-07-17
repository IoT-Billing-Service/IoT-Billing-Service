/**
 * FaultInjector — low-level fault activation primitives.
 *
 * Each method activates a specific fault for a bounded duration and
 * returns a `stop()` handle so the caller can clear the fault early or
 * wait for it to self-expire.
 *
 * All faults are scoped to the current process and are never persisted to
 * a database or external service. They are safe to activate in staging and
 * have zero effect in production builds where `CHAOS_ENABLED !== 'true'`.
 */

import type { FaultConfig } from './types.js';

// ---------------------------------------------------------------------------
// Guard — honour the kill-switch so faults can never fire in production
// ---------------------------------------------------------------------------

function assertChaosEnabled(): void {
  if (process.env['CHAOS_ENABLED'] !== 'true') {
    throw new Error(
      'FaultInjector: CHAOS_ENABLED is not set to "true". ' +
        'Chaos experiments must only run in staging.',
    );
  }
}

// ---------------------------------------------------------------------------
// Shared state — a simple in-process flag map
// ---------------------------------------------------------------------------

interface ActiveFault {
  config: FaultConfig;
  activatedAt: number;
  /** Cancels the self-expiry timer. */
  cancel: () => void;
}

const _active = new Map<string, ActiveFault>();

/** Unique key for a fault slot. Only one fault of each type is active at a time. */
function slotKey(config: FaultConfig): string {
  return config.type;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface FaultHandle {
  /** Deactivate the fault immediately (before its natural expiry). */
  stop(): void;
  /** Resolves when the fault expires (naturally or via stop()). */
  expired: Promise<void>;
}

/**
 * Activate a fault described by `config`. If a fault of the same type is
 * already active it is stopped first before the new one starts.
 *
 * Returns a {@link FaultHandle} with `stop()` and an `expired` promise.
 */
export function activateFault(config: FaultConfig): FaultHandle {
  assertChaosEnabled();
  const key = slotKey(config);

  // Stop any existing fault in this slot.
  _active.get(key)?.cancel();

  let resolve!: () => void;
  const expired = new Promise<void>((res) => {
    resolve = res;
  });

  const timer = setTimeout(() => {
    _active.delete(key);
    resolve();
  }, config.durationMs);
  // Don't block process exit.
  (timer as unknown as { unref?: () => void }).unref?.();

  const cancel = (): void => {
    clearTimeout(timer);
    _active.delete(key);
    resolve();
  };

  _active.set(key, { config, activatedAt: Date.now(), cancel });

  return { stop: cancel, expired };
}

/** Deactivate all active faults immediately. */
export function clearAllFaults(): void {
  for (const fault of _active.values()) {
    fault.cancel();
  }
  _active.clear();
}

/** Returns a snapshot of currently active faults (for metrics / assertions). */
export function getActiveFaults(): FaultConfig[] {
  return Array.from(_active.values()).map((f) => f.config);
}

/** Returns true if a fault of `type` is currently active. */
export function isFaultActive(type: FaultConfig['type']): boolean {
  return _active.has(type);
}

// ---------------------------------------------------------------------------
// Fault-specific effect helpers — called by the wrappers below
// ---------------------------------------------------------------------------

/**
 * Returns the addedLatencyMs for an active `network_latency` or `db_slow_query`
 * or `redis_latency` or `billing_compute_delay` fault, or 0.
 */
export function getActiveLatencyMs(
  type:
    | 'network_latency'
    | 'db_slow_query'
    | 'redis_latency'
    | 'billing_compute_delay',
): number {
  const fault = _active.get(type);
  if (fault === undefined) return 0;
  const ms = fault.config.params['addedLatencyMs']
    ?? fault.config.params['delayMs'];
  return typeof ms === 'number' ? ms : 0;
}

/** Returns true if an active `network_partition` or `redis_unavailable` fault is live. */
export function isBlockingFaultActive(
  type: 'network_partition' | 'redis_unavailable',
): boolean {
  return _active.has(type);
}

/**
 * Returns the corruption rate (0–1) for an active `payload_corruption` fault.
 * Returns 0 if the fault is not active.
 */
export function getCorruptionRate(): number {
  const fault = _active.get('payload_corruption');
  if (fault === undefined) return 0;
  const rate = fault.config.params['corruptionRate'];
  return typeof rate === 'number' ? Math.min(1, Math.max(0, rate)) : 0;
}

// ---------------------------------------------------------------------------
// CPU spike helper — blocks the event loop for durationMs
// ---------------------------------------------------------------------------

/**
 * Busy-loop the current thread for `durationMs` milliseconds, simulating
 * a CPU spike. Intentionally synchronous — that is the whole point of the
 * fault.
 */
export function blockEventLoopFor(durationMs: number): void {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    // spin
  }
}

// ---------------------------------------------------------------------------
// Instrumented sleep — adds configured latency on top of the requested delay
// ---------------------------------------------------------------------------

/**
 * Sleep for `ms` milliseconds plus any active `network_latency` addedLatencyMs.
 * Use this in place of raw `setTimeout` for outbound network calls.
 */
export async function instrumentedSleep(ms: number): Promise<void> {
  const extra = getActiveLatencyMs('network_latency');
  await new Promise<void>((resolve) => setTimeout(resolve, ms + extra));
}
