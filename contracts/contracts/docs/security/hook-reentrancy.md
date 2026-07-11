# Storage-Hook Reentrancy & the Reentrancy Guard (Issue #15)

## The reported vector vs. reality

The issue describes a Soroban "data-update hook" (`env.set_data_update_hook`,
`on_storage_update`, `ContractDataUpdateHook`) that the host invokes on every
storage read, letting an attacker re-enter `transfer` during a `balance_of`
read. **This callback mechanism does not exist in Soroban**: storage reads
(`env.storage().*.get`) do not call back into the contract, and there is no
host-registered data-update hook. So the specific hook attack is not reproducible.

## The real class of bug it points at

The underlying concern — a public function re-entered while an earlier frame
holds a stale in-memory balance read — **is** real for any contract that makes
an external call between reading a balance and committing the state change. The
classic Soroban form is a token `transfer` (or an attacker-controlled
`require_auth`/cross-contract call) that re-enters the calling contract before
its balance debit is committed, bypassing `balance_of(sender) >= amount`.

**Invariant:** for any `transfer(tx)`, `balance_of(sender) >= tx.amount` holds at
commit time.

## Mitigation: a reusable RAII reentrancy guard (`reentrancy_guard.rs`)

The codebase already had per-key boolean guards, but their cleanup is duplicated
on every error/panic path — easy to forget, and a leaked guard permanently
bricks the entity. This module replaces that pattern with one reusable guard:

- `ReentrancyGuard::enter(env)` increments a per-invocation depth counter and
  **panics with `ReentrancyDetected` if a guarded frame is already active**.
- The guard **decrements on `Drop`**, so it is released on every exit path —
  early return, `?`, or panic-unwind — with no manual cleanup.

`GuardedAsset` demonstrates the pattern: `balance_of`, `transfer`, and
`set_balance` each `enter` the guard, so a balance read taken inside a frame
cannot be invalidated by a re-entrant mutation before commit. Internal reads
(`read_balance`) are unguarded to avoid self-deadlock; only public entry points
take the guard.

## On the blueprint's `#[cfg(not(feature = "hooks"))]` step

There is no `on_storage_update` hook to feature-gate, so step 3 is not
applicable. The guard is the real, sufficient defense for the reentrancy class
the issue is concerned with, regardless of how a re-entrant frame is triggered
(token callback, cross-contract call, or auth callback).

## Tests

`reentrancy_guard_tests.rs`:
- `test_normal_transfer_succeeds` / `test_transfer_rejects_insufficient_balance`
  — the balance invariant holds on the happy and rejection paths.
- `test_reentrancy_is_detected` — a frame that re-enters `transfer` trips the
  guard and moves no balance (blueprint step 4).
- `test_guard_released_between_calls` — sequential calls all succeed (no leaked
  guard).

Pure-logic unit tests for the entry transition live in `reentrancy_guard.rs`.
