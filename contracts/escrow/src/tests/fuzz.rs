use crate::{EscrowContract, EscrowContractClient, ContractError, Escrow, DataKey};
use soroban_sdk::{contract, contractimpl, testutils::Address as _, Address, BytesN, Env, Executable};

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

    let owner = Address::generate(&env);
    let recipient = Address::generate(&env);

    // Register an escrow manually in storage
    env.as_contract(&escrow_address, || {
        env.storage().instance().set(&DataKey::Escrow(1), &Escrow {
            owner: owner.clone(),
            total_locked: 1000,
            last_withdrawal_epoch: 0,
        });
    });

    // Set the authorizer in the escrow contract
    client.set_authorizer(&legitimate_authorizer);

    // 3. Fuzz Test: Generate 500 random addresses and verify they fail domain check
    for _ in 0..500 {
        let random_authorizer = Address::generate(&env);

        // We want to test that if the authorizer address in storage is changed to
        // something unauthorized, the domain check catches it.
        env.as_contract(&escrow_address, || {
            env.storage().instance().set(&DataKey::Authorizer, &random_authorizer);
        });

        let result = client.try_authorize_withdrawal(&1, &100, &recipient);

        match result {
            Err(Ok(ContractError::UnauthorizedDomain)) => {
                // Success: unauthorized domain (including simple addresses) correctly rejected
            }
            _ => {
                if random_authorizer != legitimate_authorizer {
                     panic!("Fuzz failure: Random address was not rejected with UnauthorizedDomain. Result: {:?}", result);
                }
            }
        }
    }

    // 4. Verify legitimate authorizer still works
    env.as_contract(&escrow_address, || {
        env.storage().instance().set(&DataKey::Authorizer, &legitimate_authorizer);
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
        env.storage().instance().set(&DataKey::TotalLocked, &1000i128);
    });

    // Should now fail to change authorizer
    let result = client.try_set_authorizer(&authorizer2);
    assert!(result.is_err());
}
