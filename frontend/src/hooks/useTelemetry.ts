import { useEffect, useRef, useState } from 'react';

export interface TelemetryEvent {
  type: string;
  device_id: string;
  units: number;
  cost: number;
  balance_after: number;
  seq: number;
}

/**
 * Subscribe to the backend telemetry WebSocket stream.
 *
 * Pass a `device` (G... address) to subscribe to that device's channel only;
 * the backend filters `meter_billed` broadcasts per-client.
 */
export function useTelemetry(
  busUrl?: string,
  device?: string,
): TelemetryEvent | null {
  const [event, setEvent] = useState<TelemetryEvent | null>(null);
  const ws = useRef<WebSocket | null>(null);

  useEffect(() => {
    const base =
      busUrl ??
      import.meta.env.VITE_WS_URL ??
      'ws://localhost:8080/stream/telemetry';
    const url = new URL(base);
    if (device) {
      url.searchParams.set('device', device);
    }
    ws.current = new WebSocket(url.toString());
    ws.current.onmessage = (msg) => {
      try {
        setEvent(JSON.parse(msg.data as string) as TelemetryEvent);
      } catch {
        /* ignore malformed frames */
      }
    };
    return () => ws.current?.close();
  }, [busUrl, device]);

  return event;
}
