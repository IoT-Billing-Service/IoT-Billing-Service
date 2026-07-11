'use client';

import { useMemo, useState } from 'react';
import { useWallet } from '@/components/providers/WalletProvider';
import { WalletConnector } from '@/components/wallet/WalletConnector';
import { PaymentHistoryTable } from '@/components/escrow/PaymentHistoryTable';
import type { SorobanContractPayment } from '@/types';

/**
 * Aggregates mock payment statistics across all contracts.
 * In production this would come from a multi-contract indexer API.
 */
const MOCK_CONTRACTS = [
  'CCY2QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7',
  'CBX3QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH8',
  'CAW4QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH9',
] as const;

function useAggregatedPaymentStats(): {
  totalSettlements: number;
  totalVolumeXlm: number;
  pendingCount: number;
  failedCount: number;
} {
  return useMemo(() => {
    let totalSettlements = 0;
    let totalVolumeXlm = 0;
    let pendingCount = 0;
    let failedCount = 0;

    for (const contractId of MOCK_CONTRACTS) {
      const payments = generateMockPayments(contractId);
      for (const p of payments) {
        totalSettlements++;
        totalVolumeXlm += Number(p.amount);
        if (p.status === 'pending') pendingCount++;
        if (p.status === 'failed') failedCount++;
      }
    }

    return { totalSettlements, totalVolumeXlm, pendingCount, failedCount };
  }, []);
}

// Reuse the mock generator from PaymentHistoryTable
function generateMockPayments(contractId: string): SorobanContractPayment[] {
  const payments: SorobanContractPayment[] = [];
  const types: SorobanContractPayment['type'][] = [
    'escrow_deposit',
    'escrow_withdrawal',
    'billing_settlement',
    'funding_adjustment',
  ];
  const statuses: SorobanContractPayment['status'][] = [
    'confirmed',
    'confirmed',
    'confirmed',
    'pending',
    'failed',
  ];
  const baseTime = Date.now() - 30 * 24 * 3600_000;

  for (let i = 0; i < 25; i++) {
    const type = types[i % types.length] ?? 'billing_settlement';
    const status = statuses[i % statuses.length] ?? 'confirmed';
    const amount = (Math.random() * 5000 + 10).toFixed(2);
    payments.push({
      transactionHash: `${contractId.slice(0, 8)}${i.toString().padStart(8, '0')}abcdef${i}`,
      contractId,
      type,
      amount,
      asset: 'XLM',
      status,
      source: 'GA7QYNF7SOWQ3GLR2JGMGEKOV7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7',
      destination: contractId,
      timestamp: baseTime + i * 86400_000,
      memo: type === 'billing_settlement' ? `Batch settlement #${i + 1}` : undefined,
      ledger: 45000000 + i * 64,
      fee: (Math.random() * 0.01 + 0.001).toFixed(4),
    });
  }
  return payments;
}

export default function PaymentsPage() {
  const { metrics } = useWallet();
  const [selectedContract, setSelectedContract] = useState(
    'CCY2QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7',
  );
  const stats = useAggregatedPaymentStats();

  if (!metrics?.isConnected) {
    return (
      <div className="mx-auto max-w-md py-16">
        <div className="mb-6 text-center">
          <h2 className="text-xl font-semibold text-white">Payment History</h2>
          <p className="mt-1 text-sm text-gray-400">
            Connect your wallet to view smart contract payment history.
          </p>
        </div>
        <WalletConnector />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white">Smart Contract Payments</h2>
        <p className="mt-0.5 text-sm text-gray-400">
          View payment history across all Soroban escrow contracts
        </p>
      </div>

      {/* Summary KPI bar */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
          <p className="text-xs text-gray-400">Total Settlements</p>
          <p className="mt-1 text-2xl font-bold text-white">
            {stats.totalSettlements.toLocaleString()}
          </p>
        </div>
        <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
          <p className="text-xs text-gray-400">Volume (XLM)</p>
          <p className="mt-1 text-2xl font-bold text-yellow-400">
            {stats.totalVolumeXlm.toLocaleString(undefined, {
              maximumFractionDigits: 0,
            })}{' '}
            <span className="text-xs text-gray-500">XLM</span>
          </p>
        </div>
        <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
          <p className="text-xs text-gray-400">Pending</p>
          <p className="mt-1 text-2xl font-bold text-amber-400">{stats.pendingCount}</p>
        </div>
        <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
          <p className="text-xs text-gray-400">Failed</p>
          <p className="mt-1 text-2xl font-bold text-red-400">{stats.failedCount}</p>
        </div>
      </div>

      {/* Contract selector */}
      <div className="flex items-center gap-3">
        <span className="text-sm text-gray-400">Contract:</span>
        <div className="flex flex-wrap gap-2">
          {[
            {
              id: 'CCY2QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7',
              label: 'Main Escrow',
            },
            {
              id: 'CBX3QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH8',
              label: 'Billing Pool',
            },
            {
              id: 'CAW4QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH9',
              label: 'Dispute Fund',
            },
          ].map((contract) => (
            <button
              key={contract.id}
              onClick={() => setSelectedContract(contract.id)}
              className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                selectedContract === contract.id
                  ? 'bg-green-600/20 text-green-300 border border-green-500/40'
                  : 'bg-gray-800 text-gray-400 border border-gray-700 hover:border-gray-600'
              }`}
            >
              {contract.label}
            </button>
          ))}
        </div>
      </div>

      {/* Payment history table */}
      <PaymentHistoryTable contractId={selectedContract} />
    </div>
  );
}
