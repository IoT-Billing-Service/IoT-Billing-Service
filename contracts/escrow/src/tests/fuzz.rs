use crate::{
    ContractError, EscrowContract, EscrowContractClient, EscrowBalance, DataKey,
};
use soroban_sdk::{
    contract, contractimpl, testutils::Address as _, Address, BytesN, Env, Executable,
};

// Mock Authorizer Contract
#[contract]
pub struct MockAuthorizer;

#[contractimpl]
impl MockAuthorizer {
    pub fn authorize_withdrawal(_env: Env, _escrow_id: u64, _amount: i128, _recipient: Address) {}
}

#[test]
fn test_domain_authentication_fuzz() {
    let env = Env::default();
    env.mock_all_auths();

    // 1. Register a legitimate authorizer and get its hash
    let legitimate_authorizer = env.register(MockAuthorizer, ());
    let authorizer_wasm_hash = match legitimate_authorizer.executable().unwrap() {
        Executable::Wasm(hash) => hash,
        _ => panic!("Expected WASM executable"),
    };

    // 2. Setup Escrow Contract with the legitimate Authorizer WASM Hash
    let escrow_address = env.register(EscrowContract, (authorizer_wasm_hash.clone(),));
    let client = EscrowContractClient::new(&env, &escrow_address);

    let recipient = Address::generate(&env);

    // Register an escrow manually in storage
    env.as_contract(&escrow_address, || {
        env.storage()
            .persistent()
            .set(
                &DataKey::Escrow(1),
                &EscrowBalance {
                    total_locked: 1000,
                    last_deposit_epoch: 0,
                },
            );
    });

    // Set the authorizer in the escrow contract
    client.set_authorizer(&legitimate_authorizer);

    // 3. Fuzz Test: Generate 500 random addresses and verify they fail domain check
    for _ in 0..500 {
        let random_authorizer = Address::generate(&env);

        // We want to test that if the authorizer address in storage is changed to
        // something unauthorized, the domain check catches it.
        env.as_contract(&escrow_address, || {
            env.storage()
                .instance()
                .set(&DataKey::Authorizer, &random_authorizer);
        });

        let result = client.try_authorize_withdrawal(&1, &100, &recipient);

        match result {
            Err(Ok(ContractError::UnauthorizedDomain)) => {
                // Success: unauthorized domain (including simple addresses) correctly rejected
            }
            _ => {
                if random_authorizer != legitimate_authorizer {
                    panic!(
                        "Fuzz failure: Random address was not rejected with UnauthorizedDomain. Result: {:?}",
                        result
                    );
                }
            }
        }
    }

    // 4. Verify legitimate authorizer still works
    env.as_contract(&escrow_address, || {
        env.storage()
            .instance()
            .set(&DataKey::Authorizer, &legitimate_authorizer);
    });
    let result = client.try_authorize_withdrawal(&1, &100, &recipient);
    assert!(result.is_ok(), "Legitimate authorizer failed: {:?}", result);
}

#[test]
fn test_authorizer_immutability_guard() {
    let env = Env::default();
    env.mock_all_auths();

    let hash = BytesN::from_array(&env, &[0; 32]);
    let escrow_address = env.register(EscrowContract, (hash,));
    let client = EscrowContractClient::new(&env, &escrow_address);

    let authorizer1 = Address::generate(&env);
    let authorizer2 = Address::generate(&env);

    // Initially can set authorizer
    client.set_authorizer(&authorizer1);

    // Lock funds
    env.as_contract(&escrow_address, || {
        env.storage()
            .instance()
            .set(&DataKey::TotalLocked, &1000i128);
    });

    // Should now fail to change authorizer
    let result = client.try_set_authorizer(&authorizer2);
    assert!(result.is_err());
}

// ---------------------------------------------------------------------------
// Fuzz-style: random charge attempts on the new billing functions
// ---------------------------------------------------------------------------

#[test]
fn test_random_meter_charge_fuzz() {
    let env = Env::default();
    env.mock_all_auths();

    let zero_hash = BytesN::from_array(&env, &[0u8; 32]);
    let escrow_address = env.register(EscrowContract, (zero_hash,));
    let client = EscrowContractClient::new(&env, &escrow_address);

    let user = Address::generate(&env);
    let device_id = soroban_sdk::String::from_str(&env, "fuzz-meter");

    // Initialize escrow and meter.
    client.initialize_escrow(&user, &Address::generate(&env));
    client.register_meter(&device_id, &user, &Address::generate(&env));

    // Trying to charge without a valid escrow should fail with EscrowNotFound.
    let result = client.try_charge_meter_usage(&device_id, &user, &100);
    assert!(result.is_err());
}

#[test]
fn test_random_group_charge_fuzz() {
    let env = Env::default();
    env.mock_all_auths();

    let zero_hash = BytesN::from_array(&env, &[0u8; 32]);
    let escrow_address = env.register(EscrowContract, (zero_hash,));
    let client = EscrowContractClient::new(&env, &escrow_address);

    let user = Address::generate(&env);
    let group_id = soroban_sdk::String::from_str(&env, "fuzz-group");

    client.initialize_escrow(&user, &Address::generate(&env));
    client.register_group(&group_id, &user, &Address::generate(&env), &5);

    // No escrow with sufficient balance exists, so this should fail.
    let result = client.try_charge_group_usage(&group_id, &user, &100);
    assert!(result.is_err());
}
