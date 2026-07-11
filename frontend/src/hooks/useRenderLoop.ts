'use client';

import { useEffect, useRef } from 'react';

/**
 * useRenderLoop
 * ─────────────
 * Shared canvas render-loop boilerplate, extracted from LiveMetricsCanvas and
 * TelemetryChart (which had byte-identical loops). It is NOT a bug fix — both
 * loops already correctly read their data from refs and re-subscribe when their
 * `draw` callback changes — it just removes the duplication.
 *
 * Behaviour preserved exactly:
 *  - drives `draw(now)` via requestAnimationFrame while visible;
 *  - when hidden, keeps the rAF alive but skips drawing (no wasted work);
 *  - if the tab was hidden long enough that a frame gap exceeds the threshold,
 *    invokes `onResumeAfterHidden` once before drawing (used to force a full
 *    redraw on resume);
 *  - under `prefers-reduced-motion`, falls back to a slow setInterval instead
 *    of rAF;
 *  - cancels the loop on cleanup.
 *
 * `draw`, `isVisible` and `onResumeAfterHidden` must be stable (memoized) — the
 * loop re-subscribes whenever they change, mirroring the original effect deps.
 */
export interface UseRenderLoopOptions {
  /** Render one frame. Receives the frame timestamp (rAF arg / performance.now). */
  draw: (now: number) => void;
  /** When true, use a slow interval instead of rAF. */
  prefersReducedMotion: boolean;
  /** Whether the surface is currently visible; checked each frame. */
  isVisible: () => boolean;
  /** Called once when resuming after a gap longer than the hidden threshold. */
  onResumeAfterHidden?: () => void;
  /** Interval used in reduced-motion mode. Default 250ms. */
  reducedMotionIntervalMs?: number;
  /** Frame-gap (ms) beyond which a resume is considered "after hidden". Default 5000. */
  hiddenResumeThresholdMs?: number;
}

export function useRenderLoop({
  draw,
  prefersReducedMotion,
  isVisible,
  onResumeAfterHidden,
  reducedMotionIntervalMs = 250,
  hiddenResumeThresholdMs = 5000,
}: UseRenderLoopOptions): void {
  const rafRef = useRef(0);
  const lastFrameTime = useRef(0);

  useEffect(() => {
    let running = true;

    const tick = (now: number) => {
      if (lastFrameTime.current > 0 && now - lastFrameTime.current > hiddenResumeThresholdMs) {
        onResumeAfterHidden?.();
      }
      lastFrameTime.current = now;
      draw(now);
    };

    const loop = (now: number) => {
      if (!running) return;
      if (!isVisible()) {
        // Hidden: keep looping but skip drawing to avoid wasted renders.
        rafRef.current = requestAnimationFrame(loop);
        return;
      }
      tick(now);
      rafRef.current = requestAnimationFrame(loop);
    };

    if (prefersReducedMotion) {
      const intervalId = setInterval(() => {
        if (!running) return;
        if (!isVisible()) return;
        tick(performance.now());
      }, reducedMotionIntervalMs);
      return () => {
        running = false;
        clearInterval(intervalId);
      };
    }

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [
    draw,
    prefersReducedMotion,
    isVisible,
    onResumeAfterHidden,
    reducedMotionIntervalMs,
    hiddenResumeThresholdMs,
  ]);
}
