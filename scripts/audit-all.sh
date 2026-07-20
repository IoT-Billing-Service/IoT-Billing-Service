#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════
#  Automated Dependency Vulnerability Audit Script
#  Runs the same checks as the GitHub Actions workflow, locally.
# ═════════════════════════════════════════════════════════════════════
set -euo pipefail

# ----------------------------------------------------------------------
#  Terminal colors for readability
# ----------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

PASS=0
FAIL=0
SKIP=0

divider() {
  echo -e "\n${BOLD}${BLUE}═══════════════════════════════════════════════════════════════════${NC}\n"
}

section() {
  echo -e "\n${BOLD}${BLUE}── ${1}${NC}"
}

success_msg() {
  echo -e "  ${GREEN}✅ ${1}${NC}"
  PASS=$((PASS + 1))
}

fail_msg() {
  echo -e "  ${RED}❌ ${1}${NC}"
  FAIL=$((FAIL + 1))
}

skip_msg() {
  echo -e "  ${YELLOW}⏭️  ${1}${NC}"
  SKIP=$((SKIP + 1))
}

RESULT_DIR="${AUDIT_RESULTS_DIR:-audit-results}"
mkdir -p "$RESULT_DIR"

# ═════════════════════════════════════════════════════════════════════
echo -e "${BOLD}${BLUE}"
echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║    IoT Billing Service – Dependency Vulnerability Audit       ║"
echo "╚══════════════════════════════════════════════════════════════════╝"
echo -e "${NC}"
echo "Results directory: ${RESULT_DIR}"
echo ""

# ═══════════════════════════════════════════════════════════════════
#  1. npm audit — all workspaces
# ═══════════════════════════════════════════════════════════════════
divider
echo -e "${BOLD}1/5  npm audit (Node.js dependencies)${NC}"

NPM_WORKSPACES=(
  "Root Contracts:."
  "Backend:backend"
  "Frontend:frontend"
  "Dashboard Prototype:dashboard-prototype"
)

for entry in "${NPM_WORKSPACES[@]}"; do
  label="${entry%%:*}"
  dir="${entry##*:}"

  section "${label} ($dir)"

  if [[ ! -f "$dir/package.json" ]]; then
    skip_msg "No package.json found – skipping"
    continue
  fi

  pushd "$dir" > /dev/null

  # Determine install strategy: npm ci for committed lockfile, npm install otherwise
  if [[ -f "package-lock.json" ]]; then
    if ! npm ci --ignore-scripts --silent 2>/dev/null; then
      fail_msg "npm ci failed"
      popd > /dev/null
      continue
    fi
  else
    if ! npm install --ignore-scripts --legacy-peer-deps --silent 2>/dev/null; then
      fail_msg "npm install failed"
      popd > /dev/null
      continue
    fi
  fi

  # Run audit signatures (supply-chain integrity)
  echo "  → audit signatures..."
  if npm audit signatures 2>/dev/null; then
    success_msg "Audit signatures: verified"
  else
    fail_msg "Audit signatures: check failed"
  fi

  # Run audit — capture both text and JSON in a single pass
  AUDIT_OUT="$RESULT_DIR/npm-audit-${dir//\//_}.txt"
  AUDIT_JSON="$RESULT_DIR/npm-audit-${dir//\//_}.json"

  # Capture JSON first, then format text summary from it
  npm audit --json > "$AUDIT_JSON" 2>/dev/null || true

  if npm audit --audit-level=moderate 2>&1 | tee "$AUDIT_OUT"; then
    success_msg "No moderate+ vulnerabilities found"
  else
    fail_msg "Vulnerabilities found – see $AUDIT_OUT"
  fi

  # Check for critical vulnerabilities from JSON (avoids re-running npm audit)
  CRITICAL_COUNT=$(node -e "
    try {
      const d = JSON.parse(require('fs').readFileSync('$AUDIT_JSON', 'utf8'));
      console.log(Object.values(d.vulnerabilities||{}).filter(v=>v.severity==='critical').length);
    } catch(e) { console.log(0) }
  " 2>/dev/null || echo "0")

  if [[ "$CRITICAL_COUNT" -gt 0 ]]; then
    fail_msg "CRITICAL: ${CRITICAL_COUNT} critical vulnerabilities found!"
  fi

  popd > /dev/null
done

# ═══════════════════════════════════════════════════════════════════
#  2. cargo audit — Rust dependencies
# ═══════════════════════════════════════════════════════════════════
divider
echo -e "${BOLD}2/5  cargo audit (Rust dependencies)${NC}"

if command -v cargo &> /dev/null; then
  if ! command -v cargo-audit &> /dev/null; then
    echo -e "  ${YELLOW}Installing cargo-audit...${NC}"
    cargo install cargo-audit --quiet 2>/dev/null || {
      skip_msg "cargo-audit installation failed – skipping Rust audits"
    }
  fi
else
  skip_msg "Cargo not found – skipping Rust audits"
fi

if command -v cargo-audit &> /dev/null; then
  CARGO_WORKSPACES=(
    "IoT Payload Generator:contracts"
    "Soroban Contracts:contracts/contracts"
  )

  for entry in "${CARGO_WORKSPACES[@]}"; do
    label="${entry%%:*}"
    dir="${entry##*:}"

    section "${label} ($dir)"

    if [[ ! -f "$dir/Cargo.toml" ]]; then
      skip_msg "No Cargo.toml found – skipping"
      continue
    fi

    pushd "$dir" > /dev/null

    AUDIT_OUT="$RESULT_DIR/cargo-audit-${dir//\//_}.txt"
    AUDIT_JSON="$RESULT_DIR/cargo-audit-${dir//\//_}.json"

    if cargo audit 2>&1 | tee "$AUDIT_OUT"; then
      success_msg "No vulnerabilities found"
    else
      cargo audit --json > "$AUDIT_JSON" 2>/dev/null || true
      fail_msg "Vulnerabilities found – see $AUDIT_OUT"
    fi

    popd > /dev/null
  done
fi

# ═══════════════════════════════════════════════════════════════════
#  3. Supply chain integrity — verify lock files are present
# ═══════════════════════════════════════════════════════════════════
divider
echo -e "${BOLD}3/5  Supply chain integrity checks${NC}"

section "Checking lockfile presence"

declare -A LOCKFILES=(
  ["package-lock.json"]="."
  ["backend/package-lock.json"]="backend"
  ["frontend/package-lock.json"]="frontend"
  ["dashboard-prototype/package-lock.json"]="dashboard-prototype"
  ["contracts/Cargo.lock"]="contracts"
)

for lockfile in "${!LOCKFILES[@]}"; do
  if [[ -f "$lockfile" ]]; then
    success_msg "${lockfile} present"
  else
    skip_msg "${lockfile} not found (will generate from package.json)"
  fi
done

section "Checking for unpinned dependencies"

# Check for version specifiers that don't pin exact versions
UNPINNED_COUNT=$(grep -r '"version":\s*"[^"]*"\s*$' \
  package.json backend/package.json frontend/package.json dashboard-prototype/package.json 2>/dev/null | \
  grep -cv 'exact-version' || true)

if [[ "$UNPINNED_COUNT" -eq 0 ]]; then
  success_msg "Dependencies appear to have pinned versions"
else
  skip_msg "Review dependency version pinning for reproducibility"
fi

section "npm audit signatures"

# Verify registry signature integrity for each workspace that has a lockfile
for entry in "${NPM_WORKSPACES[@]}"; do
  label="${entry%%:*}"
  dir="${entry##*:}"
  if [[ -f "$dir/package-lock.json" ]]; then
    pushd "$dir" > /dev/null
    if npm audit signatures 2>/dev/null; then
      success_msg "${label}: signatures verified"
    else
      fail_msg "${label}: signature verification failed"
    fi
    popd > /dev/null
  else
    skip_msg "${label}: no lockfile for signature check"
  fi
done

# ═══════════════════════════════════════════════════════════════════
#  4. Run CI checks (lints, typechecks, tests)
# ═══════════════════════════════════════════════════════════════════
divider
echo -e "${BOLD}4/5  CI checks (lint, typecheck, test)${NC}"

# Root Hardhat
section "Root – Hardhat Tests"
if [[ -f "package.json" ]]; then
  if npx hardhat test 2>&1 | tee "$RESULT_DIR/hardhat-test.txt"; then
    success_msg "Hardhat tests passed"
  else
    fail_msg "Hardhat tests failed"
  fi
fi

# Backend
section "Backend – TypeScript"
if [[ -f "backend/package.json" ]]; then
  pushd backend > /dev/null

  echo "  → typecheck..."
  if npx tsc --noEmit 2>&1 | tee "$RESULT_DIR/backend-typecheck.txt"; then
    success_msg "Backend typecheck passed"
  else
    fail_msg "Backend typecheck failed"
  fi

  echo "  → lint..."
  if npx eslint src/ tests/ --ext .ts 2>&1 | tee "$RESULT_DIR/backend-lint.txt"; then
    success_msg "Backend lint passed"
  else
    fail_msg "Backend lint failed"
  fi

  echo "  → tests..."
  if npm test 2>&1 | tee "$RESULT_DIR/backend-test.txt"; then
    success_msg "Backend tests passed"
  else
    fail_msg "Backend tests failed"
  fi

  popd > /dev/null
fi

# Frontend
section "Frontend – TypeScript"
if [[ -f "frontend/package.json" ]]; then
  pushd frontend > /dev/null

  echo "  → typecheck..."
  if npx tsc --noEmit 2>&1 | tee "$RESULT_DIR/frontend-typecheck.txt"; then
    success_msg "Frontend typecheck passed"
  else
    fail_msg "Frontend typecheck failed"
  fi

  echo "  → lint..."
  if npx eslint . --ext .ts,.tsx 2>&1 | tee "$RESULT_DIR/frontend-lint.txt"; then
    success_msg "Frontend lint passed"
  else
    fail_msg "Frontend lint failed"
  fi

  echo "  → tests..."
  if npm test 2>&1 | tee "$RESULT_DIR/frontend-test.txt"; then
    success_msg "Frontend tests passed"
  else
    fail_msg "Frontend tests failed"
  fi

  popd > /dev/null
fi

# ═══════════════════════════════════════════════════════════════════
#  Final Summary
# ═══════════════════════════════════════════════════════════════════
divider
TOTAL=$((PASS + FAIL + SKIP))
echo -e "${BOLD}═══════════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Audit Summary${NC}"
echo -e "${BOLD}═══════════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${GREEN}✅ Passed:  ${PASS}${NC}"
echo -e "  ${RED}❌ Failed:  ${FAIL}${NC}"
echo -e "  ${YELLOW}⏭️  Skipped: ${SKIP}${NC}"
echo -e "  Total:     ${TOTAL}"
echo ""
echo -e "  Detailed reports saved to: ${RESULT_DIR}/"
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  echo -e "${RED}${BOLD}⚠️  Action required: ${FAIL} check(s) failed.${NC}"
  echo "   Review the reports above and in ${RESULT_DIR}/"
  exit 1
else
  echo -e "${GREEN}${BOLD}🎉 All checks passed!${NC}"
fi
