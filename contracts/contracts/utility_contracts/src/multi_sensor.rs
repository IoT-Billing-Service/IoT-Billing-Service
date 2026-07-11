use crate::namespace::{tenant_get, tenant_set, TenantSlot};
use soroban_sdk::{contracttype, symbol_short, Address, Env, Map, String};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MasterStream {
    pub account: Address,
    pub sensors: Map<String, i128>,
    pub balance: i128,
}

pub fn add_sensor(env: &Env, account: Address, mac: String) {
    account.require_auth();
    let mut stream = load_or_default(env, &account);

    stream.sensors.set(mac.clone(), 0);
    tenant_set(env, &account, TenantSlot::SensorStream, &stream);

    env.events()
        .publish((symbol_short!("SensAdd"),), (account, mac));
}

pub fn remove_sensor(env: &Env, account: Address, mac: String) {
    account.require_auth();
    let mut stream = load_stream(env, &account);

    stream.sensors.remove(mac.clone());
    tenant_set(env, &account, TenantSlot::SensorStream, &stream);

    env.events()
        .publish((symbol_short!("SensRem"),), (account, mac));
}

pub fn record_consumption(env: &Env, account: Address, mac: String, payload: i128) {
    account.require_auth();
    let mut stream = load_stream(env, &account);

    if stream.sensors.get(mac.clone()).is_none() {
        panic!("Sensor not registered");
    }

    stream.sensors.set(mac.clone(), payload);

    let mut total = 0i128;
    for (_sensor, value) in stream.sensors.iter() {
        total = total.saturating_add(value);
    }

    stream.balance = stream.balance.saturating_sub(total);
    tenant_set(env, &account, TenantSlot::SensorStream, &stream);

    env.events().publish(
        (symbol_short!("AggUpdt"),),
        (account, total, stream.balance),
    );
}

pub fn validate_invariants(env: &Env, account: Address) {
    let stream = load_stream(env, &account);

    if stream.balance < 0 {
        panic!("Balance invariant violated");
    }

    if stream.sensors.len() > 10 {
        panic!("Too many sensors linked");
    }
}

fn load_or_default(env: &Env, account: &Address) -> MasterStream {
    tenant_get(env, account, TenantSlot::SensorStream).unwrap_or_else(|| MasterStream {
        account: account.clone(),
        sensors: Map::new(env),
        balance: 0,
    })
}

fn load_stream(env: &Env, account: &Address) -> MasterStream {
    tenant_get(env, account, TenantSlot::SensorStream).unwrap_or_else(|| panic!("Stream not found"))
}
