#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Symbol, String};

#[derive(Clone)]
#[contracttype]
pub enum OracleKey {
    Admin,
    BasePrice(String),       // Maps base asset type to exchange rate in stroops
    CarbonMultiplier(String), // Multipliers for carbon-credits matching
}

#[contract]
pub struct IoTPriceOracle;

#[contractimpl]
impl IoTPriceOracle {
    /// Initialize the price oracle with an administrative signing authority
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&OracleKey::Admin) {
            panic!("Price Oracle already initialized");
        }
        env.storage().instance().set(&OracleKey::Admin, &admin);
    }

    /// Sets the dynamic rate of an asset (e.g., "XLM/USD" feed) on-chain
    pub fn set_price(env: Env, asset_id: String, price_stroops: i128) {
        let admin: Address = env.storage().instance().get(&OracleKey::Admin).unwrap();
        admin.require_auth();

        env.storage().persistent().set(&OracleKey::BasePrice(asset_id), &price_stroops);
    }

    /// Gets the cached exchange price of a particular asset
    pub fn get_price(env: Env, asset_id: String) -> i128 {
        env.storage()
            .persistent()
            .get(&OracleKey::BasePrice(asset_id))
            .unwrap_or(0)
    }

    /// Sets carbon offset multipliers for green-energy-dispatch grid alignments
    pub fn set_carbon_multiplier(env: Env, tariff_id: String, multiplier_bps: u32) {
        let admin: Address = env.storage().instance().get(&OracleKey::Admin).unwrap();
        admin.require_auth();

        env.storage()
            .persistent()
            .set(&OracleKey::CarbonMultiplier(tariff_id), &multiplier_bps);
    }

    /// Gets the carbon offset multiplier (in basis points, e.g., 10000 = 1.0x)
    pub fn get_carbon_multiplier(env: Env, tariff_id: String) -> u32 {
        env.storage()
            .persistent()
            .get(&OracleKey::CarbonMultiplier(tariff_id))
            .unwrap_or(10000)
    }
}
