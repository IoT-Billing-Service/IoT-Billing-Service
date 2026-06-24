use soroban_sdk::{Address, Env, Symbol, vec, IntoVal, Executable};
use crate::{ContractError, DataKey, Escrow};

pub fn authorize_withdrawal(
    env: Env,
    escrow_id: u64,
    amount: i128,
    recipient: Address,
) -> Result<(), ContractError> {
    let escrow: Escrow = env
        .storage()
        .instance()
        .get(&DataKey::Escrow(escrow_id))
        .ok_or(ContractError::EscrowNotFound)?;

    // Verify that caller is the escrow owner
    escrow.owner.require_auth();

    // Get registered authorizer
    let authorizer: Address = env
        .storage()
        .instance()
        .get(&DataKey::Authorizer)
        .ok_or(ContractError::AuthorizerNotSet)?;

    // SECURITY FIX: Verify hash(contract_code) == AUTHORIZER_DOMAIN_HASH
    let expected_hash = env
        .storage()
        .instance()
        .get::<_, soroban_sdk::BytesN<32>>(&DataKey::AuthorizerDomainHash)
        .ok_or(ContractError::UnauthorizedDomain)?;

    // Get the WASM hash of the authorizer contract via address.executable()
    let executable = authorizer.executable().ok_or(ContractError::UnauthorizedDomain)?;

    let actual_hash = match executable {
        Executable::Wasm(hash) => hash,
        _ => return Err(ContractError::UnauthorizedDomain),
    };

    if actual_hash != expected_hash {
        return Err(ContractError::UnauthorizedDomain);
    }

    // Delegate authorization to external authorizer contract
    // invoke_contract requires Vec<Val>
    let args = vec![&env, escrow_id.into_val(&env), amount.into_val(&env), recipient.into_val(&env)];
    env.invoke_contract::<()>(
        &authorizer,
        &Symbol::new(&env, "authorize_withdrawal"),
        args,
    );

    Ok(())
}
