#![cfg(test)]

//! Issue #21: flash-loan / oracle-staleness circuit-breaker tests.
//!
//! Drives `OracleGuard::record_and_resolve` directly (no live oracle contract
//! needed) to simulate the manipulation window and assert the breaker behaves.

extern crate std;

use crate::oracle_circuit_breaker::{
    OracleGuard, OracleGuardClient, MAX_DEVIATION_BPS, MAX_STALENESS_SECS, PRICE_HISTORY_LEN,
};
use soroban_sdk::Env;

fn setup() -> (Env, OracleGuardClient<'static>) {
    let env = Env::default();
    env.ledger().with_mut(|li| {
        li.timestamp = 1_000_000;
    });
    let contract_id = env.register_contract(None, OracleGuard);
    let client = OracleGuardClient::new(&env, &contract_id);
    (env, client)
}

fn now(env: &Env) -> u64 {
    env.ledger().timestamp()
}

/// Seed a stable price history so the moving average is well-defined.
fn seed_stable(env: &Env, client: &OracleGuardClient, price: i128) {
    for _ in 0..PRICE_HISTORY_LEN {
        let used = client.record_and_resolve(&price, &now(env));
        assert_eq!(used, price, "fresh in-tolerance price should be used as-is");
    }
    assert_eq!(client.current_moving_average(), price);
    assert_eq!(client.last_good_price(), Some(price));
}

/// Blueprint step 4: a 20% flash-loan swing is rejected in favour of the moving
/// average, then a stale+deviating read trips the breaker to last-known-good.
#[test]
fn test_flash_loan_manipulation_trips_breaker() {
    let (env, client) = setup();
    seed_stable(&env, &client, 100);

    // Flash-loan window: spot crashes 20% but is "fresh". The deviation check
    // catches it; billing uses the moving average (~100), never the 80.
    let manipulated = 80i128;
    let used = client.record_and_resolve(&manipulated, &now(&env));
    assert_ne!(used, manipulated, "must not bill at the manipulated price");
    // Used price stays within 5% of the moving average (the invariant).
    let ma = client.current_moving_average();
    let diff = (used - ma).abs();
    assert!(diff * 10_000 <= MAX_DEVIATION_BPS * ma);
    // last-known-good is untouched by the rejected spot.
    assert_eq!(client.last_good_price(), Some(100));

    // Now the oracle also goes stale (beyond MAX_STALENESS) while still
    // deviating → both checks fail → circuit breaker → last-known-good.
    let stale_ts = now(&env) - (MAX_STALENESS_SECS + 10);
    let used2 = client.record_and_resolve(&80i128, &stale_ts);
    assert_eq!(used2, 100, "circuit breaker must fall back to last good price");
}

/// A fresh price within tolerance is used directly and advances the good price.
#[test]
fn test_fresh_in_tolerance_price_is_used() {
    let (env, client) = setup();
    seed_stable(&env, &client, 1_000);

    // 3% move — within the 5% band — is accepted.
    let used = client.record_and_resolve(&1_030i128, &now(&env));
    assert_eq!(used, 1_030);
    assert_eq!(client.last_good_price(), Some(1_030));
}

/// A stale price with no prior good price cannot be salvaged → explicit error
/// rather than silently billing at a stale value.
#[test]
fn test_stale_with_no_history_errors() {
    let (env, client) = setup();
    let stale_ts = now(&env) - (MAX_STALENESS_SECS + 10);
    // try_* returns a Result so we can assert the error without a panic.
    let res = client.try_record_and_resolve(&500i128, &stale_ts);
    assert!(res.is_err(), "stale price with no fallback must error");
}

/// Repeated fresh observations keep the moving average tracking real price.
#[test]
fn test_history_tracks_real_price_over_time() {
    let (env, client) = setup();
    seed_stable(&env, &client, 100);
    // Genuine gradual drift to 110 (each step within tolerance) is accepted and
    // pulls the average up.
    for p in [102, 104, 106, 108, 110] {
        let used = client.record_and_resolve(&(p as i128), &now(&env));
        assert_eq!(used, p as i128);
    }
    assert!(client.current_moving_average() > 100);
}
