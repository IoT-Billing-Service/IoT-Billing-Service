import React from 'react';
import { RetryQueueTransaction } from '../types';
import { Wifi, WifiOff, RefreshCw, Layers, Database, ArrowRight, Activity } from 'lucide-react';

interface NetworkRetryQueueProps {
  isNetworkOnline: boolean;
  onToggleNetwork: () => void;
  bufferedTransactions: RetryQueueTransaction[];
  onForceSync: () => void;
}

export default function NetworkRetryQueue({
  isNetworkOnline,
  onToggleNetwork,
  bufferedTransactions,
  onForceSync,
}: NetworkRetryQueueProps) {
  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6" id="network-retry-queue-card">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
        <div className="flex items-center gap-2">
          <div className={`p-2 rounded-lg border transition-all ${
            isNetworkOnline
              ? 'bg-emerald-950/80 text-emerald-400 border-emerald-800/50'
              : 'bg-rose-950/80 text-rose-400 border-rose-900/50'
          }`}>
            {isNetworkOnline ? <Wifi className="w-5 h-5" /> : <WifiOff className="w-5 h-5 animate-pulse" />}
          </div>
          <div>
            <h3 className="font-sans font-medium text-white tracking-tight text-base">DePIN Ingestion Mesh Gateway</h3>
            <p className="text-xs text-neutral-400 font-mono">Edge-Buffering (IndexedDB Store)</p>
          </div>
        </div>

        {/* Connectivity Toggle Switch */}
        <button
          onClick={onToggleNetwork}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-mono font-medium transition-all active:scale-95 ${
            isNetworkOnline
              ? 'bg-rose-950/20 border-rose-900/50 text-rose-400 hover:bg-rose-950/40'
              : 'bg-emerald-950/20 border-emerald-800/50 text-emerald-400 hover:bg-emerald-950/40'
          }`}
          id="toggle-network-button"
        >
          {isNetworkOnline ? (
            <>
              <WifiOff className="w-3.5 h-3.5" />
              SIMULATE NETWORK OUTAGE
            </>
          ) : (
            <>
              <Wifi className="w-3.5 h-3.5" />
              RESTORE INGESTION MESH
            </>
          )}
        </button>
      </div>

      <p className="text-xs text-neutral-400 mb-6 leading-relaxed">
        If cellular / helium LoRaWAN connections fail, the Edge SDK buffers transactions locally in an offline-first IndexedDB ledger queue. Once connectivity to the ingestion mesh resumes, the queue syncs transactions in proper sequence to the Soroban billing VM.
      </p>

      {/* Connection State Info Bar */}
      <div className={`mb-6 p-4 rounded-lg border flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-xs font-mono transition-all ${
        isNetworkOnline
          ? 'bg-neutral-950 border-neutral-800'
          : 'bg-rose-950/10 border-rose-900/30'
      }`}>
        <div className="flex items-center gap-2">
          <Database className="w-4 h-4 text-neutral-500" />
          <span className="text-neutral-400">Queue Storage State:</span>
          <span className={bufferedTransactions.length > 0 ? 'text-amber-400 animate-pulse font-bold' : 'text-emerald-400 font-bold'}>
            {bufferedTransactions.length === 0 ? 'EMPTY & READY' : `${bufferedTransactions.length} PAYLOADS BUFFERED`}
          </span>
        </div>

        {!isNetworkOnline ? (
          <div className="flex items-center gap-1.5 text-rose-400 font-semibold animate-pulse">
            <Activity className="w-3.5 h-3.5" />
            <span>MESH CONNECTION OFFLINE: LOCAL HARDWARE CACHE ARMED</span>
          </div>
        ) : bufferedTransactions.length > 0 ? (
          <button
            onClick={onForceSync}
            className="flex items-center gap-1.5 bg-cyan-950 border border-cyan-800/60 text-cyan-400 hover:bg-cyan-900/60 px-3 py-1 rounded text-[11px] font-sans font-medium transition-all active:scale-95"
          >
            <RefreshCw className="w-3 h-3 animate-spin" />
            Sync Buffer Queue Now
          </button>
        ) : (
          <div className="text-neutral-500 flex items-center gap-1 text-[11px]">
            <span>● Sync Pipeline Active</span>
          </div>
        )}
      </div>

      {/* Local Buffer Queue List */}
      <div className="bg-neutral-950 border border-neutral-800 rounded-lg overflow-hidden">
        <div className="grid grid-cols-12 px-4 py-2 border-b border-neutral-900 text-[10px] font-mono text-neutral-500 uppercase tracking-wider">
          <div className="col-span-3">Tx Hash / Node</div>
          <div className="col-span-4">Payload Encrypted Data</div>
          <div className="col-span-2 text-right">Cost (XLM)</div>
          <div className="col-span-1 text-center">Retries</div>
          <div className="col-span-2 text-right">Status</div>
        </div>

        {bufferedTransactions.length === 0 ? (
          <div className="text-center py-8 text-xs font-mono text-neutral-600">
            No offline payloads in the queue. Trigger a network outage to see edge storage buffering.
          </div>
        ) : (
          <div className="divide-y divide-neutral-900 max-h-[220px] overflow-y-auto">
            {bufferedTransactions.map(tx => (
              <div key={tx.id} className="grid grid-cols-12 px-4 py-3 text-[11px] font-mono items-center hover:bg-neutral-900/30">
                <div className="col-span-3 flex flex-col">
                  <span className="text-white truncate max-w-[120px] font-semibold">{tx.nodeName}</span>
                  <span className="text-[9px] text-neutral-500 truncate max-w-[100px]">{tx.id}</span>
                </div>
                <div className="col-span-4 flex items-center gap-1">
                  <span className="text-neutral-400 font-mono text-[10px] truncate max-w-[180px] bg-neutral-900 px-1.5 py-0.5 rounded border border-neutral-800/50">
                    {tx.payload}
                  </span>
                </div>
                <div className="col-span-2 text-right text-cyan-400 font-semibold">
                  {tx.cost.toFixed(4)} XLM
                </div>
                <div className="col-span-1 text-center text-neutral-400 font-bold">
                  {tx.retries}
                </div>
                <div className="col-span-2 text-right">
                  <span className={`inline-block px-1.5 py-0.5 text-[9px] font-bold rounded uppercase ${
                    tx.status === 'syncing'
                      ? 'bg-cyan-950 text-cyan-400 border border-cyan-800/30 animate-pulse'
                      : tx.status === 'failed'
                      ? 'bg-rose-950 text-rose-400 border border-rose-900/30'
                      : 'bg-amber-950/60 text-amber-500 border border-amber-800/30 animate-pulse'
                  }`}>
                    {tx.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
