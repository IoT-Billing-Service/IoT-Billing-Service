'use client';

import { useRef, useEffect, useCallback, useState } from 'react';

interface TelemetryDataPoint {
  timestamp: number;
  value: number;
}

interface TelemetryChartProps {
  data: TelemetryDataPoint[];
  metric: string;
  color?: string;
  height?: number;
  width?: number;
}

const RING_CAPACITY = 10_000;
const FULL_REDRAW_MS = 500;
const RATE_WARN_THRESHOLD = 3000;

function createWorker(): Worker | null {
  if (typeof window === 'undefined') return null;
  try {
    return new Worker(new URL('../../workers/analyticsDataProcessor.worker.ts', import.meta.url), {
      type: 'module',
    });
  } catch {
    return null;
  }
}

export function TelemetryChart({
  data,
  metric,
  color = '#00ff88',
  height = 200,
  width = 600,
}: TelemetryChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ringRef = useRef<TelemetryDataPoint[]>(new Array(RING_CAPACITY));
  const headRef = useRef(0);
  const countRef = useRef(0);
  const lastFullRedraw = useRef(0);
  const lastDrawnHead = useRef(0);
  const msgTimestamps = useRef<number[]>([]);
  const workerRef = useRef<Worker | null>(null);
  const rafRef = useRef(0);
  const [range, setRange] = useState<{ min: number; max: number }>({ min: 0, max: 1 });

  useEffect(() => {
    workerRef.current = createWorker();

    const handleWorkerMessage = (e: MessageEvent) => {
      if (e.data.type === 'rangeResult' && e.data.range) {
        setRange({ min: e.data.range.min, max: e.data.range.max });
      }
    };

    workerRef.current?.addEventListener('message', handleWorkerMessage);

    return () => {
      workerRef.current?.removeEventListener('message', handleWorkerMessage);
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const points = data;
    const ring = ringRef.current;
    const head = headRef.current;
    const count = countRef.current;

    for (let i = 0; i < points.length; i++) {
      const point = points[i] as TelemetryDataPoint;
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
        `[TelemetryChart] High incoming rate: ${msgTimestamps.current.length} msg/s for metric "${metric}". Consider scaling horizontally.`,
      );
    }
  }, [data, metric]);

  const sendToWorker = useCallback((values: number[]) => {
    workerRef.current?.postMessage({
      type: 'computeRange',
      payload: { values },
    });
  }, []);

  const draw = useCallback(
    (now: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.scale(dpr, dpr);

      const ring = ringRef.current;
      const head = headRef.current;
      const count = countRef.current;

      if (count < 2) return;
      if (count > 1 && range.max === range.min && range.max === 0) return;

      const fullRedraw = now - lastFullRedraw.current >= FULL_REDRAW_MS;

      ctx.clearRect(0, 0, width, height);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;

      const padding = 20;
      const rng = range.max - range.min || 1;

      let startIdx = 0;
      if (!fullRedraw && lastDrawnHead.current > 0) {
        startIdx = Math.max(0, lastDrawnHead.current - 1);
      }
      lastDrawnHead.current = head + count;

      ctx.beginPath();
      let first = true;
      for (let i = startIdx; i < count; i++) {
        const idx = (head + i) % RING_CAPACITY;
        const pt = ring[idx] as TelemetryDataPoint;
        const x = padding + (i / (count - 1)) * (width - 2 * padding);
        const y = height - padding - ((pt.value - range.min) / rng) * (height - 2 * padding);
        if (first) {
          ctx.moveTo(x, y);
          first = false;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();

      if (fullRedraw) {
        lastFullRedraw.current = now;
        const values: number[] = [];
        for (let i = 0; i < count; i++) {
          const idx = (head + i) % RING_CAPACITY;
          values.push((ring[idx] as TelemetryDataPoint).value);
        }
        sendToWorker(values);
      }

      ctx.fillStyle = color;
      ctx.font = '12px monospace';
      const latest = ring[(head + count - 1) % RING_CAPACITY] as TelemetryDataPoint;
      ctx.fillText(`${metric}: ${latest.value.toFixed(2)}`, padding, 20);
    },
    [color, height, width, metric, range, sendToWorker],
  );

  useEffect(() => {
    let running = true;

    const loop = (now: number) => {
      if (!running) return;
      draw(now);
      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);

    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [draw]);

  return (
    <canvas ref={canvasRef} style={{ width, height }} aria-label={`${metric} telemetry chart`} />
  );
}
