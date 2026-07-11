use crate::{ContractError, DataKey, EscrowBalance};
use soroban_sdk::{vec, Address, Env, Executable, IntoVal, Symbol};

pub fn authorize_withdrawal(
    env: Env,
    escrow_id: u64,
    amount: i128,
    recipient: Address,
) -> Result<(), ContractError> {
    let _escrow: EscrowBalance = env
        .storage()
        .persistent()
        .get(&DataKey::Escrow(escrow_id))
        .ok_or(ContractError::EscrowNotFound)?;

    // Verify that caller is the escrow owner (the user who holds this escrow).
    // The owner must match the recipient or be derived from the storage.
    // For simplicity, we require the recipient to authenticate.
    recipient.require_auth();

    // Get registered authorizer.
    let authorizer: Address = env
        .storage()
        .instance()
        .get(&DataKey::Authorizer)
        .ok_or(ContractError::AuthorizerNotSet)?;

    // Verify hash(contract_code) == AUTHORIZER_DOMAIN_HASH.
    let expected_hash = env
        .storage()
        .instance()
        .get::<_, soroban_sdk::BytesN<32>>(&DataKey::AuthorizerDomainHash)
        .ok_or(ContractError::UnauthorizedDomain)?;

    let executable = authorizer
        .executable()
        .ok_or(ContractError::UnauthorizedDomain)?;

    let actual_hash = match executable {
        Executable::Wasm(hash) => hash,
        _ => return Err(ContractError::UnauthorizedDomain),
    };

    if actual_hash != expected_hash {
        return Err(ContractError::UnauthorizedDomain);
    }

    // Delegate authorization to external authorizer contract.
    let args = vec![
        &env,
        escrow_id.into_val(&env),
        amount.into_val(&env),
        recipient.into_val(&env),
    ];
    env.invoke_contract::<()>(
        &authorizer,
        &Symbol::new(&env, "authorize_withdrawal"),
        args,
    );

    Ok(())
}
