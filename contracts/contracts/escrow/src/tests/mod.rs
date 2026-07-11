#[cfg(test)]
mod fuzz;

use crate::{
    ContractError, DataKey, EscrowBalance, EscrowContract, EscrowContractClient, GroupUsage,
    MeterUsage,
};
use soroban_sdk::{
    contract, contractimpl, contracttype, testutils::Address as _, Address, BytesN, Env, String,
};

// ---------------------------------------------------------------------------
// Mock Token Contract
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
pub enum MockTokenDataKey {
    Admin,
    Balance(Address),
}

#[contract]
pub struct MockToken;

#[contractimpl]
impl MockToken {
    pub fn init(env: Env, admin: Address) {
        env.storage()
            .instance()
            .set(&MockTokenDataKey::Admin, &admin);
    }

    pub fn mint(env: Env, admin: Address, to: Address, amount: i128) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&MockTokenDataKey::Admin)
            .unwrap();
        if admin != stored_admin {
            panic!("not authorized");
        }
        let balance: i128 = env
            .storage()
            .persistent()
            .get(&MockTokenDataKey::Balance(to.clone()))
            .unwrap_or(0);
        env.storage().persistent().set(
            &MockTokenDataKey::Balance(to),
            &balance.saturating_add(amount),
        );
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        let mut from_balance: i128 = env
            .storage()
            .persistent()
            .get(&MockTokenDataKey::Balance(from.clone()))
            .unwrap_or(0);
        if from_balance < amount {
            panic!("insufficient balance");
        }
        from_balance = from_balance.saturating_sub(amount);
        env.storage()
            .persistent()
            .set(&MockTokenDataKey::Balance(from), &from_balance);

        let mut to_balance: i128 = env
            .storage()
            .persistent()
            .get(&MockTokenDataKey::Balance(to.clone()))
            .unwrap_or(0);
        to_balance = to_balance.saturating_add(amount);
        env.storage()
            .persistent()
            .set(&MockTokenDataKey::Balance(to), &to_balance);
    }

    pub fn balance(env: Env, owner: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&MockTokenDataKey::Balance(owner))
            .unwrap_or(0)
    }
}

// ---------------------------------------------------------------------------
// Test context struct (manually constructed to avoid lifetime issues)
// ---------------------------------------------------------------------------

struct TestCtx {
    env: Env,
    client: EscrowContractClient<'static>,
    contract_id: Address,
    token: Address,
    token_admin: Address,
    user: Address,
    user2: Address,
    fee_recipient: Address,
}

fn new_ctx() -> TestCtx {
    let env = Env::default();
    env.mock_all_auths();

    let token_admin = Address::generate(&env);
    let token = env.register(MockToken, ());
    MockTokenClient::new(&env, &token).init(&token_admin);

    let user = Address::generate(&env);
    let user2 = Address::generate(&env);
    let fee_recipient = Address::generate(&env);

    let zero_hash = BytesN::from_array(&env, &[0u8; 32]);
    let escrow_id = env.register(EscrowContract, (zero_hash,));
    let client = EscrowContractClient::new(&env, &escrow_id);

    client.set_fee_recipient(&fee_recipient);

    TestCtx {
        env,
        client,
        contract_id: escrow_id,
        token,
        token_admin,
        user,
        user2,
        fee_recipient,
    }
}

fn mint_tokens(ctx: &TestCtx, to: &Address, amount: i128) {
    MockTokenClient::new(&ctx.env, &ctx.token).mint(&ctx.token_admin, to, &amount);
}

// ---------------------------------------------------------------------------
// Tests: initialize_escrow
// ---------------------------------------------------------------------------

#[test]
fn test_initialize_escrow_success() {
    let ctx = new_ctx();

    let escrow_id = ctx
        .client
        .try_initialize_escrow(&ctx.user, &ctx.token)
        .unwrap()
        .unwrap();

    assert_eq!(escrow_id, 0u64);

    let balance = ctx.client.get_escrow_balance(&ctx.user, &ctx.token);
    assert_eq!(balance, 0);

    let info = ctx.client.get_escrow_info(&ctx.user, &ctx.token).unwrap();
    assert_eq!(info.total_locked, 0);
}

#[test]
fn test_initialize_escrow_duplicate_fails() {
    let ctx = new_ctx();

    ctx.client.initialize_escrow(&ctx.user, &ctx.token);

    let result = ctx.client.try_initialize_escrow(&ctx.user, &ctx.token);
    match result {
        Err(Ok(ContractError::AlreadyInitialized)) => {}
        other => panic!("expected AlreadyInitialized, got {:?}", other),
    }
}

#[test]
fn test_multiple_escrows_same_user_different_tokens() {
    let ctx = new_ctx();

    let token2 = ctx.env.register(MockToken, ());
    MockTokenClient::new(&ctx.env, &token2).init(&ctx.token_admin);

    let id1 = ctx
        .client
        .try_initialize_escrow(&ctx.user, &ctx.token)
        .unwrap()
        .unwrap();
    let id2 = ctx
        .client
        .try_initialize_escrow(&ctx.user, &token2)
        .unwrap()
        .unwrap();

    assert_eq!(id1, 0);
    assert_eq!(id2, 1);
}

// ---------------------------------------------------------------------------
// Tests: deposit
// ---------------------------------------------------------------------------

#[test]
fn test_deposit_success() {
    let ctx = new_ctx();

    ctx.client.initialize_escrow(&ctx.user, &ctx.token);
    mint_tokens(&ctx, &ctx.user, 1000);

    assert_eq!(
        MockTokenClient::new(&ctx.env, &ctx.token).balance(&ctx.user),
        1000
    );

    ctx.client.deposit(&ctx.user, &ctx.token, &500);

    assert_eq!(
        MockTokenClient::new(&ctx.env, &ctx.token).balance(&ctx.user),
        500
    );
    assert_eq!(
        MockTokenClient::new(&ctx.env, &ctx.token).balance(&ctx.contract_id),
        500
    );

    let info = ctx.client.get_escrow_info(&ctx.user, &ctx.token).unwrap();
    assert_eq!(info.total_locked, 500);
}

#[test]
fn test_deposit_no_escrow_fails() {
    let ctx = new_ctx();

    let result = ctx.client.try_deposit(&ctx.user, &ctx.token, &100);
    match result {
        Err(Ok(ContractError::EscrowNotFound)) => {}
        other => panic!("expected EscrowNotFound, got {:?}", other),
    }
}

#[test]
fn test_deposit_negative_amount_fails() {
    let ctx = new_ctx();

    ctx.client.initialize_escrow(&ctx.user, &ctx.token);

    let result = ctx.client.try_deposit(&ctx.user, &ctx.token, &0);
    match result {
        Err(Ok(ContractError::NegativeAmount)) => {}
        other => panic!("expected NegativeAmount, got {:?}", other),
    }

    let result = ctx.client.try_deposit(&ctx.user, &ctx.token, &(-100));
    match result {
        Err(Ok(ContractError::NegativeAmount)) => {}
        other => panic!("expected NegativeAmount, got {:?}", other),
    }
}

// ---------------------------------------------------------------------------
// Tests: meter registration & charging
// ---------------------------------------------------------------------------

fn setup_meter_charge(ctx: &TestCtx, amount: i128) -> soroban_sdk::String {
    ctx.client.initialize_escrow(&ctx.user, &ctx.token);
    mint_tokens(ctx, &ctx.user, amount);
    ctx.client.deposit(&ctx.user, &ctx.token, &amount);

    let device_id = String::from_str(&ctx.env, "meter-001");
    ctx.client.register_meter(&device_id, &ctx.user, &ctx.token);
    device_id
}

#[test]
fn test_register_meter_success() {
    let ctx = new_ctx();

    let device_id = String::from_str(&ctx.env, "meter-001");
    ctx.client.register_meter(&device_id, &ctx.user, &ctx.token);

    let meter = ctx.client.get_meter_usage(&device_id).unwrap();
    assert_eq!(meter.consumer, ctx.user);
    assert_eq!(meter.token, ctx.token);
    assert_eq!(meter.total_charged, 0);
}

#[test]
fn test_charge_meter_usage_success() {
    let ctx = new_ctx();
    let device_id = setup_meter_charge(&ctx, 1000);

    ctx.client.charge_meter_usage(&device_id, &ctx.user, &300);

    assert_eq!(
        ctx.client
            .get_escrow_info(&ctx.user, &ctx.token)
            .unwrap()
            .total_locked,
        700
    );

    assert_eq!(
        MockTokenClient::new(&ctx.env, &ctx.token).balance(&ctx.fee_recipient),
        300
    );

    let meter = ctx.client.get_meter_usage(&device_id).unwrap();
    assert_eq!(meter.total_charged, 300);
}

#[test]
fn test_charge_meter_usage_insufficient_balance() {
    let ctx = new_ctx();
    let device_id = setup_meter_charge(&ctx, 100);

    let result = ctx
        .client
        .try_charge_meter_usage(&device_id, &ctx.user, &200);
    match result {
        Err(Ok(ContractError::InsufficientBalance)) => {}
        other => panic!("expected InsufficientBalance, got {:?}", other),
    }
}

#[test]
fn test_charge_meter_usage_unregistered_meter() {
    let ctx = new_ctx();

    ctx.client.initialize_escrow(&ctx.user, &ctx.token);
    mint_tokens(&ctx, &ctx.user, 1000);
    ctx.client.deposit(&ctx.user, &ctx.token, &1000);

    let device_id = String::from_str(&ctx.env, "unknown-meter");
    let result = ctx
        .client
        .try_charge_meter_usage(&device_id, &ctx.user, &100);
    match result {
        Err(Ok(ContractError::MeterNotFound)) => {}
        other => panic!("expected MeterNotFound, got {:?}", other),
    }
}

#[test]
fn test_charge_meter_usage_unauthorized_consumer() {
    let ctx = new_ctx();
    let device_id = setup_meter_charge(&ctx, 1000);

    let result = ctx
        .client
        .try_charge_meter_usage(&device_id, &ctx.user2, &100);
    match result {
        Err(Ok(ContractError::Unauthorized)) => {}
        other => panic!("expected Unauthorized, got {:?}", other),
    }
}

#[test]
fn test_charge_meter_usage_negative_amount() {
    let ctx = new_ctx();
    let device_id = setup_meter_charge(&ctx, 1000);

    let result = ctx.client.try_charge_meter_usage(&device_id, &ctx.user, &0);
    match result {
        Err(Ok(ContractError::NegativeAmount)) => {}
        other => panic!("expected NegativeAmount, got {:?}", other),
    }
}

#[test]
fn test_charge_meter_usage_multiple_charges() {
    let ctx = new_ctx();
    let device_id = setup_meter_charge(&ctx, 2000);

    ctx.client.charge_meter_usage(&device_id, &ctx.user, &500);
    ctx.client.charge_meter_usage(&device_id, &ctx.user, &300);
    ctx.client.charge_meter_usage(&device_id, &ctx.user, &200);

    assert_eq!(ctx.client.get_escrow_balance(&ctx.user, &ctx.token), 1000);

    let meter = ctx.client.get_meter_usage(&device_id).unwrap();
    assert_eq!(meter.total_charged, 1000);

    assert_eq!(
        MockTokenClient::new(&ctx.env, &ctx.token).balance(&ctx.fee_recipient),
        1000
    );
}

// ---------------------------------------------------------------------------
// Tests: group registration & charging
// ---------------------------------------------------------------------------

fn setup_group_charge(ctx: &TestCtx, amount: i128) -> soroban_sdk::String {
    ctx.client.initialize_escrow(&ctx.user, &ctx.token);
    mint_tokens(ctx, &ctx.user, amount);
    ctx.client.deposit(&ctx.user, &ctx.token, &amount);

    let group_id = String::from_str(&ctx.env, "fleet-alpha");
    ctx.client
        .register_group(&group_id, &ctx.user, &ctx.token, &10);
    group_id
}

#[test]
fn test_register_group_success() {
    let ctx = new_ctx();

    let group_id = String::from_str(&ctx.env, "fleet-alpha");
    ctx.client
        .register_group(&group_id, &ctx.user, &ctx.token, &10);

    let group = ctx.client.get_group_usage(&group_id).unwrap();
    assert_eq!(group.manager, ctx.user);
    assert_eq!(group.token, ctx.token);
    assert_eq!(group.member_count, 10);
    assert_eq!(group.total_charged, 0);
}

#[test]
fn test_charge_group_usage_success() {
    let ctx = new_ctx();
    let group_id = setup_group_charge(&ctx, 5000);

    ctx.client.charge_group_usage(&group_id, &ctx.user, &2500);

    assert_eq!(
        ctx.client
            .get_escrow_info(&ctx.user, &ctx.token)
            .unwrap()
            .total_locked,
        2500
    );

    let group = ctx.client.get_group_usage(&group_id).unwrap();
    assert_eq!(group.total_charged, 2500);
    assert_eq!(group.member_count, 10);

    assert_eq!(
        MockTokenClient::new(&ctx.env, &ctx.token).balance(&ctx.fee_recipient),
        2500
    );
}

#[test]
fn test_charge_group_usage_insufficient_balance() {
    let ctx = new_ctx();
    let group_id = setup_group_charge(&ctx, 500);

    let result = ctx
        .client
        .try_charge_group_usage(&group_id, &ctx.user, &1000);
    match result {
        Err(Ok(ContractError::InsufficientBalance)) => {}
        other => panic!("expected InsufficientBalance, got {:?}", other),
    }
}

#[test]
fn test_charge_group_usage_unregistered_group() {
    let ctx = new_ctx();

    ctx.client.initialize_escrow(&ctx.user, &ctx.token);
    mint_tokens(&ctx, &ctx.user, 1000);
    ctx.client.deposit(&ctx.user, &ctx.token, &1000);

    let group_id = String::from_str(&ctx.env, "nonexistent-group");
    let result = ctx
        .client
        .try_charge_group_usage(&group_id, &ctx.user, &100);
    match result {
        Err(Ok(ContractError::GroupNotFound)) => {}
        other => panic!("expected GroupNotFound, got {:?}", other),
    }
}

#[test]
fn test_charge_group_usage_wrong_manager() {
    let ctx = new_ctx();
    let group_id = setup_group_charge(&ctx, 1000);

    let result = ctx
        .client
        .try_charge_group_usage(&group_id, &ctx.user2, &100);
    match result {
        Err(Ok(ContractError::Unauthorized)) => {}
        other => panic!("expected Unauthorized, got {:?}", other),
    }
}

#[test]
fn test_charge_group_usage_negative_amount() {
    let ctx = new_ctx();
    let group_id = setup_group_charge(&ctx, 1000);

    let result = ctx.client.try_charge_group_usage(&group_id, &ctx.user, &0);
    match result {
        Err(Ok(ContractError::NegativeAmount)) => {}
        other => panic!("expected NegativeAmount, got {:?}", other),
    }
}

// ---------------------------------------------------------------------------
// Tests: edge cases & queries
// ---------------------------------------------------------------------------

#[test]
fn test_set_fee_recipient() {
    let ctx = new_ctx();

    let recipient = ctx.client.get_fee_recipient();
    assert_eq!(recipient, Some(ctx.fee_recipient));
}

#[test]
fn test_escrow_balance_query_nonexistent() {
    let ctx = new_ctx();

    let balance = ctx
        .client
        .get_escrow_balance(&Address::generate(&ctx.env), &Address::generate(&ctx.env));
    assert_eq!(balance, 0);

    let info = ctx
        .client
        .get_escrow_info(&Address::generate(&ctx.env), &Address::generate(&ctx.env));
    assert!(info.is_none());
}

#[test]
fn test_meter_usage_query_nonexistent() {
    let ctx = new_ctx();

    let device_id = String::from_str(&ctx.env, "ghost-meter");
    let usage = ctx.client.get_meter_usage(&device_id);
    assert!(usage.is_none());
}

#[test]
fn test_group_usage_query_nonexistent() {
    let ctx = new_ctx();

    let group_id = String::from_str(&ctx.env, "ghost-group");
    let usage = ctx.client.get_group_usage(&group_id);
    assert!(usage.is_none());
}

#[test]
fn test_duplicate_meter_registration_fails() {
    let ctx = new_ctx();

    let device_id = String::from_str(&ctx.env, "meter-001");
    ctx.client.register_meter(&device_id, &ctx.user, &ctx.token);

    let result = ctx
        .client
        .try_register_meter(&device_id, &ctx.user, &ctx.token);
    match result {
        Err(Ok(ContractError::AlreadyInitialized)) => {}
        other => panic!("expected AlreadyInitialized, got {:?}", other),
    }
}

#[test]
fn test_duplicate_group_registration_fails() {
    let ctx = new_ctx();

    let group_id = String::from_str(&ctx.env, "fleet-alpha");
    ctx.client
        .register_group(&group_id, &ctx.user, &ctx.token, &5);

    let result = ctx
        .client
        .try_register_group(&group_id, &ctx.user, &ctx.token, &10);
    match result {
        Err(Ok(ContractError::AlreadyInitialized)) => {}
        other => panic!("expected AlreadyInitialized, got {:?}", other),
    }
}

#[test]
fn test_no_escrow_before_meter_charge() {
    let ctx = new_ctx();

    let device_id = String::from_str(&ctx.env, "meter-001");
    ctx.client.register_meter(&device_id, &ctx.user, &ctx.token);

    let result = ctx
        .client
        .try_charge_meter_usage(&device_id, &ctx.user, &100);
    match result {
        Err(Ok(ContractError::EscrowNotFound)) => {}
        other => panic!("expected EscrowNotFound, got {:?}", other),
    }
}

#[test]
fn test_charge_meter_usage_after_multiple_deposits() {
    let ctx = new_ctx();

    ctx.client.initialize_escrow(&ctx.user, &ctx.token);
    mint_tokens(&ctx, &ctx.user, 2000);
    ctx.client.deposit(&ctx.user, &ctx.token, &1000);
    ctx.client.deposit(&ctx.user, &ctx.token, &1000);

    let device_id = String::from_str(&ctx.env, "meter-001");
    ctx.client.register_meter(&device_id, &ctx.user, &ctx.token);

    assert_eq!(ctx.client.get_escrow_balance(&ctx.user, &ctx.token), 2000);

    ctx.client.charge_meter_usage(&device_id, &ctx.user, &1500);
    assert_eq!(ctx.client.get_escrow_balance(&ctx.user, &ctx.token), 500);
}

#[test]
fn test_charge_meter_usage_empty_escrow() {
    let ctx = new_ctx();

    ctx.client.initialize_escrow(&ctx.user, &ctx.token);
    // No deposit!

    let device_id = String::from_str(&ctx.env, "meter-001");
    ctx.client.register_meter(&device_id, &ctx.user, &ctx.token);

    let result = ctx.client.try_charge_meter_usage(&device_id, &ctx.user, &1);
    match result {
        Err(Ok(ContractError::InsufficientBalance)) => {}
        other => panic!("expected InsufficientBalance, got {:?}", other),
    }
}

#[test]
fn test_charge_meter_usage_wrong_token() {
    let ctx = new_ctx();

    let token2 = ctx.env.register(MockToken, ());
    MockTokenClient::new(&ctx.env, &token2).init(&ctx.token_admin);

    // Initialize escrow with TOKEN2 but meter registered with TOKEN.
    ctx.client.initialize_escrow(&ctx.user, &token2);
    // Mint token2 to user.
    MockTokenClient::new(&ctx.env, &token2).mint(&ctx.token_admin, &ctx.user, &1000);
    ctx.client.deposit(&ctx.user, &token2, &1000);

    let device_id = String::from_str(&ctx.env, "meter-001");
    ctx.client.register_meter(&device_id, &ctx.user, &ctx.token);

    let result = ctx
        .client
        .try_charge_meter_usage(&device_id, &ctx.user, &100);
    match result {
        Err(Ok(ContractError::EscrowNotFound)) => {}
        other => panic!("expected EscrowNotFound, got {:?}", other),
    }
}
