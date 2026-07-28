import React, { useState, useMemo, useRef } from 'react';
import {
  DeployedContract,
  VerificationResult,
  VerificationStatus,
  NetworkEnvironment,
} from '../types';
import { INITIAL_DEPLOYED_CONTRACTS } from '../data/contractVerificationData';
import ContractVerifier from './ContractVerifier';
import {
  FileCode,
  Search,
  Filter,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  Shield,
  BarChart3,
  Layers,
  Globe,
  RefreshCw,
  Zap,
} from 'lucide-react';

export default function ContractVerificationDashboard() {
  const [contracts] = useState<DeployedContract[]>(INITIAL_DEPLOYED_CONTRACTS);
  const [verificationResults, setVerificationResults] = useState<
    Record<string, VerificationResult>
  >({});
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<VerificationStatus | 'all'>('all');
  const [networkFilter, setNetworkFilter] = useState<NetworkEnvironment | 'all'>('all');
  const [selectedContractId, setSelectedContractId] = useState<string | null>(
    contracts[0]?.id || null
  );
  const [isVerifyingAll, setIsVerifyingAll] = useState(false);
  const verifyAllRef = useRef<(() => void)[]>([]);

  // Register a callback for each contract to trigger its verification
  const registerVerifyCallback = (contractId: string, callback: () => void) => {
    verifyAllRef.current[contracts.findIndex(c => c.id === contractId)] = callback;
  };

  const filteredContracts = useMemo(() => {
    return contracts.filter((c) => {
      if (statusFilter !== 'all' && c.verificationStatus !== statusFilter)
        return false;
      if (networkFilter !== 'all' && c.network !== networkFilter) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return (
          c.name.toLowerCase().includes(q) ||
          c.contractAddress.toLowerCase().includes(q) ||
          c.id.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [contracts, statusFilter, networkFilter, searchQuery]);

  const selectedContract = contracts.find(
    (c) => c.id === selectedContractId
  );

  const stats = useMemo(() => {
    const total = contracts.length;
    const verified = contracts.filter(
      (c) => c.verificationStatus === 'verified'
    ).length;
    const partial = contracts.filter(
      (c) => c.verificationStatus === 'partial'
    ).length;
    const unverified = contracts.filter(
      (c) =>
        c.verificationStatus === 'unverified' ||
        c.verificationStatus === 'failed'
    ).length;
    const avgSecurity = total > 0
      ? Math.round(
          contracts.reduce((sum, c) => sum + c.securityScore, 0) / total
        )
      : 0;
    return { total, verified, partial, unverified, avgSecurity };
  }, [contracts]);

  const handleVerificationComplete = (result: VerificationResult) => {
    setVerificationResults((prev) => ({
      ...prev,
      [result.contractId]: result,
    }));
  };

  const handleVerifyAll = () => {
    setIsVerifyingAll(true);
    const callbacks = verifyAllRef.current.filter(Boolean);
    callbacks.forEach((verify, index) => {
      setTimeout(() => {
        verify();
        if (index === callbacks.length - 1) {
          setTimeout(() => setIsVerifyingAll(false), 2000);
        }
      }, index * 3000);
    });
  };

  const statusCount = (status: VerificationStatus | 'all') => {
    if (status === 'all') return contracts.length;
    return contracts.filter((c) => c.verificationStatus === status).length;
  };

  const selectedResult = selectedContractId
    ? verificationResults[selectedContractId]
    : null;

  return (
    <div className="space-y-6">
      {/* Dashboard Header */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-purple-950 text-purple-400 rounded-lg border border-purple-800/50">
              <FileCode className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-sans font-medium text-white tracking-tight text-base">
                Contract Verification Dashboard
              </h3>
              <p className="text-xs text-neutral-400 font-mono">
                Soroban Smart Contract Source Verification & Audit Registry
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleVerifyAll}
              disabled={isVerifyingAll}
              className="px-3 py-1.5 rounded bg-purple-950/50 border border-purple-800/60 hover:bg-purple-900/60 text-purple-400 text-xs font-mono font-medium flex items-center gap-1.5 transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isVerifyingAll ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  Verifying...
                </>
              ) : (
                <>
                  <Zap className="w-3.5 h-3.5" />
                  Verify All Contracts
                </>
              )}
            </button>
            <span className="text-[10px] bg-purple-950 text-purple-400 border border-purple-800/50 px-2 py-0.5 rounded font-mono uppercase">
              Soroban Deployments
            </span>
          </div>
        </div>

        {/* Stats Row */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div className="bg-neutral-950 border border-neutral-800 rounded-lg p-3">
            <span className="text-[9px] text-neutral-500 font-mono uppercase block">
              Total Contracts
            </span>
            <span className="text-xl font-bold text-white font-mono">
              {stats.total}
            </span>
          </div>
          <div className="bg-neutral-950 border border-emerald-800/30 rounded-lg p-3">
            <span className="text-[9px] text-emerald-500 font-mono uppercase flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" /> Verified
            </span>
            <span className="text-xl font-bold text-emerald-400 font-mono">
              {stats.verified}
            </span>
          </div>
          <div className="bg-neutral-950 border border-amber-800/30 rounded-lg p-3">
            <span className="text-[9px] text-amber-500 font-mono uppercase flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" /> Partial
            </span>
            <span className="text-xl font-bold text-amber-400 font-mono">
              {stats.partial}
            </span>
          </div>
          <div className="bg-neutral-950 border border-red-800/30 rounded-lg p-3">
            <span className="text-[9px] text-red-500 font-mono uppercase flex items-center gap-1">
              <XCircle className="w-3 h-3" /> Unverified
            </span>
            <span className="text-xl font-bold text-red-400 font-mono">
              {stats.unverified}
            </span>
          </div>
          <div className="bg-neutral-950 border border-neutral-800 rounded-lg p-3">
            <span className="text-[9px] text-neutral-500 font-mono uppercase block">
              Avg Security Score
            </span>
            <span
              className={`text-xl font-bold font-mono ${
                stats.avgSecurity >= 80
                  ? 'text-emerald-400'
                  : stats.avgSecurity >= 50
                    ? 'text-amber-400'
                    : 'text-red-400'
              }`}
            >
              {stats.avgSecurity}
              <span className="text-sm text-neutral-500">/100</span>
            </span>
          </div>
        </div>
      </div>

      {/* Filter & Search Bar */}
      <div className="flex flex-wrap items-center gap-3 bg-neutral-900 border border-neutral-800 rounded-xl p-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search contracts by name, address, or ID..."
            className="w-full bg-neutral-950 border border-neutral-800 rounded-lg pl-8 pr-3 py-2 text-xs font-mono text-white placeholder:text-neutral-600 focus:outline-none focus:border-purple-500 transition-colors"
          />
        </div>
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-neutral-500" />
          <select
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as VerificationStatus | 'all')
            }
            className="bg-neutral-950 border border-neutral-800 rounded-lg px-2.5 py-2 text-xs font-mono text-white focus:outline-none focus:border-purple-500"
          >
            <option value="all">All Statuses ({contracts.length})</option>
            <option value="verified">
              Verified ({statusCount('verified')})
            </option>
            <option value="partial">
              Partial ({statusCount('partial')})
            </option>
            <option value="unverified">
              Unverified ({statusCount('unverified')})
            </option>
            <option value="failed">
              Failed ({statusCount('failed')})
            </option>
            <option value="pending">
              Pending ({statusCount('pending')})
            </option>
          </select>
          <select
            value={networkFilter}
            onChange={(e) =>
              setNetworkFilter(e.target.value as NetworkEnvironment | 'all')
            }
            className="bg-neutral-950 border border-neutral-800 rounded-lg px-2.5 py-2 text-xs font-mono text-white focus:outline-none focus:border-purple-500"
          >
            <option value="all">All Networks</option>
            <option value="mainnet">Mainnet</option>
            <option value="testnet">Testnet</option>
            <option value="futurenet">Futurenet</option>
            <option value="standalone">Standalone</option>
          </select>
        </div>
      </div>

      {/* Contract List + Detail Panel */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Contract List */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs font-mono text-neutral-500 mb-2 px-1">
            <span>Contract List</span>
            <span>
              {filteredContracts.length} of {contracts.length} contracts
            </span>
          </div>
          {filteredContracts.length === 0 ? (
            <div className="text-center p-8 bg-neutral-900 border border-neutral-800 rounded-xl">
              <Search className="w-8 h-8 text-neutral-600 mx-auto mb-2" />
              <p className="text-xs text-neutral-500 font-mono">
                No contracts match your filters
              </p>
            </div>
          ) : (
            filteredContracts.map((contract) => {
              const isSelected = contract.id === selectedContractId;
              const statusColors: Record<
                VerificationStatus,
                string
              > = {
                verified:
                  'border-l-emerald-500',
                partial:
                  'border-l-amber-500',
                pending:
                  'border-l-blue-500',
                unverified:
                  'border-l-red-500',
                failed:
                  'border-l-red-500',
              };
              return (
                <button
                  key={contract.id}
                  onClick={() => setSelectedContractId(contract.id)}
                  data-contract-id={contract.id}
                  className={`w-full text-left p-3 rounded-lg border border-l-4 transition-all ${
                    isSelected
                      ? 'bg-purple-950/20 border-purple-800/60 border-l-purple-500'
                      : 'bg-neutral-900 border-neutral-800 hover:border-neutral-700 border-l-neutral-800'
                  } ${statusColors[contract.verificationStatus]}`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-mono font-semibold text-white truncate max-w-[140px]">
                      {contract.name}
                    </span>
                    {contract.verificationStatus === 'verified' ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    ) : contract.verificationStatus === 'partial' ? (
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    ) : (
                      <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                    )}
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] text-neutral-500 font-mono">
                      v{contract.version}
                    </span>
                    <span className="text-[9px] font-mono capitalize text-neutral-500">
                      {contract.network}
                    </span>
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Right: Detail Panel */}
        <div className="lg:col-span-2">
          {selectedContract ? (
            <ContractVerifier
              contract={selectedContract}
              onVerificationComplete={handleVerificationComplete}
            />
          ) : (
            <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-8 text-center">
              <FileCode className="w-12 h-12 text-neutral-700 mx-auto mb-3" />
              <p className="text-sm text-neutral-500 font-mono">
                Select a contract from the list to view details and run
                verification
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Deployment Summary Footer */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-neutral-400" />
            <span className="text-xs font-mono font-medium text-white">
              Deployment Overview
            </span>
          </div>
          <span className="text-[10px] text-neutral-500 font-mono">
            Last updated: {new Date().toLocaleString()}
          </span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[10px] font-mono">
          <div className="flex items-center gap-1.5">
            <Globe className="w-3.5 h-3.5 text-amber-400" />
            <span className="text-neutral-400">
              Testnet:{' '}
              <span className="text-white">
                {contracts.filter((c) => c.network === 'testnet').length}
              </span>
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Globe className="w-3.5 h-3.5 text-blue-400" />
            <span className="text-neutral-400">
              Futurenet:{' '}
              <span className="text-white">
                {contracts.filter((c) => c.network === 'futurenet').length}
              </span>
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Shield className="w-3.5 h-3.5 text-purple-400" />
            <span className="text-neutral-400">
              Audited:{' '}
              <span className="text-white">
                {contracts.filter((c) => c.auditReports.length > 0).length}/
                {contracts.length}
              </span>
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <BarChart3 className="w-3.5 h-3.5 text-cyan-400" />
            <span className="text-neutral-400">
              Total Functions:{' '}
              <span className="text-white">
                {contracts.reduce((sum, c) => sum + c.functions.length, 0)}
              </span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
