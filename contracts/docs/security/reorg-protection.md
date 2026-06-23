# Re-Organization Replay Protection (Issue #22)

## Threat

Per-device nonce counters are stored in contract state. When the Stellar
network undergoes a **re-organization** (re-org), the ledger sequence rolls
back and contract state reverts to an earlier ledger. The nonce counter resets
to its pre-re-org value, so a previously processed signed telemetry submission
can be **replayed** with its now-reused nonce. Signature verification still
passes (the signed data and nonce are unchanged), and the telemetry is billed a
second time — **double billing**.

- Stellar re-org depth: typically 1–2 ledgers, max observed 5.
- Anything reverted by the re-org (nonce counter, dedup maps) cannot, by
  itself, defend against the replay — it reverts too.

**Invariant to preserve:** each `(device_mac, nonce)` maps to **at most one**
billing action.

## Defence: confirmation-gated two-phase billing

The fix decouples *recording* telemetry from *billing* it, and finalizes
billing only once the submitting ledger is buried deeper than any expected
re-org. Implemented in `contracts/utility_contracts/src/nonce_sync.rs`.

### Phase 1 — `submit_billable_telemetry`

Validates the Ed25519 signature and nonce, then records the submission into a
per-device **pending queue**, stamped with the ledger sequence it was observed
at (`observed_seq`). It rejects:

- telemetry whose nonce is already **finalized** (`PastNonce`) —
  `NonceAlreadyProcessed`;
- a nonce already **pending** for the device — `NonceAlreadyProcessed`;
- telemetry claiming a ledger **ahead** of the current one —
  `TelemetryFromFutureLedger`.

Crucially, Phase 1 **bills nothing** and does **not** advance the durable nonce.

### Phase 2 — `finalize_confirmed_telemetry`

Processes only pending entries buried under at least `MIN_LEDGER_CONFIRMATIONS`
ledgers (`current_seq - observed_seq >= MIN_LEDGER_CONFIRMATIONS`, using
saturating subtraction so a sequence rollback yields "not confirmed" rather than
underflowing). For each confirmed entry it:

1. records `(device_mac, nonce)` in `PastNonce` (permanent dedup);
2. advances the device nonce monotonically;
3. emits a `BillingAction` that is now safe to charge.

Entries not yet deep enough stay queued. Re-running finalization is idempotent.

## Why this defeats the re-org replay

| Re-org reverts a… | Outcome |
|---|---|
| **Pending** (not-yet-finalized) entry | Nothing was billed, so resubmitting the telemetry is benign — it bills exactly once after it later confirms. |
| **Finalized** entry buried ≥ `MIN_LEDGER_CONFIRMATIONS` deep | A re-org shallower than the confirmation depth cannot roll it back; `PastNonce` remains and replay is rejected. |

The protection is fundamentally the **confirmation depth**: billing never
happens until the telemetry's ledger is too deep to be reverted by an expected
re-org. The `PastNonce` map is the fast dedup guard within that confirmed
window.

## Tuning `MIN_LEDGER_CONFIRMATIONS`

`MIN_LEDGER_CONFIRMATIONS` (default `3`, per the issue blueprint) is the single
safety/latency knob:

- It **must exceed the deepest re-org the network can produce**, or a finalized
  record could be rolled back and replayed.
- Stellar re-orgs are typically 1–2 ledgers; the **max observed is 5**.
  Operators who must be robust against the worst observed case should raise this
  to **6** (cover a depth-5 re-org). The default of 3 covers the typical case
  with low latency.
- Higher values are safer but delay billing finalization by that many ledgers
  (~5 s per Stellar ledger).

## Residual risk

A re-org **deeper** than `MIN_LEDGER_CONFIRMATIONS` can still revert a finalized
record. This is unavoidable for any on-chain scheme and is why the constant must
be set above the chain's worst-case re-org depth. Monitor `TFinal` events and
alert on re-orgs approaching the configured depth.

## Tests

See `contracts/utility_contracts/src/nonce_sync_tests.rs`
(`mod reorg_protection_tests`):

- `test_reorg_resubmission_rejected_after_finalization` — rolls the ledger back
  by 3 after finalization and asserts replay is rejected (blueprint step 4).
- `test_no_billing_before_confirmation_depth` — nothing is billed before the
  confirmation depth; bills exactly once after, idempotently.
- `test_future_dated_telemetry_rejected`, `test_duplicate_pending_nonce_rejected`.
- `test_confirmation_depth_logic`, `test_future_ledger_logic` — pure helpers,
  including the sequence-rollback (no-underflow) case.
