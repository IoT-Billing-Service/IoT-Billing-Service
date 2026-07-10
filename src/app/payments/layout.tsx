import type { ReactNode } from 'react';
import { DashboardProviders } from '@/components/providers/DashboardProviders';
import { NotificationToast } from '@/components/NotificationToast';

export default function PaymentsLayout({ children }: { children: ReactNode }) {
  return (
    <DashboardProviders>
      <div className="flex flex-1 flex-col">
        <nav className="border-b border-gray-800 bg-gray-950 px-6 py-3">
          <div className="flex items-center gap-6 text-sm">
            <a href="/dashboard" className="text-gray-400 hover:text-gray-200 transition-colors">
              Dashboard
            </a>
            <a href="/fleet" className="text-gray-400 hover:text-gray-200 transition-colors">
              Fleet
            </a>
            <a href="/escrow" className="text-gray-400 hover:text-gray-200 transition-colors">
              Escrow
            </a>
            <span className="font-semibold text-green-400">Payments</span>
          </div>
        </nav>
        <main className="flex-1 p-6">{children}</main>
      </div>
      <NotificationToast />
    </DashboardProviders>
  );
}
