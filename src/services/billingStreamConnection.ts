'use client';

import { useSyncExternalStore } from 'react';

export type BillingStreamConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected';

export interface BillingStreamConnectionSnapshot {
  state: BillingStreamConnectionState;
  backoffDelayMs: number;
  lastChangedAt: number;
}

let snapshot: BillingStreamConnectionSnapshot = {
  state: 'idle',
  backoffDelayMs: 0,
  lastChangedAt: Date.now(),
};

const listeners = new Set<() => void>();

export function setBillingStreamConnectionState(
  state: BillingStreamConnectionState,
  backoffDelayMs = 0,
): void {
  snapshot = { state, backoffDelayMs, lastChangedAt: Date.now() };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): BillingStreamConnectionSnapshot {
  return snapshot;
}

export function useBillingStreamConnectionStatus(): BillingStreamConnectionSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
