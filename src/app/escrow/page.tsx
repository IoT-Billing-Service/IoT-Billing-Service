'use client';

import { useWallet } from '@/components/providers/WalletProvider';
import { EscrowAccountPanel } from '@/components/escrow/EscrowAccountPanel';
import { EscrowFundingPanel } from '@/components/escrow/EscrowFundingPanel';
import { PaymentHistoryTable } from '@/components/escrow/PaymentHistoryTable';
import { WalletConnector } from '@/components/wallet/WalletConnector';

const activeContractId = process.env.NEXT_PUBLIC_ESCROW_CONTRACT_ID;

export default function EscrowPage() {
  const { metrics } = useWallet();

  if (!metrics?.isConnected) {
    return (
      <div className="mx-auto max-w-md py-16">
        <div className="mb-6 text-center">
          <h2 className="text-xl font-semibold text-white">Escrow Management</h2>
          <p className="mt-1 text-sm text-gray-400">
            Connect your wallet to manage Soroban escrow accounts.
          </p>
        </div>
        <WalletConnector />
      </div>
    );
  }

  if (!activeContractId) {
    return (
      <div className="mx-auto max-w-2xl py-16">
        <div className="rounded-lg border border-amber-700 bg-amber-950/40 p-6">
          <h2 className="text-xl font-semibold text-white">Escrow contract not configured</h2>
          <p className="mt-2 text-sm text-amber-200">
            Set <code className="font-mono">NEXT_PUBLIC_ESCROW_CONTRACT_ID</code> in
            <code className="ml-1 font-mono">.env.local</code> to enable the escrow views.
          </p>
          <p className="mt-3 text-xs text-amber-300/80">
            This page intentionally avoids a hardcoded placeholder so local and deployed
            environments use an explicit Soroban contract configuration.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white">Escrow Accounts</h2>
          <p className="mt-0.5 text-sm text-gray-400">
            Manage escrow accounts linked to Soroban smart contracts
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-gray-500">Network:</span>
          <span className="rounded bg-gray-800 px-2 py-0.5 font-mono text-xs text-purple-400">
            {metrics.network}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Escrow account state */}
        <EscrowAccountPanel contractId={activeContractId} />

        {/* Funding controls */}
        <EscrowFundingPanel contractId={activeContractId} />
      </div>

      {/* Payment history */}
      <PaymentHistoryTable contractId={activeContractId} />
    </div>
  );
}
