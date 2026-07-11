'use client';

import { useEscrowBalance } from '@/hooks/useEscrowBalance';

interface EscrowAccountPanelProps {
  contractId: string;
}

export function EscrowAccountPanel({ contractId }: EscrowAccountPanelProps) {
  const { data: balance, isLoading, isError, error, refetch } = useEscrowBalance(contractId);

  return (
    <div className="rounded-lg border border-gray-700 bg-gray-900 p-6">
      <h3 className="text-base font-semibold text-white">Account State</h3>
      <p className="mt-0.5 font-mono text-xs text-gray-500">
        {contractId.slice(0, 16)}...{contractId.slice(-8)}
      </p>

      {isLoading && (
        <div className="mt-6 flex items-center gap-2 text-sm text-gray-400">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-green-400 border-t-transparent" />
          Loading escrow balance…
        </div>
      )}

      {isError && (
        <div className="mt-6 rounded-lg border border-red-900/50 bg-red-950/20 p-4">
          <p className="text-sm text-red-400">
            Error: {error instanceof Error ? error.message : 'Failed to load'}
          </p>
          <button
            onClick={() => refetch()}
            className="mt-2 text-xs text-red-300 underline hover:text-red-200"
          >
            Retry
          </button>
        </div>
      )}

      {balance && (
        <div className="mt-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-lg border border-gray-800 bg-gray-950 p-3">
              <p className="text-xs text-gray-500">Total Locked</p>
              <p className="mt-1 font-mono text-lg font-bold text-green-400">
                {Number(balance.totalLocked).toLocaleString()}{' '}
                <span className="text-xs text-gray-500">{balance.asset}</span>
              </p>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-950 p-3">
              <p className="text-xs text-gray-500">Available</p>
              <p className="mt-1 font-mono text-lg font-bold text-blue-400">
                {Number(balance.available).toLocaleString()}{' '}
                <span className="text-xs text-gray-500">{balance.asset}</span>
              </p>
            </div>
          </div>

          <div className="rounded-lg border border-gray-800 bg-gray-950 p-3">
            <p className="text-xs text-gray-500">Pending Release</p>
            <p className="mt-1 font-mono text-lg font-bold text-amber-400">
              {Number(balance.pendingRelease).toLocaleString()}{' '}
              <span className="text-xs text-gray-500">{balance.asset}</span>
            </p>
          </div>

          {/* Utilization bar */}
          <div>
            <div className="flex justify-between text-xs text-gray-500">
              <span>Utilization</span>
              <span>
                {Number(balance.totalLocked) > 0
                  ? (
                      (Number(balance.totalLocked) /
                        (Number(balance.totalLocked) + Number(balance.available))) *
                      100
                    ).toFixed(1)
                  : 0}
                %
              </span>
            </div>
            <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-gray-800">
              <div
                className="h-full rounded-full bg-green-500 transition-all"
                style={{
                  width: `${
                    Number(balance.totalLocked) > 0
                      ? Math.min(
                          100,
                          (Number(balance.totalLocked) /
                            (Number(balance.totalLocked) + Number(balance.available))) *
                            100,
                        )
                      : 0
                  }%`,
                }}
              />
            </div>
          </div>
        </div>
      )}

      {!isLoading && !balance && !isError && (
        <div className="mt-6 text-sm text-gray-500">
          No balance data available for this contract.
        </div>
      )}
    </div>
  );
}
