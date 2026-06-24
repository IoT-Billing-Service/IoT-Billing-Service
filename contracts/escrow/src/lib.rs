#![no_std]
use soroban_sdk::{contract, contractclient, contracterror, contractimpl, contracttype, Address, BytesN, Env};

pub mod config;
pub mod cross_contract;
pub mod release;

#[cfg(test)]
mod tests;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ContractError {
    Unauthorized = 1,
    UnauthorizedDomain = 2,
    EscrowAlreadyActive = 3,
    EscrowNotFound = 4,
    AuthorizerNotSet = 5,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Escrow(u64),
    Authorizer,
    AuthorizerDomainHash,
    TotalLocked,
}

#[contracttype]
#[derive(Clone)]
pub struct Escrow {
    pub owner: Address,
    pub total_locked: i128,
    pub last_withdrawal_epoch: u64,
}

#[contractclient(name = "AuthorizerClient")]
pub trait Authorizer {
    fn authorize_withdrawal(env: Env, escrow_id: u64, amount: i128, recipient: Address);
}

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    pub fn __constructor(env: Env, authorizer_wasm_hash: BytesN<32>) {
        env.storage()
            .instance()
            .set(&DataKey::AuthorizerDomainHash, &authorizer_wasm_hash);
        env.storage().instance().set(&DataKey::TotalLocked, &0i128);
    }

    pub fn set_authorizer(env: Env, authorizer: Address) -> Result<(), ContractError> {
        config::set_authorizer(env, authorizer)
    }

    pub fn authorize_withdrawal(
        env: Env,
        escrow_id: u64,
        amount: i128,
        recipient: Address,
    ) -> Result<(), ContractError> {
        cross_contract::authorize_withdrawal(env, escrow_id, amount, recipient)
    }

    pub fn execute_release(
        env: Env,
        escrow_id: u64,
        amount: i128,
        recipient: Address,
    ) -> Result<(), ContractError> {
        release::execute_release(env, escrow_id, amount, recipient)
    }
}
