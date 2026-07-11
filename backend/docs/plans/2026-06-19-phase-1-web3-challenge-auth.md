# Web3 Challenge-Response Auth (Issue #6)

## Goal
Replace the in-memory `Map` challenge store in `src/api/auth/session.ts` with a scalable, Redis-backed, cryptographically-verified Stellar challenge-response auth flow.

## Invariants
- Challenge: 32 random bytes, hex-encoded (64 chars)
- Challenge TTL: 300s (configurable via `CHALLENGE_TTL_SECONDS`)
- JWT TTL: 15m (via `JWT_EXPIRES_IN`)
- Single-use nonces (atomic `GETDEL`)
- `SET EX NX` to prevent challenge flooding per wallet
- 100 challenges/sec target; <10ms response
- No fakes/stubs in tests — real tweetnacl, real @stellar/stellar-sdk Keypair, real Redis

## Crypto contract
- Challenge = `crypto.randomBytes(32)` → hex (64 chars)
- Client signs the **raw 32 bytes** (decoded from hex) with Ed25519
- Signature sent hex-encoded (128 chars)
- Server decodes public key from Stellar `G…` address via `StrKey.decodeEd25519PublicKey`
- Verify with `nacl.sign.detached.verify(nonceBytes, sigBytes, pubBytes)`

## Phase A — pure crypto (unit tests, no Redis)
- `src/api/auth/session.ts` exports pure helpers:
  - `generateNonce()` → 64-char hex (32 bytes)
  - `isValidStellarAddress(addr)` → boolean
  - `decodeStellarPublicKey(addr)` → Uint8Array (32 bytes)
  - `verifyEd25519Signature(nonceHex, sigHex, pubBytes)` → boolean
- `tests/unit/auth.test.ts` covers: nonce format, StrKey accept/reject, real `Keypair.random()` sign→verify, tampered→false, wrong key→false

## Phase B — Redis challenge store + JWT
- `src/config/env.ts`: add `CHALLENGE_TTL_SECONDS` (default 300)
- `.env.example`: add `CHALLENGE_TTL_SECONDS=300`
- `src/database/redis.ts` (new): `getRedis()`/`closeRedis()` singleton
- `src/api/auth/session.ts`: `ChallengeStore` (SET EX NX create, GETDEL consume)
  - `generateChallenge(wallet)` → `{nonce, expiresAt}` or `null` if pending
  - `verifyChallenge(wallet, sig)` → async boolean
  - Keep `issueSessionToken` / `verifySessionToken` (JWT)

## Phase C — routes + middleware
- `src/api/middleware/auth.ts` (new): `verifyJwt` preHandler + `request.session` augmentation
- `src/api/routes/auth.ts` (new): `registerAuthRoutes`
  - `POST /api/auth/challenge` `{walletAddress}` → `{nonce, expiresAt}`; pending→409; invalid→400
  - `POST /api/auth/verify` `{walletAddress, signature}` → `{token, expiresIn}`; invalid→401
  - `GET /api/auth/me` (preHandler `verifyJwt`) → session payload
- `src/api/index.ts`: register auth routes in `buildApp()`

## Phase D — integration tests
- `tests/integration/auth.test.ts`: full cycle via `buildApp()` + `app.inject()` + real Redis + `Keypair.random()`
- Skips gracefully when Redis unavailable (mirrors `lock_manager.test.ts` pattern)
- Covers: challenge→verify→JWT→/me; bad sig→401; replay→401; missing→401; invalid addr→400; pending→409

## Phase E — CI
- `.github/workflows/ci.yml` `integration-tests` job:
  - Add `redis:7` service (healthcheck `redis-cli ping`)
  - Add `SOROBAN_NETWORK_PASSPHRASE` env (pre-existing gap surfaced)

## Files
- New: `src/database/redis.ts`, `src/api/middleware/auth.ts`, `src/api/routes/auth.ts`, `tests/unit/auth.test.ts`, `tests/integration/auth.test.ts`
- Modified: `src/config/env.ts`, `.env.example`, `src/api/auth/session.ts`, `src/api/index.ts`, `.github/workflows/ci.yml`, `package.json`, `package-lock.json`

## Verify
`npm run lint` · `npm run format` · `npm run typecheck` · `npm test` · `npm run test:integration` · `npm run build`

## Unresolved questions
None.

## Next steps
Execute TDD: Phase A (RED→GREEN) → B → C → D → E → verify suite → commit.
