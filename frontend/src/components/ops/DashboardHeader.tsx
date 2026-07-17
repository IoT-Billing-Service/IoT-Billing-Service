'use client';

import { RefreshCw, Shield, Activity } from 'lucide-react';

interface DashboardHeaderProps {
  lastUpdated: Date | null;
  onRefresh: () => void;
  isRefreshing: boolean;
}

export function DashboardHeader({ lastUpdated, onRefresh, isRefreshing }: DashboardHeaderProps) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-lg font-bold text-white flex items-center gap-2">
          <Activity className="h-5 w-5 text-cyan-400" />
          Operational Dashboard
        </h1>
        <p className="mt-0.5 text-xs text-neutral-500">
          Real-time fleet, billing, and system health monitoring
        </p>
      </div>

      <div className="flex items-center gap-3">
        {/* Compliance badge */}
        <div className="hidden sm:flex items-center gap-1.5 rounded-md border border-emerald-800/30 bg-emerald-950/20 px-2.5 py-1">
          <Shield className="h-3 w-3 text-emerald-400" />
          <span className="text-[10px] font-medium text-emerald-400">PCI-DSS / SOC2</span>
        </div>

        {/* Last updated */}
        {lastUpdated !== null && (
          <span className="text-[10px] text-neutral-600">
            Updated {lastUpdated.toLocaleTimeString()}
          </span>
        )}

        {/* Refresh button */}
        <button
          onClick={onRefresh}
          disabled={isRefreshing}
          className="flex items-center gap-1.5 rounded-md bg-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-300 transition-colors hover:bg-neutral-700 disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${isRefreshing ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>
    </div>
  );
}
