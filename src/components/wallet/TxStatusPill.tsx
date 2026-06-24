'use client';

import type { PendingTransaction } from '@/services/indexedDbCache';
import { TX_STATUS_CLASSES, TX_STATUS_FALLBACK_CLASSES } from '@/lib/statusClasses';

interface TxStatusPillProps {
  transaction: PendingTransaction;
}

export function TxStatusPill({ transaction }: TxStatusPillProps) {
  const getStatusDisplay = () => {
    switch (transaction.status) {
      case 'pending':
        return {
          text: 'Submitted (pending confirmation)',
          color: TX_STATUS_CLASSES.pending,
          icon: '⏳',
        };
      case 'confirmed':
        return {
          text: transaction.lastScannedLedger
            ? `Confirmed on ledger ${transaction.lastScannedLedger}`
            : 'Confirmed',
          color: TX_STATUS_CLASSES.confirmed,
          icon: '✓',
        };
      case 'failed':
        return {
          text: `Failed - retry ${transaction.retryCount}/${transaction.maxRetries}`,
          color: TX_STATUS_CLASSES.failed,
          icon: '✗',
        };
      default:
        return {
          text: 'Unknown',
          color: TX_STATUS_FALLBACK_CLASSES,
          icon: '?',
        };
    }
  };

  const status = getStatusDisplay();

  return (
    <div
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium ${status.color}`}
    >
      <span className="text-base leading-none">{status.icon}</span>
      <span>{status.text}</span>
      {transaction.status === 'pending' && (
        <span className="ml-1 text-[10px] opacity-70">
          {new Date(transaction.createdAt).toLocaleTimeString()}
        </span>
      )}
    </div>
  );
}

interface TxStatusListProps {
  transactions: PendingTransaction[];
  onClearCompleted?: () => void;
}

export function TxStatusList({ transactions, onClearCompleted }: TxStatusListProps) {
  const hasCompleted = transactions.some((tx) => tx.status === 'confirmed');

  if (transactions.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2 rounded-lg border border-gray-700 bg-gray-800/50 p-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-gray-300">Transaction Status</h4>
        {hasCompleted && onClearCompleted && (
          <button
            onClick={onClearCompleted}
            className="rounded bg-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-600"
          >
            Clear completed
          </button>
        )}
      </div>
      <div className="space-y-2">
        {transactions.map((tx) => (
          <div
            key={tx.id}
            className="flex items-center justify-between rounded border border-gray-700 bg-gray-900 p-3"
          >
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400">
                  {tx.type === 'escrow_deposit' ? 'Deposit' : 'Withdrawal'}
                </span>
                <span className="font-mono text-xs text-gray-500">
                  {tx.amount} {tx.asset}
                </span>
              </div>
              <div className="mt-1 font-mono text-[10px] text-gray-600">
                {tx.hash.slice(0, 16)}...
              </div>
            </div>
            <TxStatusPill transaction={tx} />
          </div>
        ))}
      </div>
    </div>
  );
}
