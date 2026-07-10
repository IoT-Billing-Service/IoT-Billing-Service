import { useState } from 'react';
import type { DePinNode, VariableTariff } from '../types';
import { Gauge, Info, Landmark, Layers, PlusCircle, ShieldAlert } from 'lucide-react';

interface EscrowListProps {
  nodes: DePinNode[];
  tariffs: VariableTariff[];
  onFundEscrow: (nodeId: string, amount: number) => void;
  onUpdateTariff: (tariffId: string, updatedFields: Partial<VariableTariff>) => void;
  isContractPaused: boolean;
  onToggleEmergencyPause: () => void;
}

export default function EscrowList({
  nodes,
  tariffs,
  onFundEscrow,
  onUpdateTariff,
  isContractPaused,
  onToggleEmergencyPause,
}: EscrowListProps) {
  const [fundingAmount, setFundingAmount] = useState<{ [nodeId: string]: string }>({});
  const initialTariff = tariffs[0];
  const [selectedTariffId, setSelectedTariffId] = useState<string>(initialTariff?.id ?? '');
  const [editingBaseRate, setEditingBaseRate] = useState<string>(
    initialTariff?.baseRatePerPayload.toString() ?? '0',
  );
  const [editingGasBuffer, setEditingGasBuffer] = useState<string>(initialTariff?.gasBuffer.toString() ?? '0');

  const handleFund = (nodeId: string) => {
    const amount = parseFloat(fundingAmount[nodeId] || '0');
    if (!isNaN(amount) && amount > 0) {
      onFundEscrow(nodeId, amount);
      setFundingAmount(prev => ({ ...prev, [nodeId]: '' }));
    }
  };

  const handleTariffSelect = (id: string) => {
    setSelectedTariffId(id);
    const tariff = tariffs.find(t => t.id === id);
    if (tariff) {
      setEditingBaseRate(tariff.baseRatePerPayload.toString());
      setEditingGasBuffer(tariff.gasBuffer.toString());
    }
  };

  const handleSaveTariff = () => {
    const base = parseFloat(editingBaseRate);
    const gas = parseFloat(editingGasBuffer);
    if (!isNaN(base) && !isNaN(gas)) {
      onUpdateTariff(selectedTariffId, {
        baseRatePerPayload: base,
        gasBuffer: gas,
      });
    }
  };

  const selectedTariff = tariffs.find((t) => t.id === selectedTariffId) ?? initialTariff;

  if (selectedTariff === undefined) {
    return null;
  }

  return (
    <div className="space-y-6">
      {/* Smart Contract Overview */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6" id="escrows-contracts-card">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-amber-950 text-amber-500 rounded-lg border border-amber-800/50">
              <Landmark className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-sans font-medium text-white tracking-tight text-base">Soroban Escrow & Rent Registry</h3>
              <p className="text-xs text-neutral-400 font-mono">Autonomous Billing Smart Contracts</p>
            </div>
          </div>

          <button
            onClick={onToggleEmergencyPause}
            className={`px-3 py-1.5 rounded-md text-[11px] font-mono font-medium border flex items-center gap-1.5 transition-all active:scale-95 ${
              isContractPaused
                ? 'bg-emerald-950 border-emerald-800 text-emerald-400 hover:bg-emerald-900'
                : 'bg-red-950 border-red-900 text-red-400 hover:bg-red-900'
            }`}
            id="emergency-pause-button"
          >
            <ShieldAlert className="w-3.5 h-3.5" />
            {isContractPaused ? 'RESUME CONTRACTS (VETO REMOVED)' : 'EMERGENCY CONTRACT PAUSE'}
          </button>
        </div>

        {isContractPaused && (
          <div className="mb-4 bg-red-950/40 border border-red-900/60 p-3 rounded-lg flex items-start gap-2.5">
            <ShieldAlert className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <div className="text-xs text-red-300">
              <span className="font-bold">SYSTEM-WIDE VETO TRIGGERED:</span> Smart contracts are frozen. Node telemetry ingestion is active but on-chain escrow funding transfers and telemetry billing debits are completely blocked.
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {nodes.map(node => {
            const isLow = node.balance < 15;
            const percentageFilled = Math.min(100, (node.balance / node.maxEscrowCapacity) * 100);

            return (
              <div
                key={node.id}
                className={`bg-neutral-950 border rounded-lg p-4 flex flex-col justify-between space-y-4 transition-all ${
                  node.status === 'exhausted'
                    ? 'border-red-900/70 bg-red-950/5'
                    : isLow
                    ? 'border-amber-900/50 hover:border-amber-800'
                    : 'border-neutral-800 hover:border-neutral-700'
                }`}
              >
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono text-neutral-400 font-medium truncate max-w-[130px]" title={node.name}>
                      {node.name}
                    </span>
                    <span
                      className={`text-[9px] px-1.5 py-0.5 font-mono rounded uppercase ${
                        node.status === 'online'
                          ? 'bg-emerald-950 text-emerald-400 border border-emerald-800/30'
                          : node.status === 'exhausted'
                          ? 'bg-red-950 text-red-400 border border-red-900/30'
                          : 'bg-neutral-900 text-neutral-400 border border-neutral-800'
                      }`}
                    >
                      {node.status}
                    </span>
                  </div>
                  <div className="text-[10px] text-neutral-500 font-mono flex justify-between items-center">
                    <span>IP: {node.ipAddress}</span>
                    <span>ID: {node.id}</span>
                  </div>
                </div>

                {/* Balance Meter */}
                <div className="space-y-1.5">
                  <div className="flex justify-between items-end">
                    <span className="text-[10px] text-neutral-500 font-mono">Escrow State Balance</span>
                    <span className={`text-sm font-mono font-bold ${isLow ? 'text-amber-400' : 'text-cyan-400'}`}>
                      {node.balance.toFixed(4)} XLM
                    </span>
                  </div>
                  {/* Progress Bar */}
                  <div className="w-full bg-neutral-900 rounded-full h-1.5 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${
                        node.status === 'exhausted'
                          ? 'bg-red-500'
                          : isLow
                          ? 'bg-amber-500'
                          : 'bg-cyan-500'
                      }`}
                      style={{ width: `${percentageFilled}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-[9px] text-neutral-600 font-mono">
                    <span>Min Threshold: 5.0 XLM</span>
                    <span>Max: {node.maxEscrowCapacity} XLM</span>
                  </div>
                </div>

                {/* Soroban Rent Storage Details */}
                <div className="bg-neutral-900/50 px-2 py-1.5 rounded border border-neutral-800/60 flex items-center justify-between text-[10px] font-mono text-neutral-400">
                  <span className="flex items-center gap-1">
                    <Layers className="w-3 h-3 text-neutral-600" /> State Storage Rent
                  </span>
                  <span className="text-amber-500">-{node.rentCostPerHour} XLM/hr</span>
                </div>

                {/* Funding form */}
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <input
                      type="number"
                      placeholder="Amount XLM"
                      value={fundingAmount[node.id] || ''}
                      onChange={(e) =>
                        setFundingAmount(prev => ({ ...prev, [node.id]: e.target.value }))
                      }
                      className="w-full bg-neutral-900 text-xs text-white border border-neutral-800 rounded px-2.5 py-1.5 font-mono focus:outline-none focus:border-cyan-500"
                    />
                    <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[9px] text-neutral-500 font-mono">
                      XLM
                    </span>
                  </div>
                  <button
                    onClick={() => handleFund(node.id)}
                    disabled={isContractPaused}
                    className={`p-1.5 rounded border flex items-center justify-center transition-all ${
                      isContractPaused
                        ? 'bg-neutral-900 border-neutral-800 text-neutral-600 cursor-not-allowed'
                        : 'bg-amber-950/40 border-amber-800/50 hover:bg-amber-900/60 text-amber-400 active:scale-95'
                    }`}
                    title="Deposit to Escrow"
                  >
                    <PlusCircle className="w-4 h-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Dynamic Tariffs Settings */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6" id="tariff-registry-card">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-indigo-950 text-indigo-400 rounded-lg border border-indigo-800/50">
              <Gauge className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-sans font-medium text-white tracking-tight text-base">Variable Tariff Rate Oracles</h3>
              <p className="text-xs text-neutral-400 font-mono">On-Chain Pricing Policies</p>
            </div>
          </div>
          <span className="text-[10px] bg-indigo-950 text-indigo-400 border border-indigo-800/50 px-2 py-0.5 rounded font-mono uppercase">
            Soroban Maps API
          </span>
        </div>

        <p className="text-xs text-neutral-400 mb-5 leading-relaxed">
          Stellar Soroban smart contracts support variable tariffs updated dynamically via authorized state Price Oracles. Tariffs charge nodes proportionally based on telemetry frequency, payload storage footprint, and renewability multipliers.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Tariff Selector */}
          <div className="md:col-span-1 space-y-2">
            <label className="block text-[10px] text-neutral-500 font-mono uppercase">Select Active Tariff</label>
            <div className="space-y-1.5">
              {tariffs.map(t => (
                <button
                  key={t.id}
                  onClick={() => handleTariffSelect(t.id)}
                  className={`w-full text-left p-2.5 rounded-lg border text-xs font-mono flex flex-col transition-all ${
                    t.id === selectedTariffId
                      ? 'bg-indigo-950/40 border-indigo-500 text-white font-semibold'
                      : 'bg-neutral-950 border-neutral-800 hover:border-neutral-700 text-neutral-400'
                  }`}
                >
                  <span className="truncate">{t.name}</span>
                  <span className="text-[10px] text-neutral-500 mt-0.5">{t.id}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Rate Editor Panel */}
          <div className="md:col-span-2 bg-neutral-950 border border-neutral-800 rounded-lg p-4 space-y-4">
            <div className="flex items-center justify-between border-b border-neutral-900 pb-2">
              <span className="text-xs font-mono font-semibold text-indigo-400 uppercase">Tariff parameters: {selectedTariff.id}</span>
              <span className="text-[10px] text-neutral-500 font-mono">Dynamic Updates</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="block text-[10px] text-neutral-500 font-mono uppercase">Base Rate (XLM per payload)</label>
                <div className="relative">
                  <input
                    type="number"
                    step="0.001"
                    value={editingBaseRate}
                    onChange={(e) => setEditingBaseRate(e.target.value)}
                    className="w-full bg-neutral-900 text-xs text-white border border-neutral-800 rounded p-2 font-mono focus:outline-none focus:border-indigo-500"
                  />
                  <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-neutral-500 font-mono">XLM</span>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="block text-[10px] text-neutral-500 font-mono uppercase">Gas Fee Buffer (Soroban Host VM)</label>
                <div className="relative">
                  <input
                    type="number"
                    step="0.0001"
                    value={editingGasBuffer}
                    onChange={(e) => setEditingGasBuffer(e.target.value)}
                    className="w-full bg-neutral-900 text-xs text-white border border-neutral-800 rounded p-2 font-mono focus:outline-none focus:border-indigo-500"
                  />
                  <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-neutral-500 font-mono">XLM</span>
                </div>
              </div>
            </div>

            {/* Read-only features metrics */}
            <div className="grid grid-cols-2 gap-4 bg-neutral-900/50 p-3 rounded border border-neutral-800/60 text-xs font-mono">
              <div className="space-y-0.5">
                <span className="text-[10px] text-neutral-500 block">Payload Size Factor</span>
                <span className="text-white">{selectedTariff.sizeRatePerKB} XLM / KB</span>
              </div>
              <div className="space-y-0.5">
                <span className="text-[10px] text-neutral-500 block">Carbon Offset Multiplier</span>
                <span className="text-emerald-400">⚡ {selectedTariff.carbonCreditStreamingMultiplier}x Offset</span>
              </div>
            </div>

            <div className="flex items-center justify-between pt-2">
              <div className="flex items-center gap-1.5 text-[10px] text-neutral-500">
                <Info className="w-3.5 h-3.5 text-neutral-600" />
                <span>Requires Oracle multisig consensus key signing.</span>
              </div>
              <button
                onClick={handleSaveTariff}
                className="bg-indigo-950 border border-indigo-800 hover:bg-indigo-900 text-indigo-400 px-3.5 py-1.5 rounded text-xs font-sans font-medium transition-all active:scale-95"
              >
                Sync Rate Oracle
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
