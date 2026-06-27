'use client';

import { useRef, useEffect, useCallback, useState } from 'react';
import { useTheme } from '@/components/providers/ThemeProvider';
import { useRenderLoop } from '@/hooks/useRenderLoop';
import { FrameBudgetReport } from '@/utils/frameBudget';

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
    return new Worker(new URL('../../workers/canvasWorker.ts', import.meta.url), {
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
  const msgTimestamps = useRef<number[]>([]);
  const workerRef = useRef<Worker | null>(null);
  const workerReadyRef = useRef(false);
  const workerInitRef = useRef(false);
  const pendingWorkerBatchesRef = useRef<{ values: number[] }[]>([]);
  const prevDataLenRef = useRef(0);
  const isPageVisible = useRef(true);
  const [memoryInfo, setMemoryInfo] = useState<string | null>(null);
  const [frameStats, setFrameStats] = useState<FrameBudgetReport | null>(null);
  const [useWorkerRender, setUseWorkerRender] = useState(false);
  const { chartPalette, prefersReducedMotion } = useTheme();

  useEffect(() => {
    if (typeof window === 'undefined') return;

    workerRef.current = createWorker();
    const worker = workerRef.current;
    if (!worker) return;

    const handleWorkerMessage = (event: MessageEvent) => {
      if (event.data?.type === 'ready') {
        workerReadyRef.current = true;
        setUseWorkerRender(true);
        pendingWorkerBatchesRef.current.forEach((batch) => {
          worker.postMessage({ type: 'appendBatch', payload: batch });
        });
        pendingWorkerBatchesRef.current.length = 0;
        return;
      }

      if (event.data?.type === 'frameStats' && event.data.payload) {
        setFrameStats(event.data.payload);
      }

      if (event.data?.type === 'error') {
        console.error('[TelemetryChart worker]', event.data.payload);
      }
    };

    worker.addEventListener('message', handleWorkerMessage);
    return () => {
      worker.removeEventListener('message', handleWorkerMessage);
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const worker = workerRef.current;
    if (!canvas || !worker || workerInitRef.current) return;
    type OffscreenTransferable = HTMLCanvasElement & {
      transferControlToOffscreen?: () => OffscreenCanvas;
    };
    const transfer = (canvas as OffscreenTransferable).transferControlToOffscreen?.();
    if (!transfer) return;

    worker.postMessage(
      {
        type: 'init',
        payload: {
          canvas: transfer,
          width,
          height,
          dpr: window.devicePixelRatio || 1,
          metric,
          color,
          isLoading,
          loadingProgress,
          totalTimeRange,
          pendingRange,
        },
      },
      [transfer],
    );
    workerInitRef.current = true;
  }, [color, height, loadingProgress, metric, pendingRange, totalTimeRange, width, isLoading]);

  useEffect(() => {
    if (!workerReadyRef.current || !workerRef.current) return;
    workerRef.current.postMessage({
      type: 'updateConfig',
      payload: {
        metric,
        color,
        isLoading,
        loadingProgress,
        totalTimeRange,
        pendingRange,
      },
    });
  }, [color, isLoading, loadingProgress, metric, pendingRange, totalTimeRange]);

  useEffect(() => {
    if (!workerReadyRef.current || !workerRef.current) return;
    workerRef.current.postMessage({
      type: 'resize',
      payload: { width, height, dpr: window.devicePixelRatio || 1 },
    });
  }, [width, height]);

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
      newCount < RING_CAPACITY ? headRef.current : (headRef.current + newPoints.length) % RING_CAPACITY;
    headRef.current = newHead;
    countRef.current = newCount;

    const values = newPoints.map((point) => point.value);
    const batch = { values };
    if (workerReadyRef.current && workerRef.current) {
      workerRef.current.postMessage({ type: 'appendBatch', payload: batch });
    } else {
      pendingWorkerBatchesRef.current.push(batch);
    }

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

  const draw = useCallback(
    (now: number) => {
      if (useWorkerRender && workerRef.current && workerReadyRef.current) {
        workerRef.current.postMessage({ type: 'draw', payload: { now } });
        return;
      }

      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const ring = ringRef.current;
      const head = headRef.current;
      const count = countRef.current;
      if (count < 2) {
        if (isLoading && totalTimeRange) {
          const computedStyle = getComputedStyle(canvas);
          const chartTextColor = computedStyle.getPropertyValue('--chart-text').trim() || '#a0a0a0';
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

      const fullRedraw = now - lastFullRedraw.current >= FULL_REDRAW_MS;
      const padding = 20;
      const widthCap = Math.max(50, Math.floor(width));
      const maxPoints = fullRedraw ? widthCap : Math.max(50, Math.floor(widthCap / 2));
      const chartMaxPoints = Math.min(maxPoints, widthCap);

      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < count; i++) {
        const idx = (head + i) % RING_CAPACITY;
        const pt = ring[idx] as TelemetryDataPoint;
        const value = pt?.value;
        if (value < min) min = value;
        if (value > max) max = value;
      }
      if (!Number.isFinite(min) || !Number.isFinite(max)) {
        min = 0;
        max = 1;
      }
      const rng = max - min || 1;

      ctx.clearRect(0, 0, width, height);

      ctx.strokeStyle = color ?? chartPalette[0] ?? '#5ec962';
      ctx.lineWidth = 2;
      ctx.beginPath();
      let first = true;
      const stride = Math.max(1, Math.ceil(count / chartMaxPoints));

      for (let i = 0; i < count; i += stride) {
        const idx = (head + i) % RING_CAPACITY;
        const pt = ring[idx] as TelemetryDataPoint;
        const x = padding + (i / (count - 1)) * (width - 2 * padding);
        const y = height - padding - ((pt.value - min) / rng) * (height - 2 * padding);
        if (first) {
          ctx.moveTo(x, y);
          first = false;
        } else {
          ctx.lineTo(x, y);
        }
      }

      if (!first && count > 1) {
        const idx = (head + count - 1) % RING_CAPACITY;
        const pt = ring[idx] as TelemetryDataPoint;
        const x = padding + ((count - 1) / (count - 1)) * (width - 2 * padding);
        const y = height - padding - ((pt.value - min) / rng) * (height - 2 * padding);
        ctx.lineTo(x, y);
      }

      ctx.stroke();

      if (fullRedraw) {
        lastFullRedraw.current = now;
      }

      const latest = ring[(head + count - 1) % RING_CAPACITY] as TelemetryDataPoint;
      ctx.fillStyle = color ?? chartPalette[0] ?? '#5ec962';
      ctx.font = '12px monospace';
      ctx.fillText(`${metric}: ${latest.value.toFixed(2)}`, padding, 20);
    },
    [color, height, isLoading, metric, totalTimeRange, useWorkerRender, width, chartPalette],
  );

  const isVisible = useCallback(() => isPageVisible.current, []);
  const handleResumeAfterHidden = useCallback(() => {
    lastFullRedraw.current = 0;
  }, []);

  useRenderLoop({
    draw,
    prefersReducedMotion,
    isVisible,
    onResumeAfterHidden: handleResumeAfterHidden,
  });

  return (
    <div className="relative">
      <canvas ref={canvasRef} style={{ width, height }} aria-label={`${metric} telemetry chart`} />
      {(memoryInfo || frameStats) && (
        <div className="absolute bottom-1 right-2 rounded bg-black/70 px-2 py-0.5 text-[10px] text-gray-400 font-mono">
          {memoryInfo}
          {frameStats && (
            <span className={memoryInfo ? 'ml-2' : ''}>
              p95 {frameStats.p95.toFixed(1)}ms · dropped {frameStats.droppedFrames}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
