'use client';

import { useRef, useEffect, useCallback } from 'react';
import { useRenderLoop } from '@/hooks/useRenderLoop';
import { useDeviceStatusStream, type DeviceStatusUpdate } from '@/hooks/useDeviceStatusStream';
import { SpriteManager } from './spriteManager';

// ─── Constants & Types ───────────────────────────────────────────────────────

/** Width of a single sprite frame in the sheet (px). */
const SPRITE_FRAME_WIDTH = 32;
/** Height of a single sprite in the sheet (px). */
const SPRITE_HEIGHT = 32;

/**
 * Mock device structure returned by a hypothetical device-list API.
 * In production this would come from a context or dedicated hook.
 */
export interface MapDevice {
  deviceId: string;
  /** Lat/lon for placement on the map canvas. */
  location: { lat: number; lng: number };
}

interface DeviceMapCanvasProps {
  /** List of devices to render; typically from `useDevices()` or context. */
  devices?: MapDevice[];
  /** Path to the sprite sheet PNG (4 frames: active, idle, alert, offline). */
  spriteSrc?: string;
  /** Canvas width in CSS pixels. */
  width?: number;
  /** Canvas height in CSS pixels. */
  height?: number;
  /** When true, uses a slow interval instead of rAF. */
  prefersReducedMotion?: boolean;
}

// ─── DeviceMapCanvas ─────────────────────────────────────────────────────────

/**
 * DeviceMapCanvas
 * ───────────────
 * Renders a 2D map of device status icons using sprite-sheet animation.
 * The status icon for each device is driven by `useDeviceStatusStream`.
 *
 * Key features:
 *  - Monotonic event sequence guard: `updateDeviceSprite` at line 95 applies
 *    the `eventSeq` check from SpriteManager, so late or out-of-order updates
 *    are discarded before they reach the canvas.
 *  - 100ms debounce upstream: `useDeviceStatusStream` buffers rapid-fire state
 *    changes for the same device, so transient spikes that resolve within 100ms
 *    are never visible.
 *  - Transition validation: `SpriteManager.applyUpdate()` rejects nonsensical
 *    state moves even if the sequence number is newer (guards protocol bugs).
 *
 * The canvas is driven by `useRenderLoop`, which handles visibility-aware
 * refresh and reduced-motion fallback.
 */
export default function DeviceMapCanvas({
  devices = [],
  spriteSrc = '/icons/device-sprite.png',
  width = 800,
  height = 600,
  prefersReducedMotion = false,
}: DeviceMapCanvasProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const spriteImageRef = useRef<HTMLImageElement | null>(null);
  const spriteManagerRef = useRef<SpriteManager>(new SpriteManager());
  const deviceMapRef = useRef<Map<string, MapDevice>>(new Map());

  // ── Sprite image loading ─────────────────────────────────────────────────
  useEffect(() => {
    const img = new Image();
    img.src = spriteSrc;
    img.onload = () => {
      spriteImageRef.current = img;
    };
    return () => {
      spriteImageRef.current = null;
    };
  }, [spriteSrc]);

  // ── Device map & sprite initialisation ──────────────────────────────────
  useEffect(() => {
    const map = new Map<string, MapDevice>();
    devices.forEach((d) => {
      map.set(d.deviceId, d);
      // Initialise each device as 'offline' (frame 3) until we receive an update.
      spriteManagerRef.current.initialise(d.deviceId, 'offline');
    });
    deviceMapRef.current = map;
  }, [devices]);

  // ── Status update handler (line 95 — the critical updateDeviceSprite) ───
  /**
   * updateDeviceSprite
   * ──────────────────
   * Applies a batch of status updates to the sprite manager.  Each
   * `applyUpdate` call checks `eventSeq` monotonicity and state-machine
   * validity before updating the internal sprite state.  Any stale or invalid
   * update is discarded with no side effect.
   *
   * Called by `useDeviceStatusStream` whenever a 100ms debounce window ends,
   * or on unmount flush.  This is the function referenced at "line 95" in the
   * issue — it is the top-level race-condition mitigation point for incoming
   * network events.
   */
  const updateDeviceSprite = useCallback((updates: DeviceStatusUpdate[]) => {
    const mgr = spriteManagerRef.current;
    for (const update of updates) {
      mgr.applyUpdate(update);
    }
  }, []);

  useDeviceStatusStream(updateDeviceSprite);

  // ── Canvas draw loop ─────────────────────────────────────────────────────
  const draw = useCallback(() => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      const spriteImg = spriteImageRef.current;
      if (!canvas || !ctx || !spriteImg) return;

      // Clear the canvas
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Rudimentary mercator-like projection (simplified for demo)
      const projectLat = (lat: number): number => {
        // Clamp to ±85°
        const clampedLat = Math.max(-85, Math.min(85, lat));
        // Map [-85..85] → [0..height]
        return ((85 - clampedLat) / 170) * canvas.height;
      };
      const projectLng = (lng: number): number => {
        // Map [-180..180] → [0..width]
        return ((lng + 180) / 360) * canvas.width;
      };

      // Draw each device's sprite
      const states = spriteManagerRef.current.getAllStates();
      for (const state of states) {
        const device = deviceMapRef.current.get(state.status);
        if (!device?.location) continue;

        const x = projectLng(device.location.lng) - SPRITE_FRAME_WIDTH / 2;
        const y = projectLat(device.location.lat) - SPRITE_HEIGHT / 2;

        ctx.drawImage(
          spriteImg,
          state.frameIndex * SPRITE_FRAME_WIDTH, // source X
          0, // source Y (single-row sprite sheet)
          SPRITE_FRAME_WIDTH,
          SPRITE_HEIGHT,
          x,
          y,
          SPRITE_FRAME_WIDTH,
          SPRITE_HEIGHT,
        );
      }
    },
    [],
  );

  const isVisible = useCallback(() => !document.hidden, []);

  const onResumeAfterHidden = useCallback(() => {
    // Force a full redraw after the tab regains visibility (optional).
  }, []);

  useRenderLoop({
    draw,
    prefersReducedMotion,
    isVisible,
    onResumeAfterHidden,
  });

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{ width, height, border: '1px solid #ccc' }}
      aria-label="Device status map"
    />
  );
}
