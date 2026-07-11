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
      {children}
      <NotificationToast />
    </DashboardProviders>
  );
}
