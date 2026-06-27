'use client';

import { useEffect, useRef } from 'react';

// ─── Public types ────────────────────────────────────────────────────────────

export type DeviceStatusValue = 'active' | 'idle' | 'alert' | 'offline';

/**
 * A single status update emitted by the stream. `eventSeq` is a
 * monotonically-increasing counter scoped per `deviceId`.  The sprite renderer
 * must discard any update whose `eventSeq` is not greater than the last applied
 * sequence for that device.
 */
export interface DeviceStatusUpdate {
  deviceId: string;
  status: DeviceStatusValue;
  /** Monotonic counter; always increments per device. */
  eventSeq: number;
  /** Wall-clock ms at the moment the event was created server-side. */
  timestamp: number;
}

export type DeviceStatusHandler = (updates: DeviceStatusUpdate[]) => void;

// ─── Internal ────────────────────────────────────────────────────────────────

/** How long (ms) to buffer rapid-fire updates before flushing the latest. */
const DEBOUNCE_MS = 100;

const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

function streamUrl(): string {
  const url = new URL('/api/device-status/stream', window.location.href);
  return url.toString().replace(/^http/, 'ws');
}

/**
 * useDeviceStatusStream
 * ─────────────────────
 * Opens a WebSocket that delivers `DeviceStatusUpdate` objects. Applies two
 * race-condition mitigations before forwarding to `handler`:
 *
 * 1. **Per-device debounce (100ms):** bursts of updates for the same device
 *    are buffered; only the last update in each 100ms window is kept.
 *    Transient spikes that resolve within the window are never surfaced.
 *
 * 2. **Monotonic sequence guard:** each update carries `eventSeq`.  The buffer
 *    only retains an incoming update when its `eventSeq` is strictly greater
 *    than the sequence already buffered for that device, so out-of-order network
 *    delivery cannot overwrite a newer event with a stale one.
 *
 * The handler is called with a batch (one entry per device that changed) at
 * the end of each debounce window.  The sprite renderer must still apply its
 * own `eventSeq` guard (see `spriteManager.ts`) as a second line of defence.
 */
export function useDeviceStatusStream(handler: DeviceStatusHandler): void {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    // Per-device debounce buffer: deviceId → latest update seen in this window.
    const debounceBuffer = new Map<string, DeviceStatusUpdate>();
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const flushDebounce = () => {
      debounceTimer = null;
      if (debounceBuffer.size === 0) return;
      const updates = Array.from(debounceBuffer.values());
      debounceBuffer.clear();
      handlerRef.current(updates);
    };

    /**
     * Enqueue an incoming update.  We keep only the highest-sequence update
     * per device within the current debounce window.  The timer is (re)started
     * only when we actually store something, so a burst of 5 updates within
     * 100ms produces exactly one flush with the latest state.
     */
    const enqueue = (update: DeviceStatusUpdate) => {
      const existing = debounceBuffer.get(update.deviceId);
      if (existing && existing.eventSeq >= update.eventSeq) {
        // Stale or duplicate — discard.
        return;
      }
      debounceBuffer.set(update.deviceId, update);

      if (debounceTimer === null) {
        debounceTimer = setTimeout(flushDebounce, DEBOUNCE_MS);
      }
    };

    const connect = async (attempt: number) => {
      if (cancelled) return;
      ws = new WebSocket(streamUrl());

      ws.onopen = () => {
        reconnectAttempt = 0;
      };

      ws.onmessage = (event: MessageEvent) => {
        try {
          const update = JSON.parse(event.data as string) as DeviceStatusUpdate;
          if (
            typeof update.deviceId === 'string' &&
            typeof update.status === 'string' &&
            typeof update.eventSeq === 'number' &&
            typeof update.timestamp === 'number'
          ) {
            enqueue(update);
          }
        } catch {
          // Ignore malformed frames.
        }
      };

      ws.onerror = () => {
        // Non-fatal; the close event drives reconnect.
      };

      ws.onclose = () => {
        if (cancelled) return;
        const delayMs =
          RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)] ?? 16_000;
        reconnectTimer = setTimeout(() => {
          void connect(attempt + 1);
        }, delayMs);
      };
    };

    void connect(reconnectAttempt);

    return () => {
      cancelled = true;
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        // Flush anything still buffered so no update is silently lost on unmount.
        flushDebounce();
      }
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, []);
}
