extern crate std;

use crate::nonce_sync::{
    DeviceNonceState, NonceAlertType, NonceDesyncAlert, NonceResetRequest, NonceSyncManager,
    SignedHeartbeat, NONCE_WINDOW_SIZE,
};
use crate::{ContractError, DataKey};
use soroban_sdk::{
    testutils::Address as TestAddress, testutils::BytesN as TestBytesN, Address, BytesN, Env,
};
use std::format;
use std::string::String;
use std::vec;
use std::vec::Vec;

#[cfg(test)]
pub mod nonce_sync_fuzz_tests {
    use super::*;

    /// Fuzz test: Replay attack rejection
    ///
    /// This test attempts to replay captured hardware signatures with the same nonce
    /// to verify the rejection logic works correctly.
    #[test]
    fn test_replay_attack_rejection() {
        let env = Env::new();
        let contract_address = TestAddress::random(&env);
        env.register_contract(&contract_address, NonceSyncManager);

        let device_mac = TestBytesN::random(&env);
        let meter_id = 12345u64;

        // Initialize device nonce
        NonceSyncManager::initialize_device_nonce(env.clone(), device_mac.clone(), 0);

        // Create initial valid heartbeat
        let heartbeat1 = create_test_heartbeat(meter_id, device_mac.clone(), 0);

        // First heartbeat should succeed
        assert!(NonceSyncManager::verify_heartbeat_nonce(
            env.clone(),
            heartbeat1
        ));

        // Attempt replay attack with same nonce - should fail
        let replay_heartbeat = create_test_heartbeat(meter_id, device_mac.clone(), 0);
        assert!(!NonceSyncManager::verify_heartbeat_nonce(
            env.clone(),
            replay_heartbeat
        ));

        // Verify device state shows desync
        let state = NonceSyncManager::get_device_nonce_state(env.clone(), device_mac.clone());
        assert!(state.desync_count_24h > 0);
    }

    /// Fuzz test: Nonce window validation
    ///
    /// Tests that nonces within the allowed window (+1 to +5) are accepted
    /// while nonces outside the window are rejected.
    #[test]
    fn test_nonce_window_validation() {
        let env = Env::new();
        let contract_address = TestAddress::random(&env);
        env.register_contract(&contract_address, NonceSyncManager);

        let device_mac = TestBytesN::random(&env);
        let meter_id = 12345u64;

        // Initialize device nonce at 100
        NonceSyncManager::initialize_device_nonce(env.clone(), device_mac.clone(), 100);

        // Test nonce within window (should be accepted)
        for offset in 1..=NONCE_WINDOW_SIZE {
            let heartbeat = create_test_heartbeat(meter_id, device_mac.clone(), 100 + offset);
            assert!(NonceSyncManager::verify_heartbeat_nonce(
                env.clone(),
                heartbeat
            ));
        }

        // Test nonce outside window (should be rejected)
        let future_heartbeat =
            create_test_heartbeat(meter_id, device_mac.clone(), 100 + NONCE_WINDOW_SIZE + 1);
        assert!(!NonceSyncManager::verify_heartbeat_nonce(
            env.clone(),
            future_heartbeat
        ));

        // Test old nonce (should be rejected)
        let old_heartbeat = create_test_heartbeat(meter_id, device_mac.clone(), 99);
        assert!(!NonceSyncManager::verify_heartbeat_nonce(
            env.clone(),
            old_heartbeat
        ));
    }

    /// Fuzz test: Network jitter simulation
    ///
    /// Simulates UDP packet loss where nonces arrive out of order
    /// but within the acceptable window.
    #[test]
    fn test_network_jitter_simulation() {
        let env = Env::new();
        let contract_address = TestAddress::random(&env);
        env.register_contract(&contract_address, NonceSyncManager);

        let device_mac = TestBytesN::random(&env);
        let meter_id = 12345u64;

        NonceSyncManager::initialize_device_nonce(env.clone(), device_mac.clone(), 0);

        // Simulate packet loss: nonce 2 arrives before nonce 1
        let heartbeat2 = create_test_heartbeat(meter_id, device_mac.clone(), 2);
        let heartbeat1 = create_test_heartbeat(meter_id, device_mac.clone(), 1);

        // Both should be accepted due to window
        assert!(NonceSyncManager::verify_heartbeat_nonce(
            env.clone(),
            heartbeat2
        ));
        assert!(NonceSyncManager::verify_heartbeat_nonce(
            env.clone(),
            heartbeat1
        ));

        // Verify final state
        let state = NonceSyncManager::get_device_nonce_state(env.clone(), device_mac.clone());
        assert_eq!(state.current_nonce, 3); // Should be max nonce + 1
    }

    /// Fuzz test: Device suspicious marking
    ///
    /// Tests that devices with frequent desyncs are marked as suspicious.
    #[test]
    fn test_device_suspicious_marking() {
        let env = Env::new();
        let contract_address = TestAddress::random(&env);
        env.register_contract(&contract_address, NonceSyncManager);

        let device_mac = TestBytesN::random(&env);
        let meter_id = 12345u64;

        NonceSyncManager::initialize_device_nonce(env.clone(), device_mac.clone(), 0);

        // Generate multiple desync events to trigger suspicious marking
        for i in 0..15 {
            let bad_heartbeat = create_test_heartbeat(meter_id, device_mac.clone(), 0); // Always nonce 0
            NonceSyncManager::verify_heartbeat_nonce(env.clone(), bad_heartbeat);
        }

        // Device should be marked as suspicious
        assert!(NonceSyncManager::is_device_suspicious(
            env.clone(),
            device_mac.clone()
        ));
    }

    /// Fuzz test: Multi-sig nonce reset
    ///
    /// Tests the multi-sig nonce reset functionality for compromised devices.
    #[test]
    fn test_multisig_nonce_reset() {
        let env = Env::new();
        let contract_address = TestAddress::random(&env);
        env.register_contract(&contract_address, NonceSyncManager);

        let device_mac = TestBytesN::random(&env);
        let meter_id = 12345u64;
        let authorized_resetter1 = TestAddress::random(&env);
        let authorized_resetter2 = TestAddress::random(&env);
        let authorized_resetter3 = TestAddress::random(&env);

        // Setup authorized resetters — 3 fixed items, use vec! macro for clarity
        let resetters_key = DataKey::AuthorizedNonceResetters;
        let resetters = soroban_sdk::vec![
            &env,
            authorized_resetter1.clone(),
            authorized_resetter2.clone(),
            authorized_resetter3.clone()
        ];
        env.storage().persistent().set(&resetters_key, &resetters);

        // Initialize device with compromised nonce
        NonceSyncManager::initialize_device_nonce(env.clone(), device_mac.clone(), 1000);

        // Create reset request
        let reset_request = NonceResetRequest {
            meter_id,
            device_mac: device_mac.clone(),
            new_nonce: 0,
            requested_by: authorized_resetter1.clone(),
            approvals: Vec::new(&env),
            required_approvals: 3,
            created_at: env.ledger().timestamp(),
            expires_at: env.ledger().timestamp() + 3600, // 1 hour
            is_executed: false,
        };

        // First approval
        NonceSyncManager::reset_device_nonce(
            env.clone(),
            meter_id,
            device_mac.clone(),
            0,
            reset_request,
            authorized_resetter1.clone(),
        );

        // Second approval
        let stored_request: NonceResetRequest = env
            .storage()
            .persistent()
            .get(&DataKey::NonceResetRequest(meter_id))
            .unwrap();
        NonceSyncManager::reset_device_nonce(
            env.clone(),
            meter_id,
            device_mac.clone(),
            0,
            stored_request,
            authorized_resetter2.clone(),
        );

        // Third approval should execute reset
        let stored_request: NonceResetRequest = env
            .storage()
            .persistent()
            .get(&DataKey::NonceResetRequest(meter_id))
            .unwrap();
        NonceSyncManager::reset_device_nonce(
            env.clone(),
            meter_id,
            device_mac.clone(),
            0,
            stored_request,
            authorized_resetter3.clone(),
        );

        // Verify nonce was reset
        let state = NonceSyncManager::get_device_nonce_state(env.clone(), device_mac.clone());
        assert_eq!(state.current_nonce, 0);
        assert_eq!(state.desync_count_24h, 0);
        assert!(!state.is_suspicious);
    }

    /// Fuzz test: Edge case - very large nonce values
    ///
    /// Tests behavior with near-u64::MAX nonce values to prevent overflow.
    #[test]
    fn test_large_nonce_values() {
        let env = Env::new();
        let contract_address = TestAddress::random(&env);
        env.register_contract(&contract_address, NonceSyncManager);

        let device_mac = TestBytesN::random(&env);
        let meter_id = 12345u64;

        // Initialize with very large nonce
        let large_nonce = u64::MAX - 10;
        NonceSyncManager::initialize_device_nonce(env.clone(), device_mac.clone(), large_nonce);

        // Test increment near overflow boundary
        let heartbeat = create_test_heartbeat(meter_id, device_mac.clone(), large_nonce);
        assert!(NonceSyncManager::verify_heartbeat_nonce(
            env.clone(),
            heartbeat
        ));

        // Verify state handles overflow correctly
        let state = NonceSyncManager::get_device_nonce_state(env.clone(), device_mac.clone());
        assert_eq!(state.current_nonce, large_nonce + 1);
    }

    /// Fuzz test: Concurrent heartbeat processing
    ///
    /// Simulates multiple heartbeats arriving simultaneously
    /// to test race condition handling.
    #[test]
    fn test_concurrent_heartbeat_processing() {
        let env = Env::new();
        let contract_address = TestAddress::random(&env);
        env.register_contract(&contract_address, NonceSyncManager);

        let device_mac = TestBytesN::random(&env);
        let meter_id = 12345u64;

        NonceSyncManager::initialize_device_nonce(env.clone(), device_mac.clone(), 0);

        // Send multiple heartbeats with different nonces
        let heartbeats = vec![
            create_test_heartbeat(meter_id, device_mac.clone(), 1),
            create_test_heartbeat(meter_id, device_mac.clone(), 2),
            create_test_heartbeat(meter_id, device_mac.clone(), 3),
            create_test_heartbeat(meter_id, device_mac.clone(), 4),
            create_test_heartbeat(meter_id, device_mac.clone(), 5),
        ];

        // Process all heartbeats
        let mut successful_count = 0;
        for heartbeat in heartbeats {
            if NonceSyncManager::verify_heartbeat_nonce(env.clone(), heartbeat) {
                successful_count += 1;
            }
        }

        // At least some should succeed
        assert!(successful_count > 0);

        // Final state should be consistent
        let state = NonceSyncManager::get_device_nonce_state(env.clone(), device_mac.clone());
        assert!(state.current_nonce > 0);
    }
}

/// Helper function to create test heartbeat
pub(crate) fn create_test_heartbeat(
    meter_id: u64,
    device_mac: BytesN<32>,
    nonce: u64,
) -> SignedHeartbeat {
    let env = Env::new();
    SignedHeartbeat {
        meter_id,
        device_mac,
        nonce,
        timestamp: env.ledger().timestamp(),
        signature: BytesN::from_array(&[1u8; 64]),
        public_key: BytesN::from_array(&[2u8; 32]),
    }
}

/// Issue #22: Re-organization replay protection tests.
///
/// These tests exercise the confirmation-gated two-phase billing path that
/// prevents a Stellar network re-organization from enabling double-billing.
#[cfg(test)]
mod reorg_protection_tests {
    use super::*;
    use crate::nonce_sync::{
        has_sufficient_confirmations, is_future_ledger, SignedTelemetry, MIN_LEDGER_CONFIRMATIONS,
    };

    fn set_sequence(env: &Env, seq: u32) {
        env.ledger().with_mut(|li| {
            li.sequence_number = seq;
        });
    }

    fn make_telemetry(
        env: &Env,
        meter_id: u64,
        device_mac: BytesN<32>,
        nonce: u64,
        reading: i128,
        ledger_seq: u32,
    ) -> SignedTelemetry {
        SignedTelemetry {
            meter_id,
            device_mac,
            nonce,
            reading,
            ledger_seq,
            timestamp: 0,
            signature: BytesN::from_array(env, &[1u8; 64]),
            public_key: BytesN::from_array(env, &[2u8; 32]),
        }
    }

    // -- pure helper logic -------------------------------------------------

    #[test]
    fn test_confirmation_depth_logic() {
        // Observed at 100, current 102 → only 2 confirmations, not enough.
        assert!(!has_sufficient_confirmations(102, 100, MIN_LEDGER_CONFIRMATIONS));
        // Observed at 100, current 103 → exactly 3 confirmations, enough.
        assert!(has_sufficient_confirmations(103, 100, MIN_LEDGER_CONFIRMATIONS));
        // A sequence rollback (current < observed) must not underflow.
        assert!(!has_sufficient_confirmations(99, 100, MIN_LEDGER_CONFIRMATIONS));
    }

    #[test]
    fn test_future_ledger_logic() {
        assert!(is_future_ledger(100, 101));
        assert!(!is_future_ledger(100, 100));
        assert!(!is_future_ledger(100, 99));
    }

    // -- contract-level re-org scenarios -----------------------------------

    /// Blueprint step 4: a finalized (device, nonce) survives a re-org that
    /// rolls the ledger back by 3 — resubmission is rejected, no double bill.
    #[test]
    fn test_reorg_resubmission_rejected_after_finalization() {
        let env = Env::default();
        let contract_address = TestAddress::generate(&env);
        env.register_contract(&contract_address, NonceSyncManager);

        let device_mac = TestBytesN::generate(&env);
        let meter_id = 12345u64;
        NonceSyncManager::initialize_device_nonce(env.clone(), device_mac.clone(), 0);

        // Submit at ledger 100.
        set_sequence(&env, 100);
        let telemetry = make_telemetry(&env, meter_id, device_mac.clone(), 0, 500, 100);
        NonceSyncManager::submit_billable_telemetry(env.clone(), telemetry.clone()).unwrap();

        // Bury it under 3 confirmations and finalize → exactly one billing action.
        set_sequence(&env, 103);
        let actions = NonceSyncManager::finalize_confirmed_telemetry(env.clone(), device_mac.clone());
        assert_eq!(actions.len(), 1);
        assert_eq!(actions.get(0).unwrap().reading, 500);
        assert!(NonceSyncManager::was_nonce_processed(
            env.clone(),
            device_mac.clone(),
            0
        ));

        // Re-org: roll the ledger back by 3 and replay the same telemetry.
        set_sequence(&env, 100);
        let replay = make_telemetry(&env, meter_id, device_mac.clone(), 0, 500, 100);
        let result = NonceSyncManager::submit_billable_telemetry(env.clone(), replay);
        assert_eq!(result, Err(ContractError::NonceAlreadyProcessed));
    }

    /// Telemetry must not be billable until it has enough confirmations. A
    /// re-org before finalization is harmless because nothing was charged.
    #[test]
    fn test_no_billing_before_confirmation_depth() {
        let env = Env::default();
        let contract_address = TestAddress::generate(&env);
        env.register_contract(&contract_address, NonceSyncManager);

        let device_mac = TestBytesN::generate(&env);
        let meter_id = 7u64;
        NonceSyncManager::initialize_device_nonce(env.clone(), device_mac.clone(), 0);

        set_sequence(&env, 100);
        let telemetry = make_telemetry(&env, meter_id, device_mac.clone(), 0, 900, 100);
        NonceSyncManager::submit_billable_telemetry(env.clone(), telemetry).unwrap();

        // Only 2 confirmations → nothing finalized, nothing billed.
        set_sequence(&env, 102);
        let actions = NonceSyncManager::finalize_confirmed_telemetry(env.clone(), device_mac.clone());
        assert_eq!(actions.len(), 0);
        assert!(!NonceSyncManager::was_nonce_processed(
            env.clone(),
            device_mac.clone(),
            0
        ));
        // Entry is still pending.
        assert_eq!(
            NonceSyncManager::get_pending_telemetry(env.clone(), device_mac.clone()).len(),
            1
        );

        // After enough confirmations it bills exactly once.
        set_sequence(&env, 103);
        let actions = NonceSyncManager::finalize_confirmed_telemetry(env.clone(), device_mac.clone());
        assert_eq!(actions.len(), 1);
        // Repeated finalization is idempotent — no second charge.
        let again = NonceSyncManager::finalize_confirmed_telemetry(env.clone(), device_mac.clone());
        assert_eq!(again.len(), 0);
    }

    /// Telemetry claiming a ledger ahead of the current one is rejected.
    #[test]
    fn test_future_dated_telemetry_rejected() {
        let env = Env::default();
        let contract_address = TestAddress::generate(&env);
        env.register_contract(&contract_address, NonceSyncManager);

        let device_mac = TestBytesN::generate(&env);
        NonceSyncManager::initialize_device_nonce(env.clone(), device_mac.clone(), 0);

        set_sequence(&env, 100);
        let telemetry = make_telemetry(&env, 1, device_mac.clone(), 0, 100, 105);
        let result = NonceSyncManager::submit_billable_telemetry(env.clone(), telemetry);
        assert_eq!(result, Err(ContractError::TelemetryFromFutureLedger));
    }

    /// Double-submitting the same nonce before confirmation is rejected.
    #[test]
    fn test_duplicate_pending_nonce_rejected() {
        let env = Env::default();
        let contract_address = TestAddress::generate(&env);
        env.register_contract(&contract_address, NonceSyncManager);

        let device_mac = TestBytesN::generate(&env);
        NonceSyncManager::initialize_device_nonce(env.clone(), device_mac.clone(), 0);

        set_sequence(&env, 100);
        let t1 = make_telemetry(&env, 1, device_mac.clone(), 0, 100, 100);
        NonceSyncManager::submit_billable_telemetry(env.clone(), t1).unwrap();

        let t2 = make_telemetry(&env, 1, device_mac.clone(), 0, 100, 100);
        let result = NonceSyncManager::submit_billable_telemetry(env.clone(), t2);
        assert_eq!(result, Err(ContractError::NonceAlreadyProcessed));
    }
}

/// Property-based test: Nonce monotonicity
///
/// This test verifies that the nonce system maintains strict monotonicity
/// and prevents any form of nonce reuse or manipulation.
#[cfg(test)]
mod property_tests {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(1000))]

        #[test]
        fn test_nonce_monotonicity_property(
            initial_nonce in 0u64..1000u64,
            nonce_sequence in prop::collection::vec(0u64..2000u64, 10..50)
        ) {
            let env = Env::new();
            let contract_address = TestAddress::random(&env);
            env.register_contract(&contract_address, NonceSyncManager);

            let device_mac = TestBytesN::random(&env);
            let meter_id = 12345u64;

            NonceSyncManager::initialize_device_nonce(env.clone(), device_mac.clone(), initial_nonce);

            let mut max_nonce = initial_nonce;
            let mut successful_verifications = 0;

            for nonce in nonce_sequence {
                let heartbeat = create_test_heartbeat(meter_id, device_mac.clone(), nonce);

                if NonceSyncManager::verify_heartbeat_nonce(env.clone(), heartbeat) {
                    successful_verifications += 1;
                    prop_assert!(nonce >= max_nonce);
                    max_nonce = nonce;
                }
            }

            // Final state should reflect highest successful nonce
            let final_state = NonceSyncManager::get_device_nonce_state(env.clone(), device_mac.clone());
            prop_assert!(final_state.current_nonce >= max_nonce);
        }
    }
}
