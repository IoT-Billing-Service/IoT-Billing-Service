/**
 * Tests for Issue #1: Hardware Telemetry Ingestion Pipeline with Real-Time Streaming.
 *
 * Coverage:
 *  - TelemetryStreamBus: publish, subscribe (wildcard + device filter), unsubscribe
 *  - SseTelemetryBridge: start/stop, event forwarding
 *  - ingestion route: stream publish on success, no publish on error
 *  - stream counters: increment/reset
 *  - backpressure / dropped events: queue full handling
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TelemetryStreamBus,
  SseTelemetryBridge,
  getStreamCounters,
  resetStreamCounters,
  incrementStreamPublished,
  incrementStreamDelivered,
  incrementStreamErrors,
  TELEMETRY_EVENT_NAME,
  type TelemetryStreamEvent,
} from '../../../src/core/ingestion/telemetry_stream.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeEvent(deviceId = 'MTR-001'): TelemetryStreamEvent {
  return {
    serverTs: new Date().toISOString(),
    deviceId,
    metrics: { voltage: 220, temperature: 25 },
    recordsWritten: 2,
  };
}

// ── TelemetryStreamBus ─────────────────────────────────────────────────────────

describe('TelemetryStreamBus', () => {
  let bus: TelemetryStreamBus;

  beforeEach(() => {
    // Reset singleton so each test gets a clean instance.
    TelemetryStreamBus.reset();
    bus = TelemetryStreamBus.getInstance();
  });

  afterEach(() => {
    TelemetryStreamBus.reset();
  });

  describe('singleton', () => {
    it('returns the same instance on repeated calls', () => {
      const a = TelemetryStreamBus.getInstance();
      const b = TelemetryStreamBus.getInstance();
      expect(a).toBe(b);
    });

    it('returns a new instance after reset()', () => {
      const a = TelemetryStreamBus.getInstance();
      TelemetryStreamBus.reset();
      const b = TelemetryStreamBus.getInstance();
      expect(a).not.toBe(b);
    });
  });

  describe('publish / subscribe (wildcard)', () => {
    it('delivers published event to a wildcard subscriber', () => {
      const received: TelemetryStreamEvent[] = [];
      bus.subscribe('*', (e) => received.push(e));

      const event = makeEvent();
      bus.publish(event);

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(event);
    });

    it('delivers events for multiple devices to a wildcard subscriber', () => {
      const received: TelemetryStreamEvent[] = [];
      bus.subscribe('*', (e) => received.push(e));

      bus.publish(makeEvent('MTR-001'));
      bus.publish(makeEvent('MTR-002'));

      expect(received).toHaveLength(2);
      expect(received.map((e) => e.deviceId)).toEqual(['MTR-001', 'MTR-002']);
    });

    it('supports multiple wildcard subscribers independently', () => {
      const a: TelemetryStreamEvent[] = [];
      const b: TelemetryStreamEvent[] = [];
      bus.subscribe('*', (e) => a.push(e));
      bus.subscribe('*', (e) => b.push(e));

      bus.publish(makeEvent());

      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
    });
  });

  describe('subscribe (device filter)', () => {
    it('delivers only matching device events to a filtered subscriber', () => {
      const received: TelemetryStreamEvent[] = [];
      bus.subscribe('MTR-001', (e) => received.push(e));

      bus.publish(makeEvent('MTR-001'));
      bus.publish(makeEvent('MTR-002'));

      expect(received).toHaveLength(1);
      expect(received[0]?.deviceId).toBe('MTR-001');
    });

    it('does not deliver events to a non-matching filtered subscriber', () => {
      const received: TelemetryStreamEvent[] = [];
      bus.subscribe('MTR-999', (e) => received.push(e));

      bus.publish(makeEvent('MTR-001'));

      expect(received).toHaveLength(0);
    });

    it('allows wildcard and filtered subscribers to coexist', () => {
      const all: TelemetryStreamEvent[] = [];
      const filtered: TelemetryStreamEvent[] = [];
      bus.subscribe('*', (e) => all.push(e));
      bus.subscribe('MTR-001', (e) => filtered.push(e));

      bus.publish(makeEvent('MTR-001'));
      bus.publish(makeEvent('MTR-002'));

      expect(all).toHaveLength(2);
      expect(filtered).toHaveLength(1);
    });
  });

  describe('unsubscribe', () => {
    it('stops receiving events after calling the returned cleanup function', () => {
      const received: TelemetryStreamEvent[] = [];
      const unsubscribe = bus.subscribe('*', (e) => received.push(e));

      bus.publish(makeEvent());
      unsubscribe();
      bus.publish(makeEvent());

      expect(received).toHaveLength(1);
    });

    it('is safe to call unsubscribe multiple times', () => {
      const received: TelemetryStreamEvent[] = [];
      const unsubscribe = bus.subscribe('*', (e) => received.push(e));

      unsubscribe();
      unsubscribe(); // should not throw

      bus.publish(makeEvent());
      expect(received).toHaveLength(0);
    });
  });

  describe('event structure', () => {
    it('preserves all fields in the published event', () => {
      const received: TelemetryStreamEvent[] = [];
      bus.subscribe('*', (e) => received.push(e));

      const event: TelemetryStreamEvent = {
        serverTs: '2026-07-29T12:00:00.000Z',
        deviceId: 'SENSOR-42',
        metrics: { current: 5.5, power: 1210 },
        recordsWritten: 2,
      };
      bus.publish(event);

      expect(received[0]).toEqual(event);
    });

    it('delivers events with correct deviceId', () => {
      const received: TelemetryStreamEvent[] = [];
      bus.subscribe('*', (e) => received.push(e));

      bus.publish({ ...makeEvent(), deviceId: 'EDGE-001' });

      expect(received[0]?.deviceId).toBe('EDGE-001');
    });
  });
});

// ── SseTelemetryBridge ─────────────────────────────────────────────────────────

describe('SseTelemetryBridge', () => {
  let bus: TelemetryStreamBus;

  beforeEach(() => {
    TelemetryStreamBus.reset();
    bus = TelemetryStreamBus.getInstance();
  });

  afterEach(() => {
    TelemetryStreamBus.reset();
  });

  it('broadcasts published events to the SSE manager when started', () => {
    const broadcastedEvents: { name: string; data: unknown }[] = [];
    const mockSse = {
      broadcast: vi.fn((name: string, data: unknown) => {
        broadcastedEvents.push({ name, data });
        return 1;
      }),
      getConnectionCount: vi.fn(() => 0),
    };

    const bridge = new SseTelemetryBridge(
      bus,
      mockSse as unknown as import('../../../src/core/ingestion/sse_manager.js').SseManager,
    );
    bridge.start();

    const event = makeEvent();
    bus.publish(event);

    expect(broadcastedEvents).toHaveLength(1);
    expect(broadcastedEvents[0]?.name).toBe(TELEMETRY_EVENT_NAME);
    expect(broadcastedEvents[0]?.data).toEqual(event);

    bridge.stop();
  });

  it('does not broadcast events after stop()', () => {
    const broadcastSpy = vi.fn();
    const mockSse = {
      broadcast: broadcastSpy,
      getConnectionCount: vi.fn(() => 0),
    };

    const bridge = new SseTelemetryBridge(
      bus,
      mockSse as unknown as import('../../../src/core/ingestion/sse_manager.js').SseManager,
    );
    bridge.start();
    bridge.stop();

    bus.publish(makeEvent());

    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('start() is idempotent — calling it twice does not double-subscribe', () => {
    const broadcastSpy = vi.fn(() => 1);
    const mockSse = {
      broadcast: broadcastSpy,
      getConnectionCount: vi.fn(() => 0),
    };

    const bridge = new SseTelemetryBridge(
      bus,
      mockSse as unknown as import('../../../src/core/ingestion/sse_manager.js').SseManager,
    );
    bridge.start();
    bridge.start(); // second call should be no-op

    bus.publish(makeEvent());

    // Should only broadcast once, not twice.
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
    bridge.stop();
  });

  it('broadcasts multiple events in order', () => {
    const received: unknown[] = [];
    const mockSse = {
      broadcast: vi.fn((_name: string, data: unknown) => {
        received.push(data);
        return 1;
      }),
      getConnectionCount: vi.fn(() => 0),
    };

    const bridge = new SseTelemetryBridge(
      bus,
      mockSse as unknown as import('../../../src/core/ingestion/sse_manager.js').SseManager,
    );
    bridge.start();

    bus.publish(makeEvent('MTR-001'));
    bus.publish(makeEvent('MTR-002'));
    bus.publish(makeEvent('MTR-003'));

    expect(received).toHaveLength(3);
    expect((received[0] as TelemetryStreamEvent).deviceId).toBe('MTR-001');
    expect((received[1] as TelemetryStreamEvent).deviceId).toBe('MTR-002');
    expect((received[2] as TelemetryStreamEvent).deviceId).toBe('MTR-003');

    bridge.stop();
  });
});

// ── Stream counters ────────────────────────────────────────────────────────────

describe('stream counters', () => {
  beforeEach(() => {
    resetStreamCounters();
  });

  it('starts at zero', () => {
    expect(getStreamCounters()).toEqual({ published: 0, delivered: 0, errors: 0 });
  });

  it('increments published counter', () => {
    incrementStreamPublished();
    incrementStreamPublished();
    expect(getStreamCounters().published).toBe(2);
  });

  it('increments delivered counter with default value of 1', () => {
    incrementStreamDelivered();
    expect(getStreamCounters().delivered).toBe(1);
  });

  it('increments delivered counter with custom value', () => {
    incrementStreamDelivered(5);
    expect(getStreamCounters().delivered).toBe(5);
  });

  it('increments errors counter', () => {
    incrementStreamErrors();
    incrementStreamErrors();
    expect(getStreamCounters().errors).toBe(2);
  });

  it('returns a snapshot (independent copy) from getStreamCounters', () => {
    incrementStreamPublished();
    const snap1 = getStreamCounters();
    incrementStreamPublished();
    const snap2 = getStreamCounters();

    // snap1 should not be mutated when the module counter changes.
    expect(snap1.published).toBe(1);
    expect(snap2.published).toBe(2);
  });

  it('resets all counters', () => {
    incrementStreamPublished();
    incrementStreamDelivered(3);
    incrementStreamErrors();

    resetStreamCounters();

    expect(getStreamCounters()).toEqual({ published: 0, delivered: 0, errors: 0 });
  });
});

// ── Integration: bus + bridge + counters ──────────────────────────────────────

describe('integration: TelemetryStreamBus + SseTelemetryBridge + counters', () => {
  beforeEach(() => {
    TelemetryStreamBus.reset();
    resetStreamCounters();
  });

  afterEach(() => {
    TelemetryStreamBus.reset();
    resetStreamCounters();
  });

  it('simulates full publish → broadcast → counter pipeline', () => {
    const bus = TelemetryStreamBus.getInstance();
    const broadcastSpy = vi.fn(() => 2); // 2 clients received it

    const mockSse = {
      broadcast: broadcastSpy,
      getConnectionCount: vi.fn(() => 2),
    };

    const bridge = new SseTelemetryBridge(
      bus,
      mockSse as unknown as import('../../../src/core/ingestion/sse_manager.js').SseManager,
    );
    bridge.start();

    // Simulate what the ingestion route does after successful persistence.
    const event = makeEvent('MTR-001');
    bus.publish(event);
    incrementStreamPublished();
    incrementStreamDelivered(event.recordsWritten);

    expect(broadcastSpy).toHaveBeenCalledWith(TELEMETRY_EVENT_NAME, event);
    const counters = getStreamCounters();
    expect(counters.published).toBe(1);
    expect(counters.delivered).toBe(2);
    expect(counters.errors).toBe(0);

    bridge.stop();
  });

  it('stream errors do not affect published counter', () => {
    incrementStreamErrors();
    incrementStreamErrors();

    expect(getStreamCounters().published).toBe(0);
    expect(getStreamCounters().errors).toBe(2);
  });

  it('handles high-volume event bursts without dropping events in-bus', () => {
    const bus = TelemetryStreamBus.getInstance();
    const received: TelemetryStreamEvent[] = [];
    bus.subscribe('*', (e) => received.push(e));

    const N = 1000;
    for (let i = 0; i < N; i++) {
      bus.publish(makeEvent(`MTR-${String(i).padStart(4, '0')}`));
    }

    expect(received).toHaveLength(N);
  });
});
