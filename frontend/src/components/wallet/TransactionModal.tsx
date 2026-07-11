'use client';

import { useState, useEffect, useRef } from 'react';
import { useWallet } from '@/components/providers/WalletProvider';
import { ErrorDecoder } from '@/utils/errorDecoder';
import { useTxRetryQueue } from '@/hooks/useTxRetryQueue';
import { TxStatusList } from './TxStatusPill';
import { GasEstimator } from './GasEstimator';
import { useGasEstimate } from '@/hooks/useGasEstimate';
import { useFormTracker } from '@/stores/useFormTracker';

function ErrorBanner({ decoded, raw }: { decoded: string; raw: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mt-3 rounded bg-red-900/30 p-2 text-xs text-red-400">
      <div>{decoded}</div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="mt-1 text-[10px] text-red-500 underline hover:text-red-300"
      >
        {expanded ? 'Hide details' : 'Details'}
      </button>
      {expanded && (
        <div className="mt-1 break-all rounded bg-red-950/40 p-1.5 font-mono text-[10px] text-red-300">
          {raw}
        </div>
      )}
    </div>
  );
}

interface TransactionModalProps {
  type: 'escrow_deposit' | 'escrow_withdrawal';
  contractId: string;
  asset: string;
  onComplete?: (hash: string) => void;
  onClose: () => void;
}

const errorDecoder = new ErrorDecoder();

export function TransactionModal({
  type,
  contractId,
  asset,
  onComplete,
  onClose,
}: TransactionModalProps) {
  const { metrics } = useWallet();
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [txError, setTxError] = useState<{ decoded: string; raw: string } | null>(null);
  // Synchronous in-flight guard. The disabled button already blocks
  // click-driven double-submits (React flushes discrete events synchronously),
  // but this makes the protection independent of render timing and of the
  // `disabled` condition staying correct — defense-in-depth for a money-moving
  // action against future non-discrete or programmatic invocation paths.
  const submittingRef = useRef(false);
  const { markDirty, markClean } = useFormTracker();
  const formId = `${type}-${contractId}`;

  const {
    feeBreakdown,
    estimating,
    simulationError,
    estimate: estimateGas,
    reset: resetGasEstimate,
  } = useGasEstimate();

  // Initialize retry queue with persistence
  const { pendingTransactions, enqueue, clearCompleted } = useTxRetryQueue(10, 'escrow-queue');

  const isDeposit = type === 'escrow_deposit';

  const handleEstimateGas = async () => {
    if (!amount || !metrics?.publicKey) return;
    await estimateGas({
      contractId,
      amount,
      asset,
      publicKey: metrics.publicKey,
      operation: type,
    });
  };

  useEffect(() => {
    resetGasEstimate();
  }, [amount, resetGasEstimate]);

  useEffect(() => {
    if (amount) {
      markDirty(formId);
    } else {
      markClean(formId);
    }
  }, [amount, formId, markDirty, markClean]);

  useEffect(() => {
    return () => {
      markClean(formId);
    };
  }, [formId, markClean]);

  const handleSubmit = async () => {
    if (!amount || !metrics?.publicKey) return;
    if (submittingRef.current) return; // already in flight — ignore re-entrant submits
    submittingRef.current = true;
    setSubmitting(true);
    setTxError(null);
    markClean(formId);
    try {
      const response = await fetch(`/api/escrow/${isDeposit ? 'deposit' : 'withdraw'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contractId,
          amount,
          asset,
          publicKey: metrics.publicKey,
        }),
      });
      if (response.ok) {
        const data = await response.json();
        const hash = data.hash as string;

        // Add to retry queue with deduplication
        await enqueue({
          hash,
          contractId,
          amount,
          asset,
          publicKey: metrics.publicKey,
          type,
        });

        onComplete?.(hash);
      } else {
        const errData = await response.json().catch(() => ({}));
        const raw = (errData.error as string) ?? response.statusText;
        setTxError({ decoded: errorDecoder.tryDecode(raw), raw });
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : 'Unknown error';
      setTxError({ decoded: errorDecoder.tryDecode(raw), raw });
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  };

  const handleClearCompleted = async () => {
    const count = await clearCompleted();
    console.log(`Cleared ${count} completed transactions`);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-md rounded-lg border border-gray-700 bg-gray-900 p-6">
        <h3 className="text-lg font-semibold text-white">
          {isDeposit ? 'Deposit to Escrow' : 'Withdraw from Escrow'}
        </h3>
        <p className="mt-1 text-xs text-gray-400">Contract: {contractId.slice(0, 16)}...</p>

        <div className="mt-4 space-y-3">
          <div>
            <label className="block text-sm text-gray-400">Amount ({asset})</label>
            <input
              type="text"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="mt-1 w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 font-mono text-white placeholder-gray-500"
            />
          </div>

          <button
            onClick={handleEstimateGas}
            disabled={!amount || estimating}
            className="w-full rounded bg-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-600 disabled:opacity-50"
          >
            {estimating ? 'Estimating...' : 'Estimate Gas Fee'}
          </button>

          <GasEstimator
            feeBreakdown={feeBreakdown}
            estimating={estimating}
            error={simulationError}
          />
        </div>

        {txError && <ErrorBanner decoded={txError.decoded} raw={txError.raw} />}

        {/* Transaction Status Display */}
        {pendingTransactions.length > 0 && (
          <div className="mt-4">
            <TxStatusList
              transactions={pendingTransactions}
              onClearCompleted={handleClearCompleted}
            />
          </div>
        )}

        <div className="mt-5 flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 rounded bg-gray-700 px-4 py-2 text-sm text-gray-300 hover:bg-gray-600"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!amount || submitting || (simulationError !== null && feeBreakdown === null)}
            className="flex-1 rounded bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-500 disabled:opacity-50"
          >
            {submitting ? 'Submitting...' : isDeposit ? 'Deposit' : 'Withdraw'}
          </button>
        </div>
      </div>
    </div>
  );
}
