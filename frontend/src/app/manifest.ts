import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'IoT Billing Service - DePIN Dashboard',
    short_name: 'IoT Billing',
    description:
      'Enterprise-grade Web3 DePIN dashboard for IoT-Billing-Service. Real-time device telemetry, Soroban smart contract escrow management, and multi-tenant fleet monitoring.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0a0a0a',
    theme_color: '#22c55e',
    orientation: 'any',
    categories: ['business', 'utilities', 'iot'],
    lang: 'en',
    scope: '/',
    id: '/',
    prefer_related_applications: false,
    screenshots: [
      {
        src: '/icons/screenshot.svg',
        sizes: '1280x720',
        type: 'image/svg+xml',
        form_factor: 'wide',
        label: 'IoT Billing Service Dashboard - Fleet Telemetry and Escrow Management',
      },
    ],
    icons: [
      { src: '/icons/icon.svg', sizes: '48x48', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icons/icon.svg', sizes: '72x72', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icons/icon.svg', sizes: '96x96', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icons/icon.svg', sizes: '128x128', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icons/icon.svg', sizes: '144x144', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icons/icon.svg', sizes: '152x152', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icons/icon.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icons/icon.svg', sizes: '384x384', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icons/icon.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any' },
      {
        src: '/icons/icon.svg',
        sizes: '192x192',
        type: 'image/svg+xml',
        purpose: 'maskable',
      },
      {
        src: '/icons/icon.svg',
        sizes: '512x512',
        type: 'image/svg+xml',
        purpose: 'maskable',
      },
    ],
    shortcuts: [
      {
        name: 'Dashboard',
        url: '/dashboard',
        icons: [{ src: '/icons/icon.svg', sizes: '192x192' }],
      },
      {
        name: 'Escrow',
        url: '/escrow',
        icons: [{ src: '/icons/icon.svg', sizes: '192x192' }],
      },
      {
        name: 'Fleet',
        url: '/fleet',
        icons: [{ src: '/icons/icon.svg', sizes: '192x192' }],
      },
    ],
  };
}
