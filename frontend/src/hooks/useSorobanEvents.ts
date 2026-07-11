'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import type { SorobanEvent, AppNotification } from '@/types';
import {
  decodeSorobanEvent,
  getEventSeverity,
  getEventTitle,
  buildNotificationMessage,
} from '@/utils/sorobanEventDecoder';
import { useNotificationStore } from '@/stores/useNotificationStore';
import { cacheGet } from '@/services/indexedDbCache';

interface EventFilter {
  contractId?: string;
  topics?: string[];
}

const RECONNECT_DELAY = 3000;
const MAX_RECONNECT_ATTEMPTS = 5;

function decodeRawEvent(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { raw };
  }
}

export function useSorobanEvents(filter?: EventFilter) {
  const [events, setEvents] = useState<SorobanEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttempts = useRef(0);
  const bufferRef = useRef<SorobanEvent[]>([]);
  const filterKey = JSON.stringify(filter);

  const flushBuffer = useCallback(() => {
    if (bufferRef.current.length > 0) {
      setEvents((prev) => [...bufferRef.current, ...prev].slice(0, 200));
      bufferRef.current = [];
    }
  }, []);

  useEffect(() => {
    // Restore undismissed critical notifications that survived page reload
    cacheGet<AppNotification[]>('notifications', 'pending-critical')
      .then((saved) => {
        if (saved?.length) {
          useNotificationStore.getState().hydrateCritical(saved);
        }
      })
      .catch(() => {});

    let flushInterval: ReturnType<typeof setInterval>;
    const parsed = filterKey ? (JSON.parse(filterKey) as EventFilter | undefined) : undefined;
    const connect = () => {
      const wsUrl = process.env.NEXT_PUBLIC_SOROBAN_WS_URL ?? 'ws://localhost:8000/events';
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        reconnectAttempts.current = 0;
        if (parsed) {
          ws.send(JSON.stringify({ type: 'subscribe', ...parsed }));
        }
        flushInterval = setInterval(flushBuffer, 500);
      };

      ws.onmessage = (msg) => {
        try {
          const raw = JSON.parse(msg.data) as SorobanEvent;
          const data = decodeRawEvent(raw.data);
          bufferRef.current.push({ ...raw, decoded: data });

          // Decode event and dispatch notification immediately (not via buffer)
          const topics = (raw.topics ?? [raw.topic]).filter(Boolean) as string[];
          const decoded = decodeSorobanEvent(topics, data);
          if (decoded) {
            const notification: AppNotification = {
              id: `${raw.contractId}-${raw.ledger}-${decoded.kind}`,
              severity: getEventSeverity(decoded.kind),
              title: getEventTitle(decoded.kind),
              message: buildNotificationMessage(decoded),
              event: decoded,
              timestamp: raw.timestamp,
              dismissed: false,
            };
            useNotificationStore.getState().add(notification);
          }
        } catch {
          // skip malformed messages
        }
      };

      ws.onclose = () => {
        setIsConnected(false);
        clearInterval(flushInterval);
        if (reconnectAttempts.current < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttempts.current++;
          setTimeout(connect, RECONNECT_DELAY * reconnectAttempts.current);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      clearInterval(flushInterval);
      wsRef.current?.close();
    };
  }, [filterKey, flushBuffer]);

  return { events, isConnected };
}
