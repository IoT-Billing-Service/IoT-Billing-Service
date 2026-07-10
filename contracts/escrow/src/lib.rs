#![no_std]
use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, crypto::Hash,
    token::TokenClient, Address, BytesN, Env, String, Symbol,
};

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
    AlreadyInitialized = 6,
    InsufficientBalance = 7,
    NegativeAmount = 8,
    MeterNotFound = 9,
    GroupNotFound = 10,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowBalance {
    pub total_locked: i128,
    pub last_deposit_epoch: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MeterUsage {
    pub consumer: Address,
    pub token: Address,
    pub total_charged: i128,
    pub last_charge_epoch: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GroupUsage {
    pub manager: Address,
    pub token: Address,
    pub total_charged: i128,
    pub last_charge_epoch: u64,
    pub member_count: u32,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Escrow(escrow_id) -> EscrowBalance
    Escrow(u64),
    /// UserEscrow(user, token) -> escrow_id
    UserEscrow(Address, Address),
    /// Counter for escrow IDs
    EscrowCounter,
    /// Authorizer domain hash
    AuthorizerDomainHash,
    /// Authorizer address
    Authorizer,
    /// Total locked across all escrows
    TotalLocked,
    /// Default fee recipient for charges
    FeeRecipient,
    /// MeterRegistration(device_hash) -> bool
    MeterRegistration(BytesN<32>),
    /// GroupRegistration(group_hash) -> bool
    GroupRegistration(BytesN<32>),
}

// ---------------------------------------------------------------------------
// Internal storage helpers
// ---------------------------------------------------------------------------

fn escrow_balance_key(id: u64) -> DataKey {
    DataKey::Escrow(id)
}

fn user_escrow_key(user: &Address, token: &Address) -> DataKey {
    DataKey::UserEscrow(user.clone(), token.clone())
}

fn device_hash(env: &Env, device_id: &String) -> BytesN<32> {
    let h: Hash<32> = env.crypto().sha256(&device_id.to_bytes());
    h.to_bytes().into()
}

fn group_hash(env: &Env, group_id: &String) -> BytesN<32> {
    let h: Hash<32> = env.crypto().sha256(&group_id.to_bytes());
    h.to_bytes().into()
}

#[contractclient(name = "AuthorizerClient")]
pub trait Authorizer {
    fn authorize_withdrawal(env: Env, escrow_id: u64, amount: i128, recipient: Address);
}

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    /// Initialize the contract with an authorizer wasm hash for domain auth.
    pub fn __constructor(env: Env, authorizer_wasm_hash: BytesN<32>) {
        env.storage()
            .instance()
            .set(&DataKey::AuthorizerDomainHash, &authorizer_wasm_hash);
        env.storage().instance().set(&DataKey::TotalLocked, &0i128);
        env.storage().instance().set(&DataKey::EscrowCounter, &0u64);
    }

    // -----------------------------------------------------------------------
    // Admin / config
    // -----------------------------------------------------------------------

    pub fn set_authorizer(env: Env, authorizer: Address) -> Result<(), ContractError> {
        config::set_authorizer(env, authorizer)
    }

    pub fn set_fee_recipient(env: Env, recipient: Address) {
        env.current_contract_address().require_auth();
        env.storage()
            .instance()
            .set(&DataKey::FeeRecipient, &recipient);
    }

    pub fn get_fee_recipient(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::FeeRecipient)
    }

    // -----------------------------------------------------------------------
    // Escrow lifecycle
    // -----------------------------------------------------------------------

    /// Create a new escrow for `user` denominated in `token`.
    /// Returns the escrow ID.
    pub fn initialize_escrow(
        env: Env,
        user: Address,
        token: Address,
    ) -> Result<u64, ContractError> {
        user.require_auth();

        if env
            .storage()
            .persistent()
            .has(&user_escrow_key(&user, &token))
        {
            return Err(ContractError::AlreadyInitialized);
        }

        let mut counter: u64 = env
            .storage()
            .instance()
            .get(&DataKey::EscrowCounter)
            .unwrap_or(0);
        let escrow_id = counter;
        counter += 1;
        env.storage()
            .instance()
            .set(&DataKey::EscrowCounter, &counter);

        let balance = EscrowBalance {
            total_locked: 0,
            last_deposit_epoch: env.ledger().timestamp(),
        };

        env.storage()
            .persistent()
            .set(&escrow_balance_key(escrow_id), &balance);
        env.storage()
            .persistent()
            .set(&user_escrow_key(&user, &token), &escrow_id);

        env.events().publish(
            (Symbol::new(&env, "EscrowInit"),),
            (escrow_id, user, token, env.ledger().timestamp()),
        );

        Ok(escrow_id)
    }

    /// Deposit `amount` tokens into the user's escrow.
    /// The user must hold sufficient tokens; `transfer` is used to move them.
    pub fn deposit(
        env: Env,
        user: Address,
        token: Address,
        amount: i128,
    ) -> Result<(), ContractError> {
        if amount <= 0 {
            return Err(ContractError::NegativeAmount);
        }

        user.require_auth();

        let escrow_id: u64 = env
            .storage()
            .persistent()
            .get(&user_escrow_key(&user, &token))
            .ok_or(ContractError::EscrowNotFound)?;

        // Transfer tokens from user to this contract.
        let token_client = TokenClient::new(&env, &token);
        token_client.transfer(&user, &env.current_contract_address(), &amount);

        // Update balance.
        let mut balance: EscrowBalance = env
            .storage()
            .persistent()
            .get(&escrow_balance_key(escrow_id))
            .unwrap(); // safe: we got escrow_id from UserEscrow

        balance.total_locked = balance.total_locked.saturating_add(amount);
        balance.last_deposit_epoch = env.ledger().timestamp();

        env.storage()
            .persistent()
            .set(&escrow_balance_key(escrow_id), &balance);

        // Update global total locked.
        let total: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalLocked)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalLocked, &total.saturating_add(amount));

        env.events().publish(
            (Symbol::new(&env, "EscrowDep"),),
            (escrow_id, user, token, amount, env.ledger().timestamp()),
        );

        Ok(())
    }

    /// Get the escrow balance for a user + token pair.
    pub fn get_escrow_balance(env: Env, user: Address, token: Address) -> i128 {
        let escrow_id: Option<u64> = env
            .storage()
            .persistent()
            .get(&user_escrow_key(&user, &token));
        match escrow_id {
            Some(id) => {
                let balance: EscrowBalance = env
                    .storage()
                    .persistent()
                    .get(&escrow_balance_key(id))
                    .unwrap_or(EscrowBalance {
                        total_locked: 0,
                        last_deposit_epoch: 0,
                    });
                balance.total_locked
            }
            None => 0,
        }
    }

    /// Get the full escrow info for a user + token pair.
    pub fn get_escrow_info(env: Env, user: Address, token: Address) -> Option<EscrowBalance> {
        let escrow_id: Option<u64> = env
            .storage()
            .persistent()
            .get(&user_escrow_key(&user, &token));
        match escrow_id {
            Some(id) => env.storage().persistent().get(&escrow_balance_key(id)),
            None => None,
        }
    }

    // -----------------------------------------------------------------------
    // Individual meter billing
    // -----------------------------------------------------------------------

    /// Register a meter for billing.
    pub fn register_meter(
        env: Env,
        device_id: String,
        consumer: Address,
        token: Address,
    ) -> Result<(), ContractError> {
        consumer.require_auth();

        let dhash = device_hash(&env, &device_id);

        if env
            .storage()
            .persistent()
            .has(&DataKey::MeterRegistration(dhash.clone()))
        {
            return Err(ContractError::AlreadyInitialized);
        }

        let usage = MeterUsage {
            consumer: consumer.clone(),
            token: token.clone(),
            total_charged: 0,
            last_charge_epoch: env.ledger().timestamp(),
        };

        // Mark registration.
        env.storage()
            .persistent()
            .set(&DataKey::MeterRegistration(dhash.clone()), &true);
        // Store usage data under the hash directly.
        env.storage().persistent().set(&dhash, &usage);

        env.events().publish(
            (Symbol::new(&env, "MeterReg"),),
            (dhash, consumer, token, env.ledger().timestamp()),
        );

        Ok(())
    }

    /// Charge `amount` from the consumer's escrow for meter `device_id` usage.
    pub fn charge_meter_usage(
        env: Env,
        device_id: String,
        consumer: Address,
        amount: i128,
    ) -> Result<(), ContractError> {
        if amount <= 0 {
            return Err(ContractError::NegativeAmount);
        }

        consumer.require_auth();

        let dhash = device_hash(&env, &device_id);

        // Check meter is registered.
        if !env
            .storage()
            .persistent()
            .has(&DataKey::MeterRegistration(dhash.clone()))
        {
            return Err(ContractError::MeterNotFound);
        }

        // Get meter usage record (stored under the hash directly).
        let meter: MeterUsage = env
            .storage()
            .persistent()
            .get(&dhash.clone())
            .ok_or(ContractError::MeterNotFound)?;

        // Verify the consumer matches.
        if meter.consumer != consumer {
            return Err(ContractError::Unauthorized);
        }

        let token = meter.token.clone();

        // Get the escrow.
        let escrow_id: u64 = env
            .storage()
            .persistent()
            .get(&user_escrow_key(&consumer, &token))
            .ok_or(ContractError::EscrowNotFound)?;

        let mut balance: EscrowBalance = env
            .storage()
            .persistent()
            .get(&escrow_balance_key(escrow_id))
            .ok_or(ContractError::EscrowNotFound)?;

        if balance.total_locked < amount {
            return Err(ContractError::InsufficientBalance);
        }

        // Determine recipient.
        let recipient: Address = env
            .storage()
            .instance()
            .get::<_, Address>(&DataKey::FeeRecipient)
            .unwrap_or_else(|| env.current_contract_address());

        // Transfer tokens from escrow (this contract) to recipient.
        let token_client = TokenClient::new(&env, &token);
        token_client.transfer(&env.current_contract_address(), &recipient, &amount);

        // Update escrow balance.
        balance.total_locked = balance.total_locked.saturating_sub(amount);
        balance.last_deposit_epoch = env.ledger().timestamp();
        env.storage()
            .persistent()
            .set(&escrow_balance_key(escrow_id), &balance);

        // Update meter usage record.
        let mut updated_meter = meter;
        updated_meter.total_charged = updated_meter.total_charged.saturating_add(amount);
        updated_meter.last_charge_epoch = env.ledger().timestamp();
        env.storage().persistent().set(&dhash, &updated_meter);

        // Update global total locked.
        let total: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalLocked)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalLocked, &total.saturating_sub(amount));

        env.events().publish(
            (Symbol::new(&env, "MtrChrg"),),
            (dhash, consumer, token, amount, env.ledger().timestamp()),
        );

        Ok(())
    }

    /// Get meter usage info.
    pub fn get_meter_usage(env: Env, device_id: String) -> Option<MeterUsage> {
        let dhash = device_hash(&env, &device_id);
        env.storage().persistent().get(&dhash)
    }

    // -----------------------------------------------------------------------
    // Group / fleet billing
    // -----------------------------------------------------------------------

    /// Register a billing group for fleet management.
    pub fn register_group(
        env: Env,
        group_id: String,
        manager: Address,
        token: Address,
        member_count: u32,
    ) -> Result<(), ContractError> {
        manager.require_auth();

        let ghash = group_hash(&env, &group_id);

        if env
            .storage()
            .persistent()
            .has(&DataKey::GroupRegistration(ghash.clone()))
        {
            return Err(ContractError::AlreadyInitialized);
        }

        let group = GroupUsage {
            manager: manager.clone(),
            token: token.clone(),
            total_charged: 0,
            last_charge_epoch: env.ledger().timestamp(),
            member_count,
        };

        env.storage()
            .persistent()
            .set(&DataKey::GroupRegistration(ghash.clone()), &true);
        env.storage().persistent().set(&ghash, &group);

        env.events().publish(
            (Symbol::new(&env, "GroupReg"),),
            (
                ghash,
                manager,
                token,
                member_count,
                env.ledger().timestamp(),
            ),
        );

        Ok(())
    }

    /// Charge `amount` from the manager's escrow for group `group_id` usage.
    pub fn charge_group_usage(
        env: Env,
        group_id: String,
        manager: Address,
        amount: i128,
    ) -> Result<(), ContractError> {
        if amount <= 0 {
            return Err(ContractError::NegativeAmount);
        }

        manager.require_auth();

        let ghash = group_hash(&env, &group_id);

        if !env
            .storage()
            .persistent()
            .has(&DataKey::GroupRegistration(ghash.clone()))
        {
            return Err(ContractError::GroupNotFound);
        }

        let group: GroupUsage = env
            .storage()
            .persistent()
            .get(&ghash.clone())
            .ok_or(ContractError::GroupNotFound)?;

        if group.manager != manager {
            return Err(ContractError::Unauthorized);
        }

        let token = group.token.clone();

        // Get the manager's escrow.
        let escrow_id: u64 = env
            .storage()
            .persistent()
            .get(&user_escrow_key(&manager, &token))
            .ok_or(ContractError::EscrowNotFound)?;

        let mut balance: EscrowBalance = env
            .storage()
            .persistent()
            .get(&escrow_balance_key(escrow_id))
            .ok_or(ContractError::EscrowNotFound)?;

        if balance.total_locked < amount {
            return Err(ContractError::InsufficientBalance);
        }

        let recipient: Address = env
            .storage()
            .instance()
            .get::<_, Address>(&DataKey::FeeRecipient)
            .unwrap_or_else(|| env.current_contract_address());

        // Transfer tokens from escrow to recipient.
        let token_client = TokenClient::new(&env, &token);
        token_client.transfer(&env.current_contract_address(), &recipient, &amount);

        // Update escrow.
        balance.total_locked = balance.total_locked.saturating_sub(amount);
        balance.last_deposit_epoch = env.ledger().timestamp();
        env.storage()
            .persistent()
            .set(&escrow_balance_key(escrow_id), &balance);

        // Update group usage.
        let mut updated_group = group;
        updated_group.total_charged = updated_group.total_charged.saturating_add(amount);
        updated_group.last_charge_epoch = env.ledger().timestamp();
        env.storage().persistent().set(&ghash, &updated_group);

        let total: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalLocked)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalLocked, &total.saturating_sub(amount));

        env.events().publish(
            (Symbol::new(&env, "GrpChrg"),),
            (ghash, manager, token, amount, env.ledger().timestamp()),
        );

        Ok(())
    }

    /// Get group usage info.
    pub fn get_group_usage(env: Env, group_id: String) -> Option<GroupUsage> {
        let ghash = group_hash(&env, &group_id);
        env.storage().persistent().get(&ghash)
    }

    // -----------------------------------------------------------------------
    // Authorizer functions (cross-contract / release)
    // -----------------------------------------------------------------------

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
