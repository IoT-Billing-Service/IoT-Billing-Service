import type { NextConfig } from 'next';

/**
 * Next.js 16 uses Turbopack by default for both `next dev` and `next build`.
 * The old `webpack()` splitChunks approach is NOT compatible with Turbopack.
 *
 * Code splitting strategy for Turbopack:
 * - Heavy chunks (@stellar/*, bignumber.js) are split at the import boundary
 *   via `next/dynamic` and route-level provider isolation (DashboardProviders).
 * - `experimental.optimizePackageImports` tells Turbopack to apply modular
 *   imports so only the exports actually used are included in each chunk.
 * - turbopackScopeHoisting collapses module wrappers to reduce output size.
 * - Bundle analysis is done via `next experimental-analyze` (Turbopack-native).
 */
const nextConfig: NextConfig = {
  experimental: {
    /**
     * Automatically apply modularizeImports optimisation for these packages.
     * Turbopack will only bundle the specific symbols imported rather than
     * pulling in the entire barrel/index file.
     */
    optimizePackageImports: [
      '@stellar/stellar-sdk',
      '@stellar/freighter-api',
      '@tanstack/react-query',
    ],

    // Scope hoisting collapses module wrappers, reducing bundle size.
    // turbopackRemoveUnusedImports / turbopackRemoveUnusedExports are
    // intentionally omitted — they prune Next.js internal ESM re-exports
    // and break the production build in 16.2.x.
    turbopackScopeHoisting: true,
  },

  async headers() {
    return [
      {
        source: '/sw.js',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=0, must-revalidate',
          },
          {
            key: 'Service-Worker-Allowed',
            value: '/',
          },
        ],
      },
      {
        source: '/manifest.json',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=3600',
          },
        ],
      },
      {
        // Pre-generated chart thumbnails (scripts/generate-thumbnails.mjs).
        // stale-while-revalidate keeps the UI instant while the CDN / edge
        // cache refreshes in the background, preventing the server-overload
        // bottleneck described in issue #66.
        source: '/thumbnails/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
