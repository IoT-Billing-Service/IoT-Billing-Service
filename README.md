# IoT Billing Frontend

Enterprise-grade Web3 DePIN dashboard for IoT-Billing-Service. Real-time device telemetry, Soroban smart contract escrow management, and multi-tenant fleet monitoring.

Built with **Next.js 16**, **React 19**, **TypeScript**, **Tailwind CSS 4**, and **Stellar Soroban SDK**.

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
- [Available Scripts](#available-scripts)
- [Project Structure](#project-structure)
- [Transaction Retry Queue](#transaction-retry-queue)
- [API Endpoints](#api-endpoints)
- [Testing](#testing)
- [Environment Variables](#environment-variables)
- [Deployment](#deployment)
- [Contributing](#contributing)

---

## Features

- **Real-time Dashboard** — Multi-tenant device telemetry with analytics and date-range filtering
- **Soroban Smart Contract Integration** — Escrow deposits and withdrawals via Stellar blockchain
- **Transaction Retry Queue** — IndexedDB-persistent queue with deduplication and automatic status polling
- **Freighter Wallet Support** — Stellar wallet connection with `@stellar/freighter-api`
- **PWA Support** — Service worker, offline capabilities, app install banner
- **Responsive Design** — Tailwind CSS 4 with dark mode
- **OpenTelemetry Tracing** — Performance monitoring instrumentation

---

## Architecture

```
src/
├── app/
│   ├── dashboard/          # Main dashboard page with analytics
│   ├── api/                # API routes (escrow, tx-status, etc.)
│   ├── layout.tsx          # Root layout with providers
│   └── page.tsx            # Entry page
├── components/
│   ├── dashboard/          # Dashboard UI components
│   ├── wallet/             # Wallet connection, transaction modal, TxStatusPill
│   └── pwa/                # PWA installer and service worker registration
├── hooks/
│   ├── useTxRetryQueue.ts  # Transaction retry queue with persistence & dedup
│   └── useWallet.ts        # Wallet connection hook
├── services/
│   ├── indexedDbCache.ts   # IndexedDB v2 schema and CRUD operations
│   └── stellar.ts          # Stellar Soroban RPC client
├── stores/                 # Zustand state stores
├── types/                  # TypeScript type definitions
├── utils/                  # Utility functions
├── lib/                    # Business logic (billing analytics, etc.)
└── workers/                # Service workers
```

---

## Prerequisites

- **Node.js** >= 20
- **npm** (or pnpm, yarn, bun)
- A **Stellar wallet** (Freighter browser extension recommended)
- Access to Stellar Testnet (for development)

---

## Getting Started

```bash
# Clone the repository
git clone https://github.com/IoT-Billing-Service/iot-billing-frontend.git
cd iot-billing-frontend

# Install dependencies
npm install

# Start the development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser. The dashboard redirects to `/dashboard?from=...&to=...`.

### Environment Variables

Create a `.env.local` file in the project root:

```env
# No required environment variables for basic development
# The app uses mock data for the dashboard by default
# For production, configure:
NEXT_PUBLIC_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
NEXT_PUBLIC_CONTRACT_ID=your-contract-id
```

---

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server with hot reload |
| `npm run build` | Production build |
| `npm start` | Run production server |
| `npm test` | Run all tests (Vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run typecheck` | TypeScript type checking |
| `npm run lint` | ESLint check |
| `npm run format` | Prettier formatting check |
| `npm run analyze` | Bundle analysis |
| `npm run generate-pwa-assets` | Generate PWA icons and assets |
| `npm run validate:css` | Validate CSS against design system |

---

## Transaction Retry Queue

The application includes a robust transaction retry queue system for handling Stellar Soroban escrow transactions.

### Key Features

- **IndexedDB Persistence** — Transaction state survives page reloads (schema v2)
- **30-second Deduplication Window** — Prevents duplicate submissions by comparing `contractId`, `amount`, `asset`, `publicKey`, and `type`
- **Automatic Status Polling** — Checks `GET /api/escrow/tx-status` every 5 seconds (max 120 attempts / 10 minutes)
- **Real-time UI** — `TxStatusPill` and `TxStatusList` components with pending/confirmed/failed states

### Usage

```typescript
import { useTxRetryQueue } from '@/hooks/useTxRetryQueue';
import { TxStatusList } from '@/components/wallet/TxStatusPill';

function MyComponent() {
  const { pendingTransactions, enqueue, clearCompleted } =
    useTxRetryQueue(10, 'my-queue');

  const handleSubmit = async () => {
    const response = await fetch('/api/escrow/deposit', { method: 'POST', body: JSON.stringify({ /* ... */ }) });
    const { hash } = await response.json();

    await enqueue({
      hash,
      contractId: 'CXXX...',
      amount: '1000',
      asset: 'USDC',
      publicKey: 'GXXX...',
      type: 'escrow_deposit',
    });
  };

  return (
    <TxStatusList
      transactions={pendingTransactions}
      onClearCompleted={clearCompleted}
    />
  );
}
```

### Configuration

| Constant | Default | Description |
|----------|---------|-------------|
| `RETRY_DELAY_BASE` | 2000ms | Base retry delay |
| `MAX_RETRIES_DEFAULT` | 10 | Maximum retry attempts |
| `DEDUP_WINDOW_MS` | 30,000ms | Deduplication time window |
| `POLL_INTERVAL` | 5000ms | Status polling interval |
| `MAX_POLL_ATTEMPTS` | 120 | Maximum polling attempts (10 min) |

### IndexedDB Schema

```
Store: pendingTransactions
Indexes: status, createdAt, hash

interface PendingTransaction {
  id: string;
  hash: string;
  contractId: string;
  amount: string;
  asset: string;
  publicKey: string;
  type: 'escrow_deposit' | 'escrow_withdrawal';
  status: 'pending' | 'confirmed' | 'failed';
  retryCount: number;
  maxRetries: number;
  lastScannedLedger?: number;
  createdAt: number;
  updatedAt: number;
}
```

---

## API Endpoints

### Transaction Status

```
GET /api/escrow/tx-status?hash={txHash}
```

Response:
```json
{ "status": "pending" | "confirmed" | "failed", "ledger": 1000000, "hash": "abc123" }
```

> **Note:** Currently uses mock simulation. For production, replace with real Soroban RPC calls using `@stellar/stellar-sdk`.

---

## Testing

The test suite covers:

- **IndexedDB operations** — CRUD, filtering, deletion (7 tests)
- **Queue deduplication** — Window logic, parameter matching (9 tests)
- **UI components** — All states, button interactions (11 tests)
- **Total**: 27+ tests

```bash
# Run all tests
npm test

# Run specific test file
npm test src/hooks/useTxRetryQueue.test.ts
```

---

## Project Structure

```
iot-billing-frontend/
├── src/
│   ├── app/                 # Next.js App Router pages and API routes
│   ├── components/          # React components
│   ├── hooks/               # Custom React hooks
│   ├── services/            # Service layer (IndexedDB, Stellar)
│   ├── stores/              # Zustand state management
│   ├── types/               # TypeScript types
│   ├── utils/               # Utility functions
│   ├── lib/                 # Business logic
│   └── workers/             # Service workers
├── tests/                   # E2E tests (Playwright)
├── public/                  # Static assets
├── scripts/                 # Build and utility scripts
├── next.config.ts           # Next.js configuration
├── vitest.config.ts         # Vitest configuration
├── playwright.config.ts     # Playwright configuration
├── tailwind.config.ts       # Tailwind CSS configuration
└── tsconfig.json            # TypeScript configuration
```

---

## Deployment

### Build for Production

```bash
npm run build
npm start
```

The production server runs on port 3000 by default.

### Docker

A Dockerfile can be added for containerized deployment. The Next.js standalone output mode is configured for optimal container builds.

---

## Contributing

### Principles

- Correctness over speed
- Security over convenience
- Readability over cleverness
- Small, reviewable changes over broad rewrites

### Guidelines

1. Read the relevant source files, tests, and configuration before making changes
2. Make the smallest correct change
3. Add or update tests for any behavioral change
4. Never commit secrets, private keys, or real `.env` values
5. Run checks before submitting: `npm run typecheck && npm run lint && npm test`

### Web3-Specific Notes

- Never assume a wallet is connected — always handle disconnected state
- Always handle rejected wallet requests
- Always handle pending, confirmed, failed, and reverted transactions
- Do not expose private keys, mnemonics, or API secrets

---

## Security

- All user input is validated and sanitized
- IndexedDB is origin-scoped (no cross-domain leakage)
- React auto-escapes displayed content (XSS protection)
- Rate limiting considered for API endpoints in production
- Transaction parameters validated before storage

---

## License

By contributing, you agree that your contributions will be licensed under the same license as the project.
