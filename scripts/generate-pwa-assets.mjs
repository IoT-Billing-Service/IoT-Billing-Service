#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const iconsDir = join(root, 'public', 'icons');

const svgSource = readFileSync(join(iconsDir, 'icon.svg'), 'utf-8');

if (!existsSync(iconsDir)) {
  mkdirSync(iconsDir, { recursive: true });
}

const sizes = [48, 72, 96, 128, 144, 152, 192, 384, 512];

sizes.forEach((size) => {
  const outPath = join(iconsDir, `icon-${size}x${size}.png`);
  if (!existsSync(outPath)) {
    writeFileSync(outPath, svgSource);
    console.log(`Placeholder: icon-${size}x${size}.png (SVG inline until pwa-asset-generator run)`);
  }
});

console.log('PWA asset placeholders generated.');
console.log(
  'For production PNG generation, run: npx pwa-asset-generator public/icons/icon.svg public/icons/',
);
