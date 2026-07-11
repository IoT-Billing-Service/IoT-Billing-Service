'use client';

import { create } from 'zustand';
import { shallow } from 'zustand/shallow';
import type { DeviceTelemetry } from '@/types';

interface DeviceStore {
  telemetryData: DeviceTelemetry[];
  deviceFilter: string | null;
  setDeviceFilter: (filter: string | null) => void;
  addTelemetryData: (data: DeviceTelemetry) => void;
}

// Stable selectors
export const selectTelemetryData = (state: DeviceStore) => state.telemetryData;
export const selectDeviceFilter = (state: DeviceStore) => state.deviceFilter;
export const selectSetDeviceFilter = (state: DeviceStore) => state.setDeviceFilter;
export const selectAddTelemetryData = (state: DeviceStore) => state.addTelemetryData;

export const useDeviceStore = create<DeviceStore>((set) => ({
  telemetryData: [],
  deviceFilter: null,
  setDeviceFilter: (filter: string | null) => set({ deviceFilter: filter }),
  addTelemetryData: (data: DeviceTelemetry) =>
    set((state) => ({
      telemetryData: [...state.telemetryData, data],
    })),
}));

export { shallow };
