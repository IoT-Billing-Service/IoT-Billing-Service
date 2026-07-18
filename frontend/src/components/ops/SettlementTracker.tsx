'use client';

import { ArrowRightLeft, ExternalLink } from 'lucide-react';

interface SettlementTrackerProps {
  billing: {
    totalRecords: number;
    pending: number;
    settled: number;
    totalUsageAmount: string;
    settledUsageAmount: string;
  };
  recentRecords: Array<{
    id: string;
    deviceId: string;
    usageAmount: string;
    txHash: string | null;
    status: string;
    createdAt: string;
  }>;
}

export function SettlementTracker({ billing, recentRecords }: SettlementTrackerProps) {
  const recentSettled = recentRecords.filter((r) => r.status === 'settled').slice(0, 5);
  const recentPending = recentRecords.filter((r) => r.status === 'pending').slice(0, 5);

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-5">
      <h3 className="text-sm font-semibold text-white flex items-center gap-2">
        <ArrowRightLeft className="h-4 w-4 text-amber-400" />
        Settlement Tracker
      </h3>

      {/* Summary stats */}
      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-md bg-neutral-800/50 p-3">
          <p className="text-[11px] text-neutral-500">Settled</p>
          <p className="text-lg font-bold font-mono text-green-400">{billing.settled}</p>
        </div>
        <div className="rounded-md bg-neutral-800/50 p-3">
          <p className="text-[11px] text-neutral-500">Pending</p>
          <p className="text-lg font-bold font-mono text-amber-400">{billing.pending}</p>
        </div>
      </div>

      {/* Recent settled transactions */}
      {recentSettled.length > 0 && (
        <div className="mt-4">
          <p className="text-[11px] text-neutral-500 mb-2">Recent Settlements</p>
          <div className="space-y-1.5">
            {recentSettled.map((record) => (
              <div
                key={record.id}
                className="flex items-center justify-between rounded-md bg-neutral-800/30 px-3 py-2"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-mono text-neutral-400 truncate">{record.id}</p>
                  <p className="text-[10px] text-neutral-600">
                    {new Date(record.createdAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex items-center gap-2 ml-2">
                  {record.txHash !== null && (
                    <a
                      href={`https://stellar.expert/explorer/testnet/tx/${record.txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[10px] text-cyan-400 hover:text-cyan-300 flex items-center gap-0.5"
                    >
                      <ExternalLink className="h-2.5 w-2.5" />
                      tx
                    </a>
                  )}
                  <span className="text-[11px] font-mono text-green-400">
                    {formatStroops(BigInt(record.usageAmount))}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pending transactions */}
      {recentPending.length > 0 && (
        <div className="mt-3">
          <p className="text-[11px] text-neutral-500 mb-2">Pending Settlements</p>
          <div className="space-y-1.5">
            {recentPending.map((record) => (
              <div
                key={record.id}
                className="flex items-center justify-between rounded-md bg-neutral-800/30 px-3 py-2"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-mono text-neutral-400 truncate">{record.id}</p>
                </div>
                <span className="text-[11px] font-mono text-amber-400">
                  {formatStroops(BigInt(record.usageAmount))}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {recentSettled.length === 0 && recentPending.length === 0 && (
        <p className="mt-4 text-center text-xs text-neutral-600">No recent transactions</p>
      )}
    </div>
  );
}

function formatStroops(amount: bigint): string {
  const xlm = Number(amount) / 10_000_000;
  return `${xlm.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })} XLM`;
}
