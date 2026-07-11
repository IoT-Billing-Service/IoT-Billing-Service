import type { ReactNode } from 'react';
import { DashboardProviders } from '@/components/providers/DashboardProviders';
import { NotificationToast } from '@/components/NotificationToast';

/**
 * Fleet route layout — reuses DashboardProviders so the Stellar SDK chunks
 * remain excluded from the initial / route.
 *
 * A shared sub-navigation bar allows switching between the default fleet
 * overview and sub-pages (device grid, ingestion logs) without leaving the
 * /fleet hierarchy.
 */
export default function FleetLayout({ children }: { children: ReactNode }) {
  return (
    <DashboardProviders>
      <div className="flex flex-1 flex-col">
        <nav className="border-b border-gray-800 bg-gray-950 px-6 py-3">
          <div className="flex items-center gap-6 text-sm">
            <a href="/dashboard" className="text-gray-400 hover:text-gray-200 transition-colors">
              Dashboard
            </a>
            <span className="font-semibold text-green-400">Fleet</span>
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
