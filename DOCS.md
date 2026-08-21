# IoT Billing Service — Documentation

> Single entry point for all project documentation, organized by audience. Part of the documentation consolidation ([#308](https://github.com/IoT-Billing-Service/IoT-Billing-Service/issues/308)).
>
> New here? Start with the [README](./README.md) for a project overview and quick start.

---

## Table of Contents

- [Contributors](#contributors)
- [Developers](#developers)
- [Operators](#operators)
- [Design Archive](#design-archive)
- [Module Entry Points](#module-entry-points)

---

## Contributors

Setting up a development environment and contributing changes.

| Document | Description |
|---|---|
| [Onboarding & local setup](./docs/contributors/onboarding.md) | Automated local environment provisioning (PowerShell script), plus how Docker image caching works in CI |
| [Pre-commit hook suite](./docs/contributors/pre-commit-hooks.md) | Quality/security gates that run before every commit: secret detection, merge markers, JSON validation |

## Developers

Building, extending, and integrating with the platform.

### System & modules

| Document | Description |
|---|---|
| [Architecture](./docs/developers/architecture.md) | System architecture: telemetry ingestion, billing orchestration, blockchain relayer, data flows |
| [Backend](./docs/developers/backend.md) | Fastify/TypeScript API reference, environment variables, configuration management, price oracle client |
| [Frontend](./docs/developers/frontend.md) | Next.js dashboard architecture, getting started, scripts, Usage Dashboard sub-project |
| [Smart contracts](./docs/developers/smart-contracts.md) | Soroban contract suite: features, security properties, build & test workflow |
| [Real-time usage dashboard](./docs/developers/real-time-usage-dashboard.md) | WebSocket streaming data path, frame format, reliability, and deployment notes |

### Reference

| Document | Description |
|---|---|
| [Contract security](./docs/developers/contract-security.md) | Re-org replay protection, oracle circuit breaker, reentrancy guard, authorization domain, privacy-preserving events, atomic TTL extension |
| [Error codes](./docs/developers/error-codes.md) | On-chain error code reference with multi-language user-facing messages (EN/YO/HA/IG/ES/FR) |
| [Contract validation](./docs/developers/contract-validation.md) | Admin address validation checklist, stream pause/resume validation, continuous flow engine status |
| [TypeScript bindings](./docs/developers/typescript-bindings.md) | Generated Soroban bindings for the meter simulator |
| [ESP32 key storage](./docs/developers/esp32-key-storage.md) | Secure Ed25519 key storage on ESP32 devices (NVS, secure elements) |

## Operators

Deploying, monitoring, and running the platform in production.

| Document | Description |
|---|---|
| [Deployment](./docs/operators/deployment.md) | One-command Stellar testnet/mainnet deployment: Docker-based scripts, key generation, funding, verification |
| [Incident response](./docs/operators/incident-response.md) | PagerDuty-integrated automated runbooks: detection sources, conditional execution, rollback |
| [Monitoring & config operations](./docs/operators/monitoring-and-config.md) | Signed runtime configuration auditing/drift detection; payment webhook delivery design |
| [Backup & recovery](./docs/operators/backup-and-recovery.md) | Backup verification procedures |
| [Chaos engineering](./docs/operators/chaos-engineering.md) | Chaos engineering blueprint and failure-injection scenarios |
| [Vulnerability scanning](./docs/operators/vulnerability-scanning.md) | Dependency vulnerability scanning pipeline and response process |
| [Block explorer guide](./docs/operators/block-explorer-guide.md) | Verifying usage drips and transactions on Stellar block explorers |
| [Stream insurance pool governance](./docs/operators/governance.md) | Governance of the stream insurance pool |

## Design Archive

Historical design documents and implementation plans, kept for context. These describe features at design time and may not reflect the current implementation.

### RFCs (`docs/design/`)

| Document | Description |
|---|---|
| [Hardware attestation](./docs/design/hardware-attestation.md) | Hardware attestation and cryptographic validation (#3, implemented) |
| [Peer-to-peer payment channels](./docs/design/peer-to-peer-payment-channels.md) | P2P payment channels for microtransactions |
| [Dynamic pricing](./docs/design/dynamic-pricing-network-congestion.md) | Dynamic pricing based on network congestion |
| [Revenue forecasting](./docs/design/revenue-forecasting.md) | Predictive analytics for revenue forecasting |
| [Emergency pause mechanism](./docs/design/emergency-pause-mechanism.md) | Emergency pause mechanism |
| [GitHub Actions optimization](./docs/design/github-actions-optimization.md) | CI optimization and release controls |

### Implementation plans (`docs/design/plans/`)

| Document | Description |
|---|---|
| [Web3 challenge-response auth](./docs/design/plans/2026-06-19-phase-1-web3-challenge-auth.md) | Phase 1 Web3 challenge-response authentication (#6) |
| [Geographic pricing tiers](./docs/design/plans/2026-07-16-issue-54-geographic-pricing-tiers.md) | Geographic pricing tiers based on node location (#54) |
| [Capacity planning](./docs/design/plans/capacity-planning.md) | Capacity planning with historical usage trending (#87) |
| [Subscription auto-renewal](./docs/design/plans/subscription-auto-renewal.md) | Subscription auto-renewal (#36) |
| [Configurable billing cycles](./docs/design/plans/2026-08-20-configurable-billing-cycles.md) | Configurable billing cycles and pro-rata charges |

## Module Entry Points

Each module keeps a short README pointing into this documentation:

| Module | README |
|---|---|
| Backend API | [`backend/`](./backend/README.md) → [Backend docs](./docs/developers/backend.md) |
| Frontend dashboard | [`frontend/`](./frontend/README.md) → [Frontend docs](./docs/developers/frontend.md) |
| Smart contracts | [`contracts/`](./contracts/README.md) → [Contracts docs](./docs/developers/smart-contracts.md) |
| Meter simulator | [`contracts/meter-simulator/`](./contracts/meter-simulator/README.md) → [Bindings docs](./docs/developers/typescript-bindings.md) |
| Usage dashboard | [`contracts/usage-dashboard/`](./contracts/usage-dashboard/README.md) → [Frontend docs](./docs/developers/frontend.md) |
| Price oracle client | [`backend/contracts/price_oracle_client/`](./backend/contracts/price_oracle_client/README.md) → [Backend docs](./docs/developers/backend.md) |
