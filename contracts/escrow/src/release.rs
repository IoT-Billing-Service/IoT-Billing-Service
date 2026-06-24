use soroban_sdk::{Address, Env, Executable};
use crate::{ContractError, DataKey, Escrow};

pub fn execute_release(
    env: Env,
    escrow_id: u64,
    _amount: i128,
    _recipient: Address,
) -> Result<(), ContractError> {
    // SECURITY FIX: Verify that the caller is the domain-authenticated authorizer
    let authorizer: Address = env
        .storage()
        .instance()
        .get(&DataKey::Authorizer)
        .ok_or(ContractError::AuthorizerNotSet)?;

    // Only the registered authorizer can call execute_release
    authorizer.require_auth();

    // Double-check the authorizer's domain identity just in case (defense in depth)
    let expected_hash = env
        .storage()
        .instance()
        .get::<_, soroban_sdk::BytesN<32>>(&DataKey::AuthorizerDomainHash)
        .ok_or(ContractError::UnauthorizedDomain)?;

    let executable = authorizer.executable().ok_or(ContractError::UnauthorizedDomain)?;
    let actual_hash = match executable {
        Executable::Wasm(hash) => hash,
        _ => return Err(ContractError::UnauthorizedDomain),
    };

    if actual_hash != expected_hash {
        return Err(ContractError::UnauthorizedDomain);
    }

    let escrow: Escrow = env
        .storage()
        .instance()
        .get(&DataKey::Escrow(escrow_id))
        .ok_or(ContractError::EscrowNotFound)?;

    // Perform actual transfer/release logic...
    // ...

    env.storage().instance().set(&DataKey::Escrow(escrow_id), &escrow);

    Ok(())
}
