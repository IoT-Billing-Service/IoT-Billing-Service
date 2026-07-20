# IoT Billing Service

> Enterprise‑grade Web3 DePIN platform for hardware telemetry metering, Stellar/Soroban smart contract billing, and multi‑tenant fleet management.

[![GitHub](https://img.shields.io/badge/GitHub-IoT_Billing_Service-181717?logo=github)](https://github.com/IoT-Billing-Service)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen?logo=node.js)](.nvmrc)
[![Rust](https://img.shields.io/badge/rust-1.85-orange?logo=rust)](contracts/rust-toolchain.toml)
[![Stellar](https://img.shields.io/badge/Stellar-Soroban-7B3FE4?logo=stellar)](https://soroban.stellar.org)

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Repository Layout](#repository-layout)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
  - [Backend](#backend)
  - [Frontend](#frontend)
  - [Smart Contracts](#smart-contracts)
- [Environment Variables](#environment-variables)
- [Configuration Management](#configuration-management)
- [Deployment](#deployment)
- [CI / Testing](#ci--testing)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

IoT Billing Service is a full‑stack DePIN (Decentralized Physical Infrastructure Network) platform that:

- **Ingests** hardware telemetry data from thousands of IoT devices in real‑time.
- **Validates** data integrity via ZK range proofs (Bulletproofs) and Ed25519 signatures.
- **Bills** consumers through Soroban smart contracts running on the Stellar network.
- **Manages** device fleets, escrow accounts, and payment settlements through a unified dashboard.

The system is built for high throughput, offline‑first resilience, and transparent on‑chain settlement.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Frontend (Next.js)                 │
│  Dashboard  │  Fleet Manager  │  Escrow  │  Payments │
│  ┌───────────────────────────────────────────────┐   │
│  │      WalletProvider · QueryProvider           │   │
│  └───────────────────────────────────────────────┘   │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP / WebSocket
┌──────────────────────▼──────────────────────────────┐
│                Backend (Fastify / TypeScript)         │
│  ┌──────────┬───────────┬──────────┬──────────────┐ │
│  │Telemetry │  Auth     │  Billing │  Blockchain  │ │
│  │Ingestion │ (JWT/OIDC)│Orchestr. │  Relayer     │ │
│  ├──────────┴───────────┴──────────┴──────────────┤ │
│  │             Prisma ORM · Redis · TimescaleDB    │ │
│  └─────────────────────────────────────────────────┘ │
└──────────────────────┬──────────────────────────────┘
                       │ Stellar RPC
┌──────────────────────▼──────────────────────────────┐
│          Smart Contracts (Soroban / Rust)             │
│  ┌──────────┬───────────┬──────────┬──────────────┐ │
│  │  Escrow  │  Tariff   │Billing   │  Settlement  │ │
│  │          │  Oracle   │Engine    │  Orchestrator│ │
│  └──────────┴───────────┴──────────┴──────────────┘ │
└─────────────────────────────────────────────────────┘
```

---

## Repository Layout

| Directory | Description |
|---|---|
| [`backend/`](./backend) | Fastify/TypeScript API — telemetry ingestion, auth, billing orchestration, blockchain relayer |
| [`frontend/`](./frontend) | Next.js application — dashboard, fleet manager, escrow UI, payment history |
| [`contracts/`](./contracts) | Soroban Rust smart contracts — escrow, tariff oracle, billing engine, settlement |
| [`dashboard-prototype/`](./dashboard-prototype) | Preserved source snapshot of the original AI Studio prototype |

---

## Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| **Node.js** | >= 20 | Backend & frontend runtimes |
| **npm** | >= 10 | Package management |
| **Rust** | 1.85+ (nightly) | Smart contract compilation |
| **Stellar CLI** | >= 23 | Contract deployment & interaction |
| **PostgreSQL** | 16+ | Primary database (backend) |
| **Redis** | 7+ | Caching / rate limiting (backend) |
| **TimescaleDB** | 2+ | Time‑series telemetry storage |
| **Docker** | 24+ | Local dev environment (optional) |

---

## Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/IoT-Billing-Service/IoT-Billind-Service.git
cd IoT-Billind-Service
```

### 2. Backend

```bash
cd backend
cp .env.example .env          # Configure database, Redis, and Stellar RPC
npm install
npx prisma migrate dev        # Apply database migrations
npm run dev                   # Start development server (default :3000)
```

### 3. Frontend

```bash
cd frontend
cp .env.example .env.local    # Configure contract IDs and API URL
npm install
npm run dev                   # Start Next.js dev server (default :3001)
```

Open [http://localhost:3001](http://localhost:3001) — you will be redirected to the dashboard.

### 4. Smart Contracts

```bash
cd contracts
# Build all contracts
for dir in utility_contracts escrow price_oracle; do
  (cd "$dir" && stellar contract build)
done

# Deploy to your Stellar network
stellar contract deploy \
  --wasm target/wasm32v1-none/release/escrow.wasm \
  --network standalone
```

---

## Environment Variables

### Backend (`backend/.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `REDIS_URL` | Yes | `redis://localhost:6379` | Redis connection string |
| `STELLAR_RPC_URL` | Yes | — | Soroban RPC endpoint |
| `STELLAR_NETWORK_PASSPHRASE` | Yes | — | Network passphrase |
| `JWT_SECRET` | Yes | — | JWT signing secret |
| `PORT` | No | `3000` | Server port |
| `NODE_ENV` | No | `development` | Environment mode |
| `CORS_ORIGIN` | No | `http://localhost:3001` | Allowed CORS origin |
| `LOG_LEVEL` | No | `info` | Pino log level |

### Frontend (`frontend/.env.local`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `NEXT_PUBLIC_API_URL` | Yes | `http://localhost:3000` | Backend API base URL |
| `NEXT_PUBLIC_ESCROW_CONTRACT_ID` | Yes | — | Soroban escrow contract ID |
| `NEXT_PUBLIC_STELLAR_NETWORK` | No | `testnet` | Stellar network name |
| `NEXT_PUBLIC_WS_URL` | No | — | WebSocket endpoint for live telemetry |

---

## Deployment

### Railway (recommended)

The project includes [`railway.toml`](./railway.toml) for zero‑configuration deployment on [Railway](https://railway.app).

```bash
railway login
railway up
```

### Render

A [`render.yaml`](./render.yaml) is provided for deployment on [Render](https://render.com):

```bash
render deploy
```

### Docker

```bash
docker compose up --build
```

This starts the backend, frontend, PostgreSQL, Redis, and TimescaleDB services as defined in [`docker-compose.yml`](../docker-compose.yml).

---

## Configuration Management

### Environment Schema Validation

All environment variables are validated at startup against a strict [Zod](https://zod.dev) schema defined in `backend/src/config/env.ts`.

- Required fields (`DATABASE_URL`, `JWT_SECRET`, etc.) must be present and well-formed — the server will not start if any are missing or invalid.
- Optional fields have typed defaults (`PORT=3000`, `NODE_ENV=development`, etc.).
- Every validation failure is reported with the field path, error code, and human-readable message. No failing field is silently collapsed.

Use `loadEnv()` to validate and cache the environment once, `getEnv()` to read the cached result, and `clearEnvCache()` (test helper) to force re-validation.

### Billing-Tier Config: Schema Validation + Hot-Reload

Billing tier configuration (`MetricRangesConfig`) is validated and hot-reloaded at runtime from Redis, defined in `backend/src/config/index.ts`.

**Schema rules** (enforced by `metricRangesConfigSchema`):

| Field | Rule |
|---|---|
| `version_id` | Non-empty string |
| `tiers` | At least one entry |
| `tiers[*].min` | `>= 0`, finite |
| `tiers[*].max` | `> 0`, not `-Infinity` (use `Infinity` for unbounded) |
| `tiers[*].min < max` | Strict per tier |

**Hot-reload behaviour:**

1. On startup, `initializeConfigWatcher(redis)` reads `config:active` from Redis. If absent, it writes the built-in fallback tiers.
2. A polling interval (default 50 ms, configurable) checks `config:active` for a changed `version_id`.
3. On version change the candidate is schema-validated. Valid configs are applied atomically via `setConfig()`; invalid ones are **rejected and the previous config is retained** (automatic rollback — no downtime).
4. Call `stopConfigWatcher()` on shutdown to cancel the interval.

**Monitoring** — two Prometheus counters track config lifecycle:

| Metric | Description |
|---|---|
| `config_reload_total` | Incremented on every successful hot-reload |
| `config_validation_failures_total` | Incremented on each rejected candidate (previous config retained) |

The current reload status, version ID, and last validation error are always accessible via `getConfigStatus()`.

---

## CI / Testing

Each workspace contains dedicated test suites:

| Directory | Command | Tools |
|---|---|---|
| `backend/` | `npm test` | Vitest, Supertest |
| `frontend/` | `npm test` | Vitest, Playwright |
| `contracts/` | `cargo test` | Rust test harness |

CI pipelines run automatically on every push via GitHub Actions (see `.github/workflows/` in each workspace).

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Commit your changes: `git commit -m 'feat: add new feature'`
4. Push to the branch: `git push origin feat/my-feature`
5. Open a Pull Request

Please follow the [Conventional Commits](https://www.conventionalcommits.org) specification and ensure all tests pass before requesting review.

---

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

---

<p align="center">
  Built with ❤️ by the IoT Billing Service Team
</p>
