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
 */
export function useTelemetry(busUrl?: string): TelemetryEvent | null {
  const [event, setEvent] = useState<TelemetryEvent | null>(null);
  const ws = useRef<WebSocket | null>(null);

  useEffect(() => {
    const url =
      busUrl ??
      import.meta.env.VITE_WS_URL ??
      'ws://localhost:8080/stream/telemetry';
    ws.current = new WebSocket(url);
    ws.current.onmessage = (msg) => {
      try {
        setEvent(JSON.parse(msg.data as string) as TelemetryEvent);
      } catch {
        /* ignore malformed frames */
      }
    };
    return () => ws.current?.close();
  }, [busUrl]);

  return event;
}
