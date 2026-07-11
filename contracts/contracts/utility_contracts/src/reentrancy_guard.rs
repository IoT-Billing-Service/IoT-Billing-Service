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

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, BytesN, Env, Map, Symbol, Vec,
};

use crate::ContractError;

const DEFAULT_FUNC: Symbol = symbol_short!("guard");
const MAX_CALL_DEPTH: u32 = 10;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum GuardKey {
    Depth,
    FunctionLock(Symbol),
    Stack,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GuardFrame {
    pub function: Symbol,
    pub context_id: BytesN<32>,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum GuardEntryError {
    ReentrantFrame,
    CallDepthExceeded,
    FunctionCycle,
}

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

pub fn validate_entry(
    current_depth: u32,
    stack_len: u32,
    function_already_active: bool,
) -> Result<u32, GuardEntryError> {
    if current_depth >= 1 {
        return Err(GuardEntryError::ReentrantFrame);
    }
    if stack_len >= MAX_CALL_DEPTH {
        return Err(GuardEntryError::CallDepthExceeded);
    }
    if function_already_active {
        return Err(GuardEntryError::FunctionCycle);
    }
    Ok(current_depth + 1)
}

// ---------------------------------------------------------------------------
// Storage-backed counter
// ---------------------------------------------------------------------------

fn load_depth(env: &Env) -> u32 {
    env.storage().instance().get(&GuardKey::Depth).unwrap_or(0)
}

fn store_depth(env: &Env, depth: u32) {
    if depth == 0 {
        env.storage().instance().remove(&GuardKey::Depth);
    } else {
        env.storage().instance().set(&GuardKey::Depth, &depth);
    }
}

fn empty_context(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0; 32])
}

fn load_stack(env: &Env) -> Vec<GuardFrame> {
    env.storage()
        .instance()
        .get(&GuardKey::Stack)
        .unwrap_or_else(|| Vec::new(env))
}

fn store_stack(env: &Env, stack: &Vec<GuardFrame>) {
    if stack.is_empty() {
        env.storage().instance().remove(&GuardKey::Stack);
    } else {
        env.storage().instance().set(&GuardKey::Stack, stack);
    }
}

fn function_is_locked(env: &Env, function: &Symbol) -> bool {
    env.storage()
        .instance()
        .get::<_, bool>(&GuardKey::FunctionLock(function.clone()))
        .unwrap_or(false)
}

fn set_function_lock(env: &Env, function: &Symbol, locked: bool) {
    let key = GuardKey::FunctionLock(function.clone());
    if locked {
        env.storage().instance().set(&key, &true);
    } else {
        env.storage().instance().remove(&key);
    }
}

fn stack_contains_function(stack: &Vec<GuardFrame>, function: &Symbol) -> bool {
    stack.iter().any(|frame| frame.function == *function)
}

/// RAII reentrancy guard. Hold it for the duration of a guarded public function;
/// it releases automatically when dropped.
pub struct ReentrancyGuard<'a> {
    env: &'a Env,
    function: Symbol,
}

impl<'a> ReentrancyGuard<'a> {
    /// Enter a guarded frame. Panics with [`ContractError::ReentrancyDetected`]
    /// if another guarded frame is already active.
    pub fn enter(env: &'a Env) -> Self {
        Self::enter_function_with_context(env, DEFAULT_FUNC, empty_context(env))
    }

    /// Enter a guarded public function frame using the function symbol as a
    /// discriminator in the lock namespace and call stack.
    pub fn enter_function(env: &'a Env, function: Symbol) -> Self {
        Self::enter_function_with_context(env, function, empty_context(env))
    }

    /// Enter a guarded public function frame with an explicit call-context id.
    /// The context id is stored in the pending frame so cross-contract call
    /// adapters can verify that an echoed return context matches the active
    /// frame before accepting side effects.
    pub fn enter_function_with_context(
        env: &'a Env,
        function: Symbol,
        context_id: BytesN<32>,
    ) -> Self {
        let mut stack = load_stack(env);
        let current_depth = load_depth(env);
        let function_already_active =
            function_is_locked(env, &function) || stack_contains_function(&stack, &function);

        match validate_entry(current_depth, stack.len(), function_already_active) {
            Ok(depth) => {
                store_depth(env, depth);
                set_function_lock(env, &function, true);
                stack.push_back(GuardFrame {
                    function: function.clone(),
                    context_id,
                });
                store_stack(env, &stack);
                ReentrancyGuard { env, function }
            }
            Err(_) => {
                soroban_sdk::panic_with_error!(env, ContractError::ReentrancyDetected);
            }
        }
    }

    /// Whether a guarded frame is currently active (for assertions/diagnostics).
    pub fn is_active(env: &Env) -> bool {
        load_depth(env) >= 1
    }

    /// Return the active call-context id, if a guarded frame is currently held.
    pub fn current_context_id(env: &Env) -> Option<BytesN<32>> {
        let stack = load_stack(env);
        stack
            .get(stack.len().checked_sub(1)?)
            .map(|frame| frame.context_id)
    }

    /// Verify that an echoed cross-contract call-context id matches the pending
    /// top frame.
    pub fn verify_current_context(env: &Env, echoed_context_id: &BytesN<32>) -> bool {
        Self::current_context_id(env)
            .map(|context_id| context_id == *echoed_context_id)
            .unwrap_or(false)
    }
}

impl Drop for ReentrancyGuard<'_> {
    fn drop(&mut self) {
        let depth = load_depth(self.env);
        store_depth(self.env, depth.saturating_sub(1));
        set_function_lock(self.env, &self.function, false);

        let mut stack = load_stack(self.env);
        if !stack.is_empty() {
            let _ = stack.pop_back();
        }
        store_stack(self.env, &stack);
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
        let _guard = ReentrancyGuard::enter_function(&env, symbol_short!("set_bal"));
        let mut balances = Self::balances(&env);
        balances.set(who, amount);
        Self::store_balances(&env, &balances);
    }

    /// Guarded public balance read. Holding the guard means no re-entrant frame
    /// can mutate state while a caller is acting on this read.
    pub fn balance_of(env: Env, who: Address) -> i128 {
        let _guard = ReentrancyGuard::enter_function(&env, symbol_short!("balance"));
        Self::read_balance(&env, &who)
    }

    /// Guarded transfer. Reads `from`'s balance and commits the debit/credit
    /// within a single guarded frame, so the `balance_of(sender) >= amount`
    /// check cannot be bypassed by reentry.
    pub fn transfer(
        env: Env,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), ContractError> {
        let _guard = ReentrancyGuard::enter_function(&env, symbol_short!("transfer"));
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
        let _outer = ReentrancyGuard::enter_function(&env, symbol_short!("balance"));
        // Re-entering a guarded entry point panics with ReentrancyDetected.
        let _ = Self::transfer(env.clone(), from, to, amount);
    }

    /// Test/diagnostic: holds one guarded public function frame and attempts to
    /// enter a different guarded public function. This models cross-function
    /// callback reentry from an untrusted contract.
    pub fn simulate_cross_function_reentry(env: Env, from: Address, to: Address, amount: i128) {
        let _outer = ReentrancyGuard::enter_function(&env, symbol_short!("another"));
        let _ = Self::transfer(env.clone(), from, to, amount);
    }

    pub fn context_matches(env: Env, context_id: BytesN<32>) -> bool {
        let _guard = ReentrancyGuard::enter_function_with_context(
            &env,
            symbol_short!("context"),
            context_id.clone(),
        );
        ReentrancyGuard::verify_current_context(&env, &context_id)
    }

    pub fn context_mismatch(env: Env, expected: BytesN<32>, echoed: BytesN<32>) -> bool {
        let _guard =
            ReentrancyGuard::enter_function_with_context(&env, symbol_short!("context"), expected);
        ReentrancyGuard::verify_current_context(&env, &echoed)
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

    #[test]
    fn validate_entry_rejects_active_frame_depth_and_cycles() {
        assert_eq!(validate_entry(0, 0, false), Ok(1));
        assert_eq!(
            validate_entry(1, 0, false),
            Err(GuardEntryError::ReentrantFrame)
        );
        assert_eq!(
            validate_entry(0, MAX_CALL_DEPTH, false),
            Err(GuardEntryError::CallDepthExceeded)
        );
        assert_eq!(
            validate_entry(0, 0, true),
            Err(GuardEntryError::FunctionCycle)
        );
    }
}
