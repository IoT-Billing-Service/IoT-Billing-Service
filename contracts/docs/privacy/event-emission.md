# Privacy-Preserving Billing Event Emission (Issue #20)

## Threat

`finalize_billing_cycle` emitted a Soroban event with cleartext topics
`[Symbol("bill_finalized"), tenant_id]` and data fields `total_charge`,
`device_count`, `avg_rate`. **Every Soroban event is world-readable.** A
competitor operating as another tenant can subscribe to the contract's event
stream and read a rival's billing amounts — a revenue-data leak and a GDPR
Article 44 (data-minimization) problem.

**Invariant:** for any emitted event `e`, an observer can associate `e` with a
real `tenant_id` only if it already knows that tenant's secret (i.e. is the
tenant). Amounts are recoverable only by a holder of the blinding factor.

## Why naive "encryption" does not work on a public ledger

A public ledger has **no on-chain secrets**. Every storage entry and every event
datum is visible to all observers. The intuitive fix — "store a per-tenant
`tenant_secret` and encrypt the payload with it" — fails, because the same
competitor can read the secret from storage and decrypt. Any scheme that relies
on a key living on-chain provides **zero** confidentiality.

Two things *do* work, and both are implemented in
`contracts/utility_contracts/src/event_privacy.rs`:

## `PrivacyConfig`

```rust
pub struct PrivacyConfig {
    /// When false, finalize_billing_cycle records the commitment but emits no
    /// event at all — the strongest privacy posture.
    pub events_enabled: bool,
}
```

Stored per tenant at `DataKey::TenantPrivacyConfig(tenant)`, toggled by the
tenant via `set_events_enabled` (guarded by `tenant.require_auth()`). Defaults
to `true` (emit minimized events) when unset.

| Setting | Behaviour |
|---|---|
| `events_enabled = true` (default) | Emit a **minimized** event: opaque handle topic + hiding commitment. No cleartext tenant_id or amounts. |
| `events_enabled = false` | Emit **nothing**. The commitment is still recorded in storage for the tenant's own audit. |

## Data minimization + hiding commitments

`finalize_billing_cycle` never emits or stores `tenant_id`, `total_charge`,
`device_count`, or `avg_rate` in cleartext. Instead:

- **Opaque tenant handle** (event topic):
  `sha256(HANDLE_DOMAIN || tenant_xdr || tenant_secret)`. Only a holder of
  `tenant_secret` can reproduce it or correlate it to the real tenant. The
  secret is supplied per call and **never written to storage**.
- **Hiding commitment** (event data + stored record):
  `sha256(COMMIT_DOMAIN || total_charge || device_count || avg_rate || blinding)`.
  The `blinding` factor is high-entropy, caller-supplied, and **never persisted
  on-chain**. Without it an observer cannot confirm a guessed amount, even
  knowing the full set of possible amounts.

Domain-separation tags (`HANDLE_DOMAIN`, `COMMIT_DOMAIN`) ensure the two
preimage families can never collide. This reuses the existing
`generate_commitment` idiom already present in `lib.rs`.

### Opening / audit

A tenant (or an auditor the tenant chooses to share the opening with) verifies a
commitment off-chain by calling `verify_billing_commitment(summary, blinding,
commitment)`, which recomputes the commitment and compares. This gives
selective, tenant-controlled disclosure without leaking to the public.

## Properties

- An observer cannot recover `tenant_id` from a handle (needs the tenant
  secret).
- An observer cannot recover or confirm `total_charge` from a commitment (needs
  the blinding).
- Two tenants charged the **same** amount produce **different** commitments
  (distinct blindings), so charges are not even linkable by equality.
- A tenant can opt out of emission entirely.

## Residual considerations

- **Handle linkability:** a fixed `(tenant, secret)` yields a stable handle, so
  an observer can group a single tenant's events together (without learning who
  the tenant is). Rotate the secret per cycle if unlinkability across events is
  required.
- **Blinding management:** the tenant must retain `blinding` (and `tenant_secret`)
  off-chain to later open commitments. Losing them makes a commitment
  unopenable (but still private).
- **Metadata:** transaction-level metadata (who invoked the contract, when) is
  still public at the ledger level; this module addresses event-payload leakage,
  not transaction-graph analysis.

## Tests

`contracts/utility_contracts/src/event_privacy_tests.rs`:

- `test_tenant_a_cannot_decode_tenant_b` — Tenant A cannot open Tenant B's
  commitment without B's blinding, even guessing the exact figures; the
  legitimate opening verifies (blueprint step 5).
- `test_equal_amounts_produce_unlinkable_commitments`.
- `test_events_can_be_disabled_per_tenant`.

Pure preimage-spec unit tests live in `event_privacy.rs` (`mod tests`).
