'use client';

import { useMemo } from 'react';
import type { DeviceTelemetry } from '@/types';
import { sanitizeHtml } from '@/utils/sanitizer';

function sanitizeMetadata(meta: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta)) {
    sanitized[sanitizeHtml(key)] = sanitizeHtml(value);
  }
  return sanitized;
}

interface DeviceDetailsProps {
  device: DeviceTelemetry;
}

export function DeviceDetails({ device }: DeviceDetailsProps) {
  const safeMetadata = useMemo(() => {
    if (!device.metadata) return null;
    return sanitizeMetadata(device.metadata);
  }, [device.metadata]);

  return (
    <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
      <h3 className="text-lg font-semibold text-green-400">
        Device: {sanitizeHtml(device.deviceId)}
      </h3>
      <div className="mt-2 grid grid-cols-2 gap-4 text-sm">
        <div>
          <span className="text-gray-400">Power Usage:</span>
          <span className="ml-2 text-white">{device.metrics.powerUsage.toFixed(2)} W</span>
        </div>
        <div>
          <span className="text-gray-400">Signal:</span>
          <span className="ml-2 text-white">{device.metrics.signalStrength.toFixed(1)} dBm</span>
        </div>
        <div>
          <span className="text-gray-400">Temperature:</span>
          <span className="ml-2 text-white">{device.metrics.temperature.toFixed(1)} °C</span>
        </div>
        <div>
          <span className="text-gray-400">Battery:</span>
          <span className="ml-2 text-white">{device.metrics.batteryLevel.toFixed(0)}%</span>
        </div>
      </div>
      {safeMetadata && (
        <div className="mt-3 border-t border-gray-700 pt-3">
          <h4 className="mb-1 text-sm font-medium text-gray-400">Device Metadata</h4>
          <div className="space-y-1">
            {Object.entries(safeMetadata).map(([key, value]) => (
              <div key={key} className="flex text-xs">
                <span className="w-24 text-gray-500">{key}:</span>
                <span className="text-gray-300">{value}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
