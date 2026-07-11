use soroban_sdk::{symbol_short, Address, BytesN, Env};
use utility_contracts::{
    grant_stream_listener::{GrantConfig, GrantMatch, GrantStreamListener},
    ConservationGoal, GoalReachedEvent, GrantDataKey, UtilityContract,
};

#[test]
fn test_grant_stream_integration() {
    let env = Env::default();
    env.mock_all_auths();

    // Setup addresses
    let admin = Address::generate(&env);
    let provider = Address::generate(&env);
    let treasury = Address::generate(&env);
    let grant_stream_contract = env.register_contract(None, GrantStreamListener);
    let utility_contract = env.register_contract(None, UtilityContract);

    // Initialize grant stream listener
    GrantStreamListener::initialize(env.clone(), admin.clone(), treasury.clone());

    // Create a conservation goal
    let goal_id = UtilityContract::create_conservation_goal(
        env.clone(),
        provider.clone(),
        1000,                                  // 1000 liters target
        env.ledger().timestamp() + 86400 * 30, // 30 days deadline
        500_000_00,                            // $5000 grant in cents
        treasury.clone(), // Grant token (using treasury as token for simplicity)
    );

    // Verify goal was created
    let goal = UtilityContract::get_conservation_goal(env.clone(), goal_id);
    assert_eq!(goal.goal_id, goal_id);
    assert_eq!(goal.provider, provider);
    assert_eq!(goal.target_water_savings, 1000);
    assert_eq!(goal.grant_amount, 500_000_00);
    assert!(goal.is_active);

    // Configure grant stream match
    UtilityContract::configure_grant_stream_match(env.clone(), goal_id, grant_stream_contract);

    // Fund treasury with grant tokens
    let token_client = soroban_sdk::token::Client::new(&env, &treasury);
    token_client.mint(&treasury, &1_000_000_00); // Mint $10,000

    // Update water savings to reach goal
    UtilityContract::update_water_savings(
        env.clone(),
        goal_id,
        1000, // Add 1000 liters savings
    );

    // Verify goal is now achieved
    let updated_goal = UtilityContract::get_conservation_goal(env.clone(), goal_id);
    assert!(!updated_goal.is_active);
    assert!(updated_goal.achieved_at.is_some());
    assert_eq!(updated_goal.current_savings, 1000);

    // Verify grant was processed
    let grant_match = GrantStreamListener::get_grant_match(env.clone(), goal_id);
    assert_eq!(grant_match.goal_id, goal_id);
    assert_eq!(grant_match.provider, provider);
    assert_eq!(grant_match.grant_amount, 500_000_00);
    assert!(grant_match.processed);
    assert_eq!(grant_match.maintenance_months_covered, 5); // $5000 / $1000 = 5 months

    // Verify provider received grant
    let provider_balance = token_client.balance(&provider);
    assert_eq!(provider_balance, 500_000_00);
}

#[test]
fn test_multiple_grant_matches() {
    let env = Env::default();
    env.mock_all_auths();

    // Setup addresses
    let admin = Address::generate(&env);
    let provider1 = Address::generate(&env);
    let provider2 = Address::generate(&env);
    let treasury = Address::generate(&env);
    let grant_stream_contract = env.register_contract(None, GrantStreamListener);
    let utility_contract = env.register_contract(None, UtilityContract);

    // Initialize grant stream listener
    GrantStreamListener::initialize(env.clone(), admin.clone(), treasury.clone());

    // Fund treasury
    let token_client = soroban_sdk::token::Client::new(&env, &treasury);
    token_client.mint(&treasury, &5_000_000_00); // Mint $50,000

    // Create goals for two providers
    let goal1_id = UtilityContract::create_conservation_goal(
        env.clone(),
        provider1.clone(),
        2000, // 2000 liters target
        env.ledger().timestamp() + 86400 * 30,
        2_000_000_00, // $20,000 grant
        treasury.clone(),
    );

    let goal2_id = UtilityContract::create_conservation_goal(
        env.clone(),
        provider2.clone(),
        1500, // 1500 liters target
        env.ledger().timestamp() + 86400 * 30,
        1_500_000_00, // $15,000 grant
        treasury.clone(),
    );

    // Configure grant stream matches
    UtilityContract::configure_grant_stream_match(env.clone(), goal1_id, grant_stream_contract);
    UtilityContract::configure_grant_stream_match(env.clone(), goal2_id, grant_stream_contract);

    // Achieve both goals
    UtilityContract::update_water_savings(env.clone(), goal1_id, 2000);
    UtilityContract::update_water_savings(env.clone(), goal2_id, 1500);

    // Verify both grants were processed
    let grant1 = GrantStreamListener::get_grant_match(env.clone(), goal1_id);
    let grant2 = GrantStreamListener::get_grant_match(env.clone(), goal2_id);

    assert!(grant1.processed);
    assert!(grant2.processed);
    assert_eq!(grant1.provider, provider1);
    assert_eq!(grant2.provider, provider2);

    // Verify statistics
    let (count, total_granted, max_monthly) =
        GrantStreamListener::get_grant_statistics(env.clone());
    assert_eq!(count, 2);
    assert_eq!(total_granted, 3_500_000_00); // $35,000 total
}

#[test]
fn test_monthly_grant_limit() {
    let env = Env::default();
    env.mock_all_auths();

    // Setup addresses
    let admin = Address::generate(&env);
    let provider = Address::generate(&env);
    let treasury = Address::generate(&env);
    let grant_stream_contract = env.register_contract(None, GrantStreamListener);
    let utility_contract = env.register_contract(None, UtilityContract);

    // Initialize grant stream listener with low monthly limit
    GrantStreamListener::initialize(env.clone(), admin.clone(), treasury.clone());
    GrantStreamListener::update_grant_config(env.clone(), true, 1_000_000_00); // $10,000 monthly limit

    // Fund treasury
    let token_client = soroban_sdk::token::Client::new(&env, &treasury);
    token_client.mint(&treasury, &3_000_000_00); // Mint $30,000

    // Create first goal within limit
    let goal1_id = UtilityContract::create_conservation_goal(
        env.clone(),
        provider.clone(),
        1000,
        env.ledger().timestamp() + 86400 * 30,
        800_000_00, // $8,000 grant (within limit)
        treasury.clone(),
    );

    // Create second goal that would exceed limit
    let goal2_id = UtilityContract::create_conservation_goal(
        env.clone(),
        provider.clone(),
        1000,
        env.ledger().timestamp() + 86400 * 30,
        500_000_00, // $5,000 grant (would exceed limit)
        treasury.clone(),
    );

    // Configure grant stream matches
    UtilityContract::configure_grant_stream_match(env.clone(), goal1_id, grant_stream_contract);
    UtilityContract::configure_grant_stream_match(env.clone(), goal2_id, grant_stream_contract);

    // Achieve first goal (should succeed)
    UtilityContract::update_water_savings(env.clone(), goal1_id, 1000);

    let grant1 = GrantStreamListener::get_grant_match(env.clone(), goal1_id);
    assert!(grant1.processed);

    // Try to achieve second goal (should fail due to monthly limit)
    let result = env.try_invoke_contract::<(), (
        soroban_sdk::xdr::ScError,
        soroban_sdk::xdr::ScErrorCode,
        u32,
    )>(
        &utility_contract,
        &soroban_sdk::Symbol::new(&env, "update_water_savings"),
        soroban_sdk::vec![&env, goal2_id.into(), 1000.into()],
    );

    assert!(result.is_err());
}

#[test]
fn test_goal_expiry() {
    let env = Env::default();
    env.mock_all_auths();

    // Setup addresses
    let admin = Address::generate(&env);
    let provider = Address::generate(&env);
    let treasury = Address::generate(&env);
    let utility_contract = env.register_contract(None, UtilityContract);

    // Create a goal with expired deadline
    let past_timestamp = env.ledger().timestamp() - 86400; // 1 day ago
    let goal_id = UtilityContract::create_conservation_goal(
        env.clone(),
        provider.clone(),
        1000,
        past_timestamp, // Expired deadline
        500_000_00,
        treasury.clone(),
    );

    // Try to update water savings after deadline (should fail)
    let result = env.try_invoke_contract::<(), (
        soroban_sdk::xdr::ScError,
        soroban_sdk::xdr::ScErrorCode,
        u32,
    )>(
        &utility_contract,
        &soroban_sdk::Symbol::new(&env, "update_water_savings"),
        soroban_sdk::vec![&env, goal_id.into(), 1000.into()],
    );

    assert!(result.is_err());

    // Verify goal is no longer active
    let goal = UtilityContract::get_conservation_goal(env.clone(), goal_id);
    assert!(!goal.is_active);
}

#[test]
fn test_insufficient_treasury_balance() {
    let env = Env::default();
    env.mock_all_auths();

    // Setup addresses
    let admin = Address::generate(&env);
    let provider = Address::generate(&env);
    let treasury = Address::generate(&env);
    let grant_stream_contract = env.register_contract(None, GrantStreamListener);
    let utility_contract = env.register_contract(None, UtilityContract);

    // Initialize grant stream listener
    GrantStreamListener::initialize(env.clone(), admin.clone(), treasury.clone());

    // Fund treasury with insufficient amount
    let token_client = soroban_sdk::token::Client::new(&env, &treasury);
    token_client.mint(&treasury, &100_000_00); // Only $1,000

    // Create goal requiring $5,000
    let goal_id = UtilityContract::create_conservation_goal(
        env.clone(),
        provider.clone(),
        1000,
        env.ledger().timestamp() + 86400 * 30,
        500_000_00, // $5,000 grant (more than treasury has)
        treasury.clone(),
    );

    // Configure grant stream match
    UtilityContract::configure_grant_stream_match(env.clone(), goal_id, grant_stream_contract);

    // Try to achieve goal (should fail due to insufficient treasury balance)
    let result = env.try_invoke_contract::<(), (
        soroban_sdk::xdr::ScError,
        soroban_sdk::xdr::ScErrorCode,
        u32,
    )>(
        &utility_contract,
        &soroban_sdk::Symbol::new(&env, "update_water_savings"),
        soroban_sdk::vec![&env, goal_id.into(), 1000.into()],
    );

    assert!(result.is_err());
}

#[test]
fn test_grant_configuration_management() {
    let env = Env::default();
    env.mock_all_auths();

    // Setup addresses
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    // Initialize grant stream listener
    GrantStreamListener::initialize(env.clone(), admin.clone(), treasury.clone());

    // Get initial config
    let config = GrantStreamListener::get_grant_config(env.clone());
    assert!(config.enabled);
    assert_eq!(config.max_grant_per_month, 1_000_000_00); // Default $10,000

    // Update configuration
    GrantStreamListener::update_grant_config(env.clone(), false, 2_000_000_00); // Disable, $20,000 limit

    // Verify updated config
    let updated_config = GrantStreamListener::get_grant_config(env.clone());
    assert!(!updated_config.enabled);
    assert_eq!(updated_config.max_grant_per_month, 2_000_000_00);

    // Update treasury
    let new_treasury = Address::generate(&env);
    GrantStreamListener::update_treasury(env.clone(), new_treasury.clone());

    // Verify treasury update
    let final_config = GrantStreamListener::get_grant_config(env.clone());
    assert_eq!(final_config.treasury, new_treasury);
}

#[test]
fn test_provider_grant_tracking() {
    let env = Env::default();
    env.mock_all_auths();

    // Setup addresses
    let admin = Address::generate(&env);
    let provider = Address::generate(&env);
    let treasury = Address::generate(&env);
    let grant_stream_contract = env.register_contract(None, GrantStreamListener);
    let utility_contract = env.register_contract(None, UtilityContract);

    // Initialize grant stream listener
    GrantStreamListener::initialize(env.clone(), admin.clone(), treasury.clone());

    // Fund treasury
    let token_client = soroban_sdk::token::Client::new(&env, &treasury);
    token_client.mint(&treasury, &3_000_000_00); // Mint $30,000

    // Create multiple goals for the same provider
    let goal1_id = UtilityContract::create_conservation_goal(
        env.clone(),
        provider.clone(),
        500,
        env.ledger().timestamp() + 86400 * 30,
        1_000_000_00, // $10,000 grant
        treasury.clone(),
    );

    let goal2_id = UtilityContract::create_conservation_goal(
        env.clone(),
        provider.clone(),
        750,
        env.ledger().timestamp() + 86400 * 30,
        1_500_000_00, // $15,000 grant
        treasury.clone(),
    );

    // Configure grant stream matches
    UtilityContract::configure_grant_stream_match(env.clone(), goal1_id, grant_stream_contract);
    UtilityContract::configure_grant_stream_match(env.clone(), goal2_id, grant_stream_contract);

    // Achieve both goals
    UtilityContract::update_water_savings(env.clone(), goal1_id, 500);
    UtilityContract::update_water_savings(env.clone(), goal2_id, 750);

    // Verify provider's total grants
    let total_grants =
        GrantStreamListener::get_provider_total_grants(env.clone(), provider.clone());
    assert_eq!(total_grants, 2_500_000_00); // $25,000 total

    // Verify provider's grant list
    let provider_grants = GrantStreamListener::get_provider_grants(env.clone(), provider.clone());
    assert_eq!(provider_grants.len(), 2);
    assert!(provider_grants.contains(&goal1_id));
    assert!(provider_grants.contains(&goal2_id));
}
