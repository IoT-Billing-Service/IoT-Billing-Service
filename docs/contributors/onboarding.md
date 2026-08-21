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

---

<!-- Consolidated from docs/docker-image-caching.md (issue #308) -->

## Docker image caching in CI

The `docker-build` job uses Docker Buildx and the GitHub Actions cache backend
to retain image layers between workflow runs. It builds the backend and frontend
independently, with a separate cache scope for each image:

| Image | Cache scope | Dependency layer |
| --- | --- | --- |
| Backend | `backend-image` | `package*.json`, then `npm ci` |
| Frontend | `frontend-image` | `package.json` and `package-lock.json`, then `npm ci` |

`mode=max` exports every reusable intermediate layer. A source-only change
therefore reuses the dependency-install layer; a lockfile change correctly
invalidates it. The backend and frontend scopes are isolated
to prevent one image from evicting or incorrectly satisfying the other image's
layers.

The cache is only a build acceleration. CI still runs the regular lint,
type-check, unit, integration, and image-build checks on every change. The
cached Docker build neither changes billing logic nor bypasses cryptographic
transaction verification. No image is pushed, and the job has read-only
repository permissions.

### Monitoring and operations

Each Docker build step shows Buildx cache hits and misses in its GitHub Actions
log. Track build duration and cache-hit messages for the two steps after a
workflow change. If cache use degrades, first confirm that `package-lock.json`
or the Dockerfile did not change; those are expected invalidation inputs.
GitHub Actions cache eviction only makes a build slower,
not less correct. The next successful run repopulates the cache.

`scripts/verify-docker-cache.mjs` is run before image builds and validates that
both images retain isolated `type=gha` cache configuration and manifest-first,
reproducible dependency layers.
