#![cfg(test)]

extern crate alloc;

use alloc::vec::Vec;
use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{Address, BytesN, Env};

use crate::storage::OperatorBalance;
use crate::types::{DeviceStatus, Error};
use crate::{IotBillingContract, IotBillingContractClient};

const RATE: i128 = 10; // stroops per unit
const FUNDS: i128 = 1_000_000;
const MINT: i128 = i128::MAX;
const TS: u64 = 1_700_000_000;
/// Must match `storage::SIGNING_DOMAIN`.
const SIGNING_DOMAIN: &[u8] = b"iot-billing-v1";

struct TestCtx {
    env: Env,
    device: Address,
    operator: Address,
    contract_id: Address,
    token: Address,
    client: IotBillingContractClient<'static>,
    pubkey: [u8; 32],
    sk: SigningKey,
}

fn signer(seed: u8) -> SigningKey {
    let mut secret = [0u8; 32];
    secret[0] = seed.max(1);
    SigningKey::from_bytes(&secret)
}

fn pubkey_of(sk: &SigningKey) -> [u8; 32] {
    sk.verifying_key().to_bytes()
}

fn payload(pubkey: [u8; 32], seq: u64, delta: u64, ts: u64) -> Vec<u8> {
    let mut msg = SIGNING_DOMAIN.to_vec();
    msg.extend_from_slice(&pubkey);
    msg.extend_from_slice(&seq.to_be_bytes());
    msg.extend_from_slice(&delta.to_be_bytes());
    msg.extend_from_slice(&ts.to_be_bytes());
    msg
}

fn setup() -> TestCtx {
    let env = Env::default();
    env.mock_all_auths();
    let sk = signer(1);
    let device = Address::generate(&env);
    let operator = Address::generate(&env);
    let admin = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(admin).address();
    let contract = env.register(IotBillingContract, (&token,));
    let client = IotBillingContractClient::new(&env, &contract);
    // Give the device real SEP-41 token units so `deposit_funds` actually
    // moves funds out of its SAC balance into contract custody.
    StellarAssetClient::new(&env, &token).mint(&device, &MINT);
    TestCtx {
        env,
        device,
        operator,
        contract_id: contract,
        token,
        client,
        pubkey: pubkey_of(&sk),
        sk,
    }
}

fn registered_client() -> TestCtx {
    let ctx = setup();
    ctx.client.register_device(
        &ctx.device,
        &BytesN::from_array(&ctx.env, &ctx.pubkey),
        &ctx.operator,
        &RATE,
    );
    ctx
}

fn mk_sig(ctx: &TestCtx, seq: u64, delta: u64, ts: u64) -> BytesN<64> {
    let sig = ctx.sk.sign(&payload(ctx.pubkey, seq, delta, ts));
    BytesN::from_array(&ctx.env, &sig.to_bytes())
}

// ---- registration & tariff ----

#[test]
fn registers_device_with_separate_state_keys() {
    let ctx = setup();
    ctx.env.ledger().set_timestamp(1_700_000_000);
    ctx.client.register_device(
        &ctx.device,
        &BytesN::from_array(&ctx.env, &ctx.pubkey),
        &ctx.operator,
        &RATE,
    );

    let reg = ctx.client.get_registration(&ctx.device).unwrap();
    assert_eq!(reg.operator, ctx.operator);
    assert_eq!(reg.status, DeviceStatus::Active);
    assert!(reg.registered_at > 0);
    assert_eq!(reg.device_pubkey.to_array(), ctx.pubkey);

    let tp = ctx.client.get_tariff(&ctx.device).unwrap();
    assert_eq!(tp.rate_per_unit, RATE);

    assert_eq!(ctx.client.get_balance(&ctx.device).unwrap(), 0);
    let _ = ctx.env;
}

#[test]
fn register_writes_distinct_storage_keys() {
    // Registration, tariff, and deposit live under separate keys; mutating one
    // must not affect the others.
    let ctx = setup();
    ctx.client.register_device(
        &ctx.device,
        &BytesN::from_array(&ctx.env, &ctx.pubkey),
        &ctx.operator,
        &RATE,
    );
    ctx.client.deposit_funds(&ctx.device, &1234);

    assert_eq!(ctx.client.get_balance(&ctx.device).unwrap(), 1234);
    assert_eq!(
        ctx.client.get_registration(&ctx.device).unwrap().operator,
        ctx.operator
    );
    assert_eq!(
        ctx.client.get_tariff(&ctx.device).unwrap().rate_per_unit,
        RATE
    );
    let _ = ctx.env;
}

#[test]
fn rejects_duplicate_registration() {
    let ctx = setup();
    let key = BytesN::from_array(&ctx.env, &ctx.pubkey);

    ctx.client
        .register_device(&ctx.device, &key, &ctx.operator, &RATE);
    let res = ctx
        .client
        .try_register_device(&ctx.device, &key, &ctx.operator, &RATE);
    assert_eq!(res, Err(Ok(Error::AlreadyRegistered)));
    let _ = ctx.env;
}

#[test]
fn rejects_negative_rate() {
    let ctx = setup();
    let key = BytesN::from_array(&ctx.env, &ctx.pubkey);

    let res = ctx
        .client
        .try_register_device(&ctx.device, &key, &ctx.operator, &(-5));
    assert_eq!(res, Err(Ok(Error::InvalidRate)));
    let _ = ctx.env;
}

// ---- deposits & balance ----

#[test]
fn deposits_funds() {
    let ctx = registered_client();

    ctx.client.deposit_funds(&ctx.device, &FUNDS);
    assert_eq!(ctx.client.get_balance(&ctx.device).unwrap(), FUNDS);

    // Real SEP-41 custody: FUNDS leaves the device wallet...
    let tokens = TokenClient::new(&ctx.env, &ctx.token);
    assert_eq!(tokens.balance(&ctx.device), MINT - FUNDS);
    // ...and lands in the billing contract's own token balance.
    assert_eq!(tokens.balance(&ctx.contract_id), FUNDS);
}

#[test]
fn rejects_deposit_on_unregistered_device() {
    let ctx = setup();

    let res = ctx.client.try_deposit_funds(&ctx.device, &FUNDS);
    assert_eq!(res, Err(Ok(Error::NotRegistered)));
}

#[test]
fn rejects_non_positive_deposit() {
    let ctx = registered_client();

    let res = ctx.client.try_deposit_funds(&ctx.device, &0);
    assert_eq!(res, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn deposit_guards_against_overflow() {
    let ctx = registered_client();

    ctx.client.deposit_funds(&ctx.device, &i128::MAX);
    let res = ctx.client.try_deposit_funds(&ctx.device, &1);
    assert_eq!(res, Err(Ok(Error::Overflow)));
}

// ---- billing & signature auth (IoT relayer pattern) ----

#[test]
fn submits_signed_reading_without_device_require_auth() {
    // The relayer calls submit_reading on the device's behalf. There is no
    // device_id.require_auth(); the ed25519 signature is the authorization.
    let ctx = registered_client();
    ctx.client.deposit_funds(&ctx.device, &FUNDS);

    let sig = mk_sig(&ctx, 1, 100, TS);
    let total_cost = ctx.client.submit_reading(&ctx.device, &100, &1, &TS, &sig);

    // cost = 100 units * 10 stroops = 1000
    assert_eq!(total_cost, 1000);
    assert_eq!(ctx.client.get_balance(&ctx.device).unwrap(), FUNDS - 1000);

    let rdg = ctx.client.get_reading(&ctx.device).unwrap();
    assert_eq!(rdg.last_seq, 1);
    assert_eq!(rdg.cumulative_units, 100);
}

#[test]
fn operator_earns_billed_revenue() {
    let ctx = registered_client();
    ctx.client.deposit_funds(&ctx.device, &FUNDS);

    let sig = mk_sig(&ctx, 1, 100, TS);
    ctx.client.submit_reading(&ctx.device, &100, &1, &TS, &sig);

    let bal = ctx.client.get_operator_balance(&ctx.operator);
    assert_eq!(
        bal,
        OperatorBalance {
            total_earned: 1000,
            total_settled: 0,
        }
    );
}

#[test]
fn rejects_reading_when_balance_exhausted() {
    let ctx = registered_client();
    ctx.client.deposit_funds(&ctx.device, &900); // pays for 90 units at rate 10

    let sig = mk_sig(&ctx, 1, 91, TS);
    let res = ctx
        .client
        .try_submit_reading(&ctx.device, &91, &1, &TS, &sig);
    assert_eq!(res, Err(Ok(Error::InsufficientBalance)));
}

#[test]
fn rejects_zero_reading() {
    let ctx = registered_client();
    ctx.client.deposit_funds(&ctx.device, &FUNDS);

    let sig = mk_sig(&ctx, 1, 0, TS);
    let res = ctx
        .client
        .try_submit_reading(&ctx.device, &0, &1, &TS, &sig);
    assert_eq!(res, Err(Ok(Error::ZeroReading)));
}

#[test]
fn reading_guards_against_cost_overflow() {
    let ctx = setup();
    let key = BytesN::from_array(&ctx.env, &ctx.pubkey);
    ctx.client
        .register_device(&ctx.device, &key, &ctx.operator, &i128::MAX);
    ctx.client.deposit_funds(&ctx.device, &FUNDS);

    let sig = mk_sig(&ctx, 1, u64::MAX, TS);
    let res = ctx
        .client
        .try_submit_reading(&ctx.device, &u64::MAX, &1, &TS, &sig);
    assert_eq!(res, Err(Ok(Error::Overflow)));
}

#[test]
fn rejects_null_signature() {
    let ctx = registered_client();
    ctx.client.deposit_funds(&ctx.device, &FUNDS);

    // The host traps when ed25519 verification fails; try_* surfaces a host
    // error rather than a contract error.
    let null_sig = BytesN::from_array(&ctx.env, &[0u8; 64]);
    let res = ctx
        .client
        .try_submit_reading(&ctx.device, &10, &1, &TS, &null_sig);
    assert!(res.is_err());
}

#[test]
fn rejects_signature_from_wrong_key() {
    let ctx = registered_client();
    ctx.client.deposit_funds(&ctx.device, &FUNDS);

    // Sign with a key that is NOT the registered device_pubkey.
    let attacker = signer(99);
    let msg = payload(pubkey_of(&attacker), 1, 10, TS);
    let sig = BytesN::from_array(&ctx.env, &attacker.sign(&msg).to_bytes());

    let res = ctx
        .client
        .try_submit_reading(&ctx.device, &10, &1, &TS, &sig);
    assert!(res.is_err());
}

#[test]
fn rejects_reading_for_unregistered_device() {
    let ctx = setup();
    let sig = mk_sig(&ctx, 1, 10, TS);
    let res = ctx
        .client
        .try_submit_reading(&ctx.device, &10, &1, &TS, &sig);
    assert_eq!(res, Err(Ok(Error::NotRegistered)));
}

#[test]
fn enforces_sequence_monotonicity() {
    let ctx = registered_client();
    ctx.client.deposit_funds(&ctx.device, &FUNDS);

    let sig1 = mk_sig(&ctx, 1, 100, TS);
    ctx.client.submit_reading(&ctx.device, &100, &1, &TS, &sig1);

    let sig2 = mk_sig(&ctx, 2, 100, TS);
    ctx.client.submit_reading(&ctx.device, &100, &2, &TS, &sig2);

    let rdg = ctx.client.get_reading(&ctx.device).unwrap();
    assert_eq!(rdg.last_seq, 2);
    assert_eq!(rdg.cumulative_units, 200);
}

#[test]
fn rejects_wrong_starting_sequence() {
    let ctx = registered_client();
    ctx.client.deposit_funds(&ctx.device, &FUNDS);

    // First reading must be sequence 1; jumping to 5 is rejected before
    // signature checks.
    let sig = mk_sig(&ctx, 5, 10, TS);
    let res = ctx
        .client
        .try_submit_reading(&ctx.device, &10, &5, &TS, &sig);
    assert_eq!(res, Err(Ok(Error::InvalidSequence)));
}

#[test]
fn rejects_replayed_signature() {
    let ctx = registered_client();
    ctx.client.deposit_funds(&ctx.device, &FUNDS);

    // Capture a valid signature for sequence 1...
    let sig = mk_sig(&ctx, 1, 100, TS);
    ctx.client.submit_reading(&ctx.device, &100, &1, &TS, &sig);

    // Replaying it is rejected: sequence 1 is stale (counter is now 1, so the
    // next expected value is 2).
    let res = ctx
        .client
        .try_submit_reading(&ctx.device, &100, &1, &TS, &sig);
    assert_eq!(res, Err(Ok(Error::InvalidSequence)));

    // Even a *fresh* signature with a stale sequence is rejected.
    let fresh_sig = mk_sig(&ctx, 1, 100, TS + 1);
    let res2 = ctx
        .client
        .try_submit_reading(&ctx.device, &100, &1, &(TS + 1), &fresh_sig);
    assert_eq!(res2, Err(Ok(Error::InvalidSequence)));
}

#[test]
fn signature_is_bound_to_delta_and_timestamp() {
    let ctx = registered_client();
    ctx.client.deposit_funds(&ctx.device, &FUNDS);

    // Signed over delta=100 but submitted with delta=10: signature must not
    // validate.
    let sig = mk_sig(&ctx, 1, 100, TS);
    let res = ctx
        .client
        .try_submit_reading(&ctx.device, &10, &1, &TS, &sig);
    assert!(res.is_err());
}

// ---- operator settlement ----

#[test]
fn operator_settles_earned_funds() {
    let ctx = registered_client();
    ctx.client.deposit_funds(&ctx.device, &FUNDS);

    let sig = mk_sig(&ctx, 1, 100, TS);
    ctx.client.submit_reading(&ctx.device, &100, &1, &TS, &sig);

    let ok = ctx.client.settle_balance(&ctx.operator, &500);
    assert!(ok);

    let bal = ctx.client.get_operator_balance(&ctx.operator);
    assert_eq!(
        bal,
        OperatorBalance {
            total_earned: 1000,
            total_settled: 500,
        }
    );
    // Device escrow is untouched by operator settlement.
    assert_eq!(ctx.client.get_balance(&ctx.device).unwrap(), FUNDS - 1000);

    // Real SEP-41 custody: the settlement moved token units out of the
    // contract into the operator's wallet.
    let tokens = TokenClient::new(&ctx.env, &ctx.token);
    assert_eq!(tokens.balance(&ctx.contract_id), FUNDS - 1000 + 500);
    assert_eq!(tokens.balance(&ctx.operator), 500);
}

#[test]
fn rejects_settlement_without_earnings() {
    let ctx = registered_client();

    let res = ctx.client.try_settle_balance(&ctx.operator, &5000);
    assert_eq!(res, Err(Ok(Error::InsufficientEarnings)));
}

#[test]
fn rejects_oversettlement() {
    let ctx = registered_client();
    ctx.client.deposit_funds(&ctx.device, &FUNDS);

    let sig = mk_sig(&ctx, 1, 100, TS);
    ctx.client.submit_reading(&ctx.device, &100, &1, &TS, &sig);

    // Only 1000 earned; 1001 must fail.
    let res = ctx.client.try_settle_balance(&ctx.operator, &1001);
    assert_eq!(res, Err(Ok(Error::InsufficientEarnings)));

    // Settling the full amount works.
    assert!(ctx.client.settle_balance(&ctx.operator, &1000));

    let res2 = ctx.client.try_settle_balance(&ctx.operator, &1);
    assert_eq!(res2, Err(Ok(Error::InsufficientEarnings)));
}

#[test]
fn rejects_non_positive_settlement() {
    let ctx = registered_client();

    let res = ctx.client.try_settle_balance(&ctx.operator, &0);
    assert_eq!(res, Err(Ok(Error::InvalidAmount)));
}

// ---- authorization ----

#[test]
fn denies_unauthenticated_registration() {
    // No mock_all_auths: device_id.require_auth() must reject the call.
    let env = Env::default();
    let sk = signer(1);
    let device = Address::generate(&env);
    let operator = Address::generate(&env);
    let token = Address::generate(&env);
    let contract = env.register(IotBillingContract, (&token,));
    let client = IotBillingContractClient::new(&env, &contract);

    let res = client.try_register_device(
        &device,
        &BytesN::from_array(&env, &pubkey_of(&sk)),
        &operator,
        &RATE,
    );
    assert!(res.is_err());
}

#[test]
fn denies_unauthenticated_settlement() {
    // No mock_all_auths: operator.require_auth() must reject the call.
    let env = Env::default();
    let operator = Address::generate(&env);
    let token = Address::generate(&env);
    let contract = env.register(IotBillingContract, (&token,));
    let client = IotBillingContractClient::new(&env, &contract);

    let res = client.try_settle_balance(&operator, &5000);
    assert!(res.is_err());
}
