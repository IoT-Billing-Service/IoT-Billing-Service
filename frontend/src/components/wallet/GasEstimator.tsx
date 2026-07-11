'use client';

import { useEffect, useState } from 'react';
import type { FeeBreakdown } from '@/hooks/useGasEstimate';
import { formatCurrency } from '@/utils/currencyFormatter';

const FALLBACK_XLM_USD_RATE = 0.1;

function useXlmUsdRate(): number | null {
  const [rate, setRate] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchRate = async () => {
      try {
        const response = await fetch(
          process.env.NEXT_PUBLIC_XLM_USD_ORACLE_URL ?? 'https://api.stellar.org/xlm-usd',
        );
        if (response.ok) {
          const data = await response.json();
          if (!cancelled) {
            if (typeof data.price === 'number') {
              setRate(data.price);
            } else if (typeof data.rate === 'number') {
              setRate(data.rate);
            }
          }
        }
      } catch {
        if (!cancelled) setRate(FALLBACK_XLM_USD_RATE);
      }
    };
    fetchRate();
    return () => {
      cancelled = true;
    };
  }, []);

  return rate;
}

function Spinner() {
  return (
    <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-gray-500 border-t-gray-300" />
  );
}

function FeeRow({
  label,
  xlmValue,
  usdRate,
  isLoading,
  isFallback,
}: {
  label: string;
  xlmValue: string | null;
  usdRate: number | null;
  isLoading: boolean;
  isFallback: boolean;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-between py-1">
        <span className="text-xs text-gray-400">{label}</span>
        <Spinner />
      </div>
    );
  }

  const usdValue = xlmValue && usdRate ? Number(xlmValue) * usdRate : null;

  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-xs text-gray-400">
        {label}
        {isFallback && (
          <span
            className="ml-1 cursor-help border-b border-dotted border-yellow-600 text-yellow-500"
            title="This is an approximate estimate because the real-time simulation timed out. The actual fee may differ."
          >
            ⓘ
          </span>
        )}
      </span>
      <span className="text-xs font-mono text-gray-200">
        {xlmValue ? `${formatCurrency(xlmValue)} XLM` : '---'}
        {usdValue !== null && (
          <span className="ml-1 text-[10px] text-gray-500">
            (${formatCurrency(usdValue.toFixed(2))})
          </span>
        )}
      </span>
    </div>
  );
}

interface GasEstimatorProps {
  feeBreakdown: FeeBreakdown | null;
  estimating: boolean;
  error: string | null;
}

export function GasEstimator({ feeBreakdown, estimating, error }: GasEstimatorProps) {
  const usdRate = useXlmUsdRate();

  if (error && !feeBreakdown) {
    return (
      <div className="rounded bg-red-900/30 p-2 text-xs text-red-400">
        Simulation failed: {error}
      </div>
    );
  }

  return (
    <div className="rounded border border-gray-700 bg-gray-800/50 p-3">
      <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
        Gas Fee Estimate
      </h4>

      <FeeRow
        label="Inclusion Fee"
        xlmValue={feeBreakdown?.classicFee ?? null}
        usdRate={usdRate}
        isLoading={estimating && !feeBreakdown}
        isFallback={feeBreakdown?.isFallback ?? false}
      />
      <FeeRow
        label="Resource Fee (Read/Write)"
        xlmValue={feeBreakdown?.minResourceFee ?? null}
        usdRate={usdRate}
        isLoading={estimating && !feeBreakdown}
        isFallback={feeBreakdown?.isFallback ?? false}
      />
      <FeeRow
        label="Rent Refundable Fee"
        xlmValue={feeBreakdown?.refundableFee ?? null}
        usdRate={usdRate}
        isLoading={estimating && !feeBreakdown}
        isFallback={feeBreakdown?.isFallback ?? false}
      />

      <div className="mt-2 border-t border-gray-700 pt-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-300">Total Estimated Cost</span>
          {estimating && !feeBreakdown ? (
            <Spinner />
          ) : (
            <span className="font-mono text-xs font-bold text-green-400">
              {feeBreakdown ? `${formatCurrency(feeBreakdown.total)} XLM` : '---'}
              {feeBreakdown && usdRate && (
                <span className="ml-1 text-[10px] text-gray-500">
                  (${formatCurrency((Number(feeBreakdown.total) * usdRate).toFixed(2))})
                </span>
              )}
            </span>
          )}
        </div>
      </div>

      {feeBreakdown?.isFallback && (
        <p className="mt-1 text-[10px] text-yellow-500">
          ⚠ Approximate estimate. Real-time simulation unavailable.
        </p>
      )}
    </div>
  );
}
