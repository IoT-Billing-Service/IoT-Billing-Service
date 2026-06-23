'use client';

import { useRef, useEffect, useCallback, useState } from 'react';
import { useTheme } from '@/components/providers/ThemeProvider';

interface TelemetryDataPoint {
  timestamp: number;
  value: number;
}

interface TelemetryChartProps {
  data: TelemetryDataPoint[];
  metric: string;
  /** Override chart line colour (defaults to --chart-line-1 from theme) */
  color?: string;
  height?: number;
  width?: number;
  /** 0-1 progress for chunked history loading */
  loadingProgress?: number;
  /** Full time range the chart represents (used for progressive rendering) */
  totalTimeRange?: { start: number; end: number };
  /** Time range currently being fetched (rendered as dimmed pending region) */
  pendingRange?: { start: number; end: number } | null;
  /** Whether data is still being loaded */
  isLoading?: boolean;
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
  color = '#5ec962',
  height = 200,
  width = 600,
  loadingProgress,
  totalTimeRange,
  pendingRange,
  isLoading = false,
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
  const prevDataLenRef = useRef(0);
  const lastFrameTime = useRef(0);
  const isPageVisible = useRef(true);
  const [range, setRange] = useState<{ min: number; max: number }>({ min: 0, max: 1 });
  const [memoryInfo, setMemoryInfo] = useState<string | null>(null);
  const { chartPalette, prefersReducedMotion } = useTheme();

  // Upstream: worker initialization
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

  // Upstream: ring buffer data processing with prevDataLenRef
  useEffect(() => {
    const points = data;
    const prevLen = prevDataLenRef.current;
    const newPoints = points.slice(prevLen);
    prevDataLenRef.current = points.length;

    if (newPoints.length === 0) return;

    const ring = ringRef.current;
    const head = headRef.current;
    const count = countRef.current;

    for (let i = 0; i < newPoints.length; i++) {
      const point = newPoints[i] as TelemetryDataPoint;
      const idx = (head + count + i) % RING_CAPACITY;
      ring[idx] = point;
    }
    const newCount = Math.min(count + newPoints.length, RING_CAPACITY);
    const newHead =
      newCount < RING_CAPACITY
        ? headRef.current
        : (headRef.current + newPoints.length) % RING_CAPACITY;
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

  // HEAD: Visibility change handler — pause/resume rAF loop
  useEffect(() => {
    const handleVisibilityChange = () => {
      isPageVisible.current = document.visibilityState === 'visible';
      if (isPageVisible.current) {
        lastFullRedraw.current = 0;
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // HEAD: Dev-mode memory measurement
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
          setMemoryInfo(`TelemetryChart memory: ${usedMB} MB`);
        }
      } catch {
        // Not available in all browsers
      }
    };

    const interval = setInterval(measure, 30_000);
    measure();

    return () => clearInterval(interval);
  }, []);

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

      // Resolve theme-aware colours from CSS custom properties for canvas rendering
      const computedStyle = getComputedStyle(canvas);
      const chartTextColor = computedStyle.getPropertyValue('--chart-text').trim() || '#a0a0a0';

      const ring = ringRef.current;
      const head = headRef.current;
      const count = countRef.current;

      if (count < 2) {
        // HEAD: Draw loading state text even with no data yet
        if (isLoading && totalTimeRange) {
          ctx.fillStyle = chartTextColor;
          ctx.globalAlpha = 0.6;
          ctx.font = '14px monospace';
          ctx.textAlign = 'center';
          ctx.fillText('Fetching telemetry data...', width / 2, height / 2);
          ctx.textAlign = 'left';
          ctx.globalAlpha = 1;
        }
        return;
      }
      if (count > 1 && range.max === range.min && range.max === 0) return;

      const fullRedraw = now - lastFullRedraw.current >= FULL_REDRAW_MS;
      const padding = 20;

      ctx.clearRect(0, 0, width, height);

      // HEAD: Draw pending/loading region (dimmed overlay) when data is still being fetched
      if (pendingRange && totalTimeRange) {
        const totalSpan = totalTimeRange.end - totalTimeRange.start || 1;
        const pendingStartRatio = (pendingRange.start - totalTimeRange.start) / totalSpan;
        const pendingEndRatio = (pendingRange.end - totalTimeRange.start) / totalSpan;
        const px = padding + pendingStartRatio * (width - 2 * padding);
        const pw = Math.max(2, (pendingEndRatio - pendingStartRatio) * (width - 2 * padding));

        ctx.fillStyle = chartTextColor;
        ctx.globalAlpha = 0.15;
        ctx.fillRect(px, padding, pw, height - 2 * padding);
        ctx.globalAlpha = 1;

        ctx.save();
        ctx.strokeStyle = chartTextColor;
        ctx.globalAlpha = 0.4;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.lineDashOffset = -(now / 50);
        ctx.strokeRect(px, padding, pw, height - 2 * padding);
        ctx.setLineDash([]);
        ctx.restore();

        ctx.fillStyle = chartTextColor;
        ctx.globalAlpha = 0.6;
        ctx.font = '10px monospace';
        ctx.fillText('Loading...', px + 4, padding + 14);
        ctx.globalAlpha = 1;
      }

      // Upstream: line chart drawing — use theme-aware colour
      ctx.strokeStyle = color ?? chartPalette[0] ?? '#5ec962';
      ctx.lineWidth = 2;

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

      ctx.fillStyle = color ?? chartPalette[0] ?? '#5ec962';
      ctx.font = '12px monospace';
      const latest = ring[(head + count - 1) % RING_CAPACITY] as TelemetryDataPoint;
      ctx.fillText(`${metric}: ${latest.value.toFixed(2)}`, padding, 20);

      // Upstream: Loading gradient for progressive chunked history
      if (loadingProgress !== undefined && loadingProgress < 1 && count > 1) {
        const loadedX = padding + loadingProgress * (width - 2 * padding);
        const gradient = ctx.createLinearGradient(loadedX, 0, width, 0);
        gradient.addColorStop(0, 'transparent');
        gradient.addColorStop(0.3, chartTextColor);
        ctx.globalAlpha = 0.15;
        ctx.fillStyle = gradient;
        ctx.fillRect(loadedX, 0, width - loadedX, height);
        ctx.globalAlpha = 1;

        const dotX = loadedX + 30;
        const dotY = height / 2;
        const dotRadius = 3;
        const dotSpacing = 12;
        const phase = Math.floor(now / 400) % 3;
        ctx.fillStyle = chartTextColor;
        for (let d = 0; d < 3; d++) {
          ctx.globalAlpha = d === phase ? 1 : 0.3;
          ctx.beginPath();
          ctx.arc(dotX + d * dotSpacing, dotY, dotRadius, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    },
    [
      chartPalette,
      color,
      height,
      isLoading,
      loadingProgress,
      metric,
      pendingRange,
      range,
      sendToWorker,
      totalTimeRange,
      width,
    ],
  );

  // HEAD: rAF loop with visibility check
  useEffect(() => {
    let running = true;

    const loop = (now: number) => {
      if (!running) return;
      if (!isPageVisible.current) {
        rafRef.current = requestAnimationFrame(loop);
        return;
      }
      if (lastFrameTime.current > 0 && now - lastFrameTime.current > 5000) {
        lastFullRedraw.current = 0;
      }
      lastFrameTime.current = now;
      draw(now);
      rafRef.current = requestAnimationFrame(loop);
    };

    // Respect reduced motion: use a longer interval instead of rAF
    const delay = prefersReducedMotion ? 250 : 0;

    if (prefersReducedMotion) {
      const intervalId = setInterval(() => {
        if (!running) return;
        if (!isPageVisible.current) return;
        if (lastFrameTime.current > 0 && performance.now() - lastFrameTime.current > 5000) {
          lastFullRedraw.current = 0;
        }
        lastFrameTime.current = performance.now();
        draw(performance.now());
      }, delay);
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
  }, [draw, prefersReducedMotion]);

  return (
    <div className="relative">
      <canvas ref={canvasRef} style={{ width, height }} aria-label={`${metric} telemetry chart`} />
      {memoryInfo && (
        <div className="absolute bottom-1 right-2 rounded bg-black/70 px-2 py-0.5 text-[10px] text-gray-400 font-mono">
          {memoryInfo}
        </div>
      )}
    </div>
  );
}
