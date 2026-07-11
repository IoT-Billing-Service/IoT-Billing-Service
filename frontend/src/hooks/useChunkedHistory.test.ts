import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useChunkedHistory } from './useChunkedHistory';

// Mock the worker module
vi.mock('../workers/analyticsDataProcessor.worker.ts', () => ({}));

// Stable references to avoid re-render loops from inline arrays
const ONE_DEVICE = ['device-1'];
const TWO_DEVICES = ['device-1', 'device-2'];
const EMPTY_DEVICES: string[] = [];

// Helper to create a mock worker that responds to processChunk messages
function createMockWorker() {
  const listeners: Array<(e: MessageEvent) => void> = [];
  const mockWorker = {
    addEventListener: vi.fn((_type: string, handler: (e: MessageEvent) => void) => {
      listeners.push(handler);
    }),
    removeEventListener: vi.fn((_type: string, handler: (e: MessageEvent) => void) => {
      const idx = listeners.indexOf(handler);
      if (idx !== -1) listeners.splice(idx, 1);
    }),
    postMessage: vi.fn(
      (msg: {
        type: string;
        chunks: Array<{ startTime: number; endTime: number; data: number[] }>;
      }) => {
        setTimeout(() => {
          const chunk = msg.chunks[0];
          if (!chunk) return;
          const sum = chunk.data.reduce((a, b) => a + b, 0);
          const avg = chunk.data.length > 0 ? sum / chunk.data.length : 0;
          const response = {
            type: 'chunkProcessed',
            result: {
              averages: [avg],
              totals: [sum],
              timestamps: [chunk.startTime],
            },
          };
          const event = { data: response } as MessageEvent;
          for (const listener of listeners) {
            listener(event);
          }
        }, 10);
      },
    ),
    terminate: vi.fn(),
  };
  return mockWorker as unknown as Worker;
}

describe('useChunkedHistory', () => {
  let mockWorker: Worker;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWorker = createMockWorker();

    class MockWorkerCreator {
      constructor() {
        return mockWorker;
      }
    }

    vi.stubGlobal('Worker', MockWorkerCreator);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns initial state with empty data', () => {
    const { result } = renderHook(() =>
      useChunkedHistory({
        deviceIds: ONE_DEVICE,
        startTime: 1000,
        endTime: 2000,
        enabled: false,
      }),
    );

    expect(result.current.data).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.progress).toBe(0);
    expect(result.current.error).toBeNull();
    expect(result.current.cancel).toBeDefined();
  });

  it('does not fetch when enabled is false', () => {
    renderHook(() =>
      useChunkedHistory({
        deviceIds: ONE_DEVICE,
        startTime: 1000,
        endTime: 90000,
        enabled: false,
      }),
    );

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('does not fetch when deviceIds is empty', () => {
    renderHook(() =>
      useChunkedHistory({
        deviceIds: EMPTY_DEVICES,
        startTime: 1000,
        endTime: 90000,
        enabled: true,
      }),
    );

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('does not fetch when startTime >= endTime', () => {
    renderHook(() =>
      useChunkedHistory({
        deviceIds: ONE_DEVICE,
        startTime: 90000,
        endTime: 1000,
        enabled: true,
      }),
    );

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('starts loading, fetches a single chunk, and processes via worker', async () => {
    const mockData = [
      { timestamp: 1000, value: 10 },
      { timestamp: 2000, value: 20 },
    ];

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockData),
    } as Response);

    const { result } = renderHook(() =>
      useChunkedHistory({
        deviceIds: ONE_DEVICE,
        startTime: 1000,
        endTime: 2000,
        chunkSizeMs: 1000,
        enabled: true,
      }),
    );

    // Wait for fetch + worker processing to complete
    await waitFor(
      () => {
        expect(result.current.isLoading).toBe(false);
      },
      { timeout: 5000 },
    );

    expect(result.current.progress).toBe(1);
    expect(result.current.error).toBeNull();
    expect(result.current.data.length).toBeGreaterThan(0);
  });

  it('handles fetch errors gracefully', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() =>
      useChunkedHistory({
        deviceIds: ONE_DEVICE,
        startTime: 1000,
        endTime: 90000,
        chunkSizeMs: 90000,
        enabled: true,
      }),
    );

    await waitFor(
      () => {
        expect(result.current.isLoading).toBe(false);
      },
      { timeout: 5000 },
    );

    expect(result.current.error).not.toBeNull();
    expect(result.current.error?.message).toBe('Network error');
  });

  it('handles non-ok fetch responses', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    } as Response);

    const { result } = renderHook(() =>
      useChunkedHistory({
        deviceIds: ONE_DEVICE,
        startTime: 1000,
        endTime: 90000,
        chunkSizeMs: 90000,
        enabled: true,
      }),
    );

    await waitFor(
      () => {
        expect(result.current.isLoading).toBe(false);
      },
      { timeout: 5000 },
    );

    expect(result.current.error).not.toBeNull();
    expect(result.current.error?.message).toContain('500');
  });

  it('splits time range into multiple chunks and accumulates results', async () => {
    const mockData = [{ timestamp: 1000, value: 10 }];

    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockData),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockData),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockData),
      } as Response);

    const { result } = renderHook(() =>
      useChunkedHistory({
        deviceIds: ONE_DEVICE,
        startTime: 1000,
        endTime: 4000,
        chunkSizeMs: 1000,
        enabled: true,
      }),
    );

    await waitFor(
      () => {
        expect(result.current.isLoading).toBe(false);
      },
      { timeout: 5000 },
    );

    expect(result.current.progress).toBe(1);
    expect(result.current.error).toBeNull();
    expect(result.current.data.length).toBe(3);
  });

  it('fetches for multiple devices sequentially', async () => {
    const mockData = [{ timestamp: 1000, value: 10 }];

    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockData),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockData),
      } as Response);

    const { result } = renderHook(() =>
      useChunkedHistory({
        deviceIds: TWO_DEVICES,
        startTime: 1000,
        endTime: 2000,
        chunkSizeMs: 1000,
        enabled: true,
      }),
    );

    await waitFor(
      () => {
        expect(result.current.isLoading).toBe(false);
      },
      { timeout: 5000 },
    );

    expect(result.current.progress).toBe(1);
    expect(result.current.error).toBeNull();
    expect(result.current.data.length).toBe(2);
  });

  it('cancels fetching when cancel is called', async () => {
    let resolveFetch: (value: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const { result } = renderHook(() =>
      useChunkedHistory({
        deviceIds: ONE_DEVICE,
        startTime: 1000,
        endTime: 90000,
        chunkSizeMs: 90000,
        enabled: true,
      }),
    );

    await waitFor(
      () => {
        expect(result.current.isLoading).toBe(true);
      },
      { timeout: 2000 },
    );

    act(() => {
      result.current.cancel();
    });

    expect(result.current.isLoading).toBe(false);

    // Resolve the pending fetch to clean up
    resolveFetch!({
      ok: true,
      json: () => Promise.resolve([{ timestamp: 1000, value: 10 }]),
    } as Response);
    await new Promise((r) => setTimeout(r, 50));
  });

  it('cleans up on unmount while fetch is pending', async () => {
    let resolveFetch: (value: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const { unmount } = renderHook(() =>
      useChunkedHistory({
        deviceIds: ONE_DEVICE,
        startTime: 1000,
        endTime: 90000,
        chunkSizeMs: 90000,
        enabled: true,
      }),
    );

    unmount();

    resolveFetch!({
      ok: true,
      json: () => Promise.resolve([{ timestamp: 1000, value: 10 }]),
    } as Response);
    await new Promise((r) => setTimeout(r, 50));

    expect(true).toBe(true);
  });

  it('sorts merged data from multiple devices by timestamp', async () => {
    const mockData1 = [{ timestamp: 5000, value: 10 }];
    const mockData2 = [{ timestamp: 1000, value: 50 }];

    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockData1),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockData2),
      } as Response);

    const { result } = renderHook(() =>
      useChunkedHistory({
        deviceIds: TWO_DEVICES,
        startTime: 1000,
        endTime: 6000,
        chunkSizeMs: 5000,
        enabled: true,
      }),
    );

    await waitFor(
      () => {
        expect(result.current.isLoading).toBe(false);
      },
      { timeout: 5000 },
    );

    const timestamps = result.current.data.map((p) => p.timestamp);
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i] as number).toBeGreaterThanOrEqual(timestamps[i - 1] as number);
    }
  });

  it('handles AbortError without setting error state', async () => {
    const abortError = new DOMException('Aborted', 'AbortError');
    vi.mocked(fetch).mockRejectedValueOnce(abortError);

    const { result } = renderHook(() =>
      useChunkedHistory({
        deviceIds: ONE_DEVICE,
        startTime: 1000,
        endTime: 90000,
        chunkSizeMs: 90000,
        enabled: true,
      }),
    );

    await waitFor(
      () => {
        expect(result.current.isLoading).toBe(false);
      },
      { timeout: 5000 },
    );

    expect(result.current.error).toBeNull();
  });
});
