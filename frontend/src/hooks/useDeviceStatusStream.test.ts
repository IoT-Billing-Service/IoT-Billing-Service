import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDeviceStatusStream, type DeviceStatusUpdate } from './useDeviceStatusStream';

// ─── Mock WebSocket ──────────────────────────────────────────────────────────

/**
 * Minimal WebSocket stand-in that records instances and lets tests push
 * messages synchronously.
 */
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  url: string;
  closed = false;
  readyState: number = WebSocket.CONNECTING;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    // Simulate immediate connection for tests
    setTimeout(() => {
      if (!this.closed) {
        this.readyState = WebSocket.OPEN;
        this.onopen?.();
      }
    }, 0);
  }

  close() {
    this.closed = true;
    this.readyState = WebSocket.CLOSED;
  }

  /**
   * Simulates receiving a message from the server.
   * The test can call this to deliver status updates.
   */
  receive(data: DeviceStatusUpdate) {
    if (this.onmessage && !this.closed) {
      this.onmessage({ data: JSON.stringify(data) } as MessageEvent);
    }
  }
}

// ─── Test Setup ──────────────────────────────────────────────────────────────

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('useDeviceStatusStream', () => {
  it('opens a WebSocket connection once on mount', () => {
    renderHook(() => useDeviceStatusStream(() => {}));
    act(() => vi.runAllTimers());
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0]!.closed).toBe(false);
  });

  it('delivers a single update after the 100ms debounce window', () => {
    const handler = vi.fn();
    renderHook(() => useDeviceStatusStream(handler));
    act(() => vi.runAllTimers()); // open connection

    const ws = MockWebSocket.instances[0]!;
    act(() => {
      ws.receive({
        deviceId: 'd1',
        status: 'active',
        eventSeq: 1,
        timestamp: 1000,
      });
    });

    // Still buffered — handler not yet called
    expect(handler).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(100));

    // Flushed at 100ms mark
    expect(handler).toHaveBeenCalledTimes(1);
    const batch = handler.mock.calls[0]![0] as DeviceStatusUpdate[];
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({
      deviceId: 'd1',
      status: 'active',
      eventSeq: 1,
    });
  });

  it('collapses multiple updates for the same device within 100ms, keeping only the latest', () => {
    const handler = vi.fn();
    renderHook(() => useDeviceStatusStream(handler));
    act(() => vi.runAllTimers());

    const ws = MockWebSocket.instances[0]!;
    act(() => {
      ws.receive({ deviceId: 'd1', status: 'active', eventSeq: 1, timestamp: 1000 });
      ws.receive({ deviceId: 'd1', status: 'alert', eventSeq: 2, timestamp: 1050 });
      ws.receive({ deviceId: 'd1', status: 'active', eventSeq: 3, timestamp: 1100 });
    });

    // All three arrive within one tick; none flushed yet.
    expect(handler).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(100));

    // Only the highest-seq update survives the debounce buffer.
    expect(handler).toHaveBeenCalledTimes(1);
    const batch = handler.mock.calls[0]![0] as DeviceStatusUpdate[];
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({
      deviceId: 'd1',
      status: 'active',
      eventSeq: 3,
      timestamp: 1100,
    });
  });

  it('discards a stale update that arrives after a newer one was buffered', () => {
    const handler = vi.fn();
    renderHook(() => useDeviceStatusStream(handler));
    act(() => vi.runAllTimers());

    const ws = MockWebSocket.instances[0]!;
    act(() => {
      // First, a high-seq "active" update arrives
      ws.receive({ deviceId: 'd1', status: 'active', eventSeq: 10, timestamp: 2000 });
      // Then, a low-seq "alert" (stale) arrives — should be discarded
      ws.receive({ deviceId: 'd1', status: 'alert', eventSeq: 5, timestamp: 1500 });
    });

    act(() => vi.advanceTimersByTime(100));

    // The stale (seq=5) update was discarded; only seq=10 made it.
    const batch = handler.mock.calls[0]![0] as DeviceStatusUpdate[];
    expect(batch).toHaveLength(1);
    expect(batch[0]!.eventSeq).toBe(10);
    expect(batch[0]!.status).toBe('active');
  });

  it(
    'handles 5 status changes within 200ms (rapid-transition test from blueprint) — ' +
      'delivers only the final confirmed state',
    () => {
      const handler = vi.fn();
      renderHook(() => useDeviceStatusStream(handler));
      act(() => vi.runAllTimers());

      const ws = MockWebSocket.instances[0]!;

      // Simulate a transient sensor spike: active → alert → active → idle → active → idle
      // All within 200ms (issue blueprint specifies "up to 3 changes within 200ms",
      // here we stress-test with 5).
      act(() => {
        ws.receive({ deviceId: 'd1', status: 'active', eventSeq: 1, timestamp: 1000 }); // t=0
        ws.receive({ deviceId: 'd1', status: 'alert', eventSeq: 2, timestamp: 1040 }); // t=40
        ws.receive({ deviceId: 'd1', status: 'active', eventSeq: 3, timestamp: 1080 }); // t=80
        ws.receive({ deviceId: 'd1', status: 'idle', eventSeq: 4, timestamp: 1120 }); // t=120
        ws.receive({ deviceId: 'd1', status: 'active', eventSeq: 5, timestamp: 1160 }); // t=160
      });

      // Nothing delivered yet — still within first debounce window.
      expect(handler).not.toHaveBeenCalled();

      // At t=100, the debounce timer fires.
      act(() => vi.advanceTimersByTime(100));

      // The hook delivered a batch with only the highest-seq update (seq=5, 'active').
      // Transient spikes (alert, idle) that arrived mid-window are never surfaced.
      expect(handler).toHaveBeenCalledTimes(1);
      const batch = handler.mock.calls[0]![0] as DeviceStatusUpdate[];
      expect(batch).toHaveLength(1);
      expect(batch[0]).toMatchObject({
        deviceId: 'd1',
        status: 'active',
        eventSeq: 5,
        timestamp: 1160,
      });
    },
  );

  it('batches updates for multiple devices in the same 100ms window', () => {
    const handler = vi.fn();
    renderHook(() => useDeviceStatusStream(handler));
    act(() => vi.runAllTimers());

    const ws = MockWebSocket.instances[0]!;
    act(() => {
      ws.receive({ deviceId: 'd1', status: 'active', eventSeq: 1, timestamp: 1000 });
      ws.receive({ deviceId: 'd2', status: 'alert', eventSeq: 1, timestamp: 1010 });
      ws.receive({ deviceId: 'd3', status: 'offline', eventSeq: 1, timestamp: 1020 });
    });

    act(() => vi.advanceTimersByTime(100));

    expect(handler).toHaveBeenCalledTimes(1);
    const batch = handler.mock.calls[0]![0] as DeviceStatusUpdate[];
    expect(batch).toHaveLength(3);

    const deviceIds = batch.map((u) => u.deviceId).sort();
    expect(deviceIds).toEqual(['d1', 'd2', 'd3']);
  });

  it('flushes any buffered updates on unmount (no data loss)', () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() => useDeviceStatusStream(handler));
    act(() => vi.runAllTimers());

    const ws = MockWebSocket.instances[0]!;
    act(() => {
      ws.receive({ deviceId: 'd1', status: 'alert', eventSeq: 1, timestamp: 1000 });
    });

    // Unmount before the debounce timer fires — must flush immediately.
    unmount();

    expect(handler).toHaveBeenCalledTimes(1);
    const batch = handler.mock.calls[0]![0] as DeviceStatusUpdate[];
    expect(batch[0]?.deviceId).toBe('d1');
  });

  it('closes the WebSocket on unmount', () => {
    const { unmount } = renderHook(() => useDeviceStatusStream(() => {}));
    act(() => vi.runAllTimers());

    const ws = MockWebSocket.instances[0]!;
    expect(ws.closed).toBe(false);

    unmount();
    expect(ws.closed).toBe(true);
  });

  it('ignores malformed messages without crashing', () => {
    const handler = vi.fn();
    renderHook(() => useDeviceStatusStream(handler));
    act(() => vi.runAllTimers());

    const ws = MockWebSocket.instances[0]!;
    act(() => {
      // Deliver a malformed frame
      ws.onmessage?.({ data: '{"deviceId": "d1" }' } as MessageEvent); // missing fields
      ws.onmessage?.({ data: 'not even JSON' } as MessageEvent);
    });

    act(() => vi.advanceTimersByTime(100));

    // No calls — malformed frames were silently discarded.
    expect(handler).not.toHaveBeenCalled();
  });
});
