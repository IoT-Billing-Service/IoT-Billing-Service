# Docker image caching in CI

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

## Monitoring and operations

Each Docker build step shows Buildx cache hits and misses in its GitHub Actions
log. Track build duration and cache-hit messages for the two steps after a
workflow change. If cache use degrades, first confirm that `package-lock.json`
or the Dockerfile did not change; those are expected invalidation inputs.
GitHub Actions cache eviction only makes a build slower,
not less correct. The next successful run repopulates the cache.

`scripts/verify-docker-cache.mjs` is run before image builds and validates that
both images retain isolated `type=gha` cache configuration and manifest-first,
reproducible dependency layers.
