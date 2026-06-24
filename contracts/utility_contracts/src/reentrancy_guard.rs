//! Issue #15: reusable reentrancy guard.
//!
//! ## The threat
//!
//! The reported vector (a Soroban "data-update hook" re-entering `transfer`
//! during a `balance_of` read) does not exist as described — Soroban has no
//! `set_data_update_hook` / `on_storage_update` callback, and storage reads do
//! not call back into the contract. **However**, the underlying class of bug —
//! a public function re-entered while an earlier frame holds a stale in-memory
//! read of a balance — is real for any contract that performs an external call
//! (e.g. a token `transfer`/`require_auth` into a malicious contract) between
//! reading a balance and committing the state change.
//!
//! The existing guards in `lib.rs` are per-key booleans whose cleanup is
//! duplicated on every error/panic path (easy to forget, and a leaked guard
//! bricks the stream). This module provides one reusable, RAII counter guard:
//!
//! - [`ReentrancyGuard::enter`] increments a per-invocation counter and **panics
//!   with `ReentrancyDetected` if the counter is already ≥ 1** (reentry).
//! - The guard **decrements on `Drop`**, so it is released on *every* exit path
//!   — early return, `?`, or panic-unwind — with no manual cleanup.
//!
//! Invariant: at most one guarded frame is active at a time, so a balance read
//! taken under the guard cannot be invalidated by a re-entrant mutation before
//! the commit.

use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, Map, Symbol};

use crate::ContractError;

/// Instance-storage key holding the active guard depth.
const GUARD_KEY: Symbol = symbol_short!("reentry");

// ---------------------------------------------------------------------------
// Pure transition (unit-tested without an Env)
// ---------------------------------------------------------------------------

/// The guard depth permitted on entry: `Ok(current + 1)` for the first frame,
/// `Err(())` once a frame is already active (reentry).
pub fn next_on_enter(current: u32) -> Result<u32, ()> {
    if current >= 1 {
        Err(())
    } else {
        Ok(current + 1)
    }
}

// ---------------------------------------------------------------------------
// Storage-backed counter
// ---------------------------------------------------------------------------

fn load_depth(env: &Env) -> u32 {
    env.storage().instance().get(&GUARD_KEY).unwrap_or(0)
}

fn store_depth(env: &Env, depth: u32) {
    if depth == 0 {
        env.storage().instance().remove(&GUARD_KEY);
    } else {
        env.storage().instance().set(&GUARD_KEY, &depth);
    }
}

/// RAII reentrancy guard. Hold it for the duration of a guarded public function;
/// it releases automatically when dropped.
pub struct ReentrancyGuard<'a> {
    env: &'a Env,
}

impl<'a> ReentrancyGuard<'a> {
    /// Enter a guarded frame. Panics with [`ContractError::ReentrancyDetected`]
    /// if another guarded frame is already active.
    pub fn enter(env: &'a Env) -> Self {
        match next_on_enter(load_depth(env)) {
            Ok(depth) => {
                store_depth(env, depth);
                ReentrancyGuard { env }
            }
            Err(()) => {
                soroban_sdk::panic_with_error!(env, ContractError::ReentrancyDetected);
            }
        }
    }

    /// Whether a guarded frame is currently active (for assertions/diagnostics).
    pub fn is_active(env: &Env) -> bool {
        load_depth(env) >= 1
    }
}

impl Drop for ReentrancyGuard<'_> {
    fn drop(&mut self) {
        let depth = load_depth(self.env);
        store_depth(self.env, depth.saturating_sub(1));
    }
}

// ---------------------------------------------------------------------------
// Demonstration: a guarded balance/transfer asset
// ---------------------------------------------------------------------------

/// Balances key (instance storage `Map<Address, i128>`).
const BAL_KEY: Symbol = symbol_short!("bal");

/// A minimal asset whose public entry points are reentrancy-guarded. Models the
/// `asset.rs` `balance_of`/`transfer` pair the issue describes, but with the
/// guard so a balance read can never be invalidated by a re-entrant transfer
/// before commit.
#[contract]
pub struct GuardedAsset;

#[contractimpl]
impl GuardedAsset {
    /// Seed/overwrite a balance (guarded).
    pub fn set_balance(env: Env, who: Address, amount: i128) {
        let _guard = ReentrancyGuard::enter(&env);
        let mut balances = Self::balances(&env);
        balances.set(who, amount);
        Self::store_balances(&env, &balances);
    }

    /// Guarded public balance read. Holding the guard means no re-entrant frame
    /// can mutate state while a caller is acting on this read.
    pub fn balance_of(env: Env, who: Address) -> i128 {
        let _guard = ReentrancyGuard::enter(&env);
        Self::read_balance(&env, &who)
    }

    /// Guarded transfer. Reads `from`'s balance and commits the debit/credit
    /// within a single guarded frame, so the `balance_of(sender) >= amount`
    /// check cannot be bypassed by reentry.
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) -> Result<(), ContractError> {
        let _guard = ReentrancyGuard::enter(&env);
        from.require_auth();

        if amount <= 0 {
            return Err(ContractError::InvalidTokenAmount);
        }
        let from_balance = Self::read_balance(&env, &from);
        if from_balance < amount {
            return Err(ContractError::InsufficientCollateral);
        }
        let to_balance = Self::read_balance(&env, &to);

        let mut balances = Self::balances(&env);
        balances.set(from, from_balance - amount);
        balances.set(to, to_balance + amount);
        Self::store_balances(&env, &balances);
        Ok(())
    }

    /// Test/diagnostic: simulate the attack. Holds a guarded frame (as if mid
    /// `balance_of`) then attempts a `transfer`, which must trip the guard and
    /// panic with `ReentrancyDetected` before any balance is moved.
    pub fn simulate_reentrant_transfer(env: Env, from: Address, to: Address, amount: i128) {
        let _outer = ReentrancyGuard::enter(&env);
        // Re-entering a guarded entry point panics with ReentrancyDetected.
        let _ = Self::transfer(env.clone(), from, to, amount);
    }
}

impl GuardedAsset {
    fn balances(env: &Env) -> Map<Address, i128> {
        env.storage()
            .instance()
            .get(&BAL_KEY)
            .unwrap_or_else(|| Map::new(env))
    }

    fn store_balances(env: &Env, balances: &Map<Address, i128>) {
        env.storage().instance().set(&BAL_KEY, balances);
    }

    fn read_balance(env: &Env, who: &Address) -> i128 {
        Self::balances(env).get(who.clone()).unwrap_or(0)
    }
}

// ---------------------------------------------------------------------------
// Pure-logic unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_entry_is_allowed() {
        assert_eq!(next_on_enter(0), Ok(1));
    }

    #[test]
    fn reentry_is_rejected() {
        assert_eq!(next_on_enter(1), Err(()));
        assert_eq!(next_on_enter(2), Err(()));
        assert_eq!(next_on_enter(u32::MAX), Err(()));
    }
}
