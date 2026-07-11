'use client';

import { useState } from 'react';
import { useWallet } from '@/components/providers/WalletProvider';
import { FleetOverview } from '@/components/fleet/FleetOverview';
import { FleetDeviceGrid } from '@/components/fleet/FleetDeviceGrid';
import { MetricStreamPanel } from '@/components/fleet/MetricStreamPanel';
import { IngestionFailureTracker } from '@/components/fleet/IngestionFailureTracker';

type FleetTab = 'overview' | 'devices' | 'metrics' | 'failures';

const TABS: { key: FleetTab; label: string }[] = [
  { key: 'overview', label: 'Fleet Overview' },
  { key: 'devices', label: 'Devices' },
  { key: 'metrics', label: 'Metric Streams' },
  { key: 'failures', label: 'Ingestion Failures' },
];

export default function FleetPage() {
  const { metrics } = useWallet();
  const [activeTab, setActiveTab] = useState<FleetTab>('overview');
  const [selectedFleetId, setSelectedFleetId] = useState<string | null>(null);

  if (!metrics?.isConnected) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-gray-400">Connect your wallet to view fleet data.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Tab navigation */}
      <div className="flex items-center gap-1 border-b border-gray-800">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === tab.key
                ? 'border-green-400 text-green-400'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="min-h-[400px]">
        {activeTab === 'overview' && (
          <FleetOverview selectedFleetId={selectedFleetId} onSelectFleet={setSelectedFleetId} />
        )}
        {activeTab === 'devices' && <FleetDeviceGrid fleetId={selectedFleetId} />}
        {activeTab === 'metrics' && <MetricStreamPanel fleetId={selectedFleetId} />}
        {activeTab === 'failures' && <IngestionFailureTracker fleetId={selectedFleetId} />}
      </div>
    </div>
  );
}
