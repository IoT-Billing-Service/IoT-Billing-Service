#![cfg(test)]

//! Issue #19: permutation-determinism tests for telemetry billing.
//!
//! Asserts the invariant `billing(E) = billing(π(E))` for every permutation of
//! a cycle's events, and confirms (via two contract instances fed the same
//! events in different orders) that the on-chain rollup agrees.

extern crate std;

use crate::telemetry_billing::{
    billing_cycle_rollup_units, naive_sequential_charge, TelemetryBilling, TelemetryBillingClient,
};
use soroban_sdk::{testutils::Address as _, Address, Env};
use std::vec::Vec;

/// Lexicographic next-permutation over indices; returns false when the sequence
/// is the last (descending) permutation.
fn next_permutation(a: &mut [usize]) -> bool {
    if a.len() < 2 {
        return false;
    }
    let mut i = a.len() - 1;
    while i > 0 && a[i - 1] >= a[i] {
        i -= 1;
    }
    if i == 0 {
        return false;
    }
    let mut j = a.len() - 1;
    while a[j] <= a[i - 1] {
        j -= 1;
    }
    a.swap(i - 1, j);
    a[i..].reverse();
    true
}

/// Blueprint step 4: all 8! = 40,320 permutations of 8 events produce an
/// identical bill.
#[test]
fn test_all_permutations_of_eight_events_are_equal() {
    // Mix of values that straddle the 1000-unit tier boundary — the worst case
    // for the old order-sensitive model.
    let units: [i128; 8] = [300, 1200, 50, 800, 1500, 10, 999, 400];
    let (t1, t2) = (1i128, 3i128);

    let expected = billing_cycle_rollup_units(&units, t1, t2);

    let mut idx: [usize; 8] = [0, 1, 2, 3, 4, 5, 6, 7];
    let mut perms = 0u64;
    loop {
        let permuted: Vec<i128> = idx.iter().map(|&i| units[i]).collect();
        assert_eq!(
            billing_cycle_rollup_units(&permuted, t1, t2),
            expected,
            "permutation {:?} produced a different bill",
            idx
        );
        perms += 1;
        if !next_permutation(&mut idx) {
            break;
        }
    }
    assert_eq!(perms, 40_320, "should have visited all 8! permutations");
}

/// Sanity: the dataset above is one where the *naive* (buggy) model genuinely
/// varies with order — so the invariance proven above is meaningful, not vacuous.
#[test]
fn test_naive_model_varies_for_this_dataset() {
    let ascending: [i128; 8] = [10, 50, 300, 400, 800, 999, 1200, 1500];
    let descending: [i128; 8] = [1500, 1200, 999, 800, 400, 300, 50, 10];
    assert_ne!(
        naive_sequential_charge(&ascending, 1, 3),
        naive_sequential_charge(&descending, 1, 3)
    );
}

/// On-chain: appending the same events in different orders into two separate
/// contract instances yields the same rollup.
#[test]
fn test_onchain_rollup_independent_of_append_order() {
    let env = Env::default();
    env.mock_all_auths();

    let units: [i128; 5] = [1500, 100, 800, 50, 1200];
    let (t1, t2) = (2i128, 7i128);

    let device = Address::generate(&env);

    // Instance 1: forward order.
    let id1 = env.register_contract(None, TelemetryBilling);
    let c1 = TelemetryBillingClient::new(&env, &id1);
    for (n, u) in units.iter().enumerate() {
        c1.append_event(&device, &(n as u64), u);
    }
    let bill1 = c1.billing_cycle_rollup(&t1, &t2);

    // Instance 2: reverse order.
    let id2 = env.register_contract(None, TelemetryBilling);
    let c2 = TelemetryBillingClient::new(&env, &id2);
    for (n, u) in units.iter().enumerate().rev() {
        c2.append_event(&device, &(n as u64), u);
    }
    let bill2 = c2.billing_cycle_rollup(&t1, &t2);

    assert_eq!(bill1, bill2, "rollup must not depend on append order");
    assert_eq!(bill1, billing_cycle_rollup_units(&units, t1, t2));
}
