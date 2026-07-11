#![cfg(test)]

use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{token, Address, Bytes, BytesN, Env, Vec};
use utility_contracts::{PrivateBillingStatus, UtilityContractClient};

// Simple test to verify ZK privacy implementation compiles and works
#[test]
fn test_zk_privacy_basic() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(UtilityContractClient, ());
    let client = UtilityContractClient::new(&env, &contract_id);

    let user = Address::generate(&env);
    let provider = Address::generate(&env);
    let token = Address::generate(&env);

    let device_public_key = BytesN::from_array(&env, &[1u8; 32]);

    // Register a meter first
    let meter_id = client.register_meter(&user, &provider, &10, &token, &device_public_key);

    // Enable privacy mode
    client.enable_privacy_mode(&meter_id);

    // Verify privacy is enabled
    assert!(client.is_privacy_enabled(&meter_id));

    // Check private billing status
    let status = client.get_private_billing_status(&meter_id);
    assert_eq!(status.meter_id, meter_id);
    assert_eq!(status.billing_cycle, 1);
    assert_eq!(status.total_commitments, 0);
    assert_eq!(status.verified_proofs, 0);
    assert!(status.privacy_enabled);

    // Disable privacy mode
    client.disable_privacy_mode(&meter_id);

    // Verify privacy is disabled
    assert!(!client.is_privacy_enabled(&meter_id));

    println!("✅ ZK privacy basic functionality test passed!");
}

#[test]
fn test_zk_privacy_without_enabling() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(UtilityContractClient, ());
    let client = UtilityContractClient::new(&env, &contract_id);

    let user = Address::generate(&env);
    let provider = Address::generate(&env);
    let token = Address::generate(&env);

    let device_public_key = BytesN::from_array(&env, &[1u8; 32]);

    // Register a meter first
    let meter_id = client.register_meter(&user, &provider, &10, &token, &device_public_key);

    // Try to submit ZK report without enabling privacy - should fail
    let commitment = BytesN::from_array(&env, &[1u8; 32]);
    let nullifier = BytesN::from_array(&env, &[2u8; 32]);
    let encrypted_usage = Bytes::from_slice(&env, b"encrypted_usage_data");
    let proof_hash = BytesN::from_array(&env, &[3u8; 32]);

    let result = env.try_invoke_contract::<_, ()>(
        &contract_id,
        &soroban_sdk::Symbol::new(&env, "submit_zk_usage_report"),
        (meter_id, commitment, nullifier, encrypted_usage, proof_hash),
    );

    // Should fail with PrivacyNotEnabled error
    assert!(result.is_err());

    println!("✅ ZK privacy error handling test passed!");
}
