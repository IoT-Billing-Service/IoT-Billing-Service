'use client';

import { useQuery } from '@tanstack/react-query';
import type { DeviceTelemetry, FleetView } from '@/types';

const BATCH_INTERVAL = 500;

async function fetchTelemetryBatch(deviceIds: string[]): Promise<DeviceTelemetry[]> {
  const params = new URLSearchParams({ deviceIds: deviceIds.join(',') });
  const response = await fetch(`/api/telemetry/batch?${params}`);
  if (!response.ok) throw new Error('Failed to fetch telemetry');
  return response.json();
}

export function useDeviceTelemetry(deviceIds: string[]) {
  return useQuery({
    queryKey: ['deviceTelemetry', deviceIds],
    queryFn: () => fetchTelemetryBatch(deviceIds),
    refetchInterval: BATCH_INTERVAL,
    staleTime: 250,
  });
}

export function useSingleDeviceTelemetry(deviceId: string) {
  return useDeviceTelemetry([deviceId]);
}

/**
 * Estimates the memory footprint of telemetry or fleet data in bytes
 */
export function estimateTelemetrySize(data: unknown): number {
  try {
    return JSON.stringify(data).length * 2;
  } catch {
    return 0;
  }
}

/**
 * Client-side aggregation of fleet data when it exceeds the memory threshold
 */
export function preAggregateFleetData(fleets: FleetView[]): FleetView[] {
  const LIMIT = 10 * 1024 * 1024; // 10MB limit
  if (estimateTelemetrySize(fleets) <= LIMIT) {
    return fleets;
  }

  const regionsMap = new Map<
    string,
    {
      fleetId: string;
      name: string;
      deviceCount: number;
      activeCount: number;
      totalPowerOutput: number;
      activeFleets: number;
      degradedFleets: number;
      inactiveFleets: number;
    }
  >();

  const getRegion = (fleet: FleetView) => {
    const regionFleet = fleet as FleetView & { region?: string };
    if (regionFleet.region) {
      return regionFleet.region;
    }
    const nameParts = fleet.name.split(/[-_ ]/);
    const firstPart = nameParts[0] ?? '';
    if (nameParts.length > 1 && firstPart.length >= 2 && firstPart.length <= 5) {
      return firstPart;
    }
    const regions: string[] = [
      'North America',
      'Europe',
      'Asia-Pacific',
      'South America',
      'Africa',
    ];
    let hash = 0;
    for (let i = 0; i < fleet.fleetId.length; i++) {
      hash = fleet.fleetId.charCodeAt(i) + ((hash << 5) - hash);
    }
    return regions[Math.abs(hash) % regions.length] ?? 'Unknown';
  };

  fleets.forEach((fleet) => {
    const reg = getRegion(fleet);
    let agg = regionsMap.get(reg);
    if (!agg) {
      agg = {
        fleetId: `region-${reg.toLowerCase().replace(/\s+/g, '-')}`,
        name: reg,
        deviceCount: 0,
        activeCount: 0,
        totalPowerOutput: 0,
        activeFleets: 0,
        degradedFleets: 0,
        inactiveFleets: 0,
      };
      regionsMap.set(reg, agg);
    }
    agg.deviceCount += fleet.deviceCount;
    agg.activeCount += fleet.activeCount;
    agg.totalPowerOutput += fleet.totalPowerOutput;
    if (fleet.status === 'active') agg.activeFleets++;
    else if (fleet.status === 'degraded') agg.degradedFleets++;
    else agg.inactiveFleets++;
  });

  return Array.from(regionsMap.values()).map((agg) => {
    let status: 'active' | 'degraded' | 'inactive' = 'inactive';
    if (agg.activeFleets > 0) status = 'active';
    else if (agg.degradedFleets > 0) status = 'degraded';

    return {
      fleetId: agg.fleetId,
      name: `${agg.name} (Cluster)`,
      deviceCount: agg.deviceCount,
      activeCount: agg.activeCount,
      totalPowerOutput: agg.totalPowerOutput,
      status,
    };
  });
}

/**
 * A custom hook to fetch and aggregate device telemetry on the client side
 */
export function useFleetTelemetry(deviceIds: string[]) {
  const query = useDeviceTelemetry(deviceIds);

  const aggregatedData = query.data
    ? {
        deviceCount: query.data.length,
        activeCount: query.data.filter((d) => d.metrics.batteryLevel > 10).length,
        totalPowerOutput: query.data.reduce((sum, d) => sum + d.metrics.powerUsage, 0),
      }
    : null;

  return {
    ...query,
    aggregatedData,
  };
}
