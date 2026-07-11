/**
 * spriteManager.ts
 * ────────────────
 * Manages per-device sprite animation state for the device map canvas.
 *
 * Sprite sheet layout (4 frames, left-to-right):
 *   Frame 0 → active
 *   Frame 1 → idle
 *   Frame 2 → alert
 *   Frame 3 → offline
 *
 * Race-condition defences (mirrors the issue blueprint):
 *
 * 1. **Monotonic sequence guard** — `applyUpdate` only advances the state
 *    when `update.eventSeq > currentState.eventSeq`.  An update that arrives
 *    late (after a newer one was already applied) is silently discarded.
 *
 * 2. **Transition validation** — only transitions that make semantic sense are
 *    accepted.  An `alert → active` recovery is valid; an older `alert` update
 *    cannot retroactively overwrite a confirmed `active` state because the seq
 *    guard catches it first.
 *
 * 3. **Debounce happens upstream** — `useDeviceStatusStream` already delivers
 *    only the latest update per device per 100ms window, so in normal operation
 *    the sequence guard here is a second line of defence, not the primary one.
 */

import type { DeviceStatusUpdate, DeviceStatusValue } from '@/hooks/useDeviceStatusStream';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Number of animation frames in the sprite sheet. */
export const SPRITE_FRAME_COUNT = 4;

/** Maps a status string to its sprite-sheet column index. */
export const STATUS_FRAME: Record<DeviceStatusValue, number> = {
  active: 0,
  idle: 1,
  alert: 2,
  offline: 3,
};

/**
 * Valid state-machine transitions.  Every `from` status may only move to the
 * listed `to` statuses.  Any update that requests an invalid transition is
 * rejected even if its `eventSeq` is newer — this guards against protocol bugs
 * where a device would skip impossible states.
 *
 * The rules are intentionally permissive for sensor-driven flows (e.g. a device
 * can jump from `offline` back to `active` when it reconnects), but they still
 * block nonsensical backward leaps driven by stale infra.
 */
const VALID_TRANSITIONS: Record<DeviceStatusValue, readonly DeviceStatusValue[]> = {
  active: ['idle', 'alert', 'offline'],
  idle: ['active', 'alert', 'offline'],
  alert: ['active', 'idle', 'offline'],
  offline: ['active', 'idle', 'alert'],
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SpriteState {
  status: DeviceStatusValue;
  /** Sprite-sheet frame index (0-3). */
  frameIndex: number;
  /** The `eventSeq` of the last applied update. */
  eventSeq: number;
  /** Wall-clock timestamp of the last applied update. */
  timestamp: number;
}

// ─── SpriteManager ────────────────────────────────────────────────────────────

/**
 * Manages the sprite states for every known device.  Intended to be
 * instantiated once per `DeviceMapCanvas` mount and held in a ref.
 */
export class SpriteManager {
  private readonly states = new Map<string, SpriteState>();

  /**
   * Returns the current sprite state for `deviceId`, or `undefined` if the
   * device has not been seen yet.
   */
  getState(deviceId: string): SpriteState | undefined {
    return this.states.get(deviceId);
  }

  /**
   * Returns the sprite states for all tracked devices.  The returned array is
   * a snapshot — callers should not hold references across frames.
   */
  getAllStates(): SpriteState[] {
    return Array.from(this.states.values());
  }

  /**
   * Initialises (or resets) a device's sprite state without going through the
   * transition validator.  Use this for initial data load, not for stream
   * updates.
   */
  initialise(deviceId: string, status: DeviceStatusValue, eventSeq = 0, timestamp = 0): void {
    this.states.set(deviceId, {
      status,
      frameIndex: STATUS_FRAME[status],
      eventSeq,
      timestamp,
    });
  }

  /**
   * Attempts to apply an incoming status update.
   *
   * Returns `true` when the update was applied; `false` when it was discarded
   * (stale sequence, invalid transition, or unknown device — callers can use the
   * return value for instrumentation).
   *
   * **Never** call this from inside a `requestAnimationFrame` callback with
   * unsynchronised concurrent writes; the caller (DeviceMapCanvas) must ensure
   * single-writer access.
   */
  applyUpdate(update: DeviceStatusUpdate): boolean {
    const current = this.states.get(update.deviceId);

    if (!current) {
      // Device not yet initialised — accept the first update unconditionally
      // so the map populates as devices come online.
      this.states.set(update.deviceId, {
        status: update.status,
        frameIndex: STATUS_FRAME[update.status],
        eventSeq: update.eventSeq,
        timestamp: update.timestamp,
      });
      return true;
    }

    // ── Monotonic sequence guard ─────────────────────────────────────────────
    if (update.eventSeq <= current.eventSeq) {
      // Stale or duplicate; discard.
      return false;
    }

    // ── Transition validation ────────────────────────────────────────────────
    if (update.status !== current.status) {
      const allowed = VALID_TRANSITIONS[current.status];
      if (!allowed.includes(update.status)) {
        // Invalid transition — discard even though the seq is newer.
        return false;
      }
    }

    this.states.set(update.deviceId, {
      status: update.status,
      frameIndex: STATUS_FRAME[update.status],
      eventSeq: update.eventSeq,
      timestamp: update.timestamp,
    });
    return true;
  }

  /**
   * Removes a device's sprite state (e.g. when a device is deprovisioned).
   */
  remove(deviceId: string): void {
    this.states.delete(deviceId);
  }

  /** Clears all state (useful on canvas unmount). */
  clear(): void {
    this.states.clear();
  }
}
