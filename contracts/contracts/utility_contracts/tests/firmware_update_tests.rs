#![cfg(test)]

use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{token, Address, BytesN, Env};
use utility_contracts::{
    SignedUpdateComplete, SignedUsageData, UtilityContract, UtilityContractClient,
};

fn setup_meter() -> (Env, Address, u64, BytesN<32>) {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let contract_id = env.register(UtilityContract, ());
    let client = UtilityContractClient::new(&env, &contract_id);

    let user = Address::generate(&env);
    let provider = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_address = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let token_admin_client = token::StellarAssetClient::new(&env, &token_address);

    token_admin_client.mint(&user, &10_000);

    let device_public_key = BytesN::from_array(&env, &[7u8; 32]);
    let meter_id = client.register_meter(&user, &provider, &10, &token_address, &device_public_key);
    client.top_up(&meter_id, &5_000);
    client.initiate_pairing(&meter_id);
    client.complete_pairing(&meter_id, &BytesN::from_array(&env, &[2u8; 64]));

    (env, contract_id, meter_id, device_public_key)
}

#[test]
fn test_initiate_firmware_update_sets_meter_state() {
    let (env, contract_id, meter_id, _) = setup_meter();
    let client = UtilityContractClient::new(&env, &contract_id);

    client.initiate_firmware_update(&meter_id);

    let meter = client.get_meter(&meter_id).unwrap();
    assert!(meter.is_updating);
    assert_eq!(meter.update_start_timestamp, env.ledger().timestamp());
}

#[test]
#[should_panic(expected = "Error(Contract, #27)")]
fn test_deduct_units_panics_while_firmware_update_is_active() {
    let (env, contract_id, meter_id, device_public_key) = setup_meter();
    let client = UtilityContractClient::new(&env, &contract_id);

    client.initiate_firmware_update(&meter_id);

    let signed_usage = SignedUsageData {
        meter_id,
        timestamp: env.ledger().timestamp(),
        watt_hours_consumed: 500,
        units_consumed: 5,
        signature: BytesN::from_array(&env, &[3u8; 64]),
        public_key: device_public_key,
        is_renewable_energy: false,
    };

    client.deduct_units(&signed_usage);
}

#[test]
fn test_complete_firmware_update_resumes_billing() {
    let (env, contract_id, meter_id, device_public_key) = setup_meter();
    let client = UtilityContractClient::new(&env, &contract_id);

    client.initiate_firmware_update(&meter_id);
    let started_at = env.ledger().timestamp();

    env.ledger().set_timestamp(started_at + 300);
    let completion = SignedUpdateComplete {
        meter_id,
        update_start_timestamp: started_at,
        completion_timestamp: started_at + 240,
        signature: BytesN::from_array(&env, &[4u8; 64]),
        device_public_key: device_public_key.clone(),
    };

    client.complete_firmware_update(&completion);

    let meter = client.get_meter(&meter_id).unwrap();
    assert!(!meter.is_updating);
    assert_eq!(meter.update_start_timestamp, 0);
    assert_eq!(meter.last_update, env.ledger().timestamp());

    let signed_usage = SignedUsageData {
        meter_id,
        timestamp: env.ledger().timestamp(),
        watt_hours_consumed: 500,
        units_consumed: 5,
        signature: BytesN::from_array(&env, &[5u8; 64]),
        public_key: device_public_key,
        is_renewable_energy: false,
    };

    client.deduct_units(&signed_usage);

    let meter = client.get_meter(&meter_id).unwrap();
    assert_eq!(meter.balance, 4_950);
}

#[test]
#[should_panic(expected = "Error(Contract, #28)")]
fn test_complete_firmware_update_rejects_expired_window() {
    let (env, contract_id, meter_id, device_public_key) = setup_meter();
    let client = UtilityContractClient::new(&env, &contract_id);

    client.initiate_firmware_update(&meter_id);
    let started_at = env.ledger().timestamp();

    env.ledger().set_timestamp(started_at + 7_201);
    let completion = SignedUpdateComplete {
        meter_id,
        update_start_timestamp: started_at,
        completion_timestamp: started_at + 7_200,
        signature: BytesN::from_array(&env, &[6u8; 64]),
        device_public_key,
    };

    client.complete_firmware_update(&completion);
}
