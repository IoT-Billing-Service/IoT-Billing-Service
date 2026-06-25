#!/usr/bin/env node
/**
 * generate-thumbnails.mjs
 *
 * Pre-generates lightweight SVG chart thumbnails at deploy time so the UI can
 * load static files instead of hitting an API endpoint for on-the-fly image
 * generation.  SVG thumbnails are chosen because they:
 *  - require zero server-side image processing (no WebP conversion bottleneck)
 *  - render natively in all browsers at any resolution
 *  - are trivially cacheable and CDN-friendly
 *  - reserve space immediately, preventing Cumulative Layout Shift (CLS)
 *
 * Strategy:
 *  - Reads a device-id manifest from /public/thumbnails/manifest.json (optional;
 *    falls back to a single example when absent).
 *  - Writes one 320×180 SVG placeholder per device to
 *    /public/thumbnails/{deviceId}.svg.
 *  - The generated files are static assets served directly by Next.js with the
 *    stale-while-revalidate Cache-Control headers configured in next.config.ts.
 *
 * Invariants (issue #66):
 *  - CLS ≤ 0.1   (thumbnails have explicit width / height that reserve space)
 *  - Max thumbnail load time < 1 000 ms (SVG is ~1 KB, no server processing)
 *
 * Usage:
 *   node scripts/generate-thumbnails.mjs
 *
 * CI integration:
 *   Runs as a pre-build step in .github/workflows/frontend-ci.yml
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const OUTPUT_DIR = join(root, 'public', 'thumbnails');
const MANIFEST_PATH = join(OUTPUT_DIR, 'manifest.json');
const THUMBNAIL_WIDTH = 320;
const THUMBNAIL_HEIGHT = 180;

/**
 * Generate a minimal SVG chart placeholder for a single device.
 * The SVG includes:
 *  - A dark background that matches the dashboard theme (#1a1a2e)
 *  - A simple green sine-wave path (chart aesthetic)
 *  - The device label / id in the header area
 *  - A subtle "Chart" caption at the bottom
 *
 * The output reserves exactly 320×180 px so it never causes layout shift
 * when embedded via <Image width={320} height={180} … />.
 */
function generatePlaceholderSvg(deviceId, label) {
  const displayLabel = label ?? deviceId;
  const escapedLabel = displayLabel
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  return [
    '<svg xmlns="http://www.w3.org/2000/svg"',
    ` width="${THUMBNAIL_WIDTH}" height="${THUMBNAIL_HEIGHT}"`,
    ` viewBox="0 0 ${THUMBNAIL_WIDTH} ${THUMBNAIL_HEIGHT}">`,
    '  <rect width="100%" height="100%" fill="#1a1a2e" rx="6"/>',
    // Decorative chart path (sine wave)
    '  <path d="M20,130 C40,80 60,80 80,130 S120,130 140,70 S180,70 200,130 S240,130 260,90 S300,90 320,110"',
    '    fill="none" stroke="#5ec962" stroke-width="2" stroke-linecap="round" opacity="0.7"/>',
    // Axis line
    '  <line x1="20" y1="130" x2="300" y2="130" stroke="#3a3a5e" stroke-width="1"/>',
    // Label
    `  <text x="160" y="22" text-anchor="middle" fill="#a0a0a0" font-family="monospace" font-size="10">${escapedLabel}</text>`,
    // Footer
    '  <text x="160" y="170" text-anchor="middle" fill="#5ec962" font-family="monospace" font-size="9" opacity="0.8">Chart Preview</text>',
    '</svg>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // Attempt to read the device manifest.
  let manifest;
  try {
    const raw = readFileSync(MANIFEST_PATH, 'utf-8');
    manifest = JSON.parse(raw);
  } catch {
    console.warn(
      `⚠  No thumbnail manifest found at ${MANIFEST_PATH}.\n` +
        '   Create a JSON file with:\n' +
        '   { "devices": [ { "deviceId": "dev-001", "label": "Device 1" }, ... ] }\n' +
        '   Falling back to a single example thumbnail.\n',
    );
    manifest = { devices: [{ deviceId: 'example-device', label: 'Example Device' }] };
  }

  if (!manifest.devices || !Array.isArray(manifest.devices)) {
    console.error('ERROR: manifest.json must contain a "devices" array.');
    process.exit(1);
  }

  // Ensure the output directory exists.
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  let generated = 0;
  for (const device of manifest.devices) {
    const svg = generatePlaceholderSvg(device.deviceId, device.label);
    const outPath = join(OUTPUT_DIR, `${device.deviceId}.svg`);
    writeFileSync(outPath, svg, 'utf-8');
    generated++;
  }

  console.log(`✓  Generated ${generated} thumbnail SVG(s) in ${OUTPUT_DIR}`);
}

main();
