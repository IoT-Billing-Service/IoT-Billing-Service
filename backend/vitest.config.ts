import { defineConfig } from 'vitest/config';

// `poolMatchGlobs` confines the forks pool to ONLY the load suite. The
// default `threads` pool is fine for every other test file.
//
// The load suite uses Node's global `fetch` (Undici). Under the
// concurrent HTTP request loop of the runner tests, the shared Undici
// agent's connection pool deadlocks its socket queue on some Node
// builds - the tests hang at the per-test timeout. Running the load
// suite in a fresh forked process gives every test file its own
// dedicated Undici instance.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    poolMatchGlobs: [['tests/unit/load/**', 'forks']],
    include: ['tests/unit/**/*.test.ts'],
    exclude: ['tests/load/**', 'tests/load/k6_scripts/**', 'node_modules', 'dist'],
       coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.sql'],
      reporter: ['text', 'lcov', 'json-summary'],
      reportOnFailure: true,
      // Baseline measured 2026-08-29 via `npm run test:coverage`:
      // statements 40.71% | branches 77.14% | functions 64.72% | lines 40.71%
      // Set a couple points below actual so the gate has a small buffer
      // against normal variance rather than sitting exactly on the line.
      // Several modules currently have 0% coverage entirely (ingestion/,
      // refund/, replication/, parts of security/, incident_response
      // index/metrics/routes) — that's real signal from this exercise,
      // not something these thresholds should paper over. Ratchet these
      // up as coverage genuinely improves; don't lower them to make CI
      // pass.
      thresholds: {
        statements: 38,
        branches: 74,
        functions: 62,
        lines: 38,
      },
    },
    // 10s global default keeps the failure signal loud for any
    // non-load test that genuinely hangs. The load suite under
    // tests/unit/load/** applies per-test 30s overrides in
    // simulation_runner.test.ts since the AbortController-capped
    // load profiles still incur CI cold-start overhead.
    testTimeout: 10000,
  },
});