'use client';

import { useRef, useEffect, useCallback } from 'react';

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
const COLORS = ['#00ff88', '#ff8800', '#4488ff', '#ff4488', '#88ff44'];

export function LiveMetricsCanvas({ stream, metrics, height = 300 }: LiveMetricsCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ringRef = useRef<MetricsFrame[]>(new Array(RING_CAPACITY));
  const headRef = useRef(0);
  const countRef = useRef(0);
  const lastFullRedraw = useRef(0);
  const lastDrawnHead = useRef(0);
  const msgTimestamps = useRef<number[]>([]);
  const rangeCache = useRef<Map<string, { min: number; max: number }>>(new Map());
  const rafRef = useRef(0);

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

      const fullRedraw = now - lastFullRedraw.current >= FULL_REDRAW_MS;
      const padding = 10;

      ctx.clearRect(0, 0, w, h);

      metrics.forEach((metric, idx) => {
        const color = COLORS[idx % COLORS.length] ?? '#ffffff';
        const { min, max } = computeRange(metric);
        const rng = max - min || 1;

        let startIdx = 0;
        if (!fullRedraw && lastDrawnHead.current > 0) {
          startIdx = Math.max(0, lastDrawnHead.current - 1);
        }

        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        let first = true;

        for (let i = startIdx; i < count; i++) {
          const ringIdx = (head + i) % RING_CAPACITY;
          const frame = ring[ringIdx] as MetricsFrame;
          const v = frame.values[metric];
          if (v === undefined) continue;

          const x = padding + (i / (count - 1)) * (w - 2 * padding);
          const y = h - padding - ((v - min) / rng) * (h - 2 * padding);

          if (first) {
            ctx.moveTo(x, y);
            first = false;
          } else {
            ctx.lineTo(x, y);
          }
        }

        ctx.stroke();
      });

      if (fullRedraw) {
        lastFullRedraw.current = now;
        rangeCache.current.clear();
      }

      lastDrawnHead.current = head + count;
    },
    [height, metrics, computeRange],
  );

  useEffect(() => {
    let running = true;

    const loop = (now: number) => {
      if (!running) return;
      drawFrame(now);
      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);

    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [drawFrame]);

  return (
    <div ref={containerRef} className="relative w-full">
      <canvas ref={canvasRef} className="block w-full" aria-label="Live metrics canvas" />
    </div>
  );
}
