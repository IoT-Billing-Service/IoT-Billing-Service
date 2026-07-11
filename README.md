# IoT Billing Service Monorepo

This repository consolidates the IoT Billing Service platform into a single monorepo.

## Repository Layout

- `backend/` — Fastify/TypeScript backend for telemetry ingestion, auth, billing orchestration, and blockchain integration
- `frontend/` — Next.js frontend application, with the AI Studio prototype promoted as the primary `/dashboard`
- `contracts/` — Stellar Soroban smart contracts and related workspace files
- `dashboard-prototype/` — preserved source snapshot of the original AI Studio prototype

## Notes

The production application code now lives in the `backend/`, `frontend/`, and `contracts/` directories. In the frontend app, the AI Studio prototype now serves as the primary dashboard at `/dashboard`, while `dashboard-prototype/` is kept as a preserved source snapshot of the original prototype.
