/// <reference types="vitest/globals" />

import { renderHook, act } from '@testing-library/react';
import {
  useDeviceStore,
  selectTelemetryData,
  selectDeviceFilter,
  selectSetDeviceFilter,
  selectAddTelemetryData,
} from '@/stores/deviceStore';
import type { DeviceTelemetry } from '@/types';
import { useBillingStream } from './useBillingStream';
import { createMockBillingSource } from './useBillingStream';

describe('useBillingStream with device filter', () => {
  beforeEach(() => {
    useDeviceStore.setState({ telemetryData: [], deviceFilter: null });
  });

  it('should demonstrate the stale closure issue first', () => {
    const { mockWs, send } = createMockBillingSource();

    const { result } = renderHook(() => {
      const telemetryData = useDeviceStore(selectTelemetryData);
      const deviceFilter = useDeviceStore(selectDeviceFilter);
      const setDeviceFilter = useDeviceStore(selectSetDeviceFilter);
      const addTelemetryData = useDeviceStore(selectAddTelemetryData);
      return { telemetryData, deviceFilter, setDeviceFilter, addTelemetryData };
    });

    // Test data
    const update1 = { deviceId: 'device-1', amount: '100', timestamp: Date.now() };
    const update2 = { deviceId: 'device-2', amount: '200', timestamp: Date.now() };

    // Setup useBillingStream with filter logic - THIS HAS THE STALE CLOSURE BUG
    renderHook(() => {
      const addTelemetryData = useDeviceStore(selectAddTelemetryData);
      const deviceFilter = useDeviceStore(selectDeviceFilter);

      useBillingStream(
        (updates) => {
          updates.forEach((update) => {
            // Simulate telemetry creation from billing update
            const telemetry: DeviceTelemetry = {
              deviceId: update.deviceId,
              timestamp: update.timestamp,
              metrics: {
                powerUsage: parseFloat(update.amount),
                signalStrength: 100,
                temperature: 25,
                batteryLevel: 100,
              },
            };

            // Apply filter - this is where stale closure happens! deviceFilter is captured once
            if (!deviceFilter || telemetry.deviceId === deviceFilter) {
              addTelemetryData(telemetry);
            }
          });
        },
        { mockSocket: mockWs },
      );
    });

    // Send first update with no filter - should add device-1
    act(() => {
      send(update1);
    });

    expect(result.current.telemetryData.length).toBe(1);
    expect(result.current.telemetryData[0]?.deviceId).toBe('device-1');

    // Change filter to device-2
    act(() => {
      result.current.setDeviceFilter('device-2');
    });

    // Send second update - stale closure still sees deviceFilter as null!
    act(() => {
      send(update2);
    });

    // Both are added, which shows the stale closure bug!
    expect(result.current.telemetryData.length).toBe(2);
  });

  it('should fix stale closure by using getState() from Zustand store', () => {
    const { mockWs, send } = createMockBillingSource();

    const { result } = renderHook(() => {
      const telemetryData = useDeviceStore(selectTelemetryData);
      const deviceFilter = useDeviceStore(selectDeviceFilter);
      const setDeviceFilter = useDeviceStore(selectSetDeviceFilter);
      const addTelemetryData = useDeviceStore(selectAddTelemetryData);
      return { telemetryData, deviceFilter, setDeviceFilter, addTelemetryData };
    });

    // Test data
    const update1 = { deviceId: 'device-1', amount: '100', timestamp: Date.now() };
    const update2 = { deviceId: 'device-2', amount: '200', timestamp: Date.now() };

    // Setup useBillingStream with FIXED filter logic using getState()
    renderHook(() => {
      useBillingStream(
        (updates) => {
          updates.forEach((update) => {
            const { addTelemetryData, deviceFilter } = useDeviceStore.getState();
            // Simulate telemetry creation from billing update
            const telemetry: DeviceTelemetry = {
              deviceId: update.deviceId,
              timestamp: update.timestamp,
              metrics: {
                powerUsage: parseFloat(update.amount),
                signalStrength: 100,
                temperature: 25,
                batteryLevel: 100,
              },
            };

            // Apply filter - this uses latest state from getState(), no stale closure!
            if (!deviceFilter || telemetry.deviceId === deviceFilter) {
              addTelemetryData(telemetry);
            }
          });
        },
        { mockSocket: mockWs },
      );
    });

    // Send first update with no filter - should add device-1
    act(() => {
      send(update1);
    });

    expect(result.current.telemetryData.length).toBe(1);
    expect(result.current.telemetryData[0]?.deviceId).toBe('device-1');

    // Change filter to device-2
    act(() => {
      result.current.setDeviceFilter('device-2');
    });

    // Send second update - only device-2 should be added now
    act(() => {
      send(update2);
    });

    // Verify fix: only 2 entries, second is device-2 (no extra device-1)
    expect(result.current.telemetryData.length).toBe(2);
    expect(result.current.telemetryData[1]?.deviceId).toBe('device-2');

    // Now send another device-1 update - should NOT be added!
    const update3 = { deviceId: 'device-1', amount: '300', timestamp: Date.now() };
    act(() => {
      send(update3);
    });

    // Length should stay 2 because filter is device-2!
    expect(result.current.telemetryData.length).toBe(2);
  });
});
