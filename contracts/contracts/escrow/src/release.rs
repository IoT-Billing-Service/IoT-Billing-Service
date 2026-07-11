use crate::{ContractError, DataKey, EscrowBalance};
use soroban_sdk::{Address, Env, Executable};

pub fn execute_release(
    env: Env,
    escrow_id: u64,
    amount: i128,
    _recipient: Address,
) -> Result<(), ContractError> {
    // Verify that the caller is the domain-authenticated authorizer.
    let authorizer: Address = env
        .storage()
        .instance()
        .get(&DataKey::Authorizer)
        .ok_or(ContractError::AuthorizerNotSet)?;

    authorizer.require_auth();

    // Double-check the authorizer's domain identity (defense in depth).
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

    let mut escrow: EscrowBalance = env
        .storage()
        .persistent()
        .get(&DataKey::Escrow(escrow_id))
        .ok_or(ContractError::EscrowNotFound)?;

    if escrow.total_locked < amount {
        return Err(ContractError::InsufficientBalance);
    }

    // Deduct from escrow.
    escrow.total_locked = escrow.total_locked.saturating_sub(amount);
    escrow.last_deposit_epoch = env.ledger().timestamp();
    env.storage()
        .persistent()
        .set(&DataKey::Escrow(escrow_id), &escrow);

    // Update global total locked.
    let total: i128 = env
        .storage()
        .instance()
        .get(&DataKey::TotalLocked)
        .unwrap_or(0);
    env.storage()
        .instance()
        .set(&DataKey::TotalLocked, &total.saturating_sub(amount));

    // Perform token transfer if we have enough info (token address is not stored
    // per-escrow in this path, so this is a placeholder for the caller to handle).
    // In practice, the caller would need to know the token address from context.
    // The authorize_withdrawal path handles token transfer in the calling context.

    Ok(())
}
