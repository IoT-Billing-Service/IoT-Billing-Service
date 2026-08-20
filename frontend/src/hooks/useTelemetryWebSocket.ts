'use client';

import { useEffect, useRef, useState } from 'react';
import { getCurrentAuthSession } from '@/services/authSession';

export interface TelemetryStreamEvent {
  serverTs: string;
  deviceId: string;
  metrics: Record<string, number>;
  recordsWritten: number;
}

export type TelemetrySocketState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000] as const;

export function isTelemetryStreamEvent(value: unknown): value is TelemetryStreamEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Partial<TelemetryStreamEvent>;
  return (
    typeof event.serverTs === 'string' &&
    typeof event.deviceId === 'string' &&
    typeof event.metrics === 'object' &&
    event.metrics !== null &&
    typeof event.recordsWritten === 'number'
  );
}

function getWebSocketUrl(token: string): string {
  const configured = process.env.NEXT_PUBLIC_WS_URL;
  const url = new URL(configured ?? '/api/billing/stream', window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', token);
  return url.toString();
}

export function useTelemetryWebSocket(onEvent: (event: TelemetryStreamEvent) => void) {
  const handlerRef = useRef(onEvent);
  const [state, setState] = useState<TelemetrySocketState>('idle');
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);

  useEffect(() => {
    handlerRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const connect = async () => {
      const session = await getCurrentAuthSession();
      if (cancelled) return;
      if (!session) {
        setState('disconnected');
        return;
      }

      setState(attempt === 0 ? 'connecting' : 'reconnecting');
      socket = new WebSocket(getWebSocketUrl(session.jwt));
      socket.onopen = () => {
        attempt = 0;
        setState('connected');
      };
      socket.onmessage = (message) => {
        try {
          const value: unknown = JSON.parse(message.data as string);
          if (isTelemetryStreamEvent(value)) {
            setLastEventAt(Date.now());
            handlerRef.current(value);
          }
        } catch {
          // Ignore malformed or control frames.
        }
      };
      socket.onclose = () => {
        if (cancelled) return;
        const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 30000;
        attempt += 1;
        setState('reconnecting');
        reconnectTimer = setTimeout(() => void connect(), delay);
      };
    };

    void connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
      setState('disconnected');
    };
  }, []);

  return { state, lastEventAt };
}