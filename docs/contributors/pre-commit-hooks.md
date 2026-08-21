# Pre-Commit Hook Suite

The repository includes a local pre-commit hook for fast quality checks before code reaches CI.

## Install

```bash
npm run hooks:install
```

This configures the current checkout to use `.githooks/`.

## What The Hook Enforces

- Blocks live `.env` files while allowing `.env.example`, `.env.sample`, and `.env.template`.
- Blocks private key and certificate material such as `.pem`, `.key`, `.p12`, and `.pfx` files.
- Scans staged text files for unresolved merge conflict markers.
- Scans staged text files for private key blocks.
- Validates staged JSON files.

The hook checks the staged version of each file, not only the working-tree copy.

## Manual Run

```bash
npm run precommit:check
```

The CI smoke test for the hook is included in:

```bash
npm run test:ci
```

## Scope

The hook is intentionally dependency-light and fast. Full workspace checks still run in CI:

- Backend formatting, linting, typechecking, tests, and build.
- Frontend linting, typechecking, tests, and build.
- Contract formatting and tests.
