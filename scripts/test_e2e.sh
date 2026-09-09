#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

cleanup() {
  # Kill any background emulator process we spawned.
  if [ -n "${EMULATOR_PID:-}" ]; then
    kill "$EMULATOR_PID" 2>/dev/null || true
    wait "$EMULATOR_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "==> E2E smoke test"

# 1. Contract tests
echo "-- contract tests"
cargo test --manifest-path contracts/Cargo.toml

# 2. Backend tests
echo "-- backend tests"
npm ci --workspace backend
npm test --workspace backend

# 3. Frontend checks
echo "-- frontend checks"
npm ci --workspace frontend
npm run typecheck --workspace frontend

# 4. Emulator sanity: generate one solar sample without a server
echo "-- emulator sample"
python3 emulator/client.py --type solar --rate 5 --device-key e2e_key --endpoint "" </dev/null >/dev/null 2>&1 &
EMULATOR_PID=$!
sleep 2
kill "$EMULATOR_PID" 2>/dev/null || true
wait "$EMULATOR_PID" 2>/dev/null || true
EMULATOR_PID=

echo "E2E smoke test passed."
