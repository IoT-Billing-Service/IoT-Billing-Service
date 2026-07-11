'use client';

/**
 * DashboardProviders
 *
 * Providers that are only needed on wallet-connected routes (/dashboard, /escrow).
 * By keeping WalletProvider and QueryProvider out of the root layout, the Stellar
 * SDK bundle (@stellar/stellar-sdk, @stellar/freighter-api) is excluded from the
 * initial / route chunk and only loaded when the user navigates here.
 */

import { type ReactNode } from 'react';
import { QueryProvider } from './QueryProvider';
import { WalletProvider } from './WalletProvider';

export function DashboardProviders({ children }: { children: ReactNode }) {
  return (
    <QueryProvider>
      <WalletProvider>{children}</WalletProvider>
    </QueryProvider>
  );
}
