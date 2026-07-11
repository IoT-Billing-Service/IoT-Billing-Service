'use client';

import React, { useRef, useState, useMemo, startTransition } from 'react';
import { useCurrencyPref, type CurrencyCode } from '@/stores/useCurrencyPref';
import { useCachedCurrencyFormatter } from '@/hooks/useCurrencyFormatter';
import { useBillingStream, type BillingUpdate } from '@/hooks/useBillingStream';

/* ─── Types ──────────────────────────────────────────── */

export interface BillingLineItem {
  deviceId: string;
  deviceName: string;
  amount: number; // Display amount (already converted from u128)
  currencyCode: CurrencyCode;
}

interface InvoiceTableProps {
  /** Static initial line items (from SSR or initial fetch) */
  initialItems: BillingLineItem[];
}

/* ─── Single row (React.memo) ────────────────────────── */

interface RowProps {
  item: BillingLineItem;
  currencyVersion: number;
  formatCurrency: (amount: number, code: CurrencyCode) => string;
}

const InvoiceRow = React.memo(function InvoiceRow({
  item,
  currencyVersion,
  formatCurrency,
}: RowProps) {
  return (
    <tr className="border-b border-gray-200">
      <td className="px-4 py-2 text-sm">{item.deviceName}</td>
      <td className="px-4 py-2 text-sm font-mono text-right">
        {formatCurrency(item.amount, item.currencyCode)}
      </td>
      <td className="px-4 py-2 text-xs text-gray-500">{item.deviceId}</td>
      <td className="px-4 py-2 text-xs text-gray-400">v{currencyVersion}</td>
    </tr>
  );
});

/* ─── Main Table Component ───────────────────────────── */

export default function InvoiceTable({ initialItems }: InvoiceTableProps) {
  const [items, setItems] = useState<BillingLineItem[]>(initialItems);
  const [currency, currencyVersion, setCurrency] = useCurrencyPref((s) => [
    s.currency,
    s.currencyVersion,
    s.setCurrency,
  ]);
  const setUserInteracting = useCurrencyPref((s) => s.setUserInteracting);
  const { formatCurrency } = useCachedCurrencyFormatter();
  const tableRef = useRef<HTMLTableElement>(null);

  /* ── Billing stream handler ─────────────────────── */

  const handleBillingUpdate = useMemo(
    () => (updates: BillingUpdate[]) => {
      setItems((prev) => {
        const next = [...prev];
        for (const u of updates) {
          const idx = next.findIndex((n) => n.deviceId === u.deviceId);
          if (idx !== -1) {
            const item = next[idx]!;
            next[idx] = {
              ...item,
              amount: parseFloat(u.amount),
            };
          }
        }
        return next;
      });
    },
    [],
  );

  useBillingStream(handleBillingUpdate);

  /* ── Mouse interaction lock ─────────────────────── */

  const handleMouseDown = () => setUserInteracting(true);
  const handleMouseUp = () => setUserInteracting(false);
  const handleBlur = () => setUserInteracting(false);

  /* ── Currency switch via startTransition ────────── */

  const handleCurrencyChange = (newCurrency: CurrencyCode) => {
    setUserInteracting(true);
    startTransition(() => {
      setCurrency(newCurrency);
      setUserInteracting(false);
    });
  };

  /* ── Render ─────────────────────────────────────── */

  return (
    <div className="space-y-4">
      {/* Currency selector */}
      <div
        className="flex items-center gap-4"
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onBlur={handleBlur}
      >
        <label className="text-sm font-medium text-gray-700">Display Currency</label>
        <select
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          value={currency}
          onChange={(e) => handleCurrencyChange(e.target.value as CurrencyCode)}
        >
          <option value="USD">USD ($)</option>
          <option value="EUR">EUR (€)</option>
          <option value="NGN">NGN (₦)</option>
        </select>
      </div>

      {/* Invoice table */}
      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table ref={tableRef} className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Device
              </th>
              <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                Amount
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                ID
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Version
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 bg-white">
            {items.map((item) => (
              <InvoiceRow
                key={item.deviceId}
                item={item}
                currencyVersion={currencyVersion}
                formatCurrency={formatCurrency}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Row count */}
      <p className="text-xs text-gray-400">
        {items.length} row{items.length !== 1 ? 's' : ''} · Currency version {currencyVersion}
      </p>
    </div>
  );
}
