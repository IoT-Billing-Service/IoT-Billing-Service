'use client';

import { useState } from 'react';
import { useWallet } from '@/components/providers/WalletProvider';
import { TransactionModal } from '@/components/wallet/TransactionModal';

interface EscrowFundingPanelProps {
  contractId: string;
}

export function EscrowFundingPanel({ contractId }: EscrowFundingPanelProps) {
  const { metrics } = useWallet();
  const [showModal, setShowModal] = useState<'deposit' | 'withdraw' | null>(null);

  if (!metrics?.isConnected) {
    return (
      <div className="rounded-lg border border-gray-700 bg-gray-900 p-6">
        <h3 className="text-base font-semibold text-white">Funding Controls</h3>
        <p className="mt-2 text-sm text-gray-500">
          Connect your wallet to deposit or withdraw funds.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="rounded-lg border border-gray-700 bg-gray-900 p-6">
        <h3 className="text-base font-semibold text-white">Funding Controls</h3>
        <p className="mt-0.5 text-sm text-gray-500">Adjust escrow funding levels</p>

        <div className="mt-6 grid grid-cols-2 gap-4">
          <button
            onClick={() => setShowModal('deposit')}
            className="rounded-lg border border-green-700 bg-green-900/20 px-4 py-3 text-sm font-medium text-green-400 hover:bg-green-900/40 transition-colors"
          >
            <span className="block text-lg">+</span>
            Deposit
          </button>
          <button
            onClick={() => setShowModal('withdraw')}
            className="rounded-lg border border-blue-700 bg-blue-900/20 px-4 py-3 text-sm font-medium text-blue-400 hover:bg-blue-900/40 transition-colors"
          >
            <span className="block text-lg">−</span>
            Withdraw
          </button>
        </div>

        {/* Quick amount selectors */}
        <div className="mt-4">
          <p className="mb-2 text-xs text-gray-500">Quick deposit amounts</p>
          <div className="flex flex-wrap gap-2">
            {[100, 500, 1000, 5000].map((amount) => (
              <button
                key={amount}
                onClick={() => setShowModal('deposit')}
                className="rounded bg-gray-800 px-3 py-1.5 text-xs font-mono text-gray-400 hover:bg-gray-700 transition-colors"
              >
                {amount} XLM
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Transaction modal */}
      {showModal && (
        <TransactionModal
          type={showModal === 'deposit' ? 'escrow_deposit' : 'escrow_withdrawal'}
          contractId={contractId}
          asset="XLM"
          onComplete={(hash) => {
            console.log(`Transaction completed: ${hash}`);
            setShowModal(null);
          }}
          onClose={() => setShowModal(null)}
        />
      )}
    </>
  );
}
