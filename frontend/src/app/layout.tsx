import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { Providers } from '@/components/providers';
import { PwaInstaller } from '@/components/pwa/PwaInstaller';
import { ServiceWorkerRegister } from '@/components/pwa/ServiceWorkerRegister';
import { AppUpdateBanner } from '@/components/AppUpdateBanner';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'IoT Billing Service - DePIN Dashboard',
  description:
    'Enterprise-grade Web3 DePIN dashboard for IoT-Billing-Service. Real-time device telemetry, Soroban smart contract escrow management, and multi-tenant fleet monitoring.',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'IoT Billing',
  },
  icons: {
    apple: '/icons/icon.svg',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  minimumScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#22c55e',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <AppUpdateBanner />
        <Providers>{children}</Providers>
        <ServiceWorkerRegister />
        <PwaInstaller />
      </body>
    </html>
  );
}
