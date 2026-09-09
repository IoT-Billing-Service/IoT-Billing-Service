#![cfg(test)]

use soroban_sdk::{testutils::Address as _, Address, BytesN, Env};

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

#[test]
fn registers_device() {
    let (_env, device, operator, client) = setup();

    client.register_device(&device, &operator, &RATE);

    let stored = client.get_device(&device).unwrap();
    assert_eq!(stored.operator, operator);
    assert_eq!(stored.rate_per_unit, RATE);
    assert_eq!(stored.balance, 0);
}

#[test]
fn rejects_duplicate_registration() {
    let (_env, device, operator, client) = setup();

    client.register_device(&device, &operator, &RATE);
    let res = client.try_register_device(&device, &operator, &RATE);
    assert!(res.is_err());
}

#[test]
fn rejects_negative_rate() {
    let (_env, device, operator, client) = setup();

    let res = client.try_register_device(&device, &operator, &(-5));
    assert!(res.is_err());
}

#[test]
fn deposits_funds() {
    let (_env, device, operator, client) = setup();

    client.register_device(&device, &operator, &RATE);
    client.deposit_funds(&device, &FUNDS);

    assert_eq!(client.get_balance(&device).unwrap(), FUNDS);
}

#[test]
fn rejects_deposit_on_unregistered_device() {
    let (_env, device, _operator, client) = setup();

    let res = client.try_deposit_funds(&device, &FUNDS);
    assert!(res.is_err());
}

#[test]
fn submits_reading_and_bills() {
    let (env, device, operator, client) = setup();

    client.register_device(&device, &operator, &RATE);
    client.deposit_funds(&device, &FUNDS);

    let sig = mk_sig(&env, 11);
    let cost = client.submit_reading(&device, &100, &sig);

    // cost = 100 units * 10 stroops = 1000
    assert_eq!(cost, 1000);
    assert_eq!(client.get_balance(&device).unwrap(), FUNDS - 1000);

    let rdg = client.get_reading(&device).unwrap();
    assert_eq!(rdg.last_seq, 1);
    assert_eq!(rdg.cumulative_units, 100);
}

#[test]
fn rejects_reading_when_balance_exhausted() {
    let (env, device, operator, client) = setup();

    client.register_device(&device, &operator, &RATE);
    client.deposit_funds(&device, &900); // pays for 90 units at rate 10

    let sig = mk_sig(&env, 22);
    let res = client.try_submit_reading(&device, &91, &sig);
    assert!(res.is_err());
}

#[test]
fn rejects_zero_reading() {
    let (env, device, operator, client) = setup();

    client.register_device(&device, &operator, &RATE);
    client.deposit_funds(&device, &FUNDS);

    let sig = mk_sig(&env, 33);
    let res = client.try_submit_reading(&device, &0, &sig);
    assert!(res.is_err());
}

#[test]
fn rejects_null_signature() {
    let (env, device, operator, client) = setup();

    client.register_device(&device, &operator, &RATE);
    client.deposit_funds(&device, &FUNDS);

    let null_sig = BytesN::from_array(&env, &[0u8; 64]);
    let res = client.try_submit_reading(&device, &10, &null_sig);
    assert!(res.is_err());
}

#[test]
fn enforces_sequence_monotonicity() {
    let (env, device, operator, client) = setup();

    client.register_device(&device, &operator, &RATE);
    client.deposit_funds(&device, &FUNDS);

    let sig = mk_sig(&env, 44);
    client.submit_reading(&device, &100, &sig);
    client.submit_reading(&device, &100, &sig);

    let rdg = client.get_reading(&device).unwrap();
    assert_eq!(rdg.last_seq, 2);
    assert_eq!(rdg.cumulative_units, 200);
}
