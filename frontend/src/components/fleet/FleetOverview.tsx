'use client';

import { useMemo } from 'react';
import { useDeviceTelemetry, preAggregateFleetData } from '@/hooks/useDeviceTelemetry';
import type { FleetView } from '@/types';

interface FleetOverviewProps {
  selectedFleetId: string | null;
  onSelectFleet: (id: string | null) => void;
}

/**
 * Static mock fleets for demonstration. In production these would come from
 * a fleet-management API endpoint keyed by the authenticated tenant.
 */
const MOCK_FLEETS: FleetView[] = [
  {
    fleetId: 'fleet-alpha',
    name: 'Alpha — North America',
    deviceCount: 248,
    activeCount: 234,
    totalPowerOutput: 14230,
    status: 'active',
  },
  {
    fleetId: 'fleet-beta',
    name: 'Beta — Europe',
    deviceCount: 156,
    activeCount: 142,
    totalPowerOutput: 8920,
    status: 'active',
  },
  {
    fleetId: 'fleet-gamma',
    name: 'Gamma — Asia-Pacific',
    deviceCount: 312,
    activeCount: 287,
    totalPowerOutput: 18740,
    status: 'active',
  },
  {
    fleetId: 'fleet-delta',
    name: 'Delta — South America',
    deviceCount: 89,
    activeCount: 67,
    totalPowerOutput: 4120,
    status: 'degraded',
  },
  {
    fleetId: 'fleet-epsilon',
    name: 'Epsilon — Africa (Deploy)',
    deviceCount: 42,
    activeCount: 38,
    totalPowerOutput: 2100,
    status: 'active',
  },
  {
    fleetId: 'fleet-zeta',
    name: 'Zeta — Oceania',
    deviceCount: 73,
    activeCount: 0,
    totalPowerOutput: 0,
    status: 'inactive',
  },
];

function StatusBadge({ status }: { status: FleetView['status'] }) {
  const colors: Record<FleetView['status'], string> = {
    active: 'bg-green-500/20 text-green-300 border-green-500/40',
    degraded: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
    inactive: 'bg-gray-500/20 text-gray-300 border-gray-500/40',
  };

  const labels: Record<FleetView['status'], string> = {
    active: 'Active',
    degraded: 'Degraded',
    inactive: 'Inactive',
  };

  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${colors[status]}`}
    >
      <span
        className={`mr-1.5 h-1.5 w-1.5 rounded-full ${
          status === 'active'
            ? 'bg-green-400'
            : status === 'degraded'
              ? 'bg-amber-400'
              : 'bg-gray-400'
        }`}
      />
      {labels[status]}
    </span>
  );
}

export function FleetOverview({ selectedFleetId, onSelectFleet }: FleetOverviewProps) {
  // Collect all device IDs from all fleets for telemetry fetching.
  const allDeviceIds = useMemo(
    () =>
      MOCK_FLEETS.flatMap((f) =>
        Array.from({ length: Math.min(f.deviceCount, 20) }, (_, i) => `${f.fleetId}-dev-${i}`),
      ),
    [],
  );

  const telemetryQuery = useDeviceTelemetry(allDeviceIds);
  const aggregatedFleets = useMemo(() => preAggregateFleetData(MOCK_FLEETS), []);

  const totalDevices = MOCK_FLEETS.reduce((s, f) => s + f.deviceCount, 0);
  const totalActive = MOCK_FLEETS.reduce((s, f) => s + f.activeCount, 0);
  const totalPower = MOCK_FLEETS.reduce((s, f) => s + f.totalPowerOutput, 0);
  const activeFleets = MOCK_FLEETS.filter((f) => f.status === 'active').length;
  const degradedFleets = MOCK_FLEETS.filter((f) => f.status === 'degraded').length;

  return (
    <div className="space-y-6">
      {/* Summary KPI bar */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
          <p className="text-xs text-gray-400">Total Fleets</p>
          <p className="mt-1 text-2xl font-bold text-white">{MOCK_FLEETS.length}</p>
        </div>
        <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
          <p className="text-xs text-gray-400">Active / Degraded</p>
          <p className="mt-1 text-2xl font-bold text-green-400">
            {activeFleets}
            <span className="text-amber-400"> / {degradedFleets}</span>
          </p>
        </div>
        <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
          <p className="text-xs text-gray-400">Total Devices</p>
          <p className="mt-1 text-2xl font-bold text-blue-400">{totalDevices.toLocaleString()}</p>
        </div>
        <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
          <p className="text-xs text-gray-400">Devices Online</p>
          <p className="mt-1 text-2xl font-bold text-green-400">{totalActive.toLocaleString()}</p>
        </div>
        <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
          <p className="text-xs text-gray-400">Total Power Output</p>
          <p className="mt-1 text-2xl font-bold text-yellow-400">{totalPower.toLocaleString()} W</p>
        </div>
      </div>

      {/* Telemetry loading indicator */}
      {telemetryQuery.isLoading && (
        <div className="flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-900 px-4 py-3 text-sm text-gray-400">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-green-400 border-t-transparent" />
          Fetching live telemetry for {allDeviceIds.length} devices…
        </div>
      )}

      {/* Fleet cards */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {MOCK_FLEETS.map((fleet) => {
          const isSelected = selectedFleetId === fleet.fleetId;
          const onlinePct =
            fleet.deviceCount > 0 ? Math.round((fleet.activeCount / fleet.deviceCount) * 100) : 0;

          return (
            <button
              key={fleet.fleetId}
              onClick={() => onSelectFleet(isSelected ? null : fleet.fleetId)}
              className={`group relative rounded-lg border p-5 text-left transition-all ${
                isSelected
                  ? 'border-green-500/60 bg-green-950/20'
                  : 'border-gray-700 bg-gray-900 hover:border-gray-600'
              }`}
            >
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-base font-semibold text-white group-hover:text-green-300 transition-colors">
                    {fleet.name}
                  </h3>
                  <p className="mt-0.5 text-xs text-gray-500">{fleet.deviceCount} devices</p>
                </div>
                <StatusBadge status={fleet.status} />
              </div>

              {/* Connectivity bar */}
              <div className="mt-4">
                <div className="flex justify-between text-xs text-gray-400">
                  <span>Online</span>
                  <span>
                    {fleet.activeCount} / {fleet.deviceCount} ({onlinePct}%)
                  </span>
                </div>
                <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-gray-800">
                  <div
                    className="h-full rounded-full bg-green-500 transition-all"
                    style={{ width: `${onlinePct}%` }}
                  />
                </div>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                <div>
                  <span className="text-gray-500">Power</span>
                  <p className="font-mono text-gray-300">
                    {fleet.totalPowerOutput.toLocaleString()} W
                  </p>
                </div>
                <div>
                  <span className="text-gray-500">Avg / Device</span>
                  <p className="font-mono text-gray-300">
                    {fleet.deviceCount > 0
                      ? (fleet.totalPowerOutput / fleet.deviceCount).toFixed(1)
                      : '—'}{' '}
                    W
                  </p>
                </div>
              </div>

              {/* Aggregation indicator for large fleets */}
              {aggregatedFleets.length > 0 && fleet.deviceCount > 100 && (
                <p className="mt-2 text-[10px] text-gray-600">
                  Data aggregated across {fleet.deviceCount} devices
                </p>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
