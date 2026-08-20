import * as esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function build() {
  await esbuild.build({
    entryPoints: [
      path.join(__dirname, 'steady_state.ts'),
      path.join(__dirname, 'burst.ts'),
      path.join(__dirname, 'recovery.ts'),
    ],
    bundle: true,
    outdir: path.join(__dirname, '../dist/k6'),
    target: 'es2020',
    platform: 'browser', // k6 uses a custom JS runtime, browser works best
    external: ['k6'],
  });
  console.log('K6 scripts bundled successfully.');
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
