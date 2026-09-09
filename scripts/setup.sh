#!/usr/bin/env bash
set -euo pipefail

# One-command developer environment bootstrap for the IoT-Billing monorepo.

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

command_exists() { command -v "$1" >/dev/null 2>&1; }

echo "==> IoT Billing Service — environment bootstrap"

# 1. Rust toolchain (Soroban contracts)
if command_exists cargo; then
  echo "==> rust toolchain: $(cargo --version)"
  rustup target add wasm32-unknown-unknown 2>/dev/null || true
else
  echo "!! cargo not found. Install via https://rustup.rs"
fi

# 2. Node toolchain (backend + frontend)
if command_exists node; then
  echo "==> node: $(node --version)"
else
  echo "!! node not found. Install via https://nodejs.org"
fi

# 3. Python toolchain (hardware emulator)
if command_exists python3; then
  echo "==> python3: $(python3 --version)"
  python3 -m pip install --quiet --user pytest 2>/dev/null || true
else
  echo "!! python3 not found. Install via your system package manager."
fi

# 4. GitHub CLI (promotions)
if command_exists gh; then
  echo "==> gh: $(gh --version | head -1)"
else
  echo "!! gh not found. Install via https://cli.github.com"
fi

# 5. Root + workspace dependencies
if [ -f "$ROOT/package.json" ]; then
  echo "==> installing npm workspaces (backend, frontend)"
  (cd "$ROOT" && npm install)
fi

# 6. Contract dependencies (cargo fetch)
if [ -f "$ROOT/contracts/Cargo.toml" ]; then
  echo "==> fetching soroban/cargo dependencies"
  (cd "$ROOT/contracts" && cargo fetch)
fi

# 7. Env templates
for envdir in backend frontend; do
  if [ -f "$ROOT/$envdir/.env.example" ] && [ ! -f "$ROOT/$envdir/.env" ]; then
    cp "$ROOT/$envdir/.env.example" "$ROOT/$envdir/.env"
    echo "==> created $envdir/.env from template (fill in secrets)"
  fi
done

echo
echo "Bootstrap complete. Next steps:"
echo "  cd backend && npm run dev        # indexer + API"
echo "  cd frontend && npm run dev       # dashboard"
echo "  cd emulator && make run-meter    # simulated device"
echo "  cargo test --manifest-path contracts/Cargo.toml   # contract tests"