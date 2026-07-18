'use client';

import { useDashboardData } from '@/components/ops/useDashboardData';
import { SystemHealthCard } from '@/components/ops/SystemHealthCard';
import { FleetStatusCard } from '@/components/ops/FleetStatusCard';
import { BillingOverviewCard } from '@/components/ops/BillingOverviewCard';
import { SettlementTracker } from '@/components/ops/SettlementTracker';
import { IngestionHealthCard } from '@/components/ops/IngestionHealthCard';
import { DashboardHeader } from '@/components/ops/DashboardHeader';

export default function OpsPage() {
  const { data, isLoading, error, refetch, lastUpdated } = useDashboardData();

  if (isLoading && data === null) {
    return (
      <div className="space-y-6">
        <div className="animate-pulse space-y-6">
          <div className="h-12 rounded-lg bg-neutral-800" />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-32 rounded-lg bg-neutral-800" />
            ))}
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="h-64 rounded-lg bg-neutral-800" />
            <div className="h-64 rounded-lg bg-neutral-800" />
          </div>
        </div>
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-20">
        <div className="rounded-lg border border-red-800/50 bg-red-950/30 px-6 py-4 text-center">
          <p className="text-sm font-medium text-red-400">Failed to load dashboard</p>
          <p className="mt-1 text-xs text-red-500">{error}</p>
        </div>
        <button
          onClick={() => { void refetch(); }}
          className="rounded-md bg-neutral-800 px-4 py-2 text-xs font-medium text-neutral-300 transition-colors hover:bg-neutral-700"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <DashboardHeader
        lastUpdated={lastUpdated}
        onRefresh={() => { void refetch(); }}
        isRefreshing={isLoading}
      />

      {/* Summary KPI row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Total Devices"
          value={data?.summary.devices.total ?? 0}
          sub={`${data?.summary.devices.enabled ?? 0} enabled`}
          color="cyan"
        />
        <KpiCard
          label="Billing Records"
          value={data?.summary.billing.totalRecords ?? 0}
          sub={`${data?.summary.billing.settled ?? 0} settled`}
          color="green"
        />
        <KpiCard
          label="Open Cycles"
          value={data?.summary.cycles.open ?? 0}
          sub={`${data?.summary.cycles.settled ?? 0} settled`}
          color="amber"
        />
        <KpiCard
          label="System Uptime"
          value={formatUptime(data?.systemHealth.uptimeSeconds ?? 0)}
          sub={`Event loop: ${(data?.systemHealth.eventLoopLagMs ?? 0).toFixed(1)}ms`}
          color="emerald"
        />
      </div>

      {/* Main dashboard grid */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <FleetStatusCard
          devices={data?.summary.devices ?? { total: 0, enabled: 0, disabled: 0 }}
        />
        <BillingOverviewCard
          billing={data?.summary.billing ?? {
            totalRecords: 0,
            pending: 0,
            settled: 0,
            totalUsageAmount: 0n,
            settledUsageAmount: 0n,
          }}
          cycles={data?.summary.cycles ?? {
            total: 0,
            open: 0,
            finalizing: 0,
            finalized: 0,
            settled: 0,
          }}
        />
        <SystemHealthCard health={data?.systemHealth} />
        <SettlementTracker
          billing={data?.summary.billing ?? {
            totalRecords: 0,
            pending: 0,
            settled: 0,
            totalUsageAmount: 0n,
            settledUsageAmount: 0n,
          }}
          recentRecords={data?.recentRecords ?? []}
        />
      </div>

      <IngestionHealthCard health={data?.systemHealth} />
    </div>
  );
}

// ── KPI card ──────────────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string | number;
  sub: string;
  color: 'cyan' | 'green' | 'amber' | 'emerald';
}) {
  const colorMap: Record<string, string> = {
    cyan: 'text-cyan-400',
    green: 'text-green-400',
    amber: 'text-amber-400',
    emerald: 'text-emerald-400',
  };

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <p className="text-xs text-neutral-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold font-mono ${colorMap[color]}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </p>
      <p className="mt-0.5 text-[11px] text-neutral-600">{sub}</p>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}
