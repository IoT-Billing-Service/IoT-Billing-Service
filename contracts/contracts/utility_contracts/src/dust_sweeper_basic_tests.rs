#![cfg(test)]

use crate::*;
use soroban_sdk::{symbol_short, Address, Env};

#[test]
fn test_dust_detection_logic() {
    // Test the dust detection function directly
    assert!(is_dust_amount(0) == false); // 0 is not dust
    assert!(is_dust_amount(1) == false); // 1 stroop is not dust (equal to minimum increment)
    assert!(is_dust_amount(-1) == false); // negative amounts are not dust
    // Since XLM_MINIMUM_INCREMENT = 1, there's no amount that would be < 1 but > 0
    // This is expected behavior for XLM with 7 decimal places
}

#[test]
fn test_dust_aggregation_creation() {
    let env = Env::default();
    let token_address = Address::generate(&env);
    
    // Test creating new aggregation
    let aggregation = get_or_create_dust_aggregation(&env, &token_address);
    assert_eq!(aggregation.total_dust, 0);
    assert_eq!(aggregation.stream_count, 0);
    assert!(aggregation.last_updated > 0);
}

#[test]
fn test_dust_aggregation_update() {
    let env = Env::default();
    let token_address = Address::generate(&env);
    
    // Update aggregation
    update_dust_aggregation(&env, &token_address, 5, 3);
    
    // Verify update
    let updated = get_or_create_dust_aggregation(&env, &token_address);
    assert_eq!(updated.total_dust, 5);
    assert_eq!(updated.stream_count, 3);
}

#[test]
fn test_admin_functions() {
    let env = Env::default();
    let contract_id = env.register_contract(None, UtilityContract);
    let client = UtilityContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    
    // Set admin
    client.set_admin(&admin);
    
    // Fund gas bounty
    client.fund_gas_bounty(&1000000);
    
    // Verify admin is set
    let stored_admin = env.storage().instance()
        .get::<DataKey, Address>(&DataKey::AdminAddress)
        .unwrap();
    assert_eq!(stored_admin, admin);
    
    // Verify bounty is funded
    let bounty = env.storage().instance()
        .get::<DataKey, i128>(&DataKey::GasBountyPool)
        .unwrap();
    assert_eq!(bounty, 1000000);
}

#[test]
fn test_stream_creation_and_dust_detection() {
    let env = Env::default();
    let contract_id = env.register_contract(None, UtilityContract);
    let client = UtilityContractClient::new(&env, &contract_id);

    // Create a stream
    let stream_id = 1u64;
    client.create_continuous_stream(&stream_id, &1000, &5000);
    
    // Get the stream
    let flow = client.get_continuous_flow(&stream_id);
    assert!(flow.is_some());
    
    let flow_data = flow.unwrap();
    assert_eq!(flow_data.stream_id, stream_id);
    assert_eq!(flow_data.flow_rate_per_second, 1000);
    assert_eq!(flow_data.accumulated_balance, 5000);
}

#[test]
fn test_dust_collection_event_structure() {
    let env = Env::default();
    let token_address = Address::generate(&env);
    let sweeper_address = Address::generate(&env);
    
    // Create dust collection event
    let event = DustCollectedEvent {
        token_address: token_address.clone(),
        total_dust_swept: 1000,
        streams_swept: 5,
        timestamp: env.ledger().timestamp(),
        sweeper_address: sweeper_address.clone(),
    };
    
    // Verify event structure
    assert_eq!(event.token_address, token_address);
    assert_eq!(event.total_dust_swept, 1000);
    assert_eq!(event.streams_swept, 5);
    assert_eq!(event.sweeper_address, sweeper_address);
}
