'use client';

import { CreditCard, Clock, CheckCircle2, Loader } from 'lucide-react';

interface BillingOverviewProps {
  billing: {
    totalRecords: number;
    pending: number;
    settled: number;
    totalUsageAmount: string;
    settledUsageAmount: string;
  };
  cycles: {
    total: number;
    open: number;
    finalizing: number;
    finalized: number;
    settled: number;
  };
}

export function BillingOverviewCard({ billing, cycles }: BillingOverviewProps) {
  const totalAmount = BigInt(billing.totalUsageAmount);
  const settledAmount = BigInt(billing.settledUsageAmount);
  const pendingAmount = totalAmount - settledAmount;

  const settlementRate =
    totalAmount > 0n ? Number((settledAmount * 100n) / totalAmount) : 0;

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-5">
      <h3 className="text-sm font-semibold text-white flex items-center gap-2">
        <CreditCard className="h-4 w-4 text-green-400" />
        Billing Overview
      </h3>

      {/* KPI row */}
      <div className="mt-4 grid grid-cols-3 gap-3">
        <div>
          <p className="text-[11px] text-neutral-500">Total</p>
          <p className="text-lg font-bold font-mono text-white">{billing.totalRecords}</p>
        </div>
        <div>
          <p className="text-[11px] text-neutral-500">Pending</p>
          <p className="text-lg font-bold font-mono text-amber-400">{billing.pending}</p>
        </div>
        <div>
          <p className="text-[11px] text-neutral-500">Settled</p>
          <p className="text-lg font-bold font-mono text-green-400">{billing.settled}</p>
        </div>
      </div>

      {/* Amount breakdown */}
      <div className="mt-4 rounded-md bg-neutral-800/50 p-3">
        <p className="text-[11px] text-neutral-500 mb-2">Amount Breakdown</p>
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs">
            <span className="text-neutral-400">Total Usage</span>
            <span className="font-mono text-white">{formatStroops(totalAmount)}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-neutral-400">Settled</span>
            <span className="font-mono text-green-400">{formatStroops(settledAmount)}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-neutral-400">Pending</span>
            <span className="font-mono text-amber-400">{formatStroops(pendingAmount)}</span>
          </div>
        </div>
      </div>

      {/* Settlement rate */}
      <div className="mt-4">
        <div className="flex justify-between text-[11px] text-neutral-500">
          <span>Settlement Rate</span>
          <span className="font-mono">{settlementRate}%</span>
        </div>
        <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-neutral-800">
          <div
            className="h-full rounded-full bg-green-500 transition-all duration-500"
            style={{ width: `${settlementRate}%` }}
          />
        </div>
      </div>

      {/* Cycle pipeline */}
      <div className="mt-4">
        <p className="text-[11px] text-neutral-500 mb-2">Cycle Pipeline</p>
        <div className="flex items-center gap-1 text-[10px]">
          <CycleStep icon={<Clock className="h-3 w-3" />} count={cycles.open} label="Open" color="text-cyan-400" />
          <Arrow />
          <CycleStep icon={<Loader className="h-3 w-3" />} count={cycles.finalizing} label="Finalizing" color="text-amber-400" />
          <Arrow />
          <CycleStep icon={<CheckCircle2 className="h-3 w-3" />} count={cycles.finalized} label="Finalized" color="text-blue-400" />
          <Arrow />
          <CycleStep icon={<CheckCircle2 className="h-3 w-3" />} count={cycles.settled} label="Settled" color="text-green-400" />
        </div>
      </div>
    </div>
  );
}

function CycleStep({
  icon,
  count,
  label,
  color,
}: {
  icon: React.ReactNode;
  count: number;
  label: string;
  color: string;
}) {
  return (
    <div className={`flex-1 flex flex-col items-center gap-0.5 ${color}`}>
      {icon}
      <span className="font-mono font-bold">{count}</span>
      <span className="text-neutral-600">{label}</span>
    </div>
  );
}

function Arrow() {
  return <span className="text-neutral-700">→</span>;
}

function formatStroops(amount: bigint): string {
  const xlm = Number(amount) / 10_000_000;
  return `${xlm.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })} XLM`;
}
