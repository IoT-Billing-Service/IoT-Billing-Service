# IoT Billing Service

Soroban-powered micro-billing for connected devices. A workspace-based monorepo
that keeps the smart-contract ABI, the backend indexer schema, and frontend
types in sync by building and testing them from a single root.

## Repo layout

```
.
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                # contract + backend + frontend gates
│   │   ├── deploy-staging.yml    # auto-deploy on merge to staging
│   │   └── deploy-production.yml # deploy on merge to main (owner-only)
│   └── pull_request_template.md
├── contracts/                    # Soroban smart contract (Rust)
├── backend/                      # event indexer, cache API, WebSocket stream
├── frontend/                     # React/TypeScript dashboard
├── emulator/                     # peripheral hardware client / test harness
├── scripts/                      # setup, promote, e2e helpers
├── Cargo.toml                    # cargo workspace -> ./contracts
└── package.json                  # npm workspace -> ./backend, ./frontend
```

## Branch architecture

| Branch | Purpose | Changes come from |
| ------ | ------- | ----------------- |
| `dev` | Default; contributor target | contributor feature branches (PR) |
| `staging` | Pre-production validation | `dev` via promotion PR only |
| `main` | Production/live | `staging` via owner-only promotion PR |

Promotions are created with `scripts/promote.sh` and validated by the
`promote.yml` workflow, which rejects any PR into `staging`/`main` that does not
originate from the expected source branch.

## Contract

The contract (`contracts/src/lib.rs`) implements the core entrypoints:

- `register_device(device_id, device_pubkey, operator, rate_per_unit)` — assigns
  billing rules and binds the device's ed25519 public key (32 bytes) for reading
  signature verification. Requires auth from both `device_id` and `operator`.
- `deposit_funds(device_id, amount)` — pre-funds escrow.
- `submit_reading(device_id, delta_units, data_seq, timestamp, sig)` — verifies
  the device's ed25519 signature over
  `"iot-billing-v1" || device_pubkey || data_seq || delta_units || timestamp`
  (big-endian u64 fields), enforces `data_seq == last_seq + 1` for replay
  protection, computes `cost = delta_units * rate`, deducts escrow, credits the
  operator's earnings, and emits a `meter` event with data
  `(delta_units, total_cost, balance_after, data_seq, ledger_timestamp)`.
  Does not require transaction auth (out-of-band relay pattern).
- `settle_balance(operator, amount)` — operator settlement withdrawal, limited
  to `total_earned - total_settled` (runs on the operator's own signature).
- `get_balance`, `get_operator_balance` — read-only queries.

State storage keys (`contracts/src/storage.rs`):

- `Device(Address)` — operator, device pubkey, status, registered-at.
- `DepositBalance(Address)` — escrow deposit per device.
- `ReadingCounter(Address)` — latest sequence + cumulative metric units (replay
  protection).
- `OperatorBalance(Address)` — `total_earned` / `total_settled` for settlement.

Run the suite:

```sh
cargo test --manifest-path contracts/Cargo.toml
```

## Backend indexer

The backend polls the Soroban RPC `getEvents` endpoint for `meter` events from
the deployed contract, decodes the
`(delta_units, total_cost, balance_after, data_seq, ledger_timestamp)` data
into a relational cache (SQLite locally, PostgreSQL in production), and serves:

- `GET /api/devices/:id/metrics` — aggregated consumption over time.
- `GET /api/devices/:id/balance` — on-chain balance + pending units.
- `WS /stream/telemetry` — real-time device heartbeats for the dashboard.

```sh
npm ci --workspace backend
npm run dev --workspace backend
```

## Frontend dashboard

React + TypeScript + Vite portal with device lists, telemetry charts, balances,
and Freighter wallet connectivity.

```sh
npm ci --workspace frontend
npm run dev --workspace frontend
```

## Hardware emulator

Simulated peripheral devices generating realistic sensor telemetry:

```sh
make -C emulator run-solar   # solar inverter, 100ms interval
make -C emulator run-meter   # smart utility meter, kWh tick mode
make -C emulator test-all    # end-to-end integration test
```

## Developer bootstrap

```sh
./scripts/setup.sh
```

Installs Rust, Node, and Python tooling, fetches dependencies for all
workspaces, and creates `.env` files from templates.

## Promote between environments

```sh
./scripts/promote.sh dev-to-staging     # PR dev -> staging
./scripts/promote.sh staging-to-main    # PR staging -> main (production!)
```