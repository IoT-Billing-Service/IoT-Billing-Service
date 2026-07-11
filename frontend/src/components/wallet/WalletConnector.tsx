'use client';

import { useWallet } from '@/components/providers/WalletProvider';
import { formatCurrency } from '@/utils/currencyFormatter';

export function WalletConnector() {
  const { metrics, isConnecting, error, connect, disconnect } = useWallet();

  if (isConnecting) {
    return (
      <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-green-400 border-t-transparent" />
          Connecting wallet...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-700 bg-red-900/20 p-4">
        <p className="text-sm text-red-400">{error}</p>
        <button
          onClick={connect}
          className="mt-2 rounded bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-500"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!metrics?.isConnected) {
    return (
      <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
        <button
          onClick={connect}
          className="w-full rounded bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-500"
        >
          Connect Freighter Wallet
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-green-700 bg-gray-900 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-green-400" />
          <span className="text-sm font-medium text-green-400">Connected</span>
        </div>
        <span className="rounded bg-gray-800 px-2 py-0.5 text-xs text-gray-400">
          {metrics.network}
        </span>
      </div>
      <p className="mt-2 font-mono text-xs text-gray-400">
        {metrics.publicKey.slice(0, 8)}...{metrics.publicKey.slice(-4)}
      </p>
      {metrics.balances.length > 0 && (
        <div className="mt-3 space-y-1 border-t border-gray-700 pt-3">
          {metrics.balances.map((b) => (
            <div key={b.asset} className="flex justify-between text-sm">
              <span className="text-gray-400">{b.asset}</span>
              <span className="font-mono text-white">{formatCurrency(b.balance)}</span>
            </div>
          ))}
        </div>
      )}
      <button
        onClick={disconnect}
        className="mt-3 w-full rounded bg-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-600"
      >
        Disconnect
      </button>
    </div>
  );
}
