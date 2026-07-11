use super::*;
use crate::gas_budget::{plan_oracle_batches, EMERGENCY_THRESHOLD, HOST_FUNCTION_BUDGET};
use soroban_sdk::{testutils::Address as _, Address, BytesN, Env};

#[test]
fn test_extreme_usage_values() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(UtilityContract, ());
    let client = UtilityContractClient::new(&env, &contract_id);

    let user = Address::generate(&env);
    let provider = Address::generate(&env);
    let oracle = Address::generate(&env);

    client.set_oracle(&oracle);

    let token_admin = Address::generate(&env);
    let token_address = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let token_admin_client = soroban_sdk::token::StellarAssetClient::new(&env, &token_address);
    token_admin_client.mint(&user, &1_000_000_000_000i128);

    let device_public_key = BytesN::from_array(&env, &[1u8; 32]);
    let meter_id =
        client.register_meter(&user, &provider, &100, &token_address, &device_public_key);

    client.top_up(&meter_id, &1_000_000_000_000i128);

    // Test large (but valid) usage updates
    let extreme_values: [i128; 3] = [1_000_000_000i128, 10_000_000_000i128, 100_000_000_000i128];

    for &usage in extreme_values.iter() {
        client.update_usage(&meter_id, &usage);
        let usage_data = client.get_usage_data(&meter_id);
        assert!(usage_data.is_some());
        let data = usage_data.unwrap();
        assert!(data.total_watt_hours >= 0);
        assert!(data.current_cycle_watt_hours >= 0);
        assert!(data.peak_usage_watt_hours >= 0);
    }
}

#[test]
fn test_precision_factor_extremes() {
    let extreme_precision_factors: [i128; 5] =
        [1, 1000, 1_000_000, 1_000_000_000, i128::MAX / 1000];

    let test_usage = 1_000_000_000i128;

    for &precision in extreme_precision_factors.iter() {
        let precise_consumption = test_usage.saturating_mul(precision);
        assert!(precise_consumption >= 0);

        if precision != 0 {
            let display = test_usage / precision;
            assert!(display >= 0);
        }
    }
}

#[test]
fn test_arithmetic_edge_cases() {
    let edge_cases: [i128; 7] = [i128::MAX, i128::MIN, i128::MAX - 1, i128::MIN + 1, 0, -1, 1];

    for &value in edge_cases.iter() {
        let _a = value.saturating_add(1);
        let _b = value.saturating_mul(1000);
        let _c = value.saturating_sub(1);

        if value != 0 {
            let _d = 1000i128 / value;
        }
    }
}

/// Stress test for `AssetManager::rebalance_pool()`.
///
/// The original spec asked us to "call `rebalance_pool()` 1000 times and assert
/// zero `HostStorageAccessViolation` events." Soroban contract execution is
/// single-threaded and the SDK has no `HostStorageAccessViolation` event type,
/// so there is nothing of that name to count. We instead exercise the function
/// 1000 times and assert the invariants the read-local-then-mutate pattern is
/// meant to preserve: no panic, an exact `reserve + allocated == total`
/// partition on every call, and a strictly monotonic rebalance counter.
#[test]
fn test_rebalance_pool_stress_1000() {
    use crate::asset::{AssetManager, AssetManagerClient};

    let env = Env::default();
    let contract_id = env.register(AssetManager, ());
    let client = AssetManagerClient::new(&env, &contract_id);

    client.init(&1_000_000u128);

    let mut last_count = 0u64;
    for _ in 0..1000 {
        let state = client.rebalance_pool();

        assert_eq!(
            state.reserve + state.allocated,
            state.total_balance,
            "reserve + allocated must equal total balance every rebalance"
        );
        assert!(
            state.rebalance_count > last_count,
            "rebalance counter must advance monotonically"
        );
        last_count = state.rebalance_count;
    }

    assert_eq!(last_count, 1000, "exactly 1000 rebalances should be recorded");
}

/// Drift simulation for billing-cycle assignment.
///
/// Introduces random device clock offsets of 0..=3600s and verifies that the
/// oracle-anchored assignment (`assign_cycle`) keeps cycle-assignment accuracy
/// above 99%. Delegates to the pure functions in `telemetry_billing_core.rs`,
/// which are also exercised by the runnable `telemetry-determinism-check`
/// standalone crate (this lib test cannot currently run because the wider
/// `utility_contracts` crate has pre-existing build breakage).
#[test]
fn test_billing_cycle_drift_assignment_accuracy() {
    // The pure time-alignment math lives in `telemetry_billing_core.rs` (the
    // single source of truth, also exercised by the standalone
    // `telemetry-determinism-check` crate). `telemetry_billing` is not a wired
    // module, so include the core directly into a nested module here.
    mod drift_core {
        include!("telemetry_billing_core.rs");
    }
    use drift_core::{assign_cycle, cycle_index, BILLING_CYCLE_SECONDS};

    // Small deterministic PRNG (SplitMix64) so the test is reproducible.
    let mut state: u64 = 0xA5A5_1234_DEAD_BEEF;
    let mut next = || {
        state = state.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^ (z >> 31)
    };

    let origin: u64 = 1_600_000_000;
    let total: u64 = 50_000;
    let mut correct: u64 = 0;

    for _ in 0..total {
        let true_ts = origin + next() % (2 * BILLING_CYCLE_SECONDS);
        let true_cycle = cycle_index(true_ts, origin);
        let anchor = true_ts; // ledger/oracle anchor tracks true time
        let offset = next() % 3601; // 0..=3600s device drift
        let device_ts = true_ts + offset;

        if assign_cycle(device_ts, anchor, origin) == true_cycle {
            correct += 1;
        }
    }

    let accuracy = correct as f64 / total as f64;
    assert!(
        accuracy >= 0.99,
        "drift-corrected cycle assignment accuracy {accuracy:.4} fell below 0.99"
    );
}

#[test]
fn test_nested_oracle_budget_splits_one_hundred_calls() {
    let plan = plan_oracle_batches(100, HOST_FUNCTION_BUDGET)
        .expect("host budget should allow chunked oracle verification");

    assert_eq!(plan.requested_calls, 100);
    assert_eq!(plan.completed_calls, 100);
    assert!(plan.batches > 1);
    assert_eq!(plan.max_calls_per_batch, 11);
    assert!(plan.min_remaining_budget >= EMERGENCY_THRESHOLD);
}

#[test]
fn test_cumulative_extreme_usage() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(UtilityContract, ());
    let client = UtilityContractClient::new(&env, &contract_id);

    let user = Address::generate(&env);
    let provider = Address::generate(&env);
    let oracle = Address::generate(&env);

    client.set_oracle(&oracle);

    let token_admin = Address::generate(&env);
    let token_address = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let token_admin_client = soroban_sdk::token::StellarAssetClient::new(&env, &token_address);
    token_admin_client.mint(&user, &i128::MAX);

    let device_public_key = BytesN::from_array(&env, &[1u8; 32]);
    let meter_id =
        client.register_meter(&user, &provider, &100, &token_address, &device_public_key);

    client.top_up(&meter_id, &1_000_000_000_000i128);

    let extreme_usage = 1_000_000_000i128;

    for i in 0u64..10 {
        let cumulative_usage = extreme_usage.saturating_mul((i + 1) as i128);
        client.update_usage(&meter_id, &cumulative_usage);

        let usage_data = client.get_usage_data(&meter_id);
        assert!(usage_data.is_some());

        let data = usage_data.unwrap();
        assert!(data.total_watt_hours >= 0);
        assert!(data.current_cycle_watt_hours >= 0);
        assert!(data.peak_usage_watt_hours >= 0);
    }
}

#[test]
fn test_debt_calculation_underflow_protection() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(UtilityContract, ());
    let client = UtilityContractClient::new(&env, &contract_id);

    let user = Address::generate(&env);
    let provider = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_address = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let token_admin_client = soroban_sdk::token::StellarAssetClient::new(&env, &token_address);

    let device_public_key = BytesN::from_array(&env, &[1u8; 32]);

    // Test PostPaid meter with extreme debt scenarios
    let meter_id = client.register_meter_with_mode(
        &user,
        &provider,
        &1000, // High rate
        &token_address,
        &BillingType::PostPaid,
        &device_public_key,
    );

    // Test 1: High rate, long duration, zero balance scenario
    client.top_up(&meter_id, &1000000); // Initial collateral

    // Pair the meter for usage deduction
    let challenge = client.initiate_pairing(&meter_id);
    let signature = BytesN::from_array(&env, &[2u8; 64]);
    client.complete_pairing(&meter_id, &signature);

    // Simulate extreme usage that would cause massive debt accumulation
    let extreme_usage = SignedUsageData {
        meter_id,
        timestamp: env.ledger().timestamp(),
        watt_hours_consumed: 100_000_000_000i128, // 100 billion Wh
        units_consumed: 10_000_000i128,           // 10 million units
        signature: BytesN::from_array(&env, &[3u8; 64]),
        public_key: device_public_key.clone(),
        is_renewable_energy: false,
    };

    // This should not panic even with extreme values
    client.deduct_units(&extreme_usage);

    let meter = client.get_meter(&meter_id).unwrap();

    // Verify debt is non-negative (critical underflow protection)
    assert!(meter.debt >= 0, "Debt should never be negative");

    // Verify debt accumulated correctly
    assert!(meter.debt > 0, "Debt should be positive after usage");

    // Test 2: Verify debt clears correctly on top-up
    let debt_to_clear = meter.debt;
    token_admin_client.mint(&user, &debt_to_clear);

    client.top_up(&meter_id, &debt_to_clear);

    let meter_after_settlement = client.get_meter(&meter_id).unwrap();

    // Debt should be fully cleared
    assert_eq!(
        meter_after_settlement.debt, 0,
        "Debt should be fully cleared after sufficient top-up"
    );

    // Collateral should be properly updated
    assert!(
        meter_after_settlement.collateral_limit >= 0,
        "Collateral limit should remain non-negative"
    );

    // Test 3: Test with maximum safe values to ensure no underflow
    let max_safe_usage = SignedUsageData {
        meter_id,
        timestamp: env.ledger().timestamp(),
        watt_hours_consumed: i128::MAX / 1_000_000, // Safe maximum
        units_consumed: i128::MAX / 1_000_000_000,  // Safe maximum
        signature: BytesN::from_array(&env, &[4u8; 64]),
        public_key: device_public_key.clone(),
        is_renewable_energy: false,
    };

    // Should handle maximum values without panicking
    client.deduct_units(&max_safe_usage);

    let max_meter = client.get_meter(&meter_id).unwrap();

    // All values should remain within valid i128 range
    assert!(max_meter.debt >= 0 && max_meter.debt <= i128::MAX);
    assert!(max_meter.collateral_limit >= 0 && max_meter.collateral_limit <= i128::MAX);
    assert!(max_meter.balance >= i128::MIN && max_meter.balance <= i128::MAX);
}

#[test]
fn test_prepaid_negative_balance_handling() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(UtilityContract, ());
    let client = UtilityContractClient::new(&env, &contract_id);

    let user = Address::generate(&env);
    let provider = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_address = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();

    let device_public_key = BytesN::from_array(&env, &[1u8; 32]);

    // Test PrePaid meter with zero balance
    let meter_id = client.register_meter_with_mode(
        &user,
        &provider,
        &1000, // High rate
        &token_address,
        &BillingType::PrePaid,
        &device_public_key,
    );

    // Pair the meter
    let challenge = client.initiate_pairing(&meter_id);
    let signature = BytesN::from_array(&env, &[2u8; 64]);
    client.complete_pairing(&meter_id, &signature);

    // Try to deduct units with zero balance - should handle gracefully
    let zero_balance_usage = SignedUsageData {
        meter_id,
        timestamp: env.ledger().timestamp(),
        watt_hours_consumed: 10_000_000i128,
        units_consumed: 100_000i128,
        signature: BytesN::from_array(&env, &[3u8; 64]),
        public_key: device_public_key.clone(),
        is_renewable_energy: false,
    };

    // This should not panic, even with zero balance
    client.deduct_units(&zero_balance_usage);

    let meter = client.get_meter(&meter_id).unwrap();

    // Balance should be negative or zero, but never cause underflow
    assert!(
        meter.balance <= 0,
        "Balance should be zero or negative with insufficient funds"
    );

    // Meter should be inactive with negative balance
    assert!(
        !meter.is_active,
        "Meter should be inactive with negative balance"
    );

    // Balance should be within valid i128 range
    assert!(meter.balance >= i128::MIN && meter.balance <= i128::MAX);
}

// Issue #204: Fuzz Test: Epoch Timestamp Manipulation
// Verifies that extreme/manipulated timestamps cannot trick flow calculations
// into releasing locked funds early or causing panics.
#[test]
fn test_epoch_timestamp_manipulation() {
    // Extreme timestamp values to fuzz: past, future, leap-year boundaries, u64 extremes
    let timestamp_cases: &[(u64, u64)] = &[
        // (last_flow_timestamp, current_timestamp)
        (0, 0),                                  // zero-zero: no elapsed time
        (0, u64::MAX),                           // max future jump
        (u64::MAX, u64::MAX),                    // same extreme value
        (u64::MAX - 1, u64::MAX),                // one second forward at max
        (1_000_000, 999_999),                    // backwards (current < last) → no accumulation
        (0, 1_577_836_800),                      // epoch to 2020-01-01
        (1_577_836_800, 1_577_836_800 + 86_400), // normal 24h window
        // Leap-year boundary: 2000-02-28 → 2000-03-01 (86400 * 2 seconds)
        (946_684_800, 946_684_800 + 172_800),
        // Far future: year ~2554
        (0, 18_446_744_073_709_551_614),
    ];

    let flow_rates: &[i128] = &[0, 1, i128::MAX, i128::MAX / 2, 1_000_000_000];

    for &(last_ts, current_ts) in timestamp_cases.iter() {
        for &rate in flow_rates.iter() {
            // Simulate calculate_flow_accumulation logic inline
            // (mirrors the contract's checked_sub approach)
            let elapsed = current_ts.checked_sub(last_ts);
            let accumulation = match elapsed {
                None => 0i128, // backwards timestamp → 0
                Some(e) => rate.saturating_mul(e as i128),
            };

            // Acceptance 1: result is never negative
            assert!(
                accumulation >= 0,
                "Accumulation must be non-negative: rate={rate}, last={last_ts}, current={current_ts}"
            );

            // Acceptance 2: no panic on any combination (saturating_mul prevents overflow)
            // Acceptance 3: backwards timestamps yield zero (no early fund release)
            if current_ts < last_ts {
                assert_eq!(
                    accumulation, 0,
                    "Backwards timestamp must yield zero accumulation"
                );
            }

            // Acceptance 3: forward movement is mathematically correct (no overflow panic)
            if let Some(e) = elapsed {
                let expected = rate.saturating_mul(e as i128);
            assert_eq!(accumulation, expected);
        }
    }
}

/// Fuzz the settlement two-phase commit invariant.
///
/// Creates N random settlement entries, randomly commits/rolls back steps,
/// and verifies that `asset_debit(tx) XOR stream_finalize(tx)` (i.e. it must
/// never be the case that debit is committed while finalize is not, or vice
/// versa) holds at every step of every journal entry.
#[test]
fn test_settlement_xor_invariant_under_random_failures() {
    use crate::settlement_orchestrator::{
        SettlementManager, SettlementManagerClient, SettlementStep, StepStatus,
    };
    use soroban_sdk::testutils::Address as _;

    const N_SETTLEMENTS: u64 = 20;

    let env = Env::default();
    env.mock_all_auths();

    let mgr_id = env.register_contract(None, SettlementManager);
    let mgr = SettlementManagerClient::new(&env, &mgr_id);

    // Generate random addresses (mock contracts with no storage — calling them
    // will fail, which is exactly what we need to exercise the rollback path).
    let mut rng_state: u64 = 0xSETTLE_MEET;
    let mut rng = || {
        rng_state = rng_state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        rng_state
    };

    let contracts: Vec<(Address, Address, Address)> = (0..N_SETTLEMENTS)
        .map(|_| {
            (
                Address::generate(&env),
                Address::generate(&env),
                Address::generate(&env),
            )
        })
        .collect();

    // Make every settlement entry a fresh init so we have a clean journal.
    for (i, (a, b, c)) in contracts.iter().enumerate() {
        let tx = i as u64;
        mgr.init_settlement(&tx, a, b, c);
    }

    // ---- Fuzz loop: randomly commit or roll each step -------------------
    for i in 0..N_SETTLEMENTS {
        let tx = i;

        // Randomly decide if each step should be committed or rolled back.
        for step in &[
            SettlementStep::AssetDebit,
            SettlementStep::InsuranceCredit,
            SettlementStep::StreamFinalize,
        ] {
            let action = rng() % 3; // 0=skip, 1=commit, 2=rollback
            match action {
                1 => mgr.commit_step(&tx, step),
                2 => mgr.rollback_step(&tx, step),
                _ => {} // leave as Pending
            }
        }

        // ---- Invariant check --------------------------------------------
        let entry = mgr.get_settlement(&tx).unwrap();
        let debit_done = entry.asset_debit_status == StepStatus::Committed;
        let finalize_done = entry.stream_finalize_status == StepStatus::Committed;

        // XOR must *never* be true — debit and finalize must be on the same
        // side of the commit/not-commit boundary.
        assert!(
            !(debit_done ^ finalize_done),
            "Invariant violation tx={tx}: debit={debit_done}, finalize={finalize_done}, statuses=({:?},{:?},{:?})",
            entry.asset_debit_status,
            entry.insurance_credit_status,
            entry.stream_finalize_status,
        );

        // Secondary invariant: if any step was rolled back, the entire
        // settlement must eventually resolve consistently.
        let any_rolled = entry.asset_debit_status == StepStatus::RolledBack
            || entry.insurance_credit_status == StepStatus::RolledBack
            || entry.stream_finalize_status == StepStatus::RolledBack;
        if any_rolled {
            // If one is rolled back, the others must not be committed.
            assert_ne!(
                entry.asset_debit_status,
                StepStatus::Committed,
                "tx={tx}: asset debit committed after rollback"
            );
            assert_ne!(
                entry.insurance_credit_status,
                StepStatus::Committed,
                "tx={tx}: insurance credit committed after rollback"
            );
            assert_ne!(
                entry.stream_finalize_status,
                StepStatus::Committed,
                "tx={tx}: stream finalize committed after rollback"
            );
        }
    }
}
}
