#![cfg(test)]

use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{token, Address, Bytes, BytesN, Env, Vec};
use utility_contracts::{
    ContractError, DataKey, MeterStatus, PrivateBillingStatus, UtilityContractClient, ZKProof,
    ZKUsageReport,
};

// --- Helpers ---
fn device_key(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

fn create_token(env: &Env) -> Address {
    let admin = Address::generate(env);
    env.register_stellar_asset_contract_v2(admin).address()
}

fn create_test_meter(
    env: &Env,
    client: &UtilityContractClient,
    user: Address,
    provider: Address,
    token: Address,
) -> u64 {
    let device_public_key = BytesN::from_array(env, &[1u8; 32]);
    client.register_meter(&user, &provider, &10, &token, &device_public_key)
}

#[test]
fn test_enable_privacy_mode() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(UtilityContractClient, ());
    let client = UtilityContractClient::new(&env, &contract_id);

    let user = Address::generate(&env);
    let provider = Address::generate(&env);
    let token = create_token(&env);

    let meter_id = create_test_meter(&env, &client, user.clone(), provider.clone(), token);

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
}

#[test]
fn test_disable_privacy_mode() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(UtilityContractClient, ());
    let client = UtilityContractClient::new(&env, &contract_id);

    let user = Address::generate(&env);
    let provider = Address::generate(&env);
    let token = create_token(&env);

    let meter_id = create_test_meter(&env, &client, user.clone(), provider.clone(), token);

    // Enable privacy mode first
    client.enable_privacy_mode(&meter_id);
    assert!(client.is_privacy_enabled(&meter_id));

    // Disable privacy mode
    client.disable_privacy_mode(&meter_id);
    assert!(!client.is_privacy_enabled(&meter_id));
}

#[test]
fn test_submit_zk_usage_report() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(UtilityContractClient, ());
    let client = UtilityContractClient::new(&env, &contract_id);

    let user = Address::generate(&env);
    let provider = Address::generate(&env);
    let token = create_token(&env);

    let meter_id = create_test_meter(&env, &client, user.clone(), provider.clone(), token);

    // Enable privacy mode
    client.enable_privacy_mode(&meter_id);

    // Create test ZK report data
    let commitment = BytesN::from_array(&env, &[1u8; 32]);
    let nullifier = BytesN::from_array(&env, &[2u8; 32]);
    let encrypted_usage = Bytes::from_slice(&env, b"encrypted_usage_data");
    let proof_hash = BytesN::from_array(&env, &[3u8; 32]);

    // Submit ZK usage report
    client.submit_zk_usage_report(
        &meter_id,
        &commitment,
        &nullifier,
        &encrypted_usage,
        &proof_hash,
    );

    // Verify the report was stored
    let status = client.get_private_billing_status(&meter_id);
    assert_eq!(status.total_commitments, 1);
    assert_eq!(status.verified_proofs, 0);
}

#[test]
fn test_nullifier_prevention() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(UtilityContractClient, ());
    let client = UtilityContractClient::new(&env, &contract_id);

    let user = Address::generate(&env);
    let provider = Address::generate(&env);
    let token = create_token(&env);

    let meter_id = create_test_meter(&env, &client, user.clone(), provider.clone(), token);

    // Enable privacy mode
    client.enable_privacy_mode(&meter_id);

    // Create test data
    let commitment1 = BytesN::from_array(&env, &[1u8; 32]);
    let commitment2 = BytesN::from_array(&env, &[4u8; 32]);
    let nullifier = BytesN::from_array(&env, &[2u8; 32]); // Same nullifier
    let encrypted_usage = Bytes::from_slice(&env, b"encrypted_usage_data");
    let proof_hash1 = BytesN::from_array(&env, &[3u8; 32]);
    let proof_hash2 = BytesN::from_array(&env, &[5u8; 32]);

    // Submit first report
    client.submit_zk_usage_report(
        &meter_id,
        &commitment1,
        &nullifier,
        &encrypted_usage.clone(),
        &proof_hash1,
    );

    // Try to submit second report with same nullifier - should fail
    let result = env.try_invoke_contract::<_, ()>(
        &contract_id,
        &soroban_sdk::Symbol::new(&env, "submit_zk_usage_report"),
        (
            meter_id,
            commitment2,
            nullifier,
            encrypted_usage,
            proof_hash2,
        ),
    );

    // Should fail with NullifierAlreadyUsed error
    assert!(result.is_err());
}

#[test]
fn test_get_status_with_privacy() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(UtilityContractClient, ());
    let client = UtilityContractClient::new(&env, &contract_id);

    let user = Address::generate(&env);
    let provider = Address::generate(&env);
    let token = create_token(&env);

    let meter_id = create_test_meter(&env, &client, user.clone(), provider.clone(), token);

    // Test status without privacy
    let status = client.get_status(&meter_id, &user);
    assert!(!status.privacy_enabled);
    assert!(status.usage_summary.is_some());

    // Enable privacy mode
    client.enable_privacy_mode(&meter_id);

    // Test status with privacy for user (should show balance)
    let user_status = client.get_status(&meter_id, &user);
    assert!(user_status.privacy_enabled);
    assert!(user_status.usage_summary.is_none());

    // Test status with privacy for provider (should show balance)
    let provider_status = client.get_status(&meter_id, &provider);
    assert!(provider_status.privacy_enabled);
    assert!(provider_status.usage_summary.is_none());

    // Test status with privacy for third party (should hide balance)
    let third_party = Address::generate(&env);
    let third_party_status = client.get_status(&meter_id, &third_party);
    assert!(third_party_status.privacy_enabled);
    assert!(third_party_status.usage_summary.is_none());
    assert_eq!(third_party_status.balance, 0); // Balance hidden
}

#[test]
fn test_verify_zk_proof() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(UtilityContractClient, ());
    let client = UtilityContractClient::new(&env, &contract_id);

    let user = Address::generate(&env);
    let provider = Address::generate(&env);
    let token = create_token(&env);

    let meter_id = create_test_meter(&env, &client, user.clone(), provider.clone(), token);

    // Enable privacy mode
    client.enable_privacy_mode(&meter_id);

    // Test proof verification with valid hash (non-zero)
    let valid_proof_hash = BytesN::from_array(&env, &[1u8; 32]);
    let is_valid = client.verify_zk_proof(&meter_id, &valid_proof_hash);
    assert!(is_valid);

    // Test proof verification with invalid hash (all zeros)
    let invalid_proof_hash = BytesN::from_array(&env, &[0u8; 32]);
    let is_invalid = client.verify_zk_proof(&meter_id, &invalid_proof_hash);
    assert!(!is_invalid);

    // Verify that verified proofs count increased
    let status = client.get_private_billing_status(&meter_id);
    assert_eq!(status.verified_proofs, 1);
    assert!(status.last_verification > 0);
}

#[test]
fn test_privacy_not_enabled_error() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(UtilityContractClient, ());
    let client = UtilityContractClient::new(&env, &contract_id);

    let user = Address::generate(&env);
    let provider = Address::generate(&env);
    let token = create_token(&env);

    let meter_id = create_test_meter(&env, &client, user.clone(), provider.clone(), token);

    // Try to submit ZK report without enabling privacy
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
}

#[test]
fn test_zk_verification_caching() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(UtilityContractClient, ());
    let client = UtilityContractClient::new(&env, &contract_id);

    let user = Address::generate(&env);
    let provider = Address::generate(&env);
    let token = create_token(&env);

    let meter_id = create_test_meter(&env, &client, user.clone(), provider.clone(), token);

    // Enable privacy mode
    client.enable_privacy_mode(&meter_id);

    let proof_hash = BytesN::from_array(&env, &[1u8; 32]);

    // Verify proof first time
    let result1 = client.verify_zk_proof(&meter_id, &proof_hash);
    assert!(result1);

    // Verify proof second time (should use cache)
    let result2 = client.verify_zk_proof(&meter_id, &proof_hash);
    assert!(result2);

    // Verified proofs count should only increase by 1 (not 2) due to caching
    let status = client.get_private_billing_status(&meter_id);
    assert_eq!(status.verified_proofs, 1);
}

#[test]
fn test_complete_zk_privacy_workflow() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(UtilityContractClient, ());
    let client = UtilityContractClient::new(&env, &contract_id);

    let user = Address::generate(&env);
    let provider = Address::generate(&env);
    let token = create_token(&env);

    let meter_id = create_test_meter(&env, &client, user.clone(), provider.clone(), token);

    // Step 1: Enable privacy mode
    client.enable_privacy_mode(&meter_id);
    assert!(client.is_privacy_enabled(&meter_id));

    // Step 2: Submit multiple ZK usage reports
    for i in 1..=3 {
        let commitment = BytesN::from_array(&env, &[i; 32]);
        let nullifier = BytesN::from_array(&env, &[i + 10; 32]);
        let encrypted_usage = Bytes::from_slice(&env, &format!("usage_data_{}", i).as_bytes());
        let proof_hash = BytesN::from_array(&env, &[i + 20; 32]);

        client.submit_zk_usage_report(
            &meter_id,
            &commitment,
            &nullifier,
            &encrypted_usage,
            &proof_hash,
        );
    }

    // Step 3: Verify commitments were recorded
    let status = client.get_private_billing_status(&meter_id);
    assert_eq!(status.total_commitments, 3);
    assert_eq!(status.verified_proofs, 0);

    // Step 4: Verify some proofs
    client.verify_zk_proof(&meter_id, &BytesN::from_array(&env, &[21; 32]));
    client.verify_zk_proof(&meter_id, &BytesN::from_array(&env, &[22; 32]));

    // Step 5: Check final status
    let final_status = client.get_private_billing_status(&meter_id);
    assert_eq!(final_status.total_commitments, 3);
    assert_eq!(final_status.verified_proofs, 2);
    assert!(final_status.last_verification > 0);

    // Step 6: Test privacy-preserving status queries
    let user_status = client.get_status(&meter_id, &user);
    assert!(user_status.privacy_enabled);
    assert_eq!(user_status.total_commitments, 3);
    assert_eq!(user_status.verified_proofs, 2);
    assert!(user_status.usage_summary.is_none());

    // Step 7: Disable privacy mode
    client.disable_privacy_mode(&meter_id);
    assert!(!client.is_privacy_enabled(&meter_id));
}
