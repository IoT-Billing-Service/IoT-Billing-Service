#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const result = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], {
  encoding: 'utf8',
  stdio: 'pipe',
});

if (result.status !== 0) {
  process.stderr.write(result.stderr || 'Failed to configure git hooks.\n');
  process.exit(result.status ?? 1);
}

console.log('Configured git to use .githooks for this checkout.');
