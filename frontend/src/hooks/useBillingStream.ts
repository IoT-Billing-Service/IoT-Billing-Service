'use client';

import { useEffect, useRef } from 'react';
import { useCurrencyPref } from '@/stores/useCurrencyPref';
import { refreshToken, validateToken } from '@/services/authSession';
import { setBillingStreamConnectionState } from '@/services/billingStreamConnection';

export interface BillingUpdate {
  deviceId: string;
  amount: string; // Raw u128 string from Soroban
  timestamp: number;
}

export type BillingUpdateHandler = (updates: BillingUpdate[]) => void;

type BillingStreamControlMessage =
  | { type: 'token_expiring'; expires_in: number }
  | { type: 'pong' };

const PING_INTERVAL = 30_000;
const PONG_TIMEOUT = 5_000;
const AUTH_PROPAGATION_GRACE_MS = 150;
const BACKOFF_DELAYS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000] as const;

function isControlMessage(message: unknown): message is BillingStreamControlMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    ((message as { type: unknown }).type === 'token_expiring' ||
      (message as { type: unknown }).type === 'pong')
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function refreshAndValidateToken(): Promise<string> {
  const session = await refreshToken();
  await delay(AUTH_PROPAGATION_GRACE_MS);
  const isValid = await validateToken(session.jwt);
  if (!isValid) throw new Error('Refreshed token failed validation');
  return session.jwt;
}

function streamUrl(jwt?: string): string {
  const url = new URL('/api/billing/stream', window.location.href);
  if (jwt) url.searchParams.set('token', jwt);
  return url.toString().replace(/^http/, 'ws');
}

/**
 * Hook that opens a WebSocket connection for billing telemetry updates.
 * When the currency selector interaction is active (isUserInteracting=true),
 * incoming updates are queued in the CurrencyPref store instead of being
 * emitted. The queue is flushed atomically when interaction ends.
 *
 * This prevents the race condition where a currency-format re-render is
 * interrupted mid-way by a telemetry update, resulting in mixed-currency
 * display.
 */
export function useBillingStream(
  handler: BillingUpdateHandler,
  options?: { mockSocket?: MockWebSocket },
) {
  const handlerRef = useRef(handler);
  const optionsRef = useRef(options);

  useEffect(() => {
    handlerRef.current = handler;
    optionsRef.current = options;
  }, [handler, options]);

  const isUserInteracting = useCurrencyPref((s) => s.isUserInteracting);
  const flushPendingQueue = useCurrencyPref((s) => s.flushPendingQueue);
  const pendingQueue = useCurrencyPref((s) => s.pendingQueue);

  // Open the billing socket once, on mount. Interaction state is read via
  // getState() inside onmessage rather than subscribed as an effect dependency,
  // so toggling the currency selector does NOT tear the socket down and
  // reconnect it (which would drop any messages arriving in the reconnect gap).
  useEffect(() => {
    let ws: WebSocket | MockWebSocket | null = null;
    let cancelled = false;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let pongTimer: ReturnType<typeof setTimeout> | null = null;

    const clearHealthTimers = () => {
      if (pingTimer) clearInterval(pingTimer);
      if (pongTimer) clearTimeout(pongTimer);
      pingTimer = null;
      pongTimer = null;
    };

    const scheduleReconnect = async (requiresFreshToken: boolean) => {
      if (cancelled) return;
      clearHealthTimers();

      const backoffDelayMs = BACKOFF_DELAYS[Math.min(reconnectAttempt, BACKOFF_DELAYS.length - 1)];
      setBillingStreamConnectionState('reconnecting', backoffDelayMs);
      reconnectAttempt += 1;

      try {
        const jwt = requiresFreshToken ? await refreshAndValidateToken() : undefined;
        reconnectTimer = setTimeout(
          () => {
            void connect(jwt);
          },
          requiresFreshToken ? 0 : backoffDelayMs,
        );
      } catch {
        reconnectTimer = setTimeout(() => {
          void scheduleReconnect(true);
        }, backoffDelayMs);
      }
    };

    const startHealthCheck = () => {
      clearHealthTimers();
      pingTimer = setInterval(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: 'ping' }));
        if (pongTimer) clearTimeout(pongTimer);
        pongTimer = setTimeout(() => {
          ws?.close();
          void scheduleReconnect(true);
        }, PONG_TIMEOUT);
      }, PING_INTERVAL);
    };

    const connect = async (jwt?: string) => {
      if (cancelled) return;
      setBillingStreamConnectionState(reconnectAttempt > 0 ? 'reconnecting' : 'connecting');
      ws = optionsRef.current?.mockSocket || new WebSocket(streamUrl(jwt));

      ws.onopen = () => {
        reconnectAttempt = 0;
        setBillingStreamConnectionState('connected');
        startHealthCheck();
      };

      ws.onmessage = (event: MessageEvent) => {
        try {
          const message = JSON.parse(event.data) as BillingUpdate | BillingStreamControlMessage;

          if (isControlMessage(message)) {
            if (message.type === 'pong') {
              if (pongTimer) clearTimeout(pongTimer);
              pongTimer = null;
            } else if (message.type === 'token_expiring' && message.expires_in <= 120) {
              void (async () => {
                const freshJwt = await refreshAndValidateToken();
                if (!cancelled) {
                  ws?.close();
                  void connect(freshJwt);
                }
              })();
            }
            return;
          }

          const update = message as BillingUpdate;
          const { isUserInteracting: interacting, queueTelemetryUpdate } =
            useCurrencyPref.getState();
          if (interacting) {
            // Queue the update — will be flushed when interaction ends
            queueTelemetryUpdate({ deviceId: update.deviceId, amount: update.amount });
          } else {
            handlerRef.current([update]);
          }
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onerror = () => {
        // WebSocket errors are non-fatal; the connection will reconnect on close
      };

      ws.onclose = (event: CloseEvent) => {
        if (cancelled) return;
        // For mock sockets, event.code might be undefined
        const requiresFreshToken = (event as CloseEvent).code === 4001;
        void scheduleReconnect(requiresFreshToken);
      };
    };

    void connect();

    return () => {
      cancelled = true;
      clearHealthTimers();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      setBillingStreamConnectionState('disconnected');
      ws?.close();
    };
  }, []);

  // When interaction ends, deliver the queued updates to the handler and THEN
  // clear the queue. The store no longer clears it on interaction end, so the
  // updates survive long enough to be delivered here (fixes silent data loss).
  useEffect(() => {
    if (!isUserInteracting && pendingQueue.length > 0) {
      const queuedUpdates: BillingUpdate[] = pendingQueue.map((q) => ({
        deviceId: q.deviceId,
        amount: q.amount,
        timestamp: Date.now(),
      }));
      handlerRef.current(queuedUpdates);
      flushPendingQueue();
    }
  }, [isUserInteracting, pendingQueue, flushPendingQueue]);
}

// Mock WebSocket interface for testing
export interface MockWebSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event?: { code?: number }) => void) | null;
  readyState: number;
  send: (data: string) => void;
  close: () => void;
}

/**
 * Creates a mock WebSocket-like source for testing.
 * Returns an object with a `send` method that simulates incoming messages.
 */
export function createMockBillingSource() {
  const mockWs: MockWebSocket = {
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    readyState: WebSocket.OPEN,
    send: () => {},
    close: () => {},
  };

  // Simulate immediate connection
  setTimeout(() => {
    mockWs.readyState = WebSocket.OPEN;
    mockWs.onopen?.();
  }, 0);

  return {
    mockWs,
    send: (update: BillingUpdate) => {
      mockWs.onmessage?.({ data: JSON.stringify(update) });
    },
  };
}
