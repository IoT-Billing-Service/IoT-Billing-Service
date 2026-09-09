#![cfg(test)]

use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{Address, BytesN, Env};

use crate::types::{DeviceStatus, Error};
use crate::{IotBillingContract, IotBillingContractClient};

const RATE: i128 = 10; // stroops per unit
const FUNDS: i128 = 1_000_000;

/// Build a well-formed 64-byte ed25519-like signature for tests.
fn mk_sig(env: &Env, tag: u8) -> BytesN<64> {
    let mut arr = [0u8; 64];
    arr[0] = tag.max(1);
    BytesN::from_array(env, &arr)
}

fn setup() -> (Env, Address, Address, IotBillingContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let device = Address::generate(&env);
    let operator = Address::generate(&env);
    let contract = env.register(IotBillingContract, ());
    let client = IotBillingContractClient::new(&env, &contract);
    (env, device, operator, client)
}

fn registered_client() -> (Env, Address, Address, IotBillingContractClient<'static>) {
    let (env, device, operator, client) = setup();
    client.register_device(&device, &operator, &RATE);
    (env, device, operator, client)
}

// ---- registration & tariff ----

#[test]
fn registers_device_with_separate_state_keys() {
    let (env, device, operator, client) = setup();
    env.ledger().set_timestamp(1_700_000_000);
    client.register_device(&device, &operator, &RATE);

    let reg = client.get_registration(&device).unwrap();
    assert_eq!(reg.operator, operator);
    assert_eq!(reg.status, DeviceStatus::Active);
    assert!(reg.registered_at > 0);

    let tp = client.get_tariff(&device).unwrap();
    assert_eq!(tp.rate_per_unit, RATE);

    assert_eq!(client.get_balance(&device).unwrap(), 0);
    let _ = env;
}

#[test]
fn register_writes_distinct_storage_keys() {
    // Registration, tariff, and deposit live under separate keys; mutating one
    // must not affect the others.
    let (env, device, operator, client) = setup();
    client.register_device(&device, &operator, &RATE);
    client.deposit_funds(&device, &1234);

    assert_eq!(client.get_balance(&device).unwrap(), 1234);
    assert_eq!(client.get_registration(&device).unwrap().operator, operator);
    assert_eq!(client.get_tariff(&device).unwrap().rate_per_unit, RATE);
    let _ = env;
}

#[test]
fn rejects_duplicate_registration() {
    let (env, device, operator, client) = setup();

    client.register_device(&device, &operator, &RATE);
    let res = client.try_register_device(&device, &operator, &RATE);
    assert_eq!(res, Err(Ok(Error::AlreadyRegistered)));
    let _ = env;
}

#[test]
fn rejects_negative_rate() {
    let (_env, device, operator, client) = setup();

    let res = client.try_register_device(&device, &operator, &(-5));
    assert_eq!(res, Err(Ok(Error::InvalidRate)));
}

// ---- deposits & balance ----

#[test]
fn deposits_funds() {
    let (_env, device, _operator, client) = registered_client();

    client.deposit_funds(&device, &FUNDS);
    assert_eq!(client.get_balance(&device).unwrap(), FUNDS);
}

#[test]
fn rejects_deposit_on_unregistered_device() {
    let (_env, device, _operator, client) = setup();

    let res = client.try_deposit_funds(&device, &FUNDS);
    assert_eq!(res, Err(Ok(Error::NotRegistered)));
}

#[test]
fn rejects_non_positive_deposit() {
    let (_env, device, _operator, client) = registered_client();

    let res = client.try_deposit_funds(&device, &0);
    assert_eq!(res, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn deposit_guards_against_overflow() {
    let (_env, device, _operator, client) = registered_client();

    client.deposit_funds(&device, &i128::MAX);
    let res = client.try_deposit_funds(&device, &1);
    assert_eq!(res, Err(Ok(Error::Overflow)));
}

// ---- billing ----

#[test]
fn submits_reading_and_bills() {
    let (env, device, operator, client) = registered_client();
    client.deposit_funds(&device, &FUNDS);

    let sig = mk_sig(&env, 11);
    let total_cost = client.submit_reading(&device, &100, &sig);

    // cost = 100 units * 10 stroops = 1000
    assert_eq!(total_cost, 1000);
    assert_eq!(client.get_balance(&device).unwrap(), FUNDS - 1000);

    let rdg = client.get_reading(&device).unwrap();
    assert_eq!(rdg.last_seq, 1);
    assert_eq!(rdg.cumulative_units, 100);

    let _ = operator;
}

#[test]
fn rejects_reading_when_balance_exhausted() {
    let (env, device, _operator, client) = registered_client();
    client.deposit_funds(&device, &900); // pays for 90 units at rate 10

    let sig = mk_sig(&env, 22);
    let res = client.try_submit_reading(&device, &91, &sig);
    assert_eq!(res, Err(Ok(Error::InsufficientBalance)));
}

#[test]
fn rejects_zero_reading() {
    let (env, device, _operator, client) = registered_client();
    client.deposit_funds(&device, &FUNDS);

    let sig = mk_sig(&env, 33);
    let res = client.try_submit_reading(&device, &0, &sig);
    assert_eq!(res, Err(Ok(Error::ZeroReading)));
}

#[test]
fn reading_guards_against_cost_overflow() {
    let (env, device, operator, client) = setup();
    client.register_device(&device, &operator, &i128::MAX);
    client.deposit_funds(&device, &FUNDS);

    let sig = mk_sig(&env, 44);
    let res = client.try_submit_reading(&device, &u64::MAX, &sig);
    assert_eq!(res, Err(Ok(Error::Overflow)));
}

#[test]
fn rejects_null_signature() {
    let (env, device, _operator, client) = registered_client();
    client.deposit_funds(&device, &FUNDS);

    let null_sig = BytesN::from_array(&env, &[0u8; 64]);
    let res = client.try_submit_reading(&device, &10, &null_sig);
    assert_eq!(res, Err(Ok(Error::InvalidSignature)));
}

#[test]
fn enforces_sequence_monotonicity() {
    let (env, device, _operator, client) = registered_client();
    client.deposit_funds(&device, &FUNDS);

    let sig = mk_sig(&env, 55);
    client.submit_reading(&device, &100, &sig);
    client.submit_reading(&device, &100, &sig);

    let rdg = client.get_reading(&device).unwrap();
    assert_eq!(rdg.last_seq, 2);
    assert_eq!(rdg.cumulative_units, 200);
}

// ---- settlement ----

#[test]
fn settles_balance_for_operator() {
    let (env, device, operator, client) = registered_client();
    client.deposit_funds(&device, &FUNDS);

    let ok = client.settle_balance(&operator, &5000);
    assert!(ok);

    assert_eq!(client.get_balance(&device).unwrap(), FUNDS);
    let _ = env;
}

#[test]
fn rejects_non_positive_settlement() {
    let (_env, _device, operator, client) = registered_client();

    let res = client.try_settle_balance(&operator, &0);
    assert_eq!(res, Err(Ok(Error::InvalidAmount)));
}

// ---- authorization ----

#[test]
fn denies_unauthenticated_registration() {
    // No mock_all_auths: device_id.require_auth() must reject the call.
    let env = Env::default();
    let device = Address::generate(&env);
    let operator = Address::generate(&env);
    let contract = env.register(IotBillingContract, ());
    let client = IotBillingContractClient::new(&env, &contract);

    let res = client.try_register_device(&device, &operator, &RATE);
    assert!(res.is_err());
}

#[test]
fn denies_unauthenticated_settlement() {
    // No mock_all_auths: operator.require_auth() must reject the call.
    let env = Env::default();
    let operator = Address::generate(&env);
    let contract = env.register(IotBillingContract, ());
    let client = IotBillingContractClient::new(&env, &contract);

    let res = client.try_settle_balance(&operator, &5000);
    assert!(res.is_err());
}
