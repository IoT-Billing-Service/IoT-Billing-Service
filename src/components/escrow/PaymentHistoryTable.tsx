'use client';

import { useMemo, useState } from 'react';
import type { SorobanContractPayment } from '@/types';

interface PaymentHistoryTableProps {
  contractId: string;
}

/**
 * Deterministic mock payment history for demonstration.
 * In production these come from a Soroban event indexer API.
 */
function generateMockPayments(contractId: string): SorobanContractPayment[] {
  const payments: SorobanContractPayment[] = [];
  const types: SorobanContractPayment['type'][] = [
    'escrow_deposit',
    'escrow_withdrawal',
    'billing_settlement',
    'funding_adjustment',
  ];
  const statuses: SorobanContractPayment['status'][] = ['confirmed', 'confirmed', 'confirmed', 'pending', 'failed'];
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

  return payments.sort((a, b) => b.timestamp - a.timestamp);
}

const TYPE_LABELS: Record<SorobanContractPayment['type'], string> = {
  escrow_deposit: 'Escrow Deposit',
  escrow_withdrawal: 'Escrow Withdrawal',
  billing_settlement: 'Billing Settlement',
  funding_adjustment: 'Funding Adjustment',
};

const TYPE_COLORS: Record<SorobanContractPayment['type'], string> = {
  escrow_deposit: 'text-green-400',
  escrow_withdrawal: 'text-blue-400',
  billing_settlement: 'text-yellow-400',
  funding_adjustment: 'text-purple-400',
};

const STATUS_PILL: Record<SorobanContractPayment['status'], string> = {
  pending: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/40',
  confirmed: 'bg-green-500/20 text-green-300 border-green-500/40',
  failed: 'bg-red-500/20 text-red-300 border-red-500/40',
};

export function PaymentHistoryTable({ contractId }: PaymentHistoryTableProps) {
  const [filterType, setFilterType] = useState<SorobanContractPayment['type'] | 'all'>('all');

  const payments = useMemo(() => generateMockPayments(contractId), [contractId]);
  const filtered = useMemo(
    () => (filterType === 'all' ? payments : payments.filter((p) => p.type === filterType)),
    [payments, filterType],
  );

  return (
    <div className="rounded-lg border border-gray-700 bg-gray-900 p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-white">Payment History</h3>
        <span className="text-xs text-gray-500">{payments.length} transactions</span>
      </div>

      {/* Type filter */}
      <div className="mt-3 flex flex-wrap gap-2">
        {(['all', ...new Set(payments.map((p) => p.type))] as const).map((type) => (
          <button
            key={type}
            onClick={() => setFilterType(type)}
            className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
              filterType === type
                ? 'bg-gray-700 text-gray-200'
                : 'bg-gray-800 text-gray-500 hover:text-gray-300'
            }`}
          >
            {type === 'all' ? 'All' : TYPE_LABELS[type] ?? type}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-left text-xs text-gray-500">
              <th className="pb-2 pr-4 font-medium">Type</th>
              <th className="pb-2 pr-4 font-medium">Amount</th>
              <th className="pb-2 pr-4 font-medium">Status</th>
              <th className="pb-2 pr-4 font-medium">Date</th>
              <th className="pb-2 pr-4 font-medium">Ledger</th>
              <th className="pb-2 font-medium">Tx Hash</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 20).map((payment) => (
              <tr key={payment.transactionHash} className="border-b border-gray-800/50">
                <td className="py-2.5 pr-4">
                  <span className={`text-xs font-medium ${TYPE_COLORS[payment.type]}`}>
                    {TYPE_LABELS[payment.type]}
                  </span>
                </td>
                <td className="py-2.5 pr-4 font-mono text-gray-300">
                  {Number(payment.amount).toLocaleString()}{' '}
                  <span className="text-gray-500">{payment.asset}</span>
                </td>
                <td className="py-2.5 pr-4">
                  <span
                    className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${STATUS_PILL[payment.status]}`}
                  >
                    {payment.status}
                  </span>
                </td>
                <td className="py-2.5 pr-4 text-gray-400">
                  {new Date(payment.timestamp).toLocaleDateString()}
                </td>
                <td className="py-2.5 pr-4 font-mono text-xs text-gray-500">
                  {payment.ledger?.toLocaleString() ?? '—'}
                </td>
                <td className="py-2.5 font-mono text-[10px] text-gray-500">
                  {payment.transactionHash.slice(0, 12)}...
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 && (
        <div className="py-8 text-center text-sm text-gray-500">
          No payments match the current filter.
        </div>
      )}
    </div>
  );
}
