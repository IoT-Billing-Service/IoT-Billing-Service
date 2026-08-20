import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TelemetryStreamBus,
  type TelemetryStreamEvent,
} from '../../../src/core/ingestion/telemetry_stream.js';
import { TelemetryWebSocketHub } from '../../../src/api/routes/telemetry_websocket.js';

function makeSocket() {
  return {
    readyState: 1,
    bufferedAmount: 0,
    send: vi.fn(),
    close: vi.fn(),
  } as any;
}

function makeEvent(deviceId: string): TelemetryStreamEvent {
  return {
    serverTs: '2026-08-20T12:00:00.000Z',
    deviceId,
    metrics: { powerUsage: 12.5 },
    recordsWritten: 1,
  };
}

describe('TelemetryWebSocketHub', () => {
  let bus: TelemetryStreamBus;
  let hub: TelemetryWebSocketHub;

  beforeEach(() => {
    TelemetryStreamBus.reset();
    bus = TelemetryStreamBus.getInstance();
    hub = new TelemetryWebSocketHub(bus);
  });

  it('delivers only events matching a device subscription', () => {
    const socket = makeSocket();
    const remove = hub.addClient(socket, 'MTR-001', Math.floor(Date.now() / 1000) + 600);

    bus.publish(makeEvent('MTR-001'));
    bus.publish(makeEvent('MTR-002'));

    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(socket.send.mock.calls[0][0])).toMatchObject({ deviceId: 'MTR-001' });
    remove();
  });

  it('answers application ping messages with pong', () => {
    const socket = makeSocket();
    hub.handleMessage(socket, JSON.stringify({ type: 'ping' }));
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'pong' }));
  });

  it('drops events when the socket write buffer is bounded', () => {
    const socket = makeSocket();
    socket.bufferedAmount = 1_048_577;
    const remove = hub.addClient(socket, '*', Math.floor(Date.now() / 1000) + 600);

    bus.publish(makeEvent('MTR-001'));

    expect(socket.send).not.toHaveBeenCalled();
    expect(hub.getStats().dropped).toBe(1);
    remove();
  });

  it('unsubscribes clients when removed', () => {
    const socket = makeSocket();
    const remove = hub.addClient(socket, '*', Math.floor(Date.now() / 1000) + 600);
    remove();
    bus.publish(makeEvent('MTR-001'));
    expect(socket.send).not.toHaveBeenCalled();
    expect(hub.getStats().connections).toBe(0);
  });
});