'use client';

import { useMemo, useState } from 'react';
import { useDeviceTelemetry } from '@/hooks/useDeviceTelemetry';
import { useDeviceStatusStream, type DeviceStatusUpdate } from '@/hooks/useDeviceStatusStream';
import type { FleetDevice } from '@/types';

interface FleetDeviceGridProps {
  fleetId: string | null;
}

/**
 * Generates deterministic mock devices for a given fleet.
 * In production these come from a fleet-management API.
 */
function generateMockDevices(fleetId: string): FleetDevice[] {
  if (!fleetId) return [];
  const count = fleetId === 'fleet-gamma' ? 48 : fleetId === 'fleet-alpha' ? 36 : 24;
  const devices: FleetDevice[] = [];
  const statuses: FleetDevice['status'][] = [
    'online',
    'online',
    'online',
    'online',
    'online',
    'offline',
    'degraded',
  ];

  for (let i = 0; i < count; i++) {
    const status = statuses[i % statuses.length] ?? 'online';
    devices.push({
      deviceId: `${fleetId}-dev-${i}`,
      fleetId,
      name: `Device-${i.toString().padStart(3, '0')}`,
      status,
      lastSeen: Date.now() - Math.random() * 120_000,
      metrics: {
        powerUsage: 10 + Math.random() * 90,
        signalStrength: -90 + Math.random() * 40,
        temperature: 25 + Math.random() * 30,
        batteryLevel: 20 + Math.random() * 80,
        dataRate: 100 + Math.random() * 900,
      },
      location: {
        lat: 25 + Math.random() * 40,
        lng: -120 + Math.random() * 60,
      },
    });
  }
  return devices;
}

function DeviceStatusDot({ status }: { status: FleetDevice['status'] }) {
  const colors: Record<FleetDevice['status'], string> = {
    online: 'bg-green-400',
    offline: 'bg-gray-500',
    degraded: 'bg-amber-400',
    provisioning: 'bg-blue-400 animate-pulse',
  };

  return <span className={`inline-block h-2 w-2 rounded-full ${colors[status]}`} />;
}

export function FleetDeviceGrid({ fleetId }: FleetDeviceGridProps) {
  const [filterStatus, setFilterStatus] = useState<FleetDevice['status'] | 'all'>('all');
  const [streamUpdates, setStreamUpdates] = useState<Map<string, DeviceStatusUpdate>>(new Map());

  // Subscribe to real-time device status stream
  useDeviceStatusStream((updates: DeviceStatusUpdate[]) => {
    setStreamUpdates((prev) => {
      const next = new Map(prev);
      for (const u of updates) {
        next.set(u.deviceId, u);
      }
      return next;
    });
  });

  const devices = useMemo(() => generateMockDevices(fleetId ?? ''), [fleetId]);

  // Apply status stream updates to devices
  const liveDevices = useMemo(() => {
    if (streamUpdates.size === 0) return devices;
    return devices.map((d) => {
      const streamUpdate = streamUpdates.get(d.deviceId);
      if (streamUpdate) {
        // Map DeviceStatusValue to FleetDevice status
        const statusMap: Record<string, FleetDevice['status']> = {
          active: 'online',
          idle: 'online',
          alert: 'degraded',
          offline: 'offline',
        };
        return {
          ...d,
          status: (statusMap[streamUpdate.status] ?? d.status) as FleetDevice['status'],
          lastSeen: streamUpdate.timestamp,
        };
      }
      return d;
    });
  }, [devices, streamUpdates]);

  const filtered = useMemo(() => {
    if (filterStatus === 'all') return liveDevices;
    return liveDevices.filter((d) => d.status === filterStatus);
  }, [liveDevices, filterStatus]);

  // Fetch telemetry for the visible devices
  const deviceIds = useMemo(() => devices.map((d) => d.deviceId), [devices]);
  const { data: telemetry } = useDeviceTelemetry(deviceIds);

  // Merge telemetry into devices for display
  const enrichedDevices = useMemo(() => {
    if (!telemetry) return filtered;
    const telMap = new Map(telemetry.map((t) => [t.deviceId, t]));
    return filtered.map((d) => {
      const tel = telMap.get(d.deviceId);
      if (tel) {
        return {
          ...d,
          metrics: {
            ...d.metrics,
            powerUsage: tel.metrics.powerUsage,
            signalStrength: tel.metrics.signalStrength,
            temperature: tel.metrics.temperature,
            batteryLevel: tel.metrics.batteryLevel,
          },
        };
      }
      return d;
    });
  }, [filtered, telemetry]);

  if (!fleetId) {
    return (
      <div className="flex items-center justify-center h-64 rounded-lg border border-dashed border-gray-700">
        <p className="text-sm text-gray-500">
          Select a fleet from the overview to view its devices.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex items-center gap-2 text-sm">
        <span className="text-gray-400">Status:</span>
        {(['all', 'online', 'offline', 'degraded'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setFilterStatus(s)}
            className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
              filterStatus === s
                ? 'bg-green-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
            }`}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
        <span className="ml-auto text-xs text-gray-500">
          {filtered.length} device{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Device grid */}
      {enrichedDevices.length === 0 ? (
        <div className="flex items-center justify-center h-48 rounded-lg border border-dashed border-gray-700">
          <p className="text-sm text-gray-500">No devices match the current filter.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {enrichedDevices.map((device) => (
            <div
              key={device.deviceId}
              className="rounded-lg border border-gray-700 bg-gray-900 p-4 transition-colors hover:border-gray-600"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <DeviceStatusDot status={device.status} />
                  <span className="text-sm font-medium text-white truncate max-w-[140px]">
                    {device.name}
                  </span>
                </div>
                <a
                  href={`/dashboard?device=${device.deviceId}`}
                  className="text-[10px] text-gray-500 hover:text-green-400 transition-colors"
                >
                  Details
                </a>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <div className="flex justify-between">
                  <span className="text-gray-500">Power</span>
                  <span className="font-mono text-gray-300">
                    {device.metrics.powerUsage.toFixed(1)} W
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Signal</span>
                  <span className="font-mono text-gray-300">
                    {device.metrics.signalStrength.toFixed(1)} dBm
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Temp</span>
                  <span className="font-mono text-gray-300">
                    {device.metrics.temperature.toFixed(1)} °C
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Battery</span>
                  <span className="font-mono text-gray-300">
                    {device.metrics.batteryLevel.toFixed(0)}%
                  </span>
                </div>
                <div className="flex justify-between col-span-2">
                  <span className="text-gray-500">Data Rate</span>
                  <span className="font-mono text-gray-300">
                    {device.metrics.dataRate.toFixed(0)} kbps
                  </span>
                </div>
              </div>

              <p className="mt-2 text-[10px] text-gray-600">
                Last seen: {new Date(device.lastSeen).toLocaleTimeString()}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
