'use client';

import dynamic from 'next/dynamic';
import { useWallet } from '@/components/providers/WalletProvider';
import type { BillingAnalyticsResponse } from '@/lib/billingAnalytics';

const TelemetryChart = dynamic(
  () =>
    import('@/components/dashboard/TelemetryChart').then((m) => ({ default: m.TelemetryChart })),
  {
    ssr: false,
    loading: () => (
      <div
        className="flex items-center justify-center rounded border border-gray-700 bg-gray-800"
        style={{ height: 200 }}
        aria-label="Loading telemetry chart…"
      >
        <span className="text-sm text-gray-400">Loading chart…</span>
      </div>
    ),
  },
);

interface DashboardClientProps {
  analytics: BillingAnalyticsResponse;
}

export function DashboardClient({ analytics }: DashboardClientProps) {
  const { metrics } = useWallet();

  if (!metrics?.isConnected) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-gray-400">Connect your wallet to view dashboard data.</p>
      </div>
    );
  }

  const chartData = analytics.points.map((p) => ({
    timestamp: new Date(p.date).getTime(),
    value: p.usageKwh,
  }));

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
          <p className="text-xs text-gray-400">Active Devices</p>
          <p className="mt-1 text-2xl font-bold text-green-400">
            {analytics.points.at(-1)?.activeDevices.toLocaleString() ?? '—'}
          </p>
        </div>
        <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
          <p className="text-xs text-gray-400">
            Total Usage ({analytics.from} to {analytics.to})
          </p>
          <p className="mt-1 text-2xl font-bold text-blue-400">
            {analytics.totalUsageKwh.toLocaleString()} kWh
          </p>
        </div>
        <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
          <p className="text-xs text-gray-400">Total Billed</p>
          <p className="mt-1 text-2xl font-bold text-yellow-400">
            {analytics.totalAmountXlm.toLocaleString()} XLM
          </p>
        </div>
        <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
          <p className="text-xs text-gray-400">Network</p>
          <p className="mt-1 text-2xl font-bold text-purple-400">{metrics.network}</p>
        </div>
      </div>
      <div className="rounded-lg border border-gray-700 bg-gray-900 p-6">
        <h3 className="mb-4 text-sm font-semibold text-gray-300">Power Usage</h3>
        <TelemetryChart data={chartData} metric="Usage (kWh)" />
      </div>
    </div>
  );
}
