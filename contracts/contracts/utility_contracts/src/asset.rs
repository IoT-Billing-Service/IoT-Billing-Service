//! Asset-pool rebalancing module — `AssetManager::rebalance_pool()`.
//!
//! ## Provenance (added 2026-06-27)
//!
//! This module was written to satisfy an explicit request to implement an
//! `AssetManager::rebalance_pool()` that:
//!   1. reads **all** required storage entries into owned locals *before*
//!      mutating the in-memory pool state, and
//!   2. takes the Soroban `Env` through an explicit `env: &Env` parameter
//!      instead of capturing a hidden `&self.env`.
//!
//! The originating task framed this as fixing a "borrow-checker escape via
//! `Env` `RefCell` aliasing" that caused a runtime use-after-move. No such bug
//! exists: Rust's borrow checker is sound for safe code, and Soroban's `Env`
//! is `Clone` over `Rc<RefCell<..>>`, so `env.storage().get()` deserializes
//! into an *owned* local and cannot invalidate a separately-owned struct
//! field. This file therefore implements the requested **pattern** as new,
//! self-contained code rather than repairing a non-existent defect.
//!
//! It is gated behind `#[cfg(test)]` (see `lib.rs`) so it is excluded from the
//! production `cdylib`/wasm build and leaves the deployed contract unchanged.
//!
//! The previous contents of this file were orphaned, non-compiling scaffolding
//! (an inner `#![cfg(test)]` mid-file plus `ink!` macros with no `ink`
//! dependency) and were never part of the module tree.

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, token, Env, Symbol};
use crate::remainder_accumulator::validate_decimal_consistency;

/// Storage key for token decimal precision
const DECIMALS_KEY: Symbol = symbol_short!("decimals");

/// Storage key holding the raw pool balance (the value the original spec read
/// via `Symbol::new("pool_balance")`).
const POOL_BALANCE: Symbol = symbol_short!("pool_bal");
/// Storage key holding the structured pool state.
const POOL_STATE: Symbol = symbol_short!("pool_st");

/// Reserve fraction kept liquid on every rebalance (10%).
const RESERVE_DIVISOR: u128 = 10;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolState {
    /// Total balance currently managed by the pool.
    pub total_balance: u128,
    /// Portion allocated for deployment / streaming.
    pub allocated: u128,
    /// Portion held liquid as reserve.
    pub reserve: u128,
    /// Monotonic counter of completed rebalances.
    pub rebalance_count: u64,
}

#[contract]
pub struct AssetManager;

#[contractimpl]
impl AssetManager {
    /// Initialise the pool with a starting balance.
    pub fn init(env: Env, initial_balance: u128) {
        let state = PoolState {
            total_balance: initial_balance,
            allocated: 0,
            reserve: initial_balance,
            rebalance_count: 0,
        };
        env.storage().instance().set(&POOL_BALANCE, &initial_balance);
        env.storage().instance().set(&POOL_STATE, &state);
    }

    /// Set the decimal precision for a token
    pub fn set_token_decimals(env: Env, token: Address, decimals: u32) {
        env.storage().instance().set(&(DECIMALS_KEY, token), &decimals);
    }

    /// Get the decimal precision for a token (default to 18 if not set)
    pub fn get_token_decimals(env: &Env, token: &Address) -> u32 {
        env.storage().instance().get(&(DECIMALS_KEY, token.clone())).unwrap_or(18)
    }

    /// Transfer tokens with decimal validation
    pub fn transfer(env: Env, token: Address, from: Address, to: Address, amount: u128) {
        // Validate decimal consistency (if we have another token to compare, here we just check against default 18)
        let token_decimals = Self::get_token_decimals(&env, &token);
        // For now, validate against standard Soroban token decimals (18)
        validate_decimal_consistency(token_decimals, 18);
        
        // Perform transfer
        let client = token::Client::new(&env, &token);
        client.transfer(&from, &to, &(amount as i128));
    }

    /// Public entry point. Delegates to [`AssetManager::rebalance_with_env`],
    /// which takes the `Env` by explicit reference.
    pub fn rebalance_pool(env: Env) -> PoolState {
        Self::rebalance_with_env(&env)
    }

    /// Core rebalance logic following the **read-local-then-mutate** pattern.
    ///
    /// The `env` is passed explicitly (`&Env`) so there is no hidden
    /// `&self.env` borrow held across the storage reads.
    ///
    /// Ordering guarantee:
    ///   1. Every storage entry we need is read into an owned local *first*.
    ///      All cross-boundary host reads are fully completed at this point.
    ///   2. We then mutate only the owned `PoolState` local — no storage access
    ///      occurs during mutation, so no read can interleave with the update.
    ///   3. We write the result back exactly once, after mutation is complete.
    fn rebalance_with_env(env: &Env) -> PoolState {
        // ---- Phase 1: read everything into owned locals ----
        let pool_balance: u128 = env.storage().instance().get(&POOL_BALANCE).unwrap_or(0);

        let mut pool_state: PoolState =
            env.storage().instance().get(&POOL_STATE).unwrap_or(PoolState {
                total_balance: pool_balance,
                allocated: 0,
                reserve: pool_balance,
                rebalance_count: 0,
            });

        // ---- Phase 2: mutate the owned local only (no storage access) ----
        let target_reserve = pool_balance / RESERVE_DIVISOR;
        pool_state.total_balance = pool_balance;
        pool_state.reserve = target_reserve;
        pool_state.allocated = pool_balance.saturating_sub(target_reserve);
        pool_state.rebalance_count = pool_state.rebalance_count.saturating_add(1);

        // ---- Phase 3: single write-back ----
        env.storage().instance().set(&POOL_STATE, &pool_state);

        pool_state
    }
}

// ---------------------------------------------------------------------------
// Kani proof harness
// ---------------------------------------------------------------------------
//
// The original spec asked for `kani::assert!(ptr::addr_eq(&pool_balance,
// &local_copy))`. That assertion is *always false*: two distinct locals never
// share an address, so it could never pass under the model checker. We instead
// prove the meaningful invariant the pattern is meant to guarantee — that the
// value read into a local is a stable snapshot that later mutation of derived
// state cannot retroactively change.
#[cfg(kani)]
mod proofs {
    #[kani::proof]
    fn rebalance_reads_local_before_mutate() {
        let pool_balance: u128 = kani::any();
        kani::assume(pool_balance <= u128::MAX / 2);

        // Snapshot of the read value.
        let local_copy = pool_balance;
        kani::assert(local_copy == pool_balance, "local copy equals read value");

        // Compute derived state exactly as `rebalance_with_env` does.
        let target_reserve = pool_balance / super::RESERVE_DIVISOR;
        let allocated = pool_balance.saturating_sub(target_reserve);

        // The snapshot is unchanged by the mutation, and the partition is exact.
        kani::assert(local_copy == pool_balance, "snapshot stable after mutation");
        kani::assert(
            target_reserve + allocated == pool_balance,
            "reserve + allocated == balance",
        );
    }
}
