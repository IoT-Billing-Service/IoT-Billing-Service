'use client';

import { Server, AlertTriangle, CheckCircle } from 'lucide-react';

interface FleetStatusProps {
  devices: {
    total: number;
    enabled: number;
    disabled: number;
  };
}

export function FleetStatusCard({ devices }: FleetStatusProps) {
  const onlinePct = devices.total > 0 ? Math.round((devices.enabled / devices.total) * 100) : 0;
  const healthStatus = onlinePct >= 90 ? 'healthy' : onlinePct >= 70 ? 'degraded' : 'critical';

  const statusConfig = {
    healthy: {
      icon: <CheckCircle className="h-4 w-4 text-green-400" />,
      label: 'Healthy',
      color: 'text-green-400',
      bgColor: 'bg-green-950/20 border-green-800/30',
    },
    degraded: {
      icon: <AlertTriangle className="h-4 w-4 text-amber-400" />,
      label: 'Degraded',
      color: 'text-amber-400',
      bgColor: 'bg-amber-950/20 border-amber-800/30',
    },
    critical: {
      icon: <AlertTriangle className="h-4 w-4 text-red-400" />,
      label: 'Critical',
      color: 'text-red-400',
      bgColor: 'bg-red-950/20 border-red-800/30',
    },
  };

  const status = statusConfig[healthStatus];

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white flex items-center gap-2">
          <Server className="h-4 w-4 text-cyan-400" />
          Fleet Status
        </h3>
        <div className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 ${status.bgColor}`}>
          {status.icon}
          <span className={`text-xs font-medium ${status.color}`}>{status.label}</span>
        </div>
      </div>

      {/* Device counts */}
      <div className="mt-4 grid grid-cols-3 gap-3">
        <div>
          <p className="text-[11px] text-neutral-500">Total</p>
          <p className="text-lg font-bold font-mono text-white">{devices.total}</p>
        </div>
        <div>
          <p className="text-[11px] text-neutral-500">Enabled</p>
          <p className="text-lg font-bold font-mono text-green-400">{devices.enabled}</p>
        </div>
        <div>
          <p className="text-[11px] text-neutral-500">Disabled</p>
          <p className="text-lg font-bold font-mono text-neutral-500">{devices.disabled}</p>
        </div>
      </div>

      {/* Online progress bar */}
      <div className="mt-4">
        <div className="flex justify-between text-[11px] text-neutral-500">
          <span>Online Rate</span>
          <span className="font-mono">{onlinePct}%</span>
        </div>
        <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-neutral-800">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              healthStatus === 'healthy'
                ? 'bg-green-500'
                : healthStatus === 'degraded'
                  ? 'bg-amber-500'
                  : 'bg-red-500'
            }`}
            style={{ width: `${onlinePct}%` }}
          />
        </div>
      </div>
    </div>
  );
}
