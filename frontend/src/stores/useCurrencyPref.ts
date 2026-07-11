import { create } from 'zustand';

export type CurrencyCode = 'USD' | 'EUR' | 'NGN';

export interface CurrencyPrefState {
  currency: CurrencyCode;
  currencyVersion: number;
  /** True while user is interacting with the currency selector (mouseDown → mouseUp/blur) */
  isUserInteracting: boolean;
  /** Billing telemetry updates queued during interaction */
  pendingQueue: Array<{ deviceId: string; amount: string }>;

  setCurrency: (currency: CurrencyCode) => void;
  setUserInteracting: (interacting: boolean) => void;
  queueTelemetryUpdate: (update: { deviceId: string; amount: string }) => void;
  flushPendingQueue: () => void;
}

export const useCurrencyPref = create<CurrencyPrefState>((set) => ({
  currency: 'USD',
  currencyVersion: 0,
  isUserInteracting: false,
  pendingQueue: [],

  setCurrency(newCurrency) {
    set((s) => ({
      currency: newCurrency,
      currencyVersion: s.currencyVersion + 1,
    }));
  },

  setUserInteracting(interacting) {
    // Only toggle the flag here. The queue is intentionally NOT cleared on
    // interaction end: the billing-stream hook must first deliver the queued
    // updates to its handler and then call flushPendingQueue(). Clearing here
    // would drop those updates before the hook could deliver them.
    set({ isUserInteracting: interacting });
  },

  queueTelemetryUpdate(update) {
    set((s) => ({ pendingQueue: [...s.pendingQueue, update] }));
  },

  flushPendingQueue() {
    set({ pendingQueue: [] });
  },
}));
