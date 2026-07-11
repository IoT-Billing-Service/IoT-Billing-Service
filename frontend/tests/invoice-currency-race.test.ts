import { describe, it, expect } from 'vitest';
import { formatCurrencyCell } from '@/hooks/useCurrencyFormatter';
import { useCurrencyPref } from '@/stores/useCurrencyPref';

/* ─── Currency formatter cache tests ─────────────────── */

describe('useCurrencyFormatter', () => {
  describe('formatCurrencyCell', () => {
    it('formats USD amounts correctly', () => {
      expect(formatCurrencyCell(1234.56, 'USD')).toBe('$1,234.56');
      expect(formatCurrencyCell(0, 'USD')).toBe('$0.00');
      expect(formatCurrencyCell(1000000, 'USD')).toBe('$1,000,000.00');
    });

    it('formats EUR amounts correctly', () => {
      expect(formatCurrencyCell(1234.56, 'EUR')).toBe('€1,234.56');
      expect(formatCurrencyCell(99.99, 'EUR')).toBe('€99.99');
    });

    it('formats NGN amounts correctly', () => {
      expect(formatCurrencyCell(5000, 'NGN')).toBe('NGN\u00a05,000.00');
    });

    it('reuses cached Intl.NumberFormat instances', () => {
      const result1 = formatCurrencyCell(100, 'USD');
      const result2 = formatCurrencyCell(200, 'USD');
      const result3 = formatCurrencyCell(100, 'EUR');
      const result4 = formatCurrencyCell(200, 'EUR');

      expect(result1).toBe('$100.00');
      expect(result2).toBe('$200.00');
      expect(result3).toBe('€100.00');
      expect(result4).toBe('€200.00');
    });
  });
});

/* ─── Currency preference store tests ────────────────── */

describe('useCurrencyPref', () => {
  it('defaults to USD with version 0', () => {
    const state = useCurrencyPref.getState();
    expect(state.currency).toBe('USD');
    expect(state.currencyVersion).toBe(0);
  });

  it('setCurrency increments version', () => {
    useCurrencyPref.getState().setCurrency('EUR');
    const state = useCurrencyPref.getState();
    expect(state.currency).toBe('EUR');
    expect(state.currencyVersion).toBe(1);
  });

  it('setCurrency to same currency still increments version', () => {
    useCurrencyPref.getState().setCurrency('EUR');
    const state = useCurrencyPref.getState();
    expect(state.currencyVersion).toBe(2);
  });

  it('queues telemetry updates during interaction', () => {
    useCurrencyPref.getState().setUserInteracting(true);
    useCurrencyPref.getState().queueTelemetryUpdate({ deviceId: 'd1', amount: '100' });
    useCurrencyPref.getState().queueTelemetryUpdate({ deviceId: 'd2', amount: '200' });

    const state = useCurrencyPref.getState();
    expect(state.isUserInteracting).toBe(true);
    expect(state.pendingQueue).toHaveLength(2);
    expect(state.pendingQueue[0]).toEqual({ deviceId: 'd1', amount: '100' });
  });

  it('setUserInteracting(false) preserves the queue for the hook to deliver', () => {
    // Reset state
    useCurrencyPref.setState({
      currency: 'USD',
      currencyVersion: 0,
      isUserInteracting: true,
      pendingQueue: [
        { deviceId: 'd1', amount: '100' },
        { deviceId: 'd2', amount: '200' },
      ],
    });

    // End interaction — the store must NOT clear the queue itself. The
    // billing-stream hook delivers the queued updates to its handler first and
    // only then calls flushPendingQueue. Clearing here would drop them.
    useCurrencyPref.getState().setUserInteracting(false);

    const state = useCurrencyPref.getState();
    expect(state.isUserInteracting).toBe(false);
    expect(state.pendingQueue).toHaveLength(2);
  });

  it('flushPendingQueue clears queue', () => {
    useCurrencyPref.setState({
      pendingQueue: [{ deviceId: 'd1', amount: '100' }],
    });

    useCurrencyPref.getState().flushPendingQueue();
    const state = useCurrencyPref.getState();
    expect(state.pendingQueue).toHaveLength(0);
  });
});

/* ─── Race condition scenario tests ──────────────────── */

describe('Race condition: currency switch + telemetry', () => {
  it('queues telemetry updates during currency switch interaction', () => {
    // Simulate user starting currency switch
    useCurrencyPref.getState().setUserInteracting(true);

    // Telemetry update arrives during interaction — should be queued
    useCurrencyPref.getState().queueTelemetryUpdate({ deviceId: 'd1', amount: '150' });

    const state = useCurrencyPref.getState();
    expect(state.isUserInteracting).toBe(true);
    expect(state.pendingQueue).toHaveLength(1);
    expect(state.pendingQueue[0]!.amount).toBe('150');
  });

  it('no queuing when not interacting', () => {
    useCurrencyPref.setState({ isUserInteracting: false, pendingQueue: [] });

    // Telemetry update arrives outside interaction
    useCurrencyPref.getState().queueTelemetryUpdate({ deviceId: 'd1', amount: '150' });

    const state = useCurrencyPref.getState();
    expect(state.pendingQueue).toHaveLength(1);
  });
});
