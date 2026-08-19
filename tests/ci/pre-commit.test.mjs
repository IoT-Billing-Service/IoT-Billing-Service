import assert from 'node:assert/strict';
import test from 'node:test';

import {
  blockedSensitivePath,
  checkTextContent,
  formatResult,
  parseStagedFileList,
  runPreCommitChecks,
} from '../../scripts/pre-commit.mjs';

test('parses null and newline separated staged file lists', () => {
  assert.deepEqual(parseStagedFileList('a.ts\0b.json\0'), ['a.ts', 'b.json']);
  assert.deepEqual(parseStagedFileList('a.ts\nb.json\n'), ['a.ts', 'b.json']);
});

test('blocks live env files and private key material', () => {
  assert.equal(blockedSensitivePath('.env'), 'Do not commit live environment files; commit .env.example instead.');
  assert.equal(blockedSensitivePath('backend/.env.local'), 'Do not commit live environment files; commit .env.example instead.');
  assert.equal(blockedSensitivePath('.env.example'), null);
  assert.match(blockedSensitivePath('certs/prod.pem'), /private key or certificate/);
});

test('detects conflict markers, private keys, and invalid JSON', () => {
  assert.deepEqual(checkTextContent('src/app.ts', 'const ok = true;\n'), []);
  assert.deepEqual(checkTextContent('src/app.ts', '<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> main\n'), [
    'contains unresolved merge conflict markers',
  ]);
  const privateKeyBlock = ['-----BEGIN', 'PRIVATE KEY-----\nabc\n'].join(' ');
  assert.deepEqual(checkTextContent('secrets.txt', privateKeyBlock), [
    'contains a private key block',
  ]);
  assert.match(checkTextContent('package.json', '{ bad json')[0], /invalid JSON/);
});

test('runs staged file checks with injectable file contents', () => {
  const files = ['backend/src/index.ts', 'frontend/package.json', 'notes.md'];
  const contents = new Map([
    ['backend/src/index.ts', 'export const ready = true;\n'],
    ['frontend/package.json', '{"name":"frontend"}\n'],
    ['notes.md', 'done\n'],
  ]);

  const result = runPreCommitChecks({ files, readFile: (file) => contents.get(file) });

  assert.equal(result.passed, true);
  assert.equal(result.checkedFiles, 3);
  assert.equal(formatResult(result), 'Pre-commit checks passed for 3 text file(s).');
});

test('returns all failures so contributors can fix them in one pass', () => {
  const result = runPreCommitChecks({
    files: ['.env', 'bad.json'],
    readFile: (file) => (file === 'bad.json' ? '{ nope' : 'DATABASE_URL=postgres://prod\n'),
  });

  assert.equal(result.passed, false);
  assert.equal(result.failures.length, 2);
  assert.match(formatResult(result), /\.env/);
  assert.match(formatResult(result), /bad\.json/);
});
