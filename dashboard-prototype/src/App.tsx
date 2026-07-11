import React, { useState, useEffect, useRef } from 'react';
import { DePinNode, VariableTariff, TelemetryPayload, RetryQueueTransaction } from './types';
import { INITIAL_NODES, INITIAL_TARIFFS, generateRandomHex } from './data/initialData';
import ZkProofVerifier from './components/ZkProofVerifier';
import EscrowList from './components/EscrowList';
import NetworkRetryQueue from './components/NetworkRetryQueue';
import TelemetryFeed from './components/TelemetryFeed';
import { 
  Network, 
  Cpu, 
  Coins, 
  FileCheck, 
  TrendingUp, 
  Database, 
  ShieldCheck, 
  RefreshCw, 
  Wifi, 
  AlertTriangle,
  Github,
  Zap,
  HelpCircle,
  Code2
} from 'lucide-react';

export default function App() {
  // Application State
  const [nodes, setNodes] = useState<DePinNode[]>(INITIAL_NODES);
  const [tariffs, setTariffs] = useState<VariableTariff[]>(INITIAL_TARIFFS);
  const [payloads, setPayloads] = useState<TelemetryPayload[]>([
    {
      id: 'TX-891a27b',
      nodeId: 'DePIN-ENV-081',
      nodeName: 'Munich Air Quality Sensor',
      timestamp: new Date(Date.now() - 30000).toLocaleTimeString(),
      value: 21.8,
      unit: '°C',
      payloadSizeKB: 1.1,
      cost: 0.0036,
      zkVerified: true,
      rawHex: '0xfa89c02d1800e31c890aefd28e719',
    },
    {
      id: 'TX-102bc45',
      nodeId: 'DePIN-GRID-102',
      nodeName: 'Berlin Solar Dispatch Grid',
      timestamp: new Date(Date.now() - 15000).toLocaleTimeString(),
      value: 840.5,
      unit: 'kW',
      payloadSizeKB: 2.3,
      cost: 0.0141,
      zkVerified: true,
      rawHex: '0x0d3f28a9b2b11cc5d33f11eef2a3d',
    },
  ]);
  const [bufferedTransactions, setBufferedTransactions] = useState<RetryQueueTransaction[]>([]);
  
  // Controls
  const [isNetworkOnline, setIsNetworkOnline] = useState<boolean>(true);
  const [isContractPaused, setIsContractPaused] = useState<boolean>(false);
  const [zkVerifySuccessCount, setZkVerifySuccessCount] = useState<number>(2);
  const [rentDecayAlert, setRentDecayAlert] = useState<boolean>(false);
  const [showExplanationModal, setShowExplanationModal] = useState<boolean>(false);

  // Stats Counters
  const [totalXlmBilled, setTotalXlmBilled] = useState<number>(0.1885);

  // Reference to prevent state updates on unmounted component
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const rentTimerRef = useRef<NodeJS.Timeout | null>(null);

  // 1. Core Telemetry Simulation Loop
  // Generates automatic telemetry every 5 seconds for online devices
  useEffect(() => {
    timerRef.current = setInterval(() => {
      // Pick a random online node
      const activeNodes = nodes.filter(n => n.status === 'online');
      if (activeNodes.length === 0) return;

      const randomNode = activeNodes[Math.floor(Math.random() * activeNodes.length)];
      generateTelemetryForNode(randomNode);
    }, 5000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [nodes, isNetworkOnline, isContractPaused, tariffs]);

  // 2. Storage Rent Decay Simulation Loop
  // Simulates Soroban's native ledger state storage rent every 12 seconds
  useEffect(() => {
    rentTimerRef.current = setInterval(() => {
      setRentDecayAlert(true);
      setTimeout(() => setRentDecayAlert(false), 2000);

      setNodes(prevNodes => 
        prevNodes.map(node => {
          const decayedBalance = Math.max(0, node.balance - node.rentCostPerHour / 300); // fraction of rent
          const isExhausted = decayedBalance <= 5.0;

          return {
            ...node,
            balance: decayedBalance,
            status: isExhausted ? 'exhausted' : node.status,
          };
        })
      );
    }, 12000);

    return () => {
      if (rentTimerRef.current) clearInterval(rentTimerRef.current);
    };
  }, []);

  // Telemetry Generation Engine
  const generateTelemetryForNode = (node: DePinNode) => {
    const tariff = tariffs.find(t => t.id === node.tariffId) || tariffs[0];
    
    // Calculate randomized hardware telemetry readings
    let telemetryValue = node.lastTelemetryValue;
    if (node.type === 'environmental') {
      telemetryValue += (Math.random() - 0.5) * 1.5; // variance in temperature
    } else if (node.type === 'power_grid') {
      telemetryValue += (Math.random() - 0.5) * 20; // grid fluctuations
    } else {
      telemetryValue += (Math.random() - 0.5) * 5; // bandwidth variance
    }

    // Size of the telemetry payload
    const payloadSizeKB = parseFloat((0.8 + Math.random() * 2.5).toFixed(2));
    
    // Calculate Soroban execution charge (Base Tariff + Footprint rate * Size + gas fee buffer)
    const cost = tariff.baseRatePerPayload + (payloadSizeKB * tariff.sizeRatePerKB) + tariff.gasBuffer;

    if (!isNetworkOnline) {
      // NETWORK IS OFFLINE -> Buffer locally in Simulated IndexedDB
      const offlineTxId = `TX-OFFLINE-${generateRandomHex(8)}`;
      const rawHex = generateRandomHex(40);
      const newBufferedTx: RetryQueueTransaction = {
        id: offlineTxId,
        nodeId: node.id,
        nodeName: node.name,
        payload: rawHex,
        cost: cost,
        timestamp: new Date().toLocaleTimeString(),
        retries: 0,
        status: 'buffered',
      };

      setBufferedTransactions(prev => [...prev, newBufferedTx]);
    } else {
      // NETWORK IS ONLINE
      if (isContractPaused) {
        // Contracts paused -> Telemetry is dropped or fails processing on ledger
        const droppedTxId = `TX-REJECTED-${generateRandomHex(8)}`;
        const rawHex = generateRandomHex(40);
        const droppedPayload: TelemetryPayload = {
          id: droppedTxId,
          nodeId: node.id,
          nodeName: node.name,
          timestamp: new Date().toLocaleTimeString(),
          value: telemetryValue,
          unit: node.unit,
          payloadSizeKB,
          cost: 0, // No payment processed because ledger is paused!
          zkVerified: false,
          rawHex,
        };
        setPayloads(prev => [droppedPayload, ...prev]);
        return;
      }

      // Check if Escrow is exhausted
      if (node.balance < cost) {
        setNodes(prev => 
          prev.map(n => n.id === node.id ? { ...n, status: 'exhausted' as const } : n)
        );
        return;
      }

      // Everything OK -> Process Debit
      const txHash = `TX-${generateRandomHex(12)}`;
      const rawHex = generateRandomHex(40);
      const newPayload: TelemetryPayload = {
        id: txHash,
        nodeId: node.id,
        nodeName: node.name,
        timestamp: new Date().toLocaleTimeString(),
        value: telemetryValue,
        unit: node.unit,
        payloadSizeKB,
        cost,
        zkVerified: true, // ZK Proof automatic verification
        rawHex,
      };

      // Apply ledger changes
      setNodes(prev =>
        prev.map(n => {
          if (n.id === node.id) {
            const nextBalance = n.balance - cost;
            return {
              ...n,
              balance: nextBalance,
              totalBilled: n.totalBilled + cost,
              lastTelemetryValue: telemetryValue,
              status: nextBalance <= 5.0 ? 'exhausted' : 'online',
            };
          }
          return n;
        })
      );

      setPayloads(prev => [newPayload, ...prev]);
      setTotalXlmBilled(prev => prev + cost);
      setZkVerifySuccessCount(prev => prev + 1);
    }
  };

  // Fund Escrow
  const handleFundEscrow = (nodeId: string, amount: number) => {
    setNodes(prev =>
      prev.map(n => {
        if (n.id === nodeId) {
          const updatedBalance = Math.min(n.maxEscrowCapacity, n.balance + amount);
          return {
            ...n,
            balance: updatedBalance,
            status: updatedBalance > 5.0 ? 'online' as const : n.status,
          };
        }
        return n;
      })
    );
  };

  // Update Tariff rates
  const handleUpdateTariff = (tariffId: string, updatedFields: Partial<VariableTariff>) => {
    setTariffs(prev =>
      prev.map(t => (t.id === tariffId ? { ...t, ...updatedFields } : t))
    );
  };

  // Toggle Contract Pause (Emergency Multi-Sig Veto)
  const handleToggleEmergencyPause = () => {
    setIsContractPaused(prev => !prev);
  };

  // Toggle Network Online/Offline
  const handleToggleNetwork = () => {
    setIsNetworkOnline(prev => !prev);
  };

  // Force Sync Offline IndexedDB queue
  const handleForceSync = () => {
    if (bufferedTransactions.length === 0 || !isNetworkOnline || isContractPaused) return;

    // We process each item with a delay to simulate real network sync propagation
    let delay = 0;
    bufferedTransactions.forEach((tx, idx) => {
      // Mark as syncing
      setBufferedTransactions(prev =>
        prev.map(item => item.id === tx.id ? { ...item, status: 'syncing' as const } : item)
      );

      setTimeout(() => {
        setNodes(prevNodes => {
          const targetNode = prevNodes.find(n => n.id === tx.nodeId);
          if (!targetNode || targetNode.balance < tx.cost) {
            // Mark failed due to depleted escrow
            setBufferedTransactions(prev =>
              prev.map(item =>
                item.id === tx.id
                  ? { ...item, status: 'failed' as const, errorReason: 'Escrow Depleted' }
                  : item
              )
            );
            return prevNodes;
          }

          // Successful debit
          const updatedNodes = prevNodes.map(n => {
            if (n.id === tx.nodeId) {
              const nextBalance = n.balance - tx.cost;
              return {
                ...n,
                balance: nextBalance,
                totalBilled: n.totalBilled + tx.cost,
                status: nextBalance <= 5.0 ? 'exhausted' as const : n.status,
              };
            }
            return n;
          });

          // Add to ledger feed
          const syncedPayload: TelemetryPayload = {
            id: tx.id.replace('OFFLINE', 'SYNCED'),
            nodeId: tx.nodeId,
            nodeName: tx.nodeName,
            timestamp: new Date().toLocaleTimeString(),
            value: targetNode.lastTelemetryValue + (Math.random() - 0.5) * 2,
            unit: targetNode.unit,
            payloadSizeKB: 1.5,
            cost: tx.cost,
            zkVerified: true,
            rawHex: tx.payload,
          };

          setPayloads(prevPay => [syncedPayload, ...prevPay]);
          setTotalXlmBilled(prevBill => prevBill + tx.cost);
          setZkVerifySuccessCount(prevCount => prevCount + 1);

          // Remove successfully synced item from buffer
          setBufferedTransactions(prevBuf => prevBuf.filter(item => item.id !== tx.id));

          return updatedNodes;
        });
      }, delay);

      delay += 800; // stagger syncs by 800ms
    });
  };

  // Manual Trigger a surge of telemetry signals across all devices
  const triggerTelemetrySurge = () => {
    nodes.forEach(node => {
      if (node.status === 'online') {
        generateTelemetryForNode(node);
      }
    });
  };

  // Manual trigger to deplete a node escrow balance to show automated pausing
  const triggerDepletion = (nodeId: string) => {
    setNodes(prev =>
      prev.map(n => n.id === nodeId ? { ...n, balance: 4.8, status: 'exhausted' as const } : n)
    );
  };

  // Calculations for total escrows locked
  const totalEscrowLocked = nodes.reduce((sum, n) => sum + n.balance, 0);

  return (
    <div className="min-h-screen bg-black text-neutral-100 flex flex-col selection:bg-cyan-500 selection:text-black">
      {/* Top Header Banner & Repository Navigation */}
      <header className="bg-neutral-950 border-b border-neutral-900 sticky top-0 z-50 px-6 py-4">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-cyan-400 animate-pulse" />
              <h1 className="font-sans font-bold text-white tracking-tight text-lg">
                IoT Billing Service <span className="text-cyan-400 font-mono text-sm font-medium">DePIN Playground</span>
              </h1>
            </div>
            <p className="text-xs text-neutral-400 font-mono mt-1">
              Enterprise-Grade Web3 Hardware Telemetry Metering & Soroban Smart Contracts
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => setShowExplanationModal(true)}
              className="px-3 py-1.5 rounded bg-neutral-900 hover:bg-neutral-800 text-xs text-neutral-300 font-mono flex items-center gap-1.5 border border-neutral-800 transition-colors"
            >
              <HelpCircle className="w-3.5 h-3.5 text-cyan-400" />
              How It Works
            </button>

            <a
              href="https://github.com/IoT-Billing-Service"
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 rounded bg-cyan-950 hover:bg-cyan-900 text-xs text-cyan-400 font-mono flex items-center gap-1.5 border border-cyan-800/40 transition-colors"
            >
              <Github className="w-3.5 h-3.5" />
              Organization Repo
            </a>
          </div>
        </div>
      </header>

      {/* Main Interactive Work Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-6 space-y-6">
        
        {/* Real-time rent storage alert overlay */}
        {rentDecayAlert && (
          <div className="bg-amber-950/40 border border-amber-900/50 text-amber-400 text-xs font-mono px-4 py-2 rounded-lg flex items-center gap-2 justify-between animate-fade-in">
            <span className="flex items-center gap-1.5">
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              <span>Simulated Stellar Epoch: Soroban state ledger rent storage fee deducted from all escrow balances!</span>
            </span>
            <span className="text-[10px] bg-amber-900/50 border border-amber-800 px-1.5 py-0.5 rounded">
              -Rent Decayed
            </span>
          </div>
        )}

        {/* Global Dashboard Metrics */}
        <section className="grid grid-cols-1 md:grid-cols-4 gap-4" id="dashboard-metrics-summary">
          {/* Metric 1 */}
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 flex flex-col justify-between">
            <span className="text-[10px] font-mono text-neutral-500 uppercase">Active Ingested Nodes</span>
            <div className="flex items-baseline gap-2 mt-2">
              <span className="text-2xl font-bold text-white font-mono">
                {nodes.filter(n => n.status === 'online').length}
              </span>
              <span className="text-xs text-emerald-400 font-mono flex items-center gap-0.5">
                ● {nodes.length} registered
              </span>
            </div>
            <p className="text-[10px] text-neutral-500 font-mono mt-1">mTLS Client Certificate Handshake</p>
          </div>

          {/* Metric 2 */}
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 flex flex-col justify-between">
            <span className="text-[10px] font-mono text-neutral-500 uppercase">Total Micro-Billed</span>
            <div className="flex items-baseline gap-2 mt-2">
              <span className="text-2xl font-bold text-cyan-400 font-mono">
                {totalXlmBilled.toFixed(4)}
              </span>
              <span className="text-xs text-neutral-400 font-mono">XLM</span>
            </div>
            <p className="text-[10px] text-neutral-500 font-mono mt-1">Autonomous Escrow Debits Complete</p>
          </div>

          {/* Metric 3 */}
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 flex flex-col justify-between">
            <span className="text-[10px] font-mono text-neutral-500 uppercase">Total Locked in Escrow</span>
            <div className="flex items-baseline gap-2 mt-2">
              <span className="text-2xl font-bold text-amber-500 font-mono">
                {totalEscrowLocked.toFixed(4)}
              </span>
              <span className="text-xs text-neutral-400 font-mono">XLM</span>
            </div>
            <p className="text-[10px] text-neutral-500 font-mono mt-1">On-Ledger Soroban Contract TVL</p>
          </div>

          {/* Metric 4 */}
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 flex flex-col justify-between">
            <span className="text-[10px] font-mono text-neutral-500 uppercase">ZK Proof verifications</span>
            <div className="flex items-baseline gap-2 mt-2">
              <span className="text-2xl font-bold text-emerald-400 font-mono">
                {zkVerifySuccessCount}
              </span>
              <span className="text-xs text-emerald-500 font-mono flex items-center">
                ✔ 100% success
              </span>
            </div>
            <p className="text-[10px] text-neutral-500 font-mono mt-1">Bulletproof Constraint Verifiers</p>
          </div>
        </section>

        {/* Quick Testing Actions Console */}
        <div className="bg-neutral-950 border border-neutral-900 p-4 rounded-xl flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Zap className="text-amber-500 w-4 h-4" />
            <span className="text-xs font-mono font-semibold text-neutral-300">INTERACTIVE TESTING CONSOLE:</span>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              onClick={triggerTelemetrySurge}
              className="bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 text-xs font-sans font-medium text-white px-3 py-1.5 rounded transition-all active:scale-95"
            >
              Force Telemetry Surge
            </button>
            <button
              onClick={() => triggerDepletion('DePIN-WIFI-540')}
              className="bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 text-xs font-sans font-medium text-amber-400 px-3 py-1.5 rounded transition-all active:scale-95"
            >
              Trigger Hamburg Escrow Depletion
            </button>
            <button
              onClick={() => {
                alert("Soroban Host contract WASM hash upgrade proposed. Timelock: 24 Hours. Required Multi-sig signatures: 2/3. Ledger State: Pending.");
              }}
              className="bg-cyan-950/30 border border-cyan-800/40 hover:bg-cyan-900/30 text-xs font-sans font-medium text-cyan-400 px-3 py-1.5 rounded transition-all active:scale-95"
            >
              Propose WASM Code Upgrade
            </button>
          </div>
        </div>

        {/* Two Column Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Column 1: Smart Contracts Escrows & Pricing Tariffs */}
          <div className="space-y-6">
            <EscrowList
              nodes={nodes}
              tariffs={tariffs}
              onFundEscrow={handleFundEscrow}
              onUpdateTariff={handleUpdateTariff}
              isContractPaused={isContractPaused}
              onToggleEmergencyPause={handleToggleEmergencyPause}
            />
          </div>

          {/* Column 2: ZK Verifier, Ingestion Buffer & Telemetry Ledger */}
          <div className="space-y-6">
            {/* ZK Verifier */}
            <ZkProofVerifier onVerifySuccess={() => setZkVerifySuccessCount(prev => prev + 1)} />

            {/* Offline-First Transaction Buffering Retry Queue */}
            <NetworkRetryQueue
              isNetworkOnline={isNetworkOnline}
              onToggleNetwork={handleToggleNetwork}
              bufferedTransactions={bufferedTransactions}
              onForceSync={handleForceSync}
            />

            {/* Ingested Telemetry Live ledger Stream */}
            <TelemetryFeed
              payloads={payloads}
              onClear={() => setPayloads([])}
            />
          </div>
        </div>
      </main>

      {/* Explanation Modal */}
      {showExplanationModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 max-w-2xl w-full max-h-[85vh] overflow-y-auto space-y-4">
            <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
              <h3 className="font-sans font-bold text-white text-base">IoT-Billing-Service Architecture Breakdown</h3>
              <button
                onClick={() => setShowExplanationModal(false)}
                className="text-neutral-500 hover:text-white font-mono text-sm"
              >
                [CLOSE]
              </button>
            </div>

            <div className="space-y-3 text-xs text-neutral-300 font-mono leading-relaxed">
              <p>
                This interactive playground visualizes the full operational lifecycle of the <span className="text-cyan-400">IoT-Billing-Service</span>, mapped precisely to your open-source enterprise GitHub repositories:
              </p>

              <div className="bg-neutral-950 p-3 rounded border border-neutral-800 space-y-2">
                <div className="flex items-center gap-1.5 font-bold text-white">
                  <Code2 className="w-4 h-4 text-amber-500" />
                  <span>1. Billing-contracts (Soroban Smart Contracts)</span>
                </div>
                <p className="text-neutral-400 text-[11px] pl-5">
                  Implemented on Stellar's native Soroban environment, these smart contracts manage dynamic escrow funds, execute variable-rate billing formulas, and support on-chain emergency pause/multisig functions.
                </p>
                <p className="text-neutral-400 text-[11px] pl-5 text-amber-500">
                  ⚡ Play with this: Toggle the "Emergency Contract Pause" or inspect "Soroban Rent Storage Fee" deductions occurring automatically in real-time.
                </p>
              </div>

              <div className="bg-neutral-950 p-3 rounded border border-neutral-800 space-y-2">
                <div className="flex items-center gap-1.5 font-bold text-white">
                  <Cpu className="w-4 h-4 text-emerald-400" />
                  <span>2. iot-billing-backend (Ingestion & ZK verification Gateway)</span>
                </div>
                <p className="text-neutral-400 text-[11px] pl-5">
                  Provides telemetry ingestion verifying hardware signatures with ZK Range Proofs (Bulletproofs). This ensures data integrity by preventing hardware spoofing and validating boundaries before ledger state updates.
                </p>
                <p className="text-neutral-400 text-[11px] pl-5 text-emerald-400">
                  ⚡ Play with this: Drag the ZK Range-Proof sliders to test values. Telemetry violating contract constraints gets safely blocked from billing!
                </p>
              </div>

              <div className="bg-neutral-950 p-3 rounded border border-neutral-800 space-y-2">
                <div className="flex items-center gap-1.5 font-bold text-white">
                  <Wifi className="w-4 h-4 text-cyan-400" />
                  <span>3. iot-billing-frontend (IndexedDB Retry Queue Dashboard)</span>
                </div>
                <p className="text-neutral-400 text-[11px] pl-5">
                  Offers a real-time multi-tenant view of active device streams, balance limits, and maintains local transaction safety via an offline-first retry buffer.
                </p>
                <p className="text-neutral-400 text-[11px] pl-5 text-cyan-400">
                  ⚡ Play with this: Toggle "Simulate Network Outage" to sever connections. Devices will buffer state locally, then sync and settle once connection is restored!
                </p>
              </div>
            </div>

            <div className="pt-2 text-right">
              <button
                onClick={() => setShowExplanationModal(false)}
                className="bg-cyan-950 hover:bg-cyan-900 text-cyan-400 px-4 py-2 rounded text-xs font-mono font-bold transition-all border border-cyan-800"
              >
                Acknowledge & Continue
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Humble Professional Footer */}
      <footer className="bg-neutral-950 border-t border-neutral-900 px-6 py-4 mt-auto text-center">
        <p className="text-[10px] text-neutral-500 font-mono uppercase">
          IoT-Billing-Service DePIN Ecosystem Simulator • Built for high fidelity Stellar/Soroban verification
        </p>
      </footer>
    </div>
  );
}
