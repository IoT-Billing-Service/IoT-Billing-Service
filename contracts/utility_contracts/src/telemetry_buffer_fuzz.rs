#![cfg(test)]

//! Issue #10: stress tests for the bounded telemetry buffer. (The blueprint
//! names `fuzz_tests.rs`; kept here as a cohesive module.)
//!
//! Simulates thousands of telemetry submissions with intermittent oracle
//! failure and asserts the live buffer never approaches the 512 KB ledger-entry
//! limit, both at the pure-model level and on-chain.

extern crate std;

use crate::telemetry_buffer::{
    buffer_bytes, simulate_max_len, within_entry_limit, TelemetryBuffer, TelemetryBufferClient,
    TelemetryEvent, EVICTION_THRESHOLD, MAX_ENTRY_BYTES, MAX_PENDING_EVENTS,
};
use proptest::prelude::*;
use soroban_sdk::{testutils::Address as _, Address, Env};

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1_000))]

    /// Blueprint step 5 (generalized): for any submission count and any oracle
    /// failure cadence, the live buffer stays within the cap and the entry limit.
    #[test]
    fn prop_buffer_never_overflows(
        submissions in 0u32..6_000,
        fail_every in 0u32..6,
    ) {
        let max_len = simulate_max_len(submissions, fail_every);
        prop_assert!(max_len <= MAX_PENDING_EVENTS);
        prop_assert!(within_entry_limit(max_len));
        prop_assert!(buffer_bytes(max_len) <= MAX_ENTRY_BYTES);
    }
}

/// Blueprint step 5: 5000 submissions with oracle failure on every 3rd flush —
/// the buffer never exceeds 512 KB.
#[test]
fn stress_5000_submissions_oracle_fails_every_third() {
    let max_len = simulate_max_len(5_000, 3);
    assert!(buffer_bytes(max_len) <= MAX_ENTRY_BYTES);
    // Eviction holds it near the threshold, far below the cap.
    assert!(max_len <= EVICTION_THRESHOLD + 1);
}

/// On-chain: appending past the eviction threshold sheds the oldest batch to the
/// archive, so the live entry never reaches the cap; total events are preserved
/// across pending + archive.
#[test]
fn onchain_eviction_keeps_pending_bounded() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register_contract(None, TelemetryBuffer);
    let client = TelemetryBufferClient::new(&env, &id);
    let device = Address::generate(&env);

    let total = 450u32; // crosses the 300 eviction threshold
    for n in 0..total {
        let ev = TelemetryEvent {
            device: device.clone(),
            value: n as u128,
            timestamp: n as u64,
            nonce: n as u64,
        };
        client.try_append_event(&ev).unwrap().unwrap();
    }

    let pending = client.pending_len();
    let archive = client.archive_len();

    // Live entry stayed bounded (never reached the cap) and within size limit.
    assert!(pending <= MAX_PENDING_EVENTS);
    assert!(buffer_bytes(pending) <= MAX_ENTRY_BYTES);
    // No events were lost — everything is in pending or archive.
    assert_eq!(pending + archive, total);
    // Eviction actually happened.
    assert!(archive > 0);
}

/// On-chain: an oracle-failed flush retains the batch (atomic), and a later
/// successful confirm removes exactly the flushed count — nothing is lost on
/// failure, nothing double-counted on success.
#[test]
fn onchain_atomic_flush_retains_on_failure() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register_contract(None, TelemetryBuffer);
    let client = TelemetryBufferClient::new(&env, &id);
    let device = Address::generate(&env);

    for n in 0..120u32 {
        let ev = TelemetryEvent { device: device.clone(), value: n as u128, timestamp: n as u64, nonce: n as u64 };
        client.append_event(&ev);
    }

    let batch = client.take_flush_batch();
    assert_eq!(batch.len(), 100);

    // Simulated oracle failure: abort → buffer unchanged.
    client.abort_flush();
    assert_eq!(client.pending_len(), 120);

    // Retry succeeds: confirm removes exactly the flushed batch.
    let batch2 = client.take_flush_batch();
    client.confirm_flush(&batch2.len());
    assert_eq!(client.pending_len(), 20);
}
