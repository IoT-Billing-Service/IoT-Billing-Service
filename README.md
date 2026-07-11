# IoT Billing Service Monorepo

This repository consolidates the IoT Billing Service platform into a single monorepo.

## Repository Layout

- `backend/` — Fastify/TypeScript backend for telemetry ingestion, auth, billing orchestration, and blockchain integration
- `frontend/` — Next.js frontend application
- `contracts/` — Stellar Soroban smart contracts and related workspace files
- `dashboard-prototype/` — preserved AI Studio prototype/dashboard app from the repository's initial state

## Notes

The production application code now lives in the `backend/`, `frontend/`, and `contracts/` directories. The `dashboard-prototype/` directory is kept to preserve the original prototype that initialized this repository.
