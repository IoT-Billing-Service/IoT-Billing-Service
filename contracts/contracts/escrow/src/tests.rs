//! Tests for the Soroban Escrow-Based Payment Settlement contract (Issue #2).
//!
//! Coverage:
//!  - Escrow lifecycle: initialize, deposit errors, get_escrow_balance, get_escrow_info
//!  - Error paths: double-initialize, negative amount, insufficient balance
//!  - Meter billing: register_meter, charge_meter_usage error paths, get_meter_usage
//!  - Group / fleet billing: register_group, charge_group_usage error paths, get_group_usage
//!  - Fee recipient: set_fee_recipient, get_fee_recipient
//!  - Authorizer: set_authorizer
//!  - execute_release: error paths (no authorizer, no escrow)
//!  - Multi-escrow independence

#![cfg(test)]

extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, BytesN, Env, String,
};

use crate::{ContractError, EscrowContract, EscrowContractClient};

// ── Helpers ────────────────────────────────────────────────────────────────────

/// Stand-in wasm hash for tests — 32 bytes of 0xAB.
fn dummy_wasm_hash(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0xAB_u8; 32])
}

/// Create a fresh environment with a deployed EscrowContract.
fn setup() -> (Env, EscrowContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();

    // Advance ledger timestamp so epoch fields are non-zero.
    env.ledger().with_mut(|li| {
        li.timestamp = 1_700_000_000;
    });

    let contract_id = env.register(EscrowContract, (dummy_wasm_hash(&env),));
    let client = EscrowContractClient::new(&env, &contract_id);

    (env, client)
}

// ---------------------------------------------------------------------------
// Escrow lifecycle
// ---------------------------------------------------------------------------

#[test]
fn test_initialize_escrow_returns_id_zero() {
    let (env, client) = setup();
    let user = Address::generate(&env);
    let token = Address::generate(&env);

    // initialize_escrow returns Result<u64, ContractError>; the generated
    // client's non-try method panics on error and returns u64 directly.
    let escrow_id = client.initialize_escrow(&user, &token);
    assert_eq!(escrow_id, 0u64);
}

#[test]
fn test_initialize_two_escrows_returns_incrementing_ids() {
    let (env, client) = setup();
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    let token = Address::generate(&env);

    let id1 = client.initialize_escrow(&user1, &token);
    let id2 = client.initialize_escrow(&user2, &token);

    assert_eq!(id1, 0u64);
    assert_eq!(id2, 1u64);
}

#[test]
fn test_double_initialize_same_user_token_returns_error() {
    let (env, client) = setup();
    let user = Address::generate(&env);
    let token = Address::generate(&env);

    client.initialize_escrow(&user, &token);
    let result = client.try_initialize_escrow(&user, &token);
    assert_eq!(result, Err(Ok(ContractError::AlreadyInitialized)));
}

#[test]
fn test_same_user_different_tokens_can_have_separate_escrows() {
    let (env, client) = setup();
    let user = Address::generate(&env);
    let token_a = Address::generate(&env);
    let token_b = Address::generate(&env);

    let id_a = client.initialize_escrow(&user, &token_a);
    let id_b = client.initialize_escrow(&user, &token_b);
    // Both should succeed with different IDs.
    assert_ne!(id_a, id_b);
}

// ---------------------------------------------------------------------------
// get_escrow_balance / get_escrow_info
// ---------------------------------------------------------------------------

#[test]
fn test_get_escrow_balance_returns_zero_for_unregistered_user() {
    let (env, client) = setup();
    let user = Address::generate(&env);
    let token = Address::generate(&env);

    let balance = client.get_escrow_balance(&user, &token);
    assert_eq!(balance, 0i128);
}

#[test]
fn test_get_escrow_info_returns_none_for_unregistered_user() {
    let (env, client) = setup();
    let user = Address::generate(&env);
    let token = Address::generate(&env);

    let info = client.get_escrow_info(&user, &token);
    assert!(info.is_none());
}

#[test]
fn test_get_escrow_info_after_initialize_shows_zero_balance() {
    let (env, client) = setup();
    let user = Address::generate(&env);
    let token = Address::generate(&env);

    client.initialize_escrow(&user, &token);

    let info = client.get_escrow_info(&user, &token).unwrap();
    assert_eq!(info.total_locked, 0i128);
    assert_eq!(info.last_deposit_epoch, 1_700_000_000u64);
}

// ---------------------------------------------------------------------------
// Deposit error paths
// ---------------------------------------------------------------------------

#[test]
fn test_deposit_negative_amount_returns_error() {
    let (env, client) = setup();
    let user = Address::generate(&env);
    let token = Address::generate(&env);

    client.initialize_escrow(&user, &token);

    let result = client.try_deposit(&user, &token, &(-100i128));
    assert_eq!(result, Err(Ok(ContractError::NegativeAmount)));
}

#[test]
fn test_deposit_zero_amount_returns_error() {
    let (env, client) = setup();
    let user = Address::generate(&env);
    let token = Address::generate(&env);

    client.initialize_escrow(&user, &token);

    let result = client.try_deposit(&user, &token, &0i128);
    assert_eq!(result, Err(Ok(ContractError::NegativeAmount)));
}

#[test]
fn test_deposit_without_escrow_returns_not_found() {
    let (env, client) = setup();
    let user = Address::generate(&env);
    let token = Address::generate(&env);
    // No initialize_escrow call.

    let result = client.try_deposit(&user, &token, &1000i128);
    assert_eq!(result, Err(Ok(ContractError::EscrowNotFound)));
}

// ---------------------------------------------------------------------------
// Meter billing
// ---------------------------------------------------------------------------

#[test]
fn test_register_meter_succeeds() {
    let (env, client) = setup();
    let consumer = Address::generate(&env);
    let token = Address::generate(&env);
    let device_id = String::from_str(&env, "MTR-001");

    client.register_meter(&device_id, &consumer, &token);

    let usage = client.get_meter_usage(&device_id).unwrap();
    assert_eq!(usage.consumer, consumer);
    assert_eq!(usage.token, token);
    assert_eq!(usage.total_charged, 0i128);
}

#[test]
fn test_register_meter_twice_returns_already_initialized() {
    let (env, client) = setup();
    let consumer = Address::generate(&env);
    let token = Address::generate(&env);
    let device_id = String::from_str(&env, "MTR-DUPE");

    client.register_meter(&device_id, &consumer, &token);
    let result = client.try_register_meter(&device_id, &consumer, &token);
    assert_eq!(result, Err(Ok(ContractError::AlreadyInitialized)));
}

#[test]
fn test_get_meter_usage_returns_none_for_unregistered_meter() {
    let (env, client) = setup();
    let device_id = String::from_str(&env, "MTR-GHOST");

    let result = client.get_meter_usage(&device_id);
    assert!(result.is_none());
}

#[test]
fn test_charge_meter_without_registration_returns_meter_not_found() {
    let (env, client) = setup();
    let consumer = Address::generate(&env);
    let device_id = String::from_str(&env, "MTR-UNREGISTERED");

    let result = client.try_charge_meter_usage(&device_id, &consumer, &500i128);
    assert_eq!(result, Err(Ok(ContractError::MeterNotFound)));
}

#[test]
fn test_charge_meter_without_escrow_returns_escrow_not_found() {
    let (env, client) = setup();
    let consumer = Address::generate(&env);
    let token = Address::generate(&env);
    let device_id = String::from_str(&env, "MTR-NOESCROW");

    client.register_meter(&device_id, &consumer, &token);

    let result = client.try_charge_meter_usage(&device_id, &consumer, &100i128);
    assert_eq!(result, Err(Ok(ContractError::EscrowNotFound)));
}

#[test]
fn test_charge_meter_negative_amount_returns_error() {
    let (env, client) = setup();
    let consumer = Address::generate(&env);
    let token = Address::generate(&env);
    let device_id = String::from_str(&env, "MTR-NEG");

    client.initialize_escrow(&consumer, &token);
    client.register_meter(&device_id, &consumer, &token);

    let result = client.try_charge_meter_usage(&device_id, &consumer, &(-50i128));
    assert_eq!(result, Err(Ok(ContractError::NegativeAmount)));
}

#[test]
fn test_charge_meter_with_insufficient_balance_returns_error() {
    let (env, client) = setup();
    let consumer = Address::generate(&env);
    let token = Address::generate(&env);
    let device_id = String::from_str(&env, "MTR-INSUF");

    client.initialize_escrow(&consumer, &token);
    client.register_meter(&device_id, &consumer, &token);

    // Escrow has 0 balance — any positive charge should fail.
    let result = client.try_charge_meter_usage(&device_id, &consumer, &100i128);
    assert_eq!(result, Err(Ok(ContractError::InsufficientBalance)));
}

#[test]
fn test_charge_meter_wrong_consumer_returns_unauthorized() {
    let (env, client) = setup();
    let real_consumer = Address::generate(&env);
    let attacker = Address::generate(&env);
    let token = Address::generate(&env);
    let device_id = String::from_str(&env, "MTR-AUTH");

    client.initialize_escrow(&real_consumer, &token);
    client.register_meter(&device_id, &real_consumer, &token);

    let result = client.try_charge_meter_usage(&device_id, &attacker, &100i128);
    assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
}

// ---------------------------------------------------------------------------
// Group / fleet billing
// ---------------------------------------------------------------------------

#[test]
fn test_register_group_succeeds() {
    let (env, client) = setup();
    let manager = Address::generate(&env);
    let token = Address::generate(&env);
    let group_id = String::from_str(&env, "FLEET-001");

    client.register_group(&group_id, &manager, &token, &5u32);

    let usage = client.get_group_usage(&group_id).unwrap();
    assert_eq!(usage.manager, manager);
    assert_eq!(usage.member_count, 5u32);
    assert_eq!(usage.total_charged, 0i128);
}

#[test]
fn test_register_group_twice_returns_already_initialized() {
    let (env, client) = setup();
    let manager = Address::generate(&env);
    let token = Address::generate(&env);
    let group_id = String::from_str(&env, "FLEET-DUPE");

    client.register_group(&group_id, &manager, &token, &3u32);
    let result = client.try_register_group(&group_id, &manager, &token, &3u32);
    assert_eq!(result, Err(Ok(ContractError::AlreadyInitialized)));
}

#[test]
fn test_get_group_usage_returns_none_for_unregistered_group() {
    let (env, client) = setup();
    let group_id = String::from_str(&env, "FLEET-GHOST");

    let result = client.get_group_usage(&group_id);
    assert!(result.is_none());
}

#[test]
fn test_charge_group_without_registration_returns_not_found() {
    let (env, client) = setup();
    let manager = Address::generate(&env);
    let group_id = String::from_str(&env, "FLEET-UNREGISTERED");

    let result = client.try_charge_group_usage(&group_id, &manager, &1000i128);
    assert_eq!(result, Err(Ok(ContractError::GroupNotFound)));
}

#[test]
fn test_charge_group_without_escrow_returns_escrow_not_found() {
    let (env, client) = setup();
    let manager = Address::generate(&env);
    let token = Address::generate(&env);
    let group_id = String::from_str(&env, "FLEET-NOESCROW");

    client.register_group(&group_id, &manager, &token, &10u32);

    let result = client.try_charge_group_usage(&group_id, &manager, &500i128);
    assert_eq!(result, Err(Ok(ContractError::EscrowNotFound)));
}

#[test]
fn test_charge_group_wrong_manager_returns_unauthorized() {
    let (env, client) = setup();
    let real_manager = Address::generate(&env);
    let attacker = Address::generate(&env);
    let token = Address::generate(&env);
    let group_id = String::from_str(&env, "FLEET-AUTH");

    client.initialize_escrow(&real_manager, &token);
    client.register_group(&group_id, &real_manager, &token, &4u32);

    let result = client.try_charge_group_usage(&group_id, &attacker, &100i128);
    assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
}

#[test]
fn test_charge_group_negative_amount_returns_error() {
    let (env, client) = setup();
    let manager = Address::generate(&env);
    let token = Address::generate(&env);
    let group_id = String::from_str(&env, "FLEET-NEG");

    client.initialize_escrow(&manager, &token);
    client.register_group(&group_id, &manager, &token, &2u32);

    let result = client.try_charge_group_usage(&group_id, &manager, &(-100i128));
    assert_eq!(result, Err(Ok(ContractError::NegativeAmount)));
}

#[test]
fn test_charge_group_insufficient_balance_returns_error() {
    let (env, client) = setup();
    let manager = Address::generate(&env);
    let token = Address::generate(&env);
    let group_id = String::from_str(&env, "FLEET-INSUF");

    client.initialize_escrow(&manager, &token);
    client.register_group(&group_id, &manager, &token, &2u32);

    let result = client.try_charge_group_usage(&group_id, &manager, &100i128);
    assert_eq!(result, Err(Ok(ContractError::InsufficientBalance)));
}

// ---------------------------------------------------------------------------
// Fee recipient
// ---------------------------------------------------------------------------

#[test]
fn test_get_fee_recipient_returns_none_when_not_set() {
    let (_env, client) = setup();
    let recipient = client.get_fee_recipient();
    assert!(recipient.is_none());
}

#[test]
fn test_set_and_get_fee_recipient() {
    let (env, client) = setup();
    let recipient = Address::generate(&env);

    client.set_fee_recipient(&recipient);

    let stored = client.get_fee_recipient().unwrap();
    assert_eq!(stored, recipient);
}

// ---------------------------------------------------------------------------
// Authorizer
// ---------------------------------------------------------------------------

#[test]
fn test_set_authorizer_succeeds_when_no_escrows_active() {
    let (env, client) = setup();
    let authorizer = Address::generate(&env);

    // total_locked is 0 so it should succeed.
    client.set_authorizer(&authorizer);
}

// ---------------------------------------------------------------------------
// execute_release error paths
// ---------------------------------------------------------------------------

#[test]
fn test_execute_release_without_authorizer_set_returns_error() {
    let (env, client) = setup();
    let recipient = Address::generate(&env);

    let result = client.try_execute_release(&0u64, &500i128, &recipient);
    assert_eq!(result, Err(Ok(ContractError::AuthorizerNotSet)));
}

#[test]
fn test_execute_release_on_nonexistent_escrow_returns_error() {
    let (env, client) = setup();
    let authorizer = Address::generate(&env);
    let recipient = Address::generate(&env);

    client.set_authorizer(&authorizer);

    // No escrow with id=42 exists — should fail.
    let result = client.try_execute_release(&42u64, &100i128, &recipient);
    assert!(result.is_err());
}

// ---------------------------------------------------------------------------
// Multi-escrow independence
// ---------------------------------------------------------------------------

#[test]
fn test_multiple_escrows_have_independent_balances() {
    let (env, client) = setup();
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    let token = Address::generate(&env);

    client.initialize_escrow(&user1, &token);
    client.initialize_escrow(&user2, &token);

    // Neither has been deposited into, so both are 0.
    assert_eq!(client.get_escrow_balance(&user1, &token), 0i128);
    assert_eq!(client.get_escrow_balance(&user2, &token), 0i128);
}

#[test]
fn test_multiple_meters_are_independent() {
    let (env, client) = setup();
    let consumer = Address::generate(&env);
    let token = Address::generate(&env);
    let dev_a = String::from_str(&env, "MTR-A");
    let dev_b = String::from_str(&env, "MTR-B");

    client.register_meter(&dev_a, &consumer, &token);
    client.register_meter(&dev_b, &consumer, &token);

    let ua = client.get_meter_usage(&dev_a).unwrap();
    let ub = client.get_meter_usage(&dev_b).unwrap();
    assert_eq!(ua.total_charged, 0i128);
    assert_eq!(ub.total_charged, 0i128);
}

#[test]
fn test_meter_and_group_can_coexist_for_same_consumer() {
    let (env, client) = setup();
    let consumer = Address::generate(&env);
    let token = Address::generate(&env);
    let device_id = String::from_str(&env, "MTR-COEXIST");
    let group_id = String::from_str(&env, "FLEET-COEXIST");

    client.initialize_escrow(&consumer, &token);
    client.register_meter(&device_id, &consumer, &token);
    client.register_group(&group_id, &consumer, &token, &1u32);

    assert!(client.get_meter_usage(&device_id).is_some());
    assert!(client.get_group_usage(&group_id).is_some());
}

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

#[test]
fn test_different_device_ids_produce_different_registrations() {
    let (env, client) = setup();
    let consumer = Address::generate(&env);
    let token = Address::generate(&env);

    for i in 0..5u32 {
        let id_str = std::format!("MTR-{i:04}");
        let device_id = String::from_str(&env, &id_str);
        client.register_meter(&device_id, &consumer, &token);
    }

    // All 5 meters should be independently registered.
    for i in 0..5u32 {
        let id_str = std::format!("MTR-{i:04}");
        let device_id = String::from_str(&env, &id_str);
        assert!(client.get_meter_usage(&device_id).is_some());
    }
}

#[test]
fn test_escrow_info_epoch_is_set_at_initialization() {
    let (env, client) = setup();
    let user = Address::generate(&env);
    let token = Address::generate(&env);

    client.initialize_escrow(&user, &token);

    let info = client.get_escrow_info(&user, &token).unwrap();
    // epoch should match the ledger timestamp we set in setup().
    assert_eq!(info.last_deposit_epoch, 1_700_000_000u64);
}

#[test]
fn test_escrow_counter_increments_sequentially() {
    let (env, client) = setup();
    let token = Address::generate(&env);

    // Create 5 escrows for 5 different users.
    let mut ids = std::vec![];
    for _ in 0..5 {
        let user = Address::generate(&env);
        let id = client.initialize_escrow(&user, &token);
        ids.push(id);
    }

    // IDs should be 0, 1, 2, 3, 4.
    for (i, id) in ids.iter().enumerate() {
        assert_eq!(*id, i as u64);
    }
}
