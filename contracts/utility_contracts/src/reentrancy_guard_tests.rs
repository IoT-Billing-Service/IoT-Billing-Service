#![cfg(test)]

//! Issue #15: reentrancy-guard tests. (The blueprint names `pause_resume_tests.rs`,
//! but these tests are cohesive enough to live in their own module.)
//!
//! Soroban has no storage-update hook to register, so the attack is reproduced
//! the realistic way: a guarded frame that re-enters a guarded entry point must
//! trip `ReentrancyDetected` before any balance moves.

extern crate std;

use crate::reentrancy_guard::{GuardedAsset, GuardedAssetClient};
use soroban_sdk::{testutils::Address as _, Address, BytesN, Env};

fn setup() -> (Env, GuardedAssetClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register_contract(None, GuardedAsset);
    let client = GuardedAssetClient::new(&env, &id);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    (env, client, alice, bob)
}

/// A normal, single-frame transfer succeeds and conserves balances.
#[test]
fn test_normal_transfer_succeeds() {
    let (_env, client, alice, bob) = setup();
    client.set_balance(&alice, &1_000);

    assert!(client.try_transfer(&alice, &bob, &400).is_ok());
    assert_eq!(client.balance_of(&alice), 600);
    assert_eq!(client.balance_of(&bob), 400);
}

/// Transfer rejects an amount exceeding the sender's balance (the invariant).
#[test]
fn test_transfer_rejects_insufficient_balance() {
    let (_env, client, alice, bob) = setup();
    client.set_balance(&alice, &100);
    assert!(client.try_transfer(&alice, &bob, &101).is_err());
    // No partial movement.
    assert_eq!(client.balance_of(&alice), 100);
    assert_eq!(client.balance_of(&bob), 0);
}

/// Blueprint step 4: a re-entrant transfer trips the guard before completing —
/// the balance is never moved.
#[test]
fn test_reentrancy_is_detected() {
    let (_env, client, alice, bob) = setup();
    client.set_balance(&alice, &1_000);

    let res = client.try_simulate_reentrant_transfer(&alice, &bob, &500);
    assert!(res.is_err(), "re-entrant transfer must trip the guard");

    // The attack moved nothing.
    assert_eq!(client.balance_of(&alice), 1_000);
    assert_eq!(client.balance_of(&bob), 0);
}

/// Cross-function reentry is rejected too: an untrusted callback cannot enter
/// `transfer` while another guarded public function frame is active.
#[test]
fn test_cross_function_reentrancy_is_detected() {
    let (_env, client, alice, bob) = setup();
    client.set_balance(&alice, &1_000);

    let res = client.try_simulate_cross_function_reentry(&alice, &bob, &500);
    assert!(
        res.is_err(),
        "cross-function reentry must trip the shared guard"
    );

    assert_eq!(client.balance_of(&alice), 1_000);
    assert_eq!(client.balance_of(&bob), 0);
}

/// A cross-contract adapter can bind an outbound call to a context id and then
/// require the callee to echo that id before accepting returned side effects.
#[test]
fn test_call_context_echo_must_match_active_frame() {
    let (env, client, _alice, _bob) = setup();
    let expected = BytesN::from_array(&env, &[7; 32]);
    let wrong = BytesN::from_array(&env, &[9; 32]);

    assert!(client.context_matches(&expected));
    assert!(!client.context_mismatch(&expected, &wrong));
}

/// The guard is released after each call, so sequential transfers all succeed
/// (no leaked guard bricking the contract).
#[test]
fn test_guard_released_between_calls() {
    let (_env, client, alice, bob) = setup();
    client.set_balance(&alice, &1_000);

    for _ in 0..3 {
        assert!(client.try_transfer(&alice, &bob, &100).is_ok());
    }
    assert_eq!(client.balance_of(&alice), 700);
    assert_eq!(client.balance_of(&bob), 300);
}
