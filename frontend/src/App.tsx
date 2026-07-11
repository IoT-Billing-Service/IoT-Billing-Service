import React, { useState, useEffect } from 'react';
import { useTransactionQueue } from './hooks/useTransactionQueue';
import { 
  Network, 
  Cpu, 
  Coins, 
  Database, 
  Layers, 
  Wifi, 
  WifiOff, 
  ShieldAlert, 
  PlayCircle, 
  PauseCircle, 
  ArrowUpRight,
  TrendingUp,
  Activity,
  UserCheck
} from 'lucide-react';

interface DeviceNode {
  id: string;
  name: string;
  status: 'online' | 'offline' | 'exhausted';
  balance: number;
  lastReading: number;
  unit: string;
}

export default function App() {
  const { queue, bufferTransaction, dequeueTransaction, incrementRetry } = useTransactionQueue();
  const [networkOnline, setNetworkOnline] = useState<boolean>(navigator.onLine);
  const [nodes, setNodes] = useState<DeviceNode[]>([
    { id: 'DePIN-ENV-081', name: 'Munich Air Quality Sensor', status: 'online', balance: 45.25, lastReading: 22.4, unit: '°C' },
    { id: 'DePIN-GRID-102', name: 'Berlin Solar Dispatch Grid', status: 'online', balance: 112.80, lastReading: 845.2, unit: 'kW' },
    { id: 'DePIN-WIFI-540', name: 'Hamburg Helium Node', status: 'online', balance: 8.45, lastReading: 142.8, unit: 'Mbps' },
  ]);
  const [isContractPaused, setIsContractPaused] = useState<boolean>(false);
  const [liveLog, setLiveLog] = useState<{ id: string; msg: string; type: 'info' | 'warn' | 'success' }[]>([
    { id: '1', msg: 'mTLS Ingestion Gateway online. Secured with AES-256.', type: 'info' },
    { id: '2', msg: 'Connected to Stellar Horizon API. Escrow Smart contracts active.', type: 'success' },
  ]);

  // Monitor real-world network connectivity changes
  useEffect(() => {
    const handleOnline = () => {
      setNetworkOnline(true);
      logEvent('Ingestion Mesh Gateway connection re-established!', 'success');
    };
    const handleOffline = () => {
      setNetworkOnline(false);
      logEvent('Connectivity lost. Armed local IndexedDB Edge Buffer Queue.', 'warn');
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const logEvent = (msg: string, type: 'info' | 'warn' | 'success') => {
    setLiveLog(prev => [{ id: Math.random().toString(), msg, type }, ...prev.slice(0, 15)]);
  };

  // Simulate telemetry broadcast
  const triggerTelemetrySample = (nodeId: string) => {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;

    const chargeAmount = 0.0035; // simulated XLM fee

    if (!networkOnline) {
      // Buffer offline transaction
      const offlineTxId = `TX-${Math.random().toString(36).substring(2, 9)}`;
      bufferTransaction({
        id: offlineTxId,
        nodeId: node.id,
        payload: `0x${Math.random().toString(36).substring(2, 15)}`,
        cost: chargeAmount
      });
      logEvent(`Buffered offline telemetry payload for ${node.name} in IndexedDB.`, 'warn');
    } else {
      if (isContractPaused) {
        logEvent(`Telemetry for ${node.name} rejected. Smart contracts frozen by admin veto.`, 'warn');
        return;
      }

      if (node.balance < chargeAmount) {
        setNodes(prev => prev.map(n => n.id === nodeId ? { ...n, status: 'exhausted' } : n));
        logEvent(`Billing aborted: Escrow balance depleted for ${node.name}.`, 'warn');
        return;
      }

      // Successful online debit
      setNodes(prev => prev.map(n => {
        if (n.id === nodeId) {
          const nextVal = n.lastReading + (Math.random() - 0.5) * 2;
          return {
            ...n,
            balance: n.balance - chargeAmount,
            lastReading: nextVal,
            status: n.balance - chargeAmount <= 1.0 ? 'exhausted' : 'online'
          };
        }
        return n;
      }));
      logEvent(`Billed ${chargeAmount} XLM for ${node.name}. State updated on-chain.`, 'success');
    }
  };

  // Sync IndexedDB Queue
  const syncQueue = () => {
    if (queue.length === 0 || !networkOnline || isContractPaused) return;

    logEvent(`Processing ${queue.length} buffered payloads...`, 'info');
    
    queue.forEach(tx => {
      setTimeout(() => {
        setNodes(prevNodes => {
          const target = prevNodes.find(n => n.id === tx.nodeId);
          if (!target || target.balance < tx.cost) {
            incrementRetry(tx.id);
            logEvent(`Failed syncing tx ${tx.id}: Escrow balance insufficient.`, 'warn');
            return prevNodes;
          }

          // Complete sync
          const updatedNodes = prevNodes.map(n => {
            if (n.id === tx.nodeId) {
              return { ...n, balance: n.balance - tx.cost };
            }
            return n;
          });

          dequeueTransaction(tx.id);
          logEvent(`Synced buffered telemetry for ${target.name}. Escrow settled.`, 'success');
          return updatedNodes;
        });
      }, 500);
    });
  };

  return (
    <div className="min-h-screen bg-black text-neutral-100 flex flex-col font-sans selection:bg-cyan-500 selection:text-black">
      {/* Top Header */}
      <header className="bg-neutral-950 border-b border-neutral-900 px-6 py-4">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-emerald-400" />
              <h1 className="font-bold text-white text-base tracking-tight uppercase">IoT-Billing Production Dashboard</h1>
            </div>
            <p className="text-xs text-neutral-400 font-mono mt-0.5">
              Stellar/Soroban Smart Contract Ingestion Fleet Manager
            </p>
          </div>

          <div className="flex items-center gap-3">
            <span className={`px-2.5 py-1 rounded text-xs font-mono font-medium border flex items-center gap-1.5 ${
              networkOnline 
                ? 'bg-emerald-950/40 border-emerald-800 text-emerald-400' 
                : 'bg-rose-950/40 border-rose-900 text-rose-400 animate-pulse'
            }`}>
              {networkOnline ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
              {networkOnline ? 'INGESTION MESH ONLINE' : 'EDGE STORAGE BACKUP ACTIVE'}
            </span>

            <button
              onClick={() => setIsContractPaused(!isContractPaused)}
              className={`px-3 py-1 rounded text-xs font-mono font-medium border flex items-center gap-1.5 transition-all ${
                isContractPaused 
                  ? 'bg-amber-950/40 border-amber-800 text-amber-400' 
                  : 'bg-neutral-900 border-neutral-800 text-neutral-400'
              }`}
            >
              <ShieldAlert className="w-3.5 h-3.5" />
              {isContractPaused ? 'CONTRACTS FROZEN' : 'SYSTEM HEALTH OK'}
            </button>
          </div>
        </div>
      </header>

      {/* Main Grid */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-6 space-y-6">
        
        {/* Network & Contract Warning Banner */}
        {(!networkOnline || isContractPaused) && (
          <div className="bg-rose-950/30 border border-rose-900/60 p-4 rounded-xl flex items-start gap-3">
            <ShieldAlert className="w-5 h-5 text-rose-400 shrink-0 mt-0.5 animate-pulse" />
            <div className="text-xs text-rose-300">
              <span className="font-bold">SYSTEM HAZARD DISPATCH:</span> 
              {!networkOnline && ' Telemetry broadcast offline. Transactions are caching into IndexedDB.'}
              {isContractPaused && ' Soroban host VM processing is paused. Telemetry cannot be billed on-chain.'}
            </div>
          </div>
        )}

        {/* Fleet & Devices Summary Grid */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {nodes.map(node => {
            const isLow = node.balance < 10;
            return (
              <div 
                key={node.id} 
                className={`bg-neutral-900 border rounded-xl p-5 flex flex-col justify-between h-[210px] transition-all ${
                  isLow ? 'border-amber-900/50 hover:border-amber-800' : 'border-neutral-800 hover:border-neutral-700'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-neutral-400 font-semibold">{node.name}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase font-mono ${
                      node.status === 'online' ? 'bg-emerald-950 text-emerald-400' : 'bg-rose-950 text-rose-400'
                    }`}>
                      {node.status}
                    </span>
                  </div>
                  <div className="text-[10px] text-neutral-500 font-mono mt-1">ID: {node.id}</div>
                </div>

                <div className="my-3 flex justify-between items-baseline">
                  <span className="text-2xl font-mono font-bold text-white">
                    {node.lastReading.toFixed(1)} <span className="text-xs text-neutral-500">{node.unit}</span>
                  </span>
                  <div className="text-right">
                    <span className="text-xs text-neutral-400 block">On-Chain Escrow Balance</span>
                    <span className={`text-sm font-mono font-bold ${isLow ? 'text-amber-400' : 'text-cyan-400'}`}>
                      {node.balance.toFixed(4)} XLM
                    </span>
                  </div>
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={() => triggerTelemetrySample(node.id)}
                    className="flex-1 bg-neutral-950 hover:bg-neutral-800 border border-neutral-800 text-xs font-mono font-medium py-1.5 rounded transition-all active:scale-95 text-cyan-400"
                  >
                    Broadcast Telemetry
                  </button>
                  <button
                    onClick={() => setNodes(prev => prev.map(n => n.id === node.id ? { ...n, balance: n.balance + 20 } : n))}
                    className="px-2.5 bg-neutral-950 hover:bg-neutral-800 border border-neutral-800 text-xs text-amber-500 rounded font-mono"
                    title="Fund Escrow Account"
                  >
                    +20 XLM
                  </button>
                </div>
              </div>
            );
          })}
        </section>

        {/* Lower Work Console */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* IndexedDB Offline-First Local Queue */}
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Database className="w-4 h-4 text-cyan-400" />
                  <h3 className="font-bold text-white text-sm">IndexedDB Edge Ingestion Cache</h3>
                </div>
                <span className="text-[10px] bg-cyan-950 text-cyan-400 border border-cyan-800 px-2 py-0.5 rounded font-mono">
                  {queue.length} Buffer Queue
                </span>
              </div>

              <p className="text-xs text-neutral-400 mb-4 leading-relaxed">
                Hardware client transactions waiting for network sync propagation. When connectivity is verified, items automatically trigger on-chain contract settlement.
              </p>

              <div className="bg-neutral-950 border border-neutral-800 rounded-lg overflow-hidden h-[180px] overflow-y-auto">
                <div className="grid grid-cols-12 px-3 py-1.5 border-b border-neutral-900 text-[9px] font-mono text-neutral-500 uppercase tracking-wider">
                  <div className="col-span-4">Node Address</div>
                  <div className="col-span-5">Data Payload</div>
                  <div className="col-span-3 text-right">Cost (XLM)</div>
                </div>

                {queue.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-xs text-neutral-600 font-mono py-8">
                    Queue clear. All edge transactions settled!
                  </div>
                ) : (
                  <div className="divide-y divide-neutral-900">
                    {queue.map(tx => (
                      <div key={tx.id} className="grid grid-cols-12 px-3 py-2 text-[10px] font-mono items-center">
                        <div className="col-span-4 text-white font-bold">{tx.nodeId}</div>
                        <div className="col-span-5 text-neutral-400 truncate pr-2">{tx.payload}</div>
                        <div className="col-span-3 text-right text-cyan-400">{tx.cost.toFixed(4)} XLM</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {queue.length > 0 && (
              <button
                onClick={syncQueue}
                disabled={!networkOnline || isContractPaused}
                className={`w-full mt-4 py-2 text-xs font-mono font-medium rounded border transition-all ${
                  !networkOnline || isContractPaused
                    ? 'bg-neutral-950 border-neutral-900 text-neutral-600 cursor-not-allowed'
                    : 'bg-cyan-950 border-cyan-800 text-cyan-400 hover:bg-cyan-900'
                }`}
              >
                Sync Buffered Telemetry Now
              </button>
            )}
          </div>

          {/* System Terminal Log Stream */}
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-emerald-400" />
                  <h3 className="font-bold text-white text-sm">mTLS Gateway / On-Chain Audit</h3>
                </div>
                <button
                  onClick={() => setLiveLog([])}
                  className="text-[10px] text-neutral-500 hover:text-white"
                >
                  Clear Logs
                </button>
              </div>

              <div className="bg-neutral-950 border border-neutral-800 rounded-lg p-3 font-mono text-xs text-neutral-400 h-[220px] overflow-y-auto space-y-1.5">
                {liveLog.length === 0 ? (
                  <div className="text-center py-12 text-neutral-600">Awaiting system event triggers...</div>
                ) : (
                  liveLog.map(log => (
                    <div key={log.id} className="flex items-start gap-1">
                      <span className="text-neutral-600 shrink-0">&gt;</span>
                      <span className={
                        log.type === 'warn' ? 'text-rose-400' :
                        log.type === 'success' ? 'text-emerald-400' :
                        'text-cyan-400'
                      }>
                        {log.msg}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
