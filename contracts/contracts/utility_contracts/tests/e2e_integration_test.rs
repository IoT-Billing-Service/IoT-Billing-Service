use soroban_sdk::testutils::{Address as _, Events, Ledger};
use soroban_sdk::{symbol_short, token, Address, BytesN, Env, Symbol};
use utility_contracts::{
    BillingType, Meter, SLAState, SignedUsageData, StreamStatus, UtilityContract,
    UtilityContractClient,
};

// Helper to create a 32-byte key
fn device_key(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

mod mock_oracle {
    use soroban_sdk::{contract, contractimpl, Address, Env};
    #[contract]
    pub struct MockOracle;
    #[contractimpl]
    impl MockOracle {
        pub fn xlm_to_usd_cents(_env: Env, amount: i128) -> i128 {
            amount
        }
        pub fn usd_cents_to_xlm(_env: Env, amount: i128) -> i128 {
            amount
        }
        pub fn get_price(_env: Env) -> i128 {
            100
        }
    }
}

#[test]
fn test_final_e2e_integration_hardware_to_dex() {
    let env = Env::default();
    env.mock_all_auths();

    // 1. Setup Contracts
    let contract_id = env.register_contract(None, UtilityContract);
    let client = UtilityContractClient::new(&env, &contract_id);

    let oracle_id = env.register_contract(None, mock_oracle::MockOracle);
    client.set_oracle(&oracle_id);

    // 2. Setup Identities
    let user = Address::generate(&env);
    let provider = Address::generate(&env);
    let token_admin = Address::generate(&env);

    // 3. Setup Assets
    let token_address = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
    let token_client = token::Client::new(&env, &token_address);

    token_admin_client.mint(&user, &1_000_000_000);

    // 4. Register and Activate Meter
    let device_public_key = device_key(&env, 42);
    let off_peak_rate = 100;

    let meter_id = client.register_meter(
        &user,
        &provider,
        &off_peak_rate,
        &token_address,
        &device_public_key,
        &1,
    );
    client.initiate_pairing(&meter_id);
    client.complete_pairing(&meter_id, &BytesN::from_array(&env, &[1u8; 64]));

    let top_up_amount = 500_000_000;
    client.top_up(&meter_id, &top_up_amount, &user);

    // 5. Hardware Interaction
    let now = 10_000;
    env.ledger().set_timestamp(now);

    let units_consumed = 50_000;
    let signed_usage = SignedUsageData {
        meter_id,
        timestamp: now,
        watt_hours_consumed: 500_000,
        units_consumed,
        is_renewable_energy: true,
        signature: BytesN::from_array(&env, &[0u8; 64]),
        public_key: device_public_key.clone(),
    };

    client.ping(&meter_id);
    client.deduct_units(&signed_usage);

    // 6. Withdrawal (triggered by earnings)
    let earnings_to_withdraw = 1_000_000;
    client.withdraw_earnings(&meter_id, &earnings_to_withdraw);
    assert_eq!(token_client.balance(&provider), earnings_to_withdraw);

    // 7. Continuous Flow: Stream to external vault
    let stream_id = 212;
    let flow_rate = 1_000;
    let stream_initial_balance = 5_000_000;

    // Mint more to provider for stream funding
    token_admin_client.mint(&provider, &stream_initial_balance);

    client.create_continuous_stream(
        &stream_id,
        &flow_rate,
        &stream_initial_balance,
        &provider,
        &provider,
    );

    // Advance time
    env.ledger().set_timestamp(now + 3600);

    // 8. Auto-Swap (Simulation)
    let withdrawn = client.withdraw_continuous(&stream_id, &500_000);
    assert_eq!(withdrawn, 500_000);

    // 9. Harvesting Yield
    client.set_min_route_threshold(&100_000);
    let routed = client.route_to_yield(&200_000);
    assert_eq!(routed, 200_000);

    // 10. Final State Validation
    let final_meter = client.get_meter(&meter_id).unwrap();
    assert_eq!(
        final_meter.balance,
        top_up_amount - (units_consumed * off_peak_rate) - earnings_to_withdraw
    );

    let final_flow = client.get_continuous_flow(&stream_id).unwrap();
    assert_eq!(final_flow.status, StreamStatus::Active);

    // Verify Events
    let events = env.events().all();
    assert!(events.len() > 0);
}
