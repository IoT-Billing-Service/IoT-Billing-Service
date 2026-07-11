'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type { TelemetryHistoryPoint, ProcessedHistoryChunk, ChunkedHistoryState } from '@/types';

const DEFAULT_CHUNK_SIZE_MS = 86_400_000; // 1 day at 1-second resolution = 86,400 data points
const MAX_MEMORY_POINTS = 200_000;

interface UseChunkedHistoryOptions {
  deviceIds: string[];
  startTime: number;
  endTime: number;
  chunkSizeMs?: number;
  enabled?: boolean;
}

function createWorker(): Worker | null {
  if (typeof window === 'undefined') return null;
  try {
    return new Worker(new URL('../workers/analyticsDataProcessor.worker.ts', import.meta.url), {
      type: 'module',
    });
  } catch {
    return null;
  }
}

function computeChunkBoundaries(
  startTime: number,
  endTime: number,
  chunkSizeMs: number,
): Array<{ from: number; to: number }> {
  const boundaries: Array<{ from: number; to: number }> = [];
  let current = startTime;
  while (current < endTime) {
    const to = Math.min(current + chunkSizeMs, endTime);
    boundaries.push({ from: current, to });
    current = to;
  }
  return boundaries;
}

async function fetchChunk(
  deviceId: string,
  from: number,
  to: number,
  signal: AbortSignal,
): Promise<TelemetryHistoryPoint[]> {
  const params = new URLSearchParams({
    deviceId,
    from: String(from),
    to: String(to),
  });
  const response = await fetch(`/api/telemetry/history?${params}`, { signal });
  if (!response.ok) {
    throw new Error(`Failed to fetch history chunk: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function processedChunksToDataPoints(chunks: ProcessedHistoryChunk[]): TelemetryHistoryPoint[] {
  const points: TelemetryHistoryPoint[] = [];
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.averages.length; i++) {
      points.push({
        timestamp: chunk.timestamps[i] ?? chunk.startTime,
        value: chunk.averages[i] ?? 0,
      });
    }
  }
  return points;
}

function enforceMemoryCap(points: TelemetryHistoryPoint[]): TelemetryHistoryPoint[] {
  if (points.length <= MAX_MEMORY_POINTS) return points;
  const stride = Math.ceil(points.length / MAX_MEMORY_POINTS);
  const downsampled: TelemetryHistoryPoint[] = [];
  for (let i = 0; i < points.length; i += stride) {
    const sliceEnd = Math.min(i + stride, points.length);
    const slice = points.slice(i, sliceEnd);
    const avgValue = slice.reduce((sum, p) => sum + p.value, 0) / slice.length;
    const midTimestamp = slice[Math.floor(slice.length / 2)]?.timestamp ?? slice[0]?.timestamp ?? 0;
    downsampled.push({ timestamp: midTimestamp, value: avgValue });
  }
  return downsampled;
}

async function fetchAndProcessChunk(
  deviceId: string,
  from: number,
  to: number,
  signal: AbortSignal,
  worker: Worker | null,
): Promise<ProcessedHistoryChunk> {
  const rawData = await fetchChunk(deviceId, from, to, signal);

  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  const analyticsChunk = {
    startTime: from,
    endTime: to,
    data: rawData.map((p) => p.value),
  };

  if (worker) {
    return new Promise<ProcessedHistoryChunk>((resolve) => {
      let settled = false;

      const settle = (result: ProcessedHistoryChunk) => {
        if (settled) return;
        settled = true;
        worker.removeEventListener('message', handler);
        resolve(result);
      };

      const handler = (e: MessageEvent) => {
        if (e.data.type === 'chunkProcessed' && e.data.result) {
          settle({
            averages: e.data.result.averages as number[],
            totals: e.data.result.totals as number[],
            timestamps: e.data.result.timestamps as number[],
            startTime: from,
            endTime: to,
          });
        }
      };
      worker.addEventListener('message', handler);
      worker.postMessage({
        type: 'processChunk',
        chunks: [analyticsChunk],
      });

      // Timeout: resolve with local computation if worker doesn't respond within 10s
      setTimeout(() => {
        if (settled) return;
        const values = rawData.map((p) => p.value);
        const sum = values.reduce((a, b) => a + b, 0);
        const avg = values.length > 0 ? sum / values.length : 0;
        settle({
          averages: [avg],
          totals: [sum],
          timestamps: rawData.length > 0 ? [rawData[0]?.timestamp ?? from] : [from],
          startTime: from,
          endTime: to,
        });
      }, 10_000);
    });
  }

  // Fallback: compute locally
  const values = rawData.map((p) => p.value);
  const sum = values.reduce((a, b) => a + b, 0);
  const avg = values.length > 0 ? sum / values.length : 0;
  return {
    averages: [avg],
    totals: [sum],
    timestamps: rawData.length > 0 ? [rawData[0]?.timestamp ?? from] : [from],
    startTime: from,
    endTime: to,
  };
}

function mergeDeviceResults(
  existing: ProcessedHistoryChunk[],
  incoming: ProcessedHistoryChunk[],
): ProcessedHistoryChunk[] {
  // Since chunks from each device arrive in time order, just concat
  const merged = existing.concat(incoming);

  // Sort by startTime to ensure correct order across devices
  if (merged.length > 1) {
    merged.sort((a, b) => a.startTime - b.startTime);
  }
  return merged;
}

export function useChunkedHistory({
  deviceIds,
  startTime,
  endTime,
  chunkSizeMs = DEFAULT_CHUNK_SIZE_MS,
  enabled = true,
}: UseChunkedHistoryOptions): ChunkedHistoryState & { cancel: () => void } {
  const [state, setState] = useState<ChunkedHistoryState>({
    data: [],
    isLoading: false,
    progress: 0,
    error: null,
  });

  const abortRef = useRef<AbortController | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const processedRef = useRef<ProcessedHistoryChunk[]>([]);
  const mountedRef = useRef(true);
  const effectIdRef = useRef(0);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setState((prev) => ({ ...prev, isLoading: false }));
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled || deviceIds.length === 0) return;
    if (startTime >= endTime) return;

    effectIdRef.current += 1;
    const effectId = effectIdRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    processedRef.current = [];

    const worker = createWorker();
    workerRef.current = worker;

    const boundaries = computeChunkBoundaries(startTime, endTime, chunkSizeMs);
    const totalChunkOperations = boundaries.length * deviceIds.length;

    let completedOps = 0;

    const accumulateFromDevice = (deviceChunks: ProcessedHistoryChunk[]) => {
      if (!mountedRef.current || controller.signal.aborted || effectId !== effectIdRef.current)
        return;

      processedRef.current = mergeDeviceResults(processedRef.current, deviceChunks);
      const dataPoints = processedChunksToDataPoints(processedRef.current);
      const cappedPoints = enforceMemoryCap(dataPoints);

      const progress = totalChunkOperations > 0 ? completedOps / totalChunkOperations : 1;
      setState({
        data: cappedPoints,
        isLoading: completedOps < totalChunkOperations,
        progress,
        error: null,
      });
    };

    const runFetchLoop = async () => {
      // Set loading state at the start of async processing
      if (effectId !== effectIdRef.current) return;
      setState({
        data: [],
        isLoading: true,
        progress: 0,
        error: null,
      });

      // Process each device sequentially across all time chunks
      for (const deviceId of deviceIds) {
        if (controller.signal.aborted || effectId !== effectIdRef.current) break;

        for (const boundary of boundaries) {
          if (controller.signal.aborted || effectId !== effectIdRef.current) break;

          try {
            const processed = await fetchAndProcessChunk(
              deviceId,
              boundary.from,
              boundary.to,
              controller.signal,
              worker,
            );
            completedOps++;

            // Accumulate incrementally after each chunk
            accumulateFromDevice([processed]);
          } catch (err) {
            if (isAbortError(err) || controller.signal.aborted) break;

            const error = err instanceof Error ? err : new Error(String(err));
            if (mountedRef.current && effectId === effectIdRef.current) {
              setState((prev) => ({
                ...prev,
                isLoading: false,
                error,
              }));
            }
            return; // Stop processing on error
          }
        }
      }

      // Final state update after loop completes normally
      if (effectId === effectIdRef.current && !controller.signal.aborted) {
        setState((prev) => ({ ...prev, isLoading: false }));
      }
    };

    runFetchLoop();

    return () => {
      controller.abort();
      worker?.terminate();
      workerRef.current = null;
    };
  }, [deviceIds, startTime, endTime, chunkSizeMs, enabled]);

  return { ...state, cancel };
}
