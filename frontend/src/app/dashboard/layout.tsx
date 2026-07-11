import type { ReactNode } from 'react';
import { DashboardProviders } from '@/components/providers/DashboardProviders';
import { NotificationToast } from '@/components/NotificationToast';

/**
 * Dashboard layout
 *
 * Wraps all /dashboard/** routes with DashboardProviders so that the
 * Stellar/Soroban SDK chunks are only fetched when the user navigates here,
 * keeping the initial / route bundle small.
 */
export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <DashboardProviders>
      <div className="flex flex-1 flex-col">
        <nav className="border-b border-gray-800 bg-gray-950 px-6 py-3">
          <div className="flex items-center gap-6 text-sm">
            <span className="font-semibold text-green-400">Dashboard</span>
            <a href="/fleet" className="text-gray-400 hover:text-gray-200 transition-colors">
              Fleet
            </a>
            <a href="/escrow" className="text-gray-400 hover:text-gray-200 transition-colors">
              Escrow
            </a>
            <a href="/payments" className="text-gray-400 hover:text-gray-200 transition-colors">
              Payments
            </a>
          </div>
        </nav>
        <main className="flex-1 p-6">{children}</main>
      </div>
      <NotificationToast />
    </DashboardProviders>
  );
}
