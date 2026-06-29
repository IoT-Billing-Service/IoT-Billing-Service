'use client';

import { type ReactNode } from 'react';
import { ThemeProvider } from './ThemeProvider';
import { ErrorBoundary } from './ErrorBoundary';

/**
 * Root-level Providers
 *
 * Only ThemeProvider and ErrorBoundary live here so the initial / route stays lean.
 * WalletProvider and QueryProvider (which pull in @stellar/* SDKs) are
 * mounted by DashboardProviders inside the dashboard layout instead.
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary>
      <ThemeProvider>{children}</ThemeProvider>
    </ErrorBoundary>
  );
}
