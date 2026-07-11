'use client';

import { useRef, useEffect, useCallback, useState } from 'react';
import { useTheme } from '@/components/providers/ThemeProvider';
import { FrameBudgetMonitor, decimationStride, type FrameBudgetReport } from '@/utils/frameBudget';
import { useRenderLoop } from '@/hooks/useRenderLoop';

interface MetricsFrame {
  timestamp: number;
  values: Record<string, number>;
}

interface LiveMetricsCanvasProps {
  stream: MetricsFrame[];
  metrics: string[];
  height?: number;
}

const RING_CAPACITY = 10_000;
const FULL_REDRAW_MS = 500;
const RATE_WARN_THRESHOLD = 3000;
/**
 * Hard ceiling on points plotted per metric per frame. Drawing more points
 * than there are horizontal pixels is wasted work the rasteriser collapses
 * anyway; the loop additionally caps by canvas width and halves this under
 * budget pressure (see FrameBudgetMonitor). This is the real fix for the
 * frame-budget overruns issue #72 is concerned with.
 */
const MAX_POINTS_PER_METRIC = 2_000;

export function LiveMetricsCanvas({ stream, metrics, height = 300 }: LiveMetricsCanvasProps) {
  const { chartPalette, prefersReducedMotion } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ringRef = useRef<MetricsFrame[]>(new Array(RING_CAPACITY));
  const headRef = useRef(0);
  const countRef = useRef(0);
  const lastFullRedraw = useRef(0);
  const lastDrawnHead = useRef(0);
  const msgTimestamps = useRef<number[]>([]);
  const rangeCache = useRef<Map<string, { min: number; max: number }>>(new Map());
  const isPageVisible = useRef(true);
  const [memoryInfo, setMemoryInfo] = useState<string | null>(null);
  const [frameStats, setFrameStats] = useState<FrameBudgetReport | null>(null);

  // Per-instance frame-budget monitor. Lazily created so it survives re-renders
  // without re-instantiating each time.
  const monitorRef = useRef<FrameBudgetMonitor | null>(null);
  if (monitorRef.current === null) {
    monitorRef.current = new FrameBudgetMonitor();
  }

  // Visibility change handler: pause/resume rAF loop
  useEffect(() => {
    const handleVisibilityChange = () => {
      isPageVisible.current = document.visibilityState === 'visible';
      if (isPageVisible.current) {
        lastFullRedraw.current = 0; // Force full redraw on resume
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // Dev-mode memory measurement
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;

    const measure = async () => {
      try {
        const perf = performance as Performance & {
          measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
        };
        if (typeof perf.measureUserAgentSpecificMemory === 'function') {
          const result = await perf.measureUserAgentSpecificMemory();
          const usedMB = ((result.bytes ?? 0) / 1_048_576).toFixed(2);
          setMemoryInfo(`LiveMetricsCanvas memory: ${usedMB} MB`);
        }
      } catch {
        // Not available in all browsers
      }
    };

    const interval = setInterval(measure, 30_000);
    measure();

    return () => clearInterval(interval);
  }, []);

  // Dev-mode frame-budget readout: surface p95 draw time and dropped frames so
  // regressions in the render loop are visible without DevTools.
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    const interval = setInterval(() => {
      setFrameStats(monitorRef.current?.report() ?? null);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const points = stream;
    const ring = ringRef.current;
    const head = headRef.current;
    const count = countRef.current;

    for (let i = 0; i < points.length; i++) {
      const point = points[i] as MetricsFrame;
      const idx = (head + count + i) % RING_CAPACITY;
      ring[idx] = point;
    }
    const newCount = Math.min(count + points.length, RING_CAPACITY);
    const newHead =
      newCount < RING_CAPACITY
        ? headRef.current
        : (headRef.current + points.length) % RING_CAPACITY;
    headRef.current = newHead;
    countRef.current = newCount;

    const now = performance.now();
    msgTimestamps.current.push(now);
    const cutoff = now - 1000;
    msgTimestamps.current = msgTimestamps.current.filter((t) => t > cutoff);
    if (msgTimestamps.current.length > RATE_WARN_THRESHOLD) {
      console.warn(
        `[LiveMetricsCanvas] High incoming rate: ${msgTimestamps.current.length} msg/s. Consider scaling horizontally.`,
      );
    }
  }, [stream]);

  const computeRange = useCallback((metric: string): { min: number; max: number } => {
    const cached = rangeCache.current.get(metric);
    if (cached) return cached;

    const ring = ringRef.current;
    const head = headRef.current;
    const count = countRef.current;
    let min = Infinity;
    let max = -Infinity;
    let found = false;

    for (let i = 0; i < count; i++) {
      const idx = (head + i) % RING_CAPACITY;
      const frame = ring[idx] as MetricsFrame;
      const v = frame.values[metric];
      if (v === undefined) continue;
      found = true;
      if (v < min) min = v;
      if (v > max) max = v;
    }

    const result = found ? { min, max } : { min: 0, max: 1 };
    rangeCache.current.set(metric, result);
    return result;
  }, []);

  const drawFrame = useCallback(
    (now: number) => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;

      const rect = container.getBoundingClientRect();

      // Viewport culling: skip drawing if container is entirely off-screen
      const isOffscreen =
        rect.bottom < 0 ||
        rect.top > (window.innerHeight || document.documentElement.clientHeight) ||
        rect.right < 0 ||
        rect.left > (window.innerWidth || document.documentElement.clientWidth);

      if (isOffscreen) return;

      const dpr = window.devicePixelRatio || 1;
      const w = rect.width;
      const h = height;

      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(dpr, dpr);

      const ring = ringRef.current;
      const head = headRef.current;
      const count = countRef.current;
      if (count < 2) return;

      const monitor = monitorRef.current;
      monitor?.beginFrame(now);

      // Budget-adaptive work shedding: when our recent draw cost is eating too
      // much of the frame, full redraws are deferred and points are decimated
      // harder so the loop stays within budget instead of compounding jank.
      const underPressure = monitor?.isUnderPressure() ?? false;
      const fullRedrawInterval = underPressure ? FULL_REDRAW_MS * 2 : FULL_REDRAW_MS;
      const fullRedraw = now - lastFullRedraw.current >= fullRedrawInterval;
      const padding = 10;

      // Never plot more points than there are horizontal pixels (the line
      // rasteriser collapses them anyway), and halve that again under pressure.
      const widthCap = Math.max(50, Math.floor(w));
      const maxPoints = underPressure
        ? Math.max(50, Math.floor(Math.min(MAX_POINTS_PER_METRIC, widthCap) / 2))
        : Math.min(MAX_POINTS_PER_METRIC, widthCap);

      ctx.clearRect(0, 0, w, h);

      // Use the theme-aware chart palette instead of hardcoded COLORS
      const colors =
        chartPalette.length >= metrics.length
          ? chartPalette
          : ['#5ec962', '#fca50a', '#21918c', '#932667', '#fcffa4'];

      const xOf = (i: number) => padding + (i / (count - 1)) * (w - 2 * padding);

      metrics.forEach((metric, idx) => {
        const color = colors[idx % colors.length] ?? '#ffffff';
        const { min, max } = computeRange(metric);
        const rng = max - min || 1;
        const yOf = (v: number) => h - padding - ((v - min) / rng) * (h - 2 * padding);

        let startIdx = 0;
        if (!fullRedraw && lastDrawnHead.current > 0) {
          startIdx = Math.max(0, lastDrawnHead.current - 1);
        }

        const stride = decimationStride(count - startIdx, maxPoints);

        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        let first = true;
        let lastPlotted = -1;

        for (let i = startIdx; i < count; i += stride) {
          const ringIdx = (head + i) % RING_CAPACITY;
          const frame = ring[ringIdx] as MetricsFrame;
          const v = frame.values[metric];
          if (v === undefined) continue;

          const x = xOf(i);
          const y = yOf(v);

          if (first) {
            ctx.moveTo(x, y);
            first = false;
          } else {
            ctx.lineTo(x, y);
          }
          lastPlotted = i;
        }

        // Decimation can step over the most recent sample; always anchor the
        // line to it so the chart reaches "now" regardless of stride.
        if (lastPlotted !== count - 1) {
          const ringIdx = (head + count - 1) % RING_CAPACITY;
          const frame = ring[ringIdx] as MetricsFrame;
          const v = frame.values[metric];
          if (v !== undefined) {
            const x = xOf(count - 1);
            const y = yOf(v);
            if (first) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
        }

        ctx.stroke();
      });

      if (fullRedraw) {
        lastFullRedraw.current = now;
        rangeCache.current.clear();
      }

      lastDrawnHead.current = head + count;

      monitor?.endFrame(performance.now());
    },
    [height, metrics, computeRange, chartPalette],
  );

  const isVisible = useCallback(() => isPageVisible.current, []);
  const handleResumeAfterHidden = useCallback(() => {
    // Tab was hidden long enough; force a full redraw on resume.
    lastFullRedraw.current = 0;
  }, []);

  useRenderLoop({
    draw: drawFrame,
    prefersReducedMotion,
    isVisible,
    onResumeAfterHidden: handleResumeAfterHidden,
  });

  return (
    <div ref={containerRef} className="relative w-full">
      <canvas ref={canvasRef} className="block w-full" aria-label="Live metrics canvas" />
      {(memoryInfo || frameStats) && (
        <div className="absolute bottom-1 right-2 rounded bg-black/70 px-2 py-0.5 text-[10px] text-gray-400 font-mono">
          {memoryInfo}
          {frameStats && frameStats.sampleCount > 0 && (
            <span className={memoryInfo ? 'ml-2' : ''}>
              p95 {frameStats.p95.toFixed(1)}ms · dropped {frameStats.droppedFrames}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
