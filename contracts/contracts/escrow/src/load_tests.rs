//! Escrow Contract Load Tests — Performance Validation
//!
//! This module contains comprehensive load tests that validate the escrow
//! contract meets the P99 < 200ms performance target for all billing operations.
//!
//! ## Test Structure
//!
//! - `test_*_load` — Individual operation load tests
//! - `test_billing_lifecycle_*` — End-to-end billing workflow tests
//! - `test_concurrent_*` — Concurrency and isolation tests
//! - `test_performance_*` — Performance regression tests
//!
//! ## Running
//!
//! ```bash
//! cd contracts/contracts
//! cargo test --package escrow -- load_tests --nocapture
//! ```

#![cfg(test)]

extern crate std;

use soroban_sdk::{
    testutils::Address as AddressTest, testutils::Ledger, token, Address, BytesN, Env, String,
};

use crate::gas_metrics::ESCROW_GAS_METER;
use crate::load_test_harness::{LoadTestConfig, LoadTestHarness};
use crate::EscrowContract;

use std::string::{String as StdString, ToString};
use std::time::{Duration, Instant};
use std::vec;
use std::vec::Vec;

// ============================================================================
// Helpers
// ============================================================================

fn dummy_wasm_hash(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0xAB_u8; 32])
}

/// Set up the test environment with a mock token contract.
/// Returns (env, client, token_address, token_admin_address).
fn setup() -> (Env, crate::EscrowContractClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| {
        li.timestamp = 1_700_000_000;
    });
    let contract_id = env.register(EscrowContract, (dummy_wasm_hash(&env),));
    let client = crate::EscrowContractClient::new(&env, &contract_id);
    let token_admin = Address::generate(&env);
    let token_address = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    (env, client, token_address, token_admin)
}

/// Mint tokens to a user via the token admin.
fn mint_to(env: &Env, token_admin: &Address, token: &Address, to: &Address, amount: i128) {
    // Use the token admin to mint — StellarAssetClient::new uses the admin to authorize
    let admin_client = token::StellarAssetClient::new(env, token);
    admin_client.mint(to, &amount);
}

// ============================================================================
// Individual Operation Load Tests
// ============================================================================

#[test]
fn test_initialize_escrow_load() {
    ESCROW_GAS_METER.clear();

    let (env, client, token, _token_admin) = setup();

    let start = Instant::now();
    for _ in 0..100 {
        let user = Address::generate(&env);
        let s = Instant::now();
        client.initialize_escrow(&user, &token);
        ESCROW_GAS_METER.record_latency("initialize_escrow", s.elapsed());
    }
    let total = start.elapsed();

    let report = ESCROW_GAS_METER.generate_report();
    let stats = report.operation_stats.get("initialize_escrow").unwrap();

    std::println!("\n=== initialize_escrow Load Test ===");
    std::println!("  Total: 100 operations in {:?}", total);
    std::println!("  P50:   {:?}", stats.latency.p50);
    std::println!("  P99:   {:?}", stats.latency.p99);
    std::println!("  Max:   {:?}", stats.latency.max);
    assert!(stats.latency.p99 < Duration::from_millis(200));
    ESCROW_GAS_METER.clear();
}

#[test]
fn test_deposit_load() {
    ESCROW_GAS_METER.clear();

    let (env, client, token, token_admin) = setup();
    let user = Address::generate(&env);
    mint_to(&env, &token_admin, &token, &user, 100_000_000i128);
    client.initialize_escrow(&user, &token);

    for _ in 0..100 {
        let s = Instant::now();
        client.deposit(&user, &token, &1_000i128);
        ESCROW_GAS_METER.record_latency("deposit", s.elapsed());
    }

    let report = ESCROW_GAS_METER.generate_report();
    let stats = report.operation_stats.get("deposit").unwrap();

    std::println!("\n=== deposit Load Test ===");
    std::println!("  P50: {:?}", stats.latency.p50);
    std::println!("  P99: {:?}", stats.latency.p99);
    assert!(stats.latency.p99 < Duration::from_millis(200));
    ESCROW_GAS_METER.clear();
}

#[test]
fn test_charge_meter_usage_load() {
    ESCROW_GAS_METER.clear();

    let (env, client, token, token_admin) = setup();
    let consumer = Address::generate(&env);
    let device_id = String::from_str(&env, "MTR-LOAD");

    mint_to(&env, &token_admin, &token, &consumer, 100_000_000i128);
    client.initialize_escrow(&consumer, &token);
    client.deposit(&consumer, &token, &10_000_000i128);
    client.register_meter(&device_id, &consumer, &token);

    for i in 0..100 {
        let amount = 10i128 + (i as i128 % 90);
        let s = Instant::now();
        let _ = client.try_charge_meter_usage(&device_id, &consumer, &amount);
        ESCROW_GAS_METER.record_latency("charge_meter_usage", s.elapsed());
    }

    let report = ESCROW_GAS_METER.generate_report();
    let stats = report.operation_stats.get("charge_meter_usage").unwrap();

    std::println!("\n=== charge_meter_usage Load Test ===");
    std::println!("  P50: {:?}", stats.latency.p50);
    std::println!("  P99: {:?}", stats.latency.p99);
    assert!(stats.latency.p99 < Duration::from_millis(200));
    ESCROW_GAS_METER.clear();
}

#[test]
fn test_charge_group_usage_load() {
    ESCROW_GAS_METER.clear();

    let (env, client, token, token_admin) = setup();
    let manager = Address::generate(&env);
    let group_id = String::from_str(&env, "FLEET-LOAD");

    mint_to(&env, &token_admin, &token, &manager, 100_000_000i128);
    client.initialize_escrow(&manager, &token);
    client.deposit(&manager, &token, &10_000_000i128);
    client.register_group(&group_id, &manager, &token, &10u32);

    for i in 0..100 {
        let amount = 10i128 + (i as i128 % 90);
        let s = Instant::now();
        let _ = client.try_charge_group_usage(&group_id, &manager, &amount);
        ESCROW_GAS_METER.record_latency("charge_group_usage", s.elapsed());
    }

    let report = ESCROW_GAS_METER.generate_report();
    let stats = report.operation_stats.get("charge_group_usage").unwrap();

    std::println!("\n=== charge_group_usage Load Test ===");
    std::println!("  P50: {:?}", stats.latency.p50);
    std::println!("  P99: {:?}", stats.latency.p99);
    assert!(stats.latency.p99 < Duration::from_millis(200));
    ESCROW_GAS_METER.clear();
}

#[test]
fn test_get_escrow_balance_load() {
    ESCROW_GAS_METER.clear();

    let (env, client, token, _token_admin) = setup();
    let user = Address::generate(&env);
    client.initialize_escrow(&user, &token);

    for _ in 0..1000 {
        let s = Instant::now();
        let _ = client.get_escrow_balance(&user, &token);
        ESCROW_GAS_METER.record_latency("get_escrow_balance", s.elapsed());
    }

    let report = ESCROW_GAS_METER.generate_report();
    let stats = report.operation_stats.get("get_escrow_balance").unwrap();

    std::println!("\n=== get_escrow_balance Load Test (1000 ops) ===");
    std::println!("  P50: {:?}", stats.latency.p50);
    std::println!("  P99: {:?}", stats.latency.p99);
    assert!(stats.latency.p99 < Duration::from_millis(200));
    ESCROW_GAS_METER.clear();
}

// ============================================================================
// Billing Lifecycle Load Tests
// ============================================================================

#[test]
fn test_billing_lifecycle_smoke() {
    let mut harness = LoadTestHarness::with_config(LoadTestConfig::smoke());
    harness.run_billing_lifecycle_test();

    std::println!("\n=== Billing Lifecycle Smoke Test ===");
    harness.report.print_summary();

    let result = harness.validate_p99_target();
    result.print_report();
    assert!(result.passed, "Load test failed: {:?}", result.violations);
}

#[test]
fn test_billing_lifecycle_steady_state() {
    let mut harness = LoadTestHarness::with_config(LoadTestConfig::steady_state());
    harness.run_billing_lifecycle_test();

    std::println!("\n=== Billing Lifecycle Steady State Test ===");
    harness.report.print_summary();

    let result = harness.validate_p99_target();
    result.print_report();
    assert!(result.passed, "Load test failed: {:?}", result.violations);
}

#[test]
fn test_charge_billing_load() {
    let mut harness = LoadTestHarness::with_config(LoadTestConfig::smoke());
    harness.run_charge_billing_test();

    std::println!("\n=== Charge Billing Load Test ===");
    harness.report.print_summary();

    let result = harness.validate_p99_target();
    result.print_report();
    assert!(result.passed, "Load test failed: {:?}", result.violations);
}

// ============================================================================
// Concurrency & Isolation Tests
// ============================================================================

#[test]
fn test_concurrent_escrows_are_isolated() {
    let (env, client, token, token_admin) = setup();

    let mut users = Vec::new();
    for _ in 0..50 {
        let user = Address::generate(&env);
        mint_to(&env, &token_admin, &token, &user, 1_000_000i128);
        client.initialize_escrow(&user, &token);
        client.deposit(&user, &token, &1_000_000i128);
        users.push(user);
    }

    // Charge from user 0's meter
    let device_a = String::from_str(&env, "ISO-A");
    let user0 = &users[0];
    client.register_meter(&device_a, user0, &token);
    let _ = client.try_charge_meter_usage(&device_a, user0, &100i128);

    // All other users should still have full balance
    for (i, user) in users.iter().enumerate() {
        if i == 0 {
            let balance = client.get_escrow_balance(user, &token);
            assert_eq!(balance, 1_000_000i128 - 100);
        } else {
            let balance = client.get_escrow_balance(user, &token);
            assert_eq!(balance, 1_000_000i128);
        }
    }
}

#[test]
fn test_concurrent_meters_are_independent() {
    let (env, client, token, token_admin) = setup();
    let consumer = Address::generate(&env);

    mint_to(&env, &token_admin, &token, &consumer, 100_000_000i128);
    client.initialize_escrow(&consumer, &token);
    client.deposit(&consumer, &token, &10_000_000i128);

    // Register 20 meters
    for i in 0..20 {
        let device_id = String::from_str(&env, &std::format!("IND-{i:04}"));
        let _ = client.try_register_meter(&device_id, &consumer, &token);
    }

    // Charge each meter
    for i in 0..20 {
        let device_id = String::from_str(&env, &std::format!("IND-{i:04}"));
        let _ = client.try_charge_meter_usage(&device_id, &consumer, &100i128);
    }

    // Verify all meters charged independently
    let mut total_charged = 0i128;
    for i in 0..20 {
        let device_id = String::from_str(&env, &std::format!("IND-{i:04}"));
        let usage = client.get_meter_usage(&device_id).unwrap();
        assert_eq!(usage.total_charged, 100i128);
        total_charged += usage.total_charged;
    }
    assert_eq!(total_charged, 2000i128);
}

// ============================================================================
// Performance Regression Tests
// ============================================================================

#[test]
fn test_initialize_escrow_gas_baseline() {
    let (env, client, token, _token_admin) = setup();
    let user = Address::generate(&env);

    let start = Instant::now();
    client.initialize_escrow(&user, &token);
    let latency = start.elapsed();

    assert!(
        latency < Duration::from_millis(50),
        "initialize_escrow latency {:?} exceeds 50ms baseline",
        latency
    );
}

#[test]
fn test_deposit_gas_baseline() {
    let (env, client, token, token_admin) = setup();
    let user = Address::generate(&env);
    mint_to(&env, &token_admin, &token, &user, 10_000_000i128);
    client.initialize_escrow(&user, &token);

    let start = Instant::now();
    client.deposit(&user, &token, &1_000_000i128);
    let latency = start.elapsed();

    assert!(
        latency < Duration::from_millis(50),
        "deposit latency {:?} exceeds 50ms baseline",
        latency
    );
}

#[test]
fn test_charge_meter_usage_gas_baseline() {
    let (env, client, token, token_admin) = setup();
    let consumer = Address::generate(&env);
    let device_id = String::from_str(&env, "BL-BASE");

    mint_to(&env, &token_admin, &token, &consumer, 100_000_000i128);
    client.initialize_escrow(&consumer, &token);
    client.deposit(&consumer, &token, &10_000_000i128);
    client.register_meter(&device_id, &consumer, &token);

    let start = Instant::now();
    let _ = client.try_charge_meter_usage(&device_id, &consumer, &100i128);
    let latency = start.elapsed();

    assert!(
        latency < Duration::from_millis(50),
        "charge_meter_usage latency {:?} exceeds 50ms baseline",
        latency
    );
}

#[test]
fn test_charge_group_usage_gas_baseline() {
    let (env, client, token, token_admin) = setup();
    let manager = Address::generate(&env);
    let group_id = String::from_str(&env, "GR-BASE");

    mint_to(&env, &token_admin, &token, &manager, 100_000_000i128);
    client.initialize_escrow(&manager, &token);
    client.deposit(&manager, &token, &10_000_000i128);
    client.register_group(&group_id, &manager, &token, &5u32);

    let start = Instant::now();
    let _ = client.try_charge_group_usage(&group_id, &manager, &100i128);
    let latency = start.elapsed();

    assert!(
        latency < Duration::from_millis(50),
        "charge_group_usage latency {:?} exceeds 50ms baseline",
        latency
    );
}

// ============================================================================
// Prometheus Metrics Export Test
// ============================================================================

#[test]
fn test_prometheus_metrics_export() {
    let mut harness = LoadTestHarness::with_config(LoadTestConfig::smoke());
    harness.run_billing_lifecycle_test();

    let prom = harness.prometheus_metrics();

    assert!(prom.contains("escrow_p99_latency_ms"));
    assert!(prom.contains("escrow_p50_latency_ms"));
    assert!(prom.contains("escrow_p90_latency_ms"));
    assert!(prom.contains("escrow_p95_latency_ms"));
    assert!(prom.contains("escrow_total_measurements"));
    assert!(prom.contains("escrow_total_gas"));
    assert!(prom.contains("escrow_p99_target_passed"));

    assert!(prom.contains("initialize_escrow"));
    assert!(prom.contains("deposit"));
    assert!(prom.contains("charge_meter_usage"));
    assert!(prom.contains("get_escrow_balance"));

    std::println!("\n=== Prometheus Metrics ===\n{}", prom);
}

// ============================================================================
// Stress Test
// ============================================================================

#[test]
fn test_high_volume_meter_charges() {
    ESCROW_GAS_METER.clear();

    let (env, client, token, token_admin) = setup();
    let consumers: Vec<Address> = (0..10).map(|_| Address::generate(&env)).collect();

    // Setup: 10 consumers, each with 5 meters
    for consumer in &consumers {
        mint_to(&env, &token_admin, &token, consumer, 100_000_000i128);
        client.initialize_escrow(consumer, &token);
        client.deposit(consumer, &token, &100_000_000i128);
    }

    let mut device_ids = Vec::new();
    for (ci, consumer) in consumers.iter().enumerate() {
        for di in 0..5 {
            let device_id = String::from_str(&env, &std::format!("HV-{ci:02}-{di:02}"));
            let _ = client.try_register_meter(&device_id, consumer, &token);
            device_ids.push((device_id, ci));
        }
    }

    // Stress: 500 total charges
    let start = Instant::now();
    for charge_idx in 0..500 {
        let (device_id, ci) = &device_ids[charge_idx % device_ids.len()];
        let consumer = &consumers[*ci];
        let amount = 1i128 + (charge_idx as i128 % 10);
        let s = Instant::now();
        let _ = client.try_charge_meter_usage(device_id, consumer, &amount);
        ESCROW_GAS_METER.record_latency("charge_meter_usage", s.elapsed());
    }
    let total = start.elapsed();

    let report = ESCROW_GAS_METER.generate_report();
    let stats = report.operation_stats.get("charge_meter_usage").unwrap();

    std::println!("\n=== High Volume Stress Test ===");
    std::println!("  500 charges across 10 consumers, 50 meters");
    std::println!("  Total time: {:?}", total);
    std::println!("  Throughput: {:.0} ops/sec", 500.0 / total.as_secs_f64());
    std::println!("  P50: {:?}", stats.latency.p50);
    std::println!("  P90: {:?}", stats.latency.p90);
    std::println!("  P95: {:?}", stats.latency.p95);
    std::println!("  P99: {:?}", stats.latency.p99);

    assert!(
        stats.latency.p99 < Duration::from_millis(200),
        "P99 latency {:?} exceeds 200ms target",
        stats.latency.p99
    );
    ESCROW_GAS_METER.clear();
}
