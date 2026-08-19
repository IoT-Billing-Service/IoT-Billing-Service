#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const TEXT_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.env',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.rs',
  '.sh',
  '.sol',
  '.sql',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);

const FORBIDDEN_SECRET_EXTENSIONS = new Set(['.key', '.p12', '.pfx', '.pem']);
const ALLOWED_ENV_FILES = new Set(['.env.example', '.env.sample', '.env.template']);

function git(args) {
  return spawnSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
}

export function parseStagedFileList(value) {
  if (!value) return [];
  return value
    .split(/\0|\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isTextFile(file) {
  const ext = path.extname(file).toLowerCase();
  const base = path.basename(file).toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || base.startsWith('.env');
}

export function blockedSensitivePath(file) {
  const normalized = file.replace(/\\/g, '/').toLowerCase();
  const base = path.posix.basename(normalized);
  const ext = path.posix.extname(normalized);

  if (base.startsWith('.env') && !ALLOWED_ENV_FILES.has(base)) {
    return 'Do not commit live environment files; commit .env.example instead.';
  }

  if (FORBIDDEN_SECRET_EXTENSIONS.has(ext)) {
    return `Do not commit private key or certificate material (${ext}).`;
  }

  return null;
}

export function checkTextContent(file, content) {
  const failures = [];
  const lines = content.split(/\r?\n/);

  const hasConflictMarker = lines.some(
    (line) => line.startsWith('<<<<<<< ') || line === '=======' || line.startsWith('>>>>>>> '),
  );
  if (hasConflictMarker) failures.push('contains unresolved merge conflict markers');

  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content)) {
    failures.push('contains a private key block');
  }

  if (path.extname(file).toLowerCase() === '.json' && content.trim()) {
    try {
      JSON.parse(content);
    } catch (error) {
      failures.push(`contains invalid JSON: ${error.message}`);
    }
  }

  return failures;
}

export function readStagedFile(file) {
  const staged = git(['show', `:${file}`]);
  if (staged.status === 0) return staged.stdout;
  if (existsSync(file)) return readFileSync(file, 'utf8');
  throw new Error(`Unable to read staged file: ${file}`);
}

export function getStagedFiles() {
  if (process.env.PRE_COMMIT_STAGED_FILES !== undefined) {
    return parseStagedFileList(process.env.PRE_COMMIT_STAGED_FILES);
  }

  const result = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']);
  if (result.status !== 0) {
    throw new Error(result.stderr || 'Unable to list staged files.');
  }

  return parseStagedFileList(result.stdout);
}

export function runPreCommitChecks({ files, readFile = readStagedFile } = {}) {
  const stagedFiles = files ?? getStagedFiles();
  const failures = [];
  let checkedFiles = 0;

  for (const file of stagedFiles) {
    const pathFailure = blockedSensitivePath(file);
    if (pathFailure) failures.push({ file, reason: pathFailure });

    if (!isTextFile(file)) continue;
    checkedFiles += 1;

    let content;
    try {
      content = readFile(file);
    } catch (error) {
      failures.push({ file, reason: error.message });
      continue;
    }

    for (const reason of checkTextContent(file, content)) {
      failures.push({ file, reason });
    }
  }

  return {
    checkedFiles,
    failures,
    passed: failures.length === 0,
    stagedFiles,
  };
}

export function formatResult(result) {
  if (result.passed) {
    return `Pre-commit checks passed for ${result.checkedFiles} text file(s).`;
  }

  const details = result.failures.map(({ file, reason }) => `- ${file}: ${reason}`).join('\n');
  return `Pre-commit checks failed:\n${details}`;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = runPreCommitChecks();
    const output = formatResult(result);
    if (result.passed) {
      console.log(output);
    } else {
      console.error(output);
      process.exit(1);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
