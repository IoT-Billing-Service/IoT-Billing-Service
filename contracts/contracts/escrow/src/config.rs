use soroban_sdk::{Address, Env};
use crate::{ContractError, DataKey};

pub fn set_authorizer(env: Env, authorizer: Address) -> Result<(), ContractError> {
    let total_locked: i128 = env.storage().instance().get(&DataKey::TotalLocked).unwrap_or(0);

    if total_locked > 0 {
        return Err(ContractError::EscrowAlreadyActive);
    }

    env.storage()
        .instance()
        .set(&DataKey::Authorizer, &authorizer);
    Ok(())
}
