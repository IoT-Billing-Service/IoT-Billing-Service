#!/usr/bin/env node
/**
 * validate-css.mjs
 *
 * Verifies that every status/severity Tailwind utility class defined in
 * src/lib/statusClasses.ts survives the production build and appears in
 * the emitted CSS bundle.
 *
 * Usage:
 *   npm run build && npm run validate:css
 *
 * Exit codes:
 *   0  – all expected classes present
 *   1  – one or more classes missing (CSS purge regression) or build not found
 */

import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
// Next.js App Router emits CSS into .next/static/chunks/, not .next/static/chunks/.
const cssDir = join(root, '.next', 'static', 'chunks');

/**
 * Every class string that must be present in the production CSS.
 * Keep this list in sync with src/lib/statusClasses.ts.
 */
const EXPECTED_CLASSES = [
  // TxStatus: pending
  'bg-yellow-500/20',
  'text-yellow-300',
  'border-yellow-500/40',
  // TxStatus: confirmed
  'bg-green-500/20',
  'text-green-300',
  'border-green-500/40',
  // TxStatus: failed
  'bg-red-500/20',
  'text-red-300',
  'border-red-500/40',
  // TxStatus: unknown (fallback)
  'bg-gray-500/20',
  'text-gray-300',
  'border-gray-500/40',
  // Notification severity: info
  'border-green-500',
  'bg-green-950',
  'text-green-100',
  // Notification severity: warning
  'border-amber-500',
  'bg-amber-950',
  'text-amber-100',
  'text-amber-300',
  // Notification severity: critical
  'border-red-500',
  'bg-red-950',
  'text-red-100',
  'text-red-300',
];

let cssFiles;
try {
  cssFiles = readdirSync(cssDir).filter((f) => f.endsWith('.css'));
} catch {
  console.error('ERROR: No CSS output found at .next/static/chunks/');
  console.error('       Run `npm run build` before validate:css.');
  process.exit(1);
}

if (cssFiles.length === 0) {
  console.error('ERROR: No .css files found in .next/static/chunks/');
  console.error('       Run `npm run build` before validate:css.');
  process.exit(1);
}

const css = cssFiles.map((f) => readFileSync(join(cssDir, f), 'utf-8')).join('\n');

// In generated CSS, Tailwind escapes `/` in class names as `\/`.
const missing = EXPECTED_CLASSES.filter((cls) => {
  const escaped = cls.replace(/\//g, '\\/');
  return !css.includes(escaped);
});

if (missing.length > 0) {
  console.error(
    `\nERROR: ${missing.length} status/severity class(es) missing from production CSS:\n`,
  );
  missing.forEach((cls) => console.error(`  ✗  ${cls}`));
  console.error(
    '\nThis means Tailwind purged a dynamically-selected class. Add it to the\n' +
      '@source inline() safelist in src/app/globals.css and re-run the build.\n',
  );
  process.exit(1);
}

console.log(
  `\n✓  All ${EXPECTED_CLASSES.length} status/severity classes are present in the production CSS.\n`,
);
