# Billing Contracts — IoT-Billing-Service

Soroban smart contracts for a decentralized utility metering and streaming protocol on Stellar. Supports prepaid/postpaid billing, continuous streaming, variable-rate tariffs, gas buffers, ZK-SNARK sensor privacy, multi-sig governance, and emergency response.

**Contract ID (Testnet):** `CB7PSJZALNWNX7NLOAM6LOEL4OJZMFPQZJMIYO522ZSACYWXTZIDEDSS`

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Security Properties](#security-properties)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
- [Project Structure](#project-structure)
- [Contracts Overview](#contracts-overview)
- [Testing](#testing)
- [Deployment](#deployment)
- [CI/CD](#cicd)
- [Contributing](#contributing)
- [Security & Vulnerability Reporting](#security--vulnerability-reporting)
- [Emergency Procedures](#emergency-procedures)

---

## Features

- **Utility Metering** — Track energy/water consumption with precision billing
- **Prepaid & Postpaid Billing** — Both models supported
- **Continuous Streaming** — Real-time balance monitoring with buffer protection
- **Variable Rate Tariffs** — Peak/off-peak pricing (18:00–21:00 UTC at 1.5× rate)
- **Gas Buffer** — Pre-paid XLM buffer ensures withdrawals clear during network congestion
- **ZK-SNARK Privacy** — Groth16 proofs let meters prove usage without revealing raw readings
- **Firmware Update Gate** — Time-limited, cryptographically signed update authorization
- **Multi-Sig Governance** — 3-of-5 finance wallet quorum for large withdrawals
- **Emergency Response** — Circuit breakers, legal freezes, velocity limits, protocol pauses
- **Nonce Synchronization** — Tamper-proof replay attack prevention for IoT device liveness
- **Tariff Oracle** — Time-of-Use pricing with 24-hour schedules and grid administrator control
- **Ghost Stream Sweeper** — Automated abandoned stream pruning with archive integrity
- **Dust Sweeper** — Prunes fractional remainders from depleted streams
- **Grant Stream** — Conservation goals trigger automatic grant matching

---

## Architecture

```
Billing-contracts/
├── contracts/
│   ├── Cargo.toml              # Workspace root
│   ├── utility_contracts/      # Main billing contract
│   │   ├── src/lib.rs          # Core implementation
│   │   ├── src/test.rs         # Unit tests
│   │   └── src/fuzz_tests.rs   # Fuzz/invariant tests
│   ├── price_oracle/           # Price oracle contract
│   ├── escrow/                 # Escrow contract
│   ├── telemetry_determinism_check/  # Telemetry validation
│   └── docs/                   # Contract documentation
├── meter-simulator/            # Device simulator (JavaScript)
├── usage-dashboard/            # Usage tracking dashboard
├── examples/                   # Usage examples
├── scripts/                    # Deployment scripts
├── docs/                       # Project documentation
├── .github/workflows/          # CI pipeline
├── SECURITY.md                 # (Consolidated into this README)
├── CONTRIBUTING.md             # (Consolidated into this README)
├── EMERGENCY_RUNBOOK.md        # (Consolidated into this README)
└── AUDIT_READY_RUNBOOK.md      # (Consolidated into this README)
```

### Variable Rate Tariffs

Peak hours: **18:00–21:00 UTC** (1.5× off-peak rate).

```
Peak rate = off_peak_rate × 3 / 2
Example: off_peak = 10 tokens/sec → peak = 15 tokens/sec
```

| UTC Hour | Seconds | Status |
|----------|---------|--------|
| 00:00 | 0 | OFF-PEAK |
| 12:00 | 43,200 | OFF-PEAK |
| 18:00 | 64,800 | PEAK |
| 20:59 | 75,599 | PEAK |
| 21:00 | 75,600 | OFF-PEAK |

### Gas Buffer

Ensures 100% service availability during network congestion.

| Constant | Value | Description |
|----------|-------|-------------|
| `MIN_GAS_BUFFER` | 100 XLM | Minimum required buffer |
| `MAX_GAS_BUFFER` | 10,000 XLM | Maximum buffer capacity |
| `GAS_BUFFER_TOP_UP_THRESHOLD` | 200 XLM | Auto top-up trigger |

---

## Security Properties

### Formal Proof: Per-Second Stream Exhaustion Invariant

> **For every active stream:** `current_time ≤ start_time + ⌊initial_balance / flow_rate⌋`

Equivalently, `calculate_remaining_balance(balance, rate, elapsed)` **never returns a negative value**.

**Mathematical Proof:**

Let:
- `B` = initial balance (integer, stroops or token units)
- `R` = flow rate (integer, units per second, `R > 0`)
- `T_max` = `⌊B / R⌋` (maximum seconds the stream can run)
- `C(t)` = consumed at time `t` = `R × t` (integer multiplication)

**Claim:** `B - C(T_max) ≥ 0`

**Proof:**
```
T_max = ⌊B / R⌋
⟹ T_max ≤ B / R
⟹ R × T_max ≤ B
⟹ B - R × T_max ≥ 0
⟹ B - C(T_max) ≥ 0  ∎
```

**Rounding direction:** All divisions use Rust integer truncation (floor for positive values), always rounding down in favour of the contract.

**Overflow protection:** All arithmetic uses `saturating_mul` and `saturating_sub`, clamping to `i128::MAX` / `i128::MIN` rather than wrapping. The `max(0)` clamp provides a final safety net.

### Fuzz Test Coverage

| Test | Description | Coverage |
|------|-------------|----------|
| `test_stream_exhaustion_invariant_randomised` | 100,000 randomised (balance, rate) pairs via deterministic LCG | balance ∈ [1, 10¹²], rate ∈ [1, 10⁶] |
| `test_stream_never_negative_after_pause_resume` | 10-year simulation with pause/resume and partial top-ups | 315M+ seconds |
| `test_rounding_always_favours_solvency` | Verifies floor-division rounding direction | Hand-crafted edge cases |
| `test_calculate_remaining_balance_never_negative` | Grid search (balance, rate, elapsed) | 150 combinations |

### Auto-Rent-Deduction

- Rent deducted only when contract TTL falls below 6-month safety threshold (~3,110,400 ledgers)
- Deduction capped at 1,000 stroops (0.0001 XLM) per claim
- Non-XLM tokens skip deduction silently
- `RentRenew` event emitted with amount and new TTL

### Multi-Sig Technical Veto

- Fleet-level config changes require 48-hour staging window
- Fleet Security Council (3-of-5 multi-sig) can veto within the window
- Emergency circuit-breaker updates bypass staging
- Lost council keys rotatable by DAO after 7-day delay

### Carbon-Credit Streaming

- Green energy ratio and credit multiplier set by whitelisted environmental auditor
- Full integer credits trigger cross-contract mint; partial credits stored in `Deferred_Issuance`
- No fractional dust is lost

### Nonce Synchronization (Issue #260)

- Strict incrementing u64 nonce per device MAC address
- +1 to +5 nonce window for network jitter tolerance
- Multi-sig nonce reset for compromised devices
- Automatic suspicious device marking

### Tariff Oracle Security (Issue #261)

- 24-hour notice period for tariff changes
- Cryptographic signature verification
- Grid administrator key controls

### Ghost Stream Management (Issue #262)

- 90-day zero balance threshold with archive preservation
- Cryptographic archive hashes for integrity
- Gas bounty incentives for relayers

---

## Prerequisites

- **Rust** 1.70+ (with `wasm32-unknown-unknown` target)
- **Soroban CLI** (install via `cargo install soroban-cli`)
- **Stellar Testnet** access (for deployment and integration testing)

---

## Getting Started

### Build

```bash
cd contracts && cargo build --target wasm32-unknown-unknown --release
```

### Test

```bash
# Run all tests (unit + fuzz)
cargo test

# Run specific fuzz test
cargo test -p utility_contracts test_stream_exhaustion_invariant_randomised -- --nocapture
```

### Lint

```bash
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
```

### Local Development

```bash
# Full local dev cycle
cargo fmt --all -- --check
cargo clippy --target wasm32-unknown-unknown -- -D warnings
cargo build --target wasm32-unknown-unknown --release
cargo test

# Code coverage
cargo tarpaulin --ignore-tests
```

### Local Stellar + Postgres Stack

A working local stack for Soroban protocol 27 is included in `docker-compose.local.yml`.

```bash
docker compose -f docker-compose.local.yml up -d
```

This starts:
- PostgreSQL on `localhost:5432`
- Stellar Quickstart on `localhost:8000`
- Soroban local network with `--protocol-version 27`
- Soroban resource limits set to `unlimited`

---

## Project Structure

```
contracts/
├── utility_contracts/           # Main billing contract
│   ├── src/lib.rs               # Core implementation (metering, billing, streaming)
│   ├── src/test.rs              # Unit tests
│   └── src/fuzz_tests.rs        # Fuzz + invariant tests
├── price_oracle/                # Price oracle for USD/XLM conversion
├── escrow/                      # Escrow contract for deposits
├── telemetry_determinism_check/ # Telemetry validation
└── docs/                        # Contract-specific docs (security, deployment, privacy)

meter-simulator/                 # JavaScript device simulator for testing
usage-dashboard/                 # Web dashboard for usage tracking
scripts/                         # Deployment and CI scripts
examples/                        # Code examples
docs/                            # Project documentation
```

---

## Contracts Overview

### Utility Contracts (`contracts/utility_contracts/`)

The core billing contract handling:
- Meter registration, activation, and management
- Prepaid and postpaid billing models
- Continuous streaming with balance monitoring
- Variable rate tariffs (peak/off-peak)
- ZK-SNARK privacy verification
- Firmware update authorization
- Emergency pause/shutdown
- Multi-sig withdrawal management
- Gas buffer management
- Legal freeze compliance
- Velocity limit enforcement

### Price Oracle (`contracts/price_oracle/`)

Provides USD/XLM conversion rates for billing calculations. Key functions:
- `set_oracle` — Update oracle address
- `get_current_rate` — Get current USD/XLM rate
- `resolve_challenge` — Resolve disputed meters

### Escrow Contract (`contracts/escrow/`)

Manages escrow deposits and withdrawals between parties.

---

## Testing

### Unit Tests
```bash
cargo test
```

### Fuzz Tests
The fuzz test suite covers:
- Stream exhaustion invariant (100,000 randomised pairs)
- Pause/resume cycles over 10-year simulations
- Rounding precision edge cases
- Overflow/underflow protection
- Gas buffer boundary conditions

### Integration Testing
```bash
# Run integration tests (requires testnet access)
make integration-test
```

### Coverage
```bash
cargo tarpaulin --ignore-tests
```

---

## Deployment

### Network

- **Development:** Stellar Testnet
- **Production:** Stellar Mainnet (after audit)

### Deploy Contract

```bash
# Build
cd contracts/utility_contracts
cargo build --target wasm32-unknown-unknown --release

# Upload Wasm to network
stellar contract upload \
  --network testnet \
  --source $ADMIN_KEY \
  --wasm target/wasm32-unknown-unknown/release/utility_contracts.wasm

# Deploy
stellar contract deploy \
  --network testnet \
  --source $ADMIN_KEY \
  --wasm target/wasm32-unknown-unknown/release/utility_contracts.wasm
```

### Upgrade Contract (With Timelock)

1. Build and upload new Wasm binary
2. Propose upgrade: `propose_upgrade --new_wasm_hash <hash>`
3. Veto window opens (users can veto)
4. After window passes: `finalize_upgrade`

The contract enforces a veto window (`UPGRADE_VETO_PERIOD_SECONDS`). If veto count exceeds `VETO_THRESHOLD_BPS` of total meters, the upgrade is blocked.

---

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`) runs on:
- Push to `main`
- Pull Requests to `main`

### Pipeline Stages

1. **Environment Setup** — Rust toolchain with WASM target, Stellar CLI v25.1.0, dependency caching
2. **Code Quality** — `cargo fmt --all -- --check` + `cargo clippy --target wasm32-unknown-unknown -- -D warnings`
3. **Build** — `cargo build --target wasm32-unknown-unknown --release`
4. **Unit Tests** — `cargo test` including fuzz tests
5. **Fuzz Tests** — Auto-detection and validation of fuzz infrastructure

---

## Contributing

### Development Areas

#### Smart Contract Development (Rust/Soroban)

```bash
# Setup
cargo install soroban-cli

# Build & Test
cd contracts
cargo build --target wasm32-unknown-unknown --release
cargo test

# Gas Optimization Guidelines
- Minimize storage operations
- Use efficient data structures
- Batch operations when possible
```

#### Hardware Development (C++/Arduino)

- Arduino IDE 2.0+ or PlatformIO
- ESP32 or Arduino-compatible hardware
- Sample rate: Minimum 1 reading per second
- Accuracy: ±1% for power measurements
- Data format: JSON over MQTT/HTTP

### Contribution Workflow

1. Fork and clone
2. Create feature branch: `git checkout -b feature/my-feature`
3. Make changes and add tests
4. Run lint/format: `cargo fmt --all -- --check && cargo clippy --all-targets --all-features -- -D warnings`
5. Run tests: `cargo test`
6. Submit pull request

### Label Guidelines

- `hardware` / `arduino` / `embedded` — Hardware-related changes
- `contracts` / `soroban` — Smart contract changes
- `bugfix` / `feature` / `documentation` / `testing` — General categories

### Bug Reports

**Hardware Bugs:** Include hardware model, firmware version, error logs, reproduction steps.

**Contract Bugs:** Include contract version, transaction hash, input parameters, error message.

---

## Security & Vulnerability Reporting

Report vulnerabilities **privately** via GitHub Security Advisory:
`https://github.com/IoT-Billing-Service/Billing-contracts/security/advisories/new`

Do **not** open a public issue for security-sensitive findings.

### Scope of Security Guarantees

- ✅ Single-stream balance exhaustion (formally proven)
- ✅ Pause / resume cycles
- ✅ Partial top-ups mid-stream
- ✅ Rounding-error accumulation over 10-year durations
- ✅ Overflow / underflow protection via saturating arithmetic
- ⚠️ Multi-stream interactions (integration tests, not formal invariant)
- ⚠️ Oracle price conversion rounding (separate audit scope)

---

## Emergency Procedures

Emergency scenarios and corresponding runbook procedures:

### Scenario A — Active Exploit / Hack in Progress
1. Pause affected meters: `challenge_service` (sets `is_disputed = true`, `is_paused = true`)
2. Hard shutdown: `emergency_shutdown` (sets `is_active = false`)
3. Pause continuous flow streams: `pause_continuous_flow`
4. Revoke velocity overrides: `revoke_velocity_override`
5. Enable global velocity limiting: `set_velocity_limit_config`
6. Cancel pending multi-sig withdrawals

### Scenario B — Protocol Pause
- Pause single meter: `set_meter_pause --paused true`
- Pause stream: `pause_continuous_flow`
- Enable global velocity limits
- Resume: `set_meter_pause --paused false`, `resume_continuous_flow`

### Scenario C — Wasm Hash Upgrade
1. Build and upload new Wasm (verify SHA-256 independently)
2. Propose upgrade: `propose_upgrade`
3. Veto window: 48 hours; monitor `VetoSubmt` events
4. Finalize: `finalize_upgrade` (only after window passes)

### Scenario D — Migrating Trapped State
- Requires DAO approval + independent audit of migration contract
- Pause all meters → enumerate/dump state → deploy migration contract → migrate → verify

### Scenario E — Multi-Sig Withdrawal Freeze
- Cancel: `cancel_multisig_withdrawal`
- Revoke approval: `revoke_multisig_approval`
- Reconfigure: `disable_multisig` → `configure_multisig_withdrawal`

### Scenario F — Legal Freeze
- Freeze: `legal_freeze` (Compliance Officer key)
- Release: `release_legal_freeze` (≥2 Compliance Council signatures)
- Update officer: `set_compliance_officer`

### Scenario G — Gas Buffer Exhaustion
- Check: `get_gas_buffer_balance`
- Top up: `top_up_gas_buffer` (recommended: 500–1,000 XLM during congestion)
- Initialize if missing: `initialize_gas_buffer`
- Withdraw excess: `withdraw_from_gas_buffer` (min 100 XLM must remain)

### Scenario H — Admin Key Compromise
1. Initiate transfer: `initiate_admin_transfer` (48h timelock)
2. Announce to DAO
3. Execute after 48h: `execute_admin_transfer`
4. Rotate all dependent keys (Compliance Officer, Oracle, Finance Wallets)

### Scenario I — Oracle Failure
- Check: `get_current_rate`
- Update oracle: `set_oracle`
- Resolve challenges: `resolve_challenge`

### Scenario J — Velocity Limit Breach
- Check: `get_velocity_limits`
- Temporary override: `apply_velocity_override`
- Tighten limits: `set_velocity_limit_config`
- Revoke override: `revoke_velocity_override`

### Post-Incident Procedures

1. Preserve evidence (export transactions from block explorer)
2. Resolve open challenges
3. Resume paused meters
4. Disable emergency velocity limits
5. Publish post-mortem within 72 hours
6. Rotate compromised keys
7. Update this runbook

### Multi-Sig Signer Reference

Finance wallet holders verify withdrawal requests before approving:

```bash
# Approve
stellar contract invoke --id $CONTRACT --network testnet --source $YOUR_KEY -- approve_multisig_withdrawal --provider $PROVIDER --request_id $ID

# Revoke
stellar contract invoke --id $CONTRACT --network testnet --source $YOUR_KEY -- revoke_multisig_approval --provider $PROVIDER --request_id $ID

# Execute (after quorum reached)
stellar contract invoke --id $CONTRACT --network testnet --source $YOUR_KEY -- execute_multisig_withdrawal --provider $PROVIDER --request_id $ID
```

### Contact Tree

| Priority | Role | Method |
|----------|------|--------|
| 1 | DAO Admin | Signal / PagerDuty |
| 2 | Finance Wallet Holders | Signal group |
| 3 | Compliance Officer | Signal + Email |
| 4 | Oracle Operator | PagerDuty |
| 5 | Stellar Foundation Security | security@stellar.org |

### Escalation Thresholds

| Severity | Criteria | Response |
|----------|----------|----------|
| P1 — Critical | Active exploit, funds draining | < 5 min |
| P2 — High | Suspected exploit, key compromise | < 15 min |
| P3 — Medium | Planned pause, upgrade | < 1 hour |
| P4 — Low | Gas buffer low | < 4 hours |

---

## License

By contributing, you agree that your contributions will be licensed under the same license as the project.
