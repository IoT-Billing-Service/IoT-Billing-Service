# Issue #272 — Audit Trail with Tamper-Evident Hash Chain Verification

## What was already there

Before touching anything I checked the actual repo. The **write side** of
this feature already existed and is wired into billing operations:
`backend/src/security/audit_logger.ts` (`AuditLogger.logTransaction`)
already appends SHA-256 hash-chained, Ed25519-signed entries per entity, and
`payment_channel.ts`, `finalizer.ts`, `reconciliation_service.ts`, and
`settlement_cron.ts` already call it.

What was genuinely missing — and is what issue #272's title actually calls
for — is **verification**: nothing in the codebase walked the chain to
detect tampering, and there was no way for an external auditor to check a
signature independently. That's the real gap this fills.

## What this adds

### 1. A real bug fix: canonical JSON hashing
`logTransaction` computed each entry's hash from `JSON.stringify(payload)`.
`payload` is stored as Postgres JSONB via Prisma, and JSONB is not
guaranteed to preserve JS object key insertion order on read-back. That
means a naive re-`JSON.stringify()` at verification time can produce a
**different** string — and therefore a different hash — than the one
computed at write time, for an entry that was never tampered with. That's a
false positive in exactly the mechanism this feature exists to provide.

Fixed by adding `canonicalJson()` (recursively sorts object keys before
serializing) and using it on **both** the write path (`logTransaction`) and
the new read/verify path, so hashing is deterministic regardless of how the
JSON round-trips through storage. Flagged here explicitly because it's a
behavior change: entries logged before this change used the old
non-canonical serialization, so their historical hashes may not
re-verify cleanly if their payload's key order didn't already happen to be
sorted. That's a one-time migration/backfill conversation for whoever owns
this in production, not something a PR should paper over silently.

### 2. Chain verification (`AuditLogger.verifyEntityChain`)
Walks one entity's chain oldest → newest and checks, per entry: the
`previousHash` link, the recomputed SHA-256 hash, and the Ed25519 signature.
Stops at the first failure and reports exactly where (`brokenAtIndex`) and
why (`broken_link` / `hash_mismatch` / `invalid_signature`).

### 3. Integrity scanning (`AuditLogger.runIntegrityScan`)
Verifies every distinct entity's chain in one pass — meant to be triggered
by a periodic monitoring job (issue's step 3, "deploy with monitoring"),
not called on the hot billing path.

### 4. Public key exposure (`AuditLogger.getPublicKeyHex`)
Derives and exposes the Ed25519 public key so external auditors can verify
signatures independently, without trusting this service's own verification
code — the actual point of using asymmetric signatures for a PCI-DSS/SOC2
audit trail rather than just an HMAC.

### 5. New API routes — `backend/src/api/routes/audit.ts`
- `GET  /api/v1/audit/public-key` — unauthenticated (public keys are meant
  to be public)
- `GET  /api/v1/audit/:entityType/:entityId/verify` — admin-gated
  (`X-Admin-Key`, same convention as `admin.ts`/`incident_response`)
- `GET  /api/v1/audit/:entityType/:entityId` — full chain export,
  admin-gated
- `POST /api/v1/audit/scan` — full integrity scan, admin-gated

Registered in `backend/src/api/index.ts`.

### 6. Tests — `backend/tests/unit/security/audit_logger.test.ts`
Extended the existing file (didn't touch the 3 tests already there) with:
an in-memory fake Prisma store so the new tests exercise the real
hash/sign/verify code path end-to-end instead of hand-computing expected
hashes; a valid multi-entry chain; empty-chain edge case; tampered-payload
detection; broken-link detection; invalid-signature detection;
`runIntegrityScan` aggregation across multiple entities; public key format;
and a dedicated `canonicalJson` test proving key-order independence (the
direct regression test for the bug fix in #1).

## Files changed

- **MODIFIED** `backend/src/security/audit_logger.ts`
- **NEW** `backend/src/api/routes/audit.ts`
- **MODIFIED** `backend/src/api/index.ts` (route registration only — 2 lines)
- **MODIFIED** `backend/tests/unit/security/audit_logger.test.ts` (appended only)

## ⚠️ Not run — no network access in my environment

I don't have npm registry access in this sandbox (`npm install` fails with
403), so I could not run `vitest` against this. Everything above is a
careful manual review against the existing code and its own test
conventions, not a compiler/test-runner-verified result. You need to
actually run it before trusting it.

## How to verify locally

```
cd backend
npm install
npx vitest run tests/unit/security/audit_logger.test.ts
npx tsc --noEmit
```

If either fails, **paste me the exact error output** — don't try to debug
it yourself.
