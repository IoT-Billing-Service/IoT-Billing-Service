#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env, Symbol, String, Map};

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    Token,
    Paused,
    Escrow(Address), // Maps a DePIN node Address to its current escrow balance
    Tariff(String),  // Maps a tariff code to its rate structures
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct TariffConfig {
    pub base_rate: i128,      // Base rate per payload (in stroops / micro-XLM)
    pub size_rate_kb: i128,   // Rate per KB of payload data
    pub gas_buffer: i128,     // Allocated gas fee buffer
    pub carbon_multiplier: u32, // Offset scaling multiplier
}

#[contract]
pub struct IoTBillingEscrow;

#[contractimpl]
impl IoTBillingEscrow {
    /// Initialize the contract with the administrator address and the Stellar Asset Token (XLM)
    pub fn initialize(env: Env, admin: Address, token: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Contract already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::Paused, &false);
    }

    /// Retrieve the current administrator address
    pub fn get_admin(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).unwrap()
    }

    /// Deposits XLM tokens from a Node Owner into the node's billing escrow balance
    pub fn fund_escrow(env: Env, node_id: Address, amount: i128) {
        self::check_not_paused(&env);
        
        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let token_client = token::Client::new(&env, &token_addr);
        
        // Transfer funds from node owner to this contract address
        token_client.transfer(&node_id, &env.current_contract_address(), &amount);

        // Update stored balance
        let mut balance = self::get_escrow_balance(env.clone(), node_id.clone());
        balance += amount;
        env.storage().persistent().set(&DataKey::Escrow(node_id), &balance);
    }

    /// Processes a telemetry billing debit on behalf of an authorized mTLS Ingestion Gateway
    pub fn bill_telemetry(
        env: Env,
        node_id: Address,
        tariff_id: String,
        payload_size_kb: u32,
    ) -> i128 {
        self::check_not_paused(&env);
        
        // Ensure the sender is the admin/authorized oracle gateway
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        // Retrieve tariff rates
        let tariff: TariffConfig = env
            .storage()
            .persistent()
            .get(&DataKey::Tariff(tariff_id))
            .expect("Tariff configuration not found");

        // Calculate total stroops to debit
        let payload_charge = (payload_size_kb as i128) * tariff.size_rate_kb;
        let total_charge = tariff.base_rate + payload_charge + tariff.gas_buffer;

        // Verify escrow balance
        let mut balance = self::get_escrow_balance(env.clone(), node_id.clone());
        if balance < total_charge {
            panic!("Escrow balance insufficient. Telemetry rejected.");
        }

        // Deduct balance and update state
        balance -= total_charge;
        env.storage().persistent().set(&DataKey::Escrow(node_id.clone()), &balance);

        // Optionally, payout to the service provider here
        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let token_client = token::Client::new(&env, &token_addr);
        token_client.transfer(&env.current_contract_address(), &admin, &total_charge);

        // Return billed amount for ledger verification
        total_charge
    }

    /// Gets the active escrow balance for a specific hardware node
    pub fn get_escrow_balance(env: Env, node_id: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Escrow(node_id))
            .unwrap_or(0)
    }

    /// Sets or updates a dynamic tariff rate configuration via the Price Oracle
    pub fn update_tariff(env: Env, tariff_id: String, config: TariffConfig) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        env.storage().persistent().set(&DataKey::Tariff(tariff_id), &config);
    }

    /// Triggers an emergency pause veto to immediately freeze state billing operations
    pub fn set_paused(env: Env, paused: bool) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        env.storage().instance().set(&DataKey::Paused, &paused);
    }

    /// Returns the active pause status of the smart contracts
    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().get(&DataKey::Paused).unwrap_or(false)
    }
}

// Internal Helper Functions
fn check_not_paused(env: &Env) {
    let paused: bool = env.storage().instance().get(&DataKey::Paused).unwrap_or(false);
    if paused {
        panic!("Contract is currently paused due to emergency administrative veto");
    }
}
