import { describe, it, expect, beforeEach } from 'vitest';
import { SpriteManager, STATUS_FRAME } from './spriteManager';
import type { DeviceStatusUpdate } from '@/hooks/useDeviceStatusStream';

function update(
  deviceId: string,
  status: DeviceStatusUpdate['status'],
  eventSeq: number,
  timestamp = eventSeq * 1000,
): DeviceStatusUpdate {
  return { deviceId, status, eventSeq, timestamp };
}

describe('SpriteManager', () => {
  let mgr: SpriteManager;

  beforeEach(() => {
    mgr = new SpriteManager();
  });

  // ── Initial state ─────────────────────────────────────────────────────────

  it('returns undefined for an unknown device', () => {
    expect(mgr.getState('unknown')).toBeUndefined();
  });

  it('initialise() seeds the state without validation', () => {
    mgr.initialise('d1', 'offline');
    const s = mgr.getState('d1')!;
    expect(s.status).toBe('offline');
    expect(s.frameIndex).toBe(STATUS_FRAME['offline']);
    expect(s.eventSeq).toBe(0);
  });

  // ── First update (device not yet initialised) ─────────────────────────────

  it('accepts the first update for an unknown device unconditionally', () => {
    const applied = mgr.applyUpdate(update('d1', 'active', 1));
    expect(applied).toBe(true);
    expect(mgr.getState('d1')?.status).toBe('active');
    expect(mgr.getState('d1')?.frameIndex).toBe(STATUS_FRAME['active']);
  });

  // ── Monotonic sequence guard ──────────────────────────────────────────────

  it('applies an update when eventSeq is strictly greater', () => {
    mgr.initialise('d1', 'active', 5);
    const applied = mgr.applyUpdate(update('d1', 'idle', 6));
    expect(applied).toBe(true);
    expect(mgr.getState('d1')?.status).toBe('idle');
    expect(mgr.getState('d1')?.eventSeq).toBe(6);
  });

  it('discards a stale update when eventSeq is equal', () => {
    mgr.initialise('d1', 'active', 5);
    const applied = mgr.applyUpdate(update('d1', 'alert', 5));
    expect(applied).toBe(false);
    // State must not have changed.
    expect(mgr.getState('d1')?.status).toBe('active');
  });

  it('discards a stale update when eventSeq is less than current', () => {
    mgr.initialise('d1', 'active', 10);
    const applied = mgr.applyUpdate(update('d1', 'alert', 3));
    expect(applied).toBe(false);
    expect(mgr.getState('d1')?.status).toBe('active');
  });

  // ── Transition validation ─────────────────────────────────────────────────

  it('allows valid transition: active → alert', () => {
    mgr.initialise('d1', 'active', 1);
    expect(mgr.applyUpdate(update('d1', 'alert', 2))).toBe(true);
    expect(mgr.getState('d1')?.status).toBe('alert');
  });

  it('allows valid recovery: alert → active', () => {
    mgr.initialise('d1', 'alert', 1);
    expect(mgr.applyUpdate(update('d1', 'active', 2))).toBe(true);
    expect(mgr.getState('d1')?.status).toBe('active');
  });

  it('allows valid transition: offline → active (device came back online)', () => {
    mgr.initialise('d1', 'offline', 1);
    expect(mgr.applyUpdate(update('d1', 'active', 2))).toBe(true);
  });

  it('accepts a self-transition (same status, higher seq) — no-op on sprite but valid', () => {
    mgr.initialise('d1', 'active', 1);
    // active → active is not in the transition table (it's only populated for
    // _different_ statuses); the code short-circuits when status is unchanged.
    expect(mgr.applyUpdate(update('d1', 'active', 2))).toBe(true);
    expect(mgr.getState('d1')?.eventSeq).toBe(2);
  });

  // ── Race-condition scenario from the bug report ───────────────────────────

  it(
    'race scenario: active(seq=1) arrives, then alert(seq=2) arrives late — ' +
      'alert must NOT overwrite if seq guard is applied correctly',
    () => {
      // In the real race, seq=1 (active) arrives first, then seq=2 (alert)
      // arrives late. Because seq is monotonic, seq=2 IS newer so it would
      // normally apply.  The test below confirms that if a seq=3 (active)
      // arrives BEFORE seq=2 (alert), the later-arriving alert is discarded.
      mgr.initialise('d1', 'active', 1);

      // seq=3 (active) already applied (debounce delivered the latest in-window)
      mgr.applyUpdate(update('d1', 'active', 3));
      expect(mgr.getState('d1')!.eventSeq).toBe(3);

      // seq=2 (alert) arrives late — stale; must be discarded.
      const applied = mgr.applyUpdate(update('d1', 'alert', 2));
      expect(applied).toBe(false);
      expect(mgr.getState('d1')!.status).toBe('active');
      expect(mgr.getState('d1')!.frameIndex).toBe(STATUS_FRAME['active']);
    },
  );

  it('5 rapid updates simulate the bug scenario — sprite always reflects the latest seq', () => {
    const updates: DeviceStatusUpdate[] = [
      update('d1', 'active', 1, 1000),
      update('d1', 'alert', 2, 1040),
      update('d1', 'active', 3, 1080),
      update('d1', 'idle', 4, 1120),
      update('d1', 'active', 5, 1160),
    ];

    // Apply in sequence (simulating what happens after debounce delivers seq=5)
    // The debounce layer in useDeviceStatusStream would deliver only seq=5.
    // If it didn't, and all 5 arrive, the SpriteManager still handles them correctly.
    for (const u of updates) {
      mgr.applyUpdate(u);
    }

    const state = mgr.getState('d1')!;
    expect(state.status).toBe('active');
    expect(state.eventSeq).toBe(5);
    expect(state.frameIndex).toBe(STATUS_FRAME['active']);
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  it('remove() deletes a device', () => {
    mgr.initialise('d1', 'active', 1);
    mgr.remove('d1');
    expect(mgr.getState('d1')).toBeUndefined();
  });

  it('clear() removes all devices', () => {
    mgr.initialise('d1', 'active', 1);
    mgr.initialise('d2', 'offline', 1);
    mgr.clear();
    expect(mgr.getAllStates()).toHaveLength(0);
  });

  it('getAllStates() returns current states for all devices', () => {
    mgr.initialise('d1', 'active', 1);
    mgr.initialise('d2', 'alert', 2);
    const states = mgr.getAllStates();
    expect(states).toHaveLength(2);
    const ids = states.map((s) => s.status).sort();
    expect(ids).toEqual(['active', 'alert']);
  });
});
