'use client';

import { type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { DashboardProviders } from '@/components/providers/DashboardProviders';
import { NotificationToast } from '@/components/NotificationToast';
import { Code2, Cpu, BarChart3, Key, Shield, Activity } from 'lucide-react';

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: <BarChart3 className="w-3.5 h-3.5" /> },
  { href: '/fleet', label: 'Fleet', icon: <Cpu className="w-3.5 h-3.5" /> },
  { href: '/escrow', label: 'Escrow', icon: <Shield className="w-3.5 h-3.5" /> },
  { href: '/payments', label: 'Payments', icon: <Key className="w-3.5 h-3.5" /> },
  { href: '/ops', label: 'Ops', icon: <Activity className="w-3.5 h-3.5" /> },
];

/**
 * SectionShell
 *
 * A shared layout shell that wraps dashboard-adjacent pages (fleet, escrow, payments)
 * with the same dark‑background / cyan‑accent design language as the main dashboard
 * prototype. Includes:
 *  - DashboardProviders (WalletProvider + QueryProvider)
 *  - A sticky dark header with app branding and horizontal route navigation
 *  - Active‑route highlighting
 *  - NotificationToast for global alerts
 */
export function SectionShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <DashboardProviders>
      <div className="min-h-screen bg-black text-neutral-100 flex flex-col selection:bg-cyan-500 selection:text-black">
        {/* Sticky header with branding and navigation */}
        <header className="bg-neutral-950 border-b border-neutral-900 sticky top-0 z-50 px-6 py-3">
          <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
            {/* Branding */}
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
              <span className="font-sans font-bold text-white tracking-tight text-sm">
                IoT Billing Service{' '}
                <span className="text-cyan-400 font-mono text-[11px] font-medium">
                  DePIN Playground
                </span>
              </span>
            </div>

            {/* Horizontal navigation tabs */}
            <nav className="flex items-center gap-1" role="tablist">
              {NAV_ITEMS.map((item) => {
                const isActive = pathname === item.href || pathname.startsWith(item.href + '/');
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    role="tab"
                    aria-selected={isActive}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-mono transition-colors ${
                      isActive
                        ? 'bg-cyan-950 text-cyan-400 border border-cyan-800/50'
                        : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900 border border-transparent'
                    }`}
                  >
                    {item.icon}
                    {item.label}
                  </Link>
                );
              })}
            </nav>

            {/* External link */}
            <a
              href="https://github.com/IoT-Billing-Service"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded bg-neutral-900 hover:bg-neutral-800 text-xs text-neutral-300 font-mono border border-neutral-800 transition-colors"
            >
              <Code2 className="w-3.5 h-3.5 text-cyan-400" />
              Organization Repo
            </a>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 max-w-7xl w-full mx-auto p-6">{children}</main>

        {/* Footer */}
        <footer className="bg-neutral-950 border-t border-neutral-900 px-6 py-3 mt-auto text-center">
          <p className="text-[10px] text-neutral-500 font-mono uppercase">
            IoT-Billing-Service DePIN Ecosystem • Built for high fidelity Stellar/Soroban verification
          </p>
        </footer>

        <NotificationToast />
      </div>
    </DashboardProviders>
  );
}
