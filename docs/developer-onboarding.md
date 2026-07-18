# Developer onboarding

Use the PowerShell onboarding script to prepare a local, isolated development
environment for the backend and frontend:

```powershell
pwsh -File scripts/setup-local.ps1
```

It verifies Node.js 20+, npm 10+, Git, and Docker Compose; creates missing
local environment files; starts PostgreSQL/TimescaleDB and Redis; performs
locked dependency installs; then generates Prisma and applies the schema to
the local container database. Existing `.env` and `.env.local` files are never
overwritten.

The backend environment gets a random local JWT secret when it is first
created. The script does not generate Stellar keys, deploy contracts, or copy
secrets from another environment. Configure a testnet contract ID manually if
your feature needs one. Never commit either generated environment file.

## Options

```powershell
# Preview every action without changing files, containers, or databases.
pwsh -File scripts/setup-local.ps1 -WhatIf

# Use already-running services, dependencies, or a prepared database.
pwsh -File scripts/setup-local.ps1 -SkipServices -SkipDependencies -SkipDatabase
```

Start the applications after setup:

```powershell
cd backend; npm run dev
# another terminal
cd frontend; npm run dev
```

## Verification and monitoring

`scripts/test-setup-local.ps1` runs the script in dry-run mode and verifies its
required safeguards. CI executes it on each change to onboarding assets.
Docker Compose waits for database and Redis health checks before the script
continues. Inspect local service health with:

```powershell
docker compose -f docker-compose.dev.yml ps
docker compose -f docker-compose.dev.yml logs
```

The local services are development-only; they use known local credentials and
must never be deployed or exposed outside the developer machine.
