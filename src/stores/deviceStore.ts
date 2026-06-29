'use client';

import { create } from 'zustand';
import type { DeviceTelemetry } from '@/types';

interface DeviceStore {
  telemetryData: DeviceTelemetry[];
  deviceFilter: string | null;
  setDeviceFilter: (filter: string | null) => void;
  addTelemetryData: (data: DeviceTelemetry) => void;
}

export const useDeviceStore = create<DeviceStore>((set) => ({
  telemetryData: [],
  deviceFilter: null,
  setDeviceFilter: (filter: string | null) => set({ deviceFilter: filter }),
  addTelemetryData: (data: DeviceTelemetry) =>
    set((state) => ({
      telemetryData: [...state.telemetryData, data],
    })),
}));
