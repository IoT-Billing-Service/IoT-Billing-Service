# Backup Verification & Restore Testing

> Issue #67 — Scheduled database backup verification with automated restore testing.

---

## Overview

The `BackupVerificationService` runs on a configurable schedule (default **every 6 hours**) and performs two sequential checks:

1. **Verification** – confirms the latest backup file exists, is recent enough, and (when a `manifest.json` is present) matches its SHA-256 checksum.
2. **Restore test** – restores the latest backup into a short-lived temporary PostgreSQL database, validates that at least one user table exists, then immediately drops the temp database.

Neither operation touches the production database.

---

## Backup Verification Process

1. Scan `BACKUP_DIR` for the most recently modified file.
2. Reject the file if it is older than `maxBackupAgeMs` (default 26 h — slightly beyond a 24 h backup window to absorb scheduling jitter).
3. If `manifest.json` is present in `BACKUP_DIR`, locate the entry matching the file name and compare the stored SHA-256 against a freshly computed digest. A missing entry is treated as **unverified but passing** (best-effort mode).
4. Record the outcome in `BackupStatus` and fire the injected Prometheus metric callbacks.

### `manifest.json` format

```json
[
  {
    "filename": "db_2026-07-17T00:00:00Z.dump",
    "sha256": "<hex-sha256>",
    "createdAt": "2026-07-17T00:00:00.000Z"
  }
]
```

The manifest should be written atomically by your backup creation script immediately after the dump completes.

---

## Restore Testing Workflow

1. Find the latest backup file (same logic as verification).
2. Create a temporary database: `backup_restore_test_<12-hex-chars>`.
3. Restore using `pg_restore` (custom-format `.dump`) or `psql` (plain `.sql`).
4. Verify the restore succeeded: query `information_schema.tables` and assert at least one user-defined table is present.
5. **Always** drop the temporary database — even when step 3 or 4 fails.

The temporary database is isolated from the production schema and uses an unguessable random suffix to prevent name collisions between concurrent runs.

---

## Configuration

| Env Var / Option | Default | Description |
|---|---|---|
| `BACKUP_DIR` | `/var/backups/postgres` | Directory containing backup files |
| `maxBackupAgeMs` | `93600000` (26 h) | Maximum acceptable backup age |
| `intervalMs` | `21600000` (6 h) | Verification schedule interval |
| `restoreTestEveryNCycles` | `1` | Run restore test on every Nth cycle |
| `adminDatabaseUrl` | `DATABASE_URL` | PostgreSQL admin connection string |

Override `BACKUP_DIR` by setting the environment variable before starting the server.

---

## Monitoring Metrics

All metrics are exposed on the standard `GET /metrics` (Prometheus scrape endpoint).

| Metric | Type | Description |
|---|---|---|
| `backup_last_backup_timestamp_seconds` | Gauge | Unix timestamp of the most recently detected backup file |
| `backup_last_verification_timestamp_seconds` | Gauge | Unix timestamp of the last successful verification |
| `backup_verification_status` | Gauge | `1` = last verification passed, `0` = failed or never run |
| `backup_verification_failures_total` | Counter | Cumulative verification failures since process start |
| `backup_last_restore_test_timestamp_seconds` | Gauge | Unix timestamp of the last restore test |
| `backup_restore_test_status` | Gauge | `1` = last restore test passed, `0` = failed or never run |
| `backup_restore_failures_total` | Counter | Cumulative restore test failures since process start |

### Health endpoint

```
GET /backup-health
```

Returns `200 OK` + JSON when the last verification passed, `503 Service Unavailable` otherwise.

```json
{
  "lastBackupTime": "2026-07-17T00:00:00.000Z",
  "lastVerificationTime": "2026-07-17T06:00:00.000Z",
  "lastVerificationOk": true,
  "lastRestoreTestTime": "2026-07-17T06:00:01.234Z",
  "lastRestoreTestOk": true,
  "verificationFailures": 0,
  "restoreFailures": 0
}
```

**Recommended alert:** fire a PagerDuty/OpsGenie alert when `backup_verification_status == 0` for more than 30 minutes, or when `backup_restore_failures_total` increases.

---

## Operational Procedures

### Manual verification trigger

Backup verification runs automatically. To trigger a manual cycle, restart the backend process — the first tick runs after the first `intervalMs` elapses. If you need an immediate run, expose `backupVerifier.tick()` via an admin route or run a one-off script:

```ts
const svc = new BackupVerificationService({ ... });
await svc.runVerification();
await svc.runRestoreTest();
```

### Adding a new backup file

1. Write the dump to `BACKUP_DIR`.
2. Compute its SHA-256: `sha256sum <file>`.
3. Append an entry to `manifest.json` (or replace the whole file atomically).

### Rotating old backups

Remove files from `BACKUP_DIR` on your own schedule. The service always selects the *most recently modified* file, so it will automatically pick up newer dumps.

---

## Security & Compliance

- Backup files are read-only from the service's perspective; it never writes to the backup directory.
- Symlinks are not followed (uses `lstat` / `statSync`).
- File paths are validated against `BACKUP_DIR` to prevent path-traversal.
- Temporary database names match `/^backup_restore_test_[0-9a-f]{12}$/`; any deviation is rejected before reaching `psql` (prevents injection).
- The restore test never touches the production schema.
- SHA-256 checksum validation preserves PCI-DSS and SOC2 data-integrity requirements for backup media.

---

## Tests

```bash
# Run only the backup verification unit tests
npx vitest run tests/unit/backup_verification.test.ts

# Run the full unit suite
npm test
```

Test coverage includes: successful verification, missing backup, stale backup, checksum mismatch, successful restore, restore failure (verifies temp DB is always dropped), monitoring counter accumulation.
