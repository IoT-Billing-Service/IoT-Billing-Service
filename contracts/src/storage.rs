use soroban_sdk::{contracttype, Address, Bytes, BytesN, Env};

use crate::types::{DeviceStatus, Error};

/// Registration record for a device.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeviceRegistration {
    pub operator: Address,
    pub status: DeviceStatus,
    pub registered_at: u64,
    /// Raw ed25519 public key used to authorize telemetry readings.
    pub device_pubkey: BytesN<32>,
}

/// Per-device tariff (stroops per unit of work).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TariffRate {
    pub rate_per_unit: i128,
}

/// Per-device escrow deposit balance.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DepositBalance {
    pub amount: i128,
}

/// Per-device reading cursor — used for replay protection.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReadingCounter {
    pub last_seq: u64,
    pub last_ts: u64,
    pub cumulative_units: u64,
}

/// Per-operator settlement ledger.
///
/// `total_earned` accumulates every billing credit received from devices and
/// `total_settled` tracks cumulative withdrawals granted to the operator. The
/// withdrawable amount is `total_earned - total_settled`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperatorBalance {
    pub total_earned: i128,
    pub total_settled: i128,
}

/// Storage key namespace.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StorageKey {
    DeviceRegistration(Address),
    TariffRate(Address),
    DepositBalance(Address),
    ReadingCounter(Address),
    OperatorBalance(Address),
}

/// Default persistent-TTL window. Entries are refreshed on every write; the
/// values keep device/metadata live for roughly six months between touchpoints.
pub const TTL_THRESHOLD: u32 = 1_000_000;
pub const TTL_EXTEND_TO: u32 = 3_000_000;

pub fn write_registration(env: &Env, id: &Address, reg: &DeviceRegistration) {
    env.storage()
        .persistent()
        .set(&StorageKey::DeviceRegistration(id.clone()), reg);
    bump_ttl(env, &StorageKey::DeviceRegistration(id.clone()));
}

pub fn registration(env: &Env, id: &Address) -> Option<DeviceRegistration> {
    let key = StorageKey::DeviceRegistration(id.clone());
    let value: Option<DeviceRegistration> = env.storage().persistent().get(&key);
    if value.is_some() {
        bump_ttl(env, &key);
    }
    value
}

pub fn write_tariff(env: &Env, id: &Address, rate: &TariffRate) {
    env.storage()
        .persistent()
        .set(&StorageKey::TariffRate(id.clone()), rate);
    bump_ttl(env, &StorageKey::TariffRate(id.clone()));
}

pub fn tariff(env: &Env, id: &Address) -> Option<TariffRate> {
    let key = StorageKey::TariffRate(id.clone());
    let value: Option<TariffRate> = env.storage().persistent().get(&key);
    if value.is_some() {
        bump_ttl(env, &key);
    }
    value
}

pub fn write_deposit(env: &Env, id: &Address, balance: &DepositBalance) {
    env.storage()
        .persistent()
        .set(&StorageKey::DepositBalance(id.clone()), balance);
    bump_ttl(env, &StorageKey::DepositBalance(id.clone()));
}

pub fn deposit(env: &Env, id: &Address) -> Option<DepositBalance> {
    let key = StorageKey::DepositBalance(id.clone());
    let value: Option<DepositBalance> = env.storage().persistent().get(&key);
    if value.is_some() {
        bump_ttl(env, &key);
    }
    value
}

pub fn write_reading(env: &Env, id: &Address, rdg: &ReadingCounter) {
    env.storage()
        .persistent()
        .set(&StorageKey::ReadingCounter(id.clone()), rdg);
    bump_ttl(env, &StorageKey::ReadingCounter(id.clone()));
}

pub fn reading(env: &Env, id: &Address) -> Option<ReadingCounter> {
    let key = StorageKey::ReadingCounter(id.clone());
    let value: Option<ReadingCounter> = env.storage().persistent().get(&key);
    if value.is_some() {
        bump_ttl(env, &key);
    }
    value
}

pub fn read_operator_balance(env: &Env, operator: &Address) -> OperatorBalance {
    let key = StorageKey::OperatorBalance(operator.clone());
    let balance: Option<OperatorBalance> = env.storage().persistent().get(&key);
    if balance.is_some() {
        bump_ttl(env, &key);
    }
    balance.unwrap_or(OperatorBalance {
        total_earned: 0,
        total_settled: 0,
    })
}

pub fn write_operator_balance(env: &Env, operator: &Address, balance: &OperatorBalance) {
    env.storage()
        .persistent()
        .set(&StorageKey::OperatorBalance(operator.clone()), balance);
    bump_ttl(env, &StorageKey::OperatorBalance(operator.clone()));
}

/// Refresh the TTL of a persistent entry to keep long-lived contract data on
/// the ledger.
pub fn bump_ttl(env: &Env, key: &StorageKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND_TO);
}

/// Domain-separation prefix for signed telemetry payloads. Signatures are only
/// valid for this scheme, preventing cross-protocol replay.
const SIGNING_DOMAIN: &[u8] = b"iot-billing-v1";

/// Real ed25519 signature verification for the IoT relayer pattern.
///
/// The signing payload is a deterministic byte sequence —
/// `SIGNING_DOMAIN || device_pubkey || data_seq(be) || delta_units(be) ||
/// timestamp(be)` — bound to the device's public key and monotonic sequence so
/// a captured signature cannot be replayed or re-signed across devices.
pub fn verify_signature(
    env: &Env,
    device_pubkey: &BytesN<32>,
    data_seq: u64,
    delta_units: u64,
    timestamp: u64,
    sig: &BytesN<64>,
) -> Result<(), Error> {
    if sig.len() != 64 {
        return Err(Error::InvalidSignature);
    }

    let mut msg: Bytes = Bytes::new(env);
    msg.append(&Bytes::from_slice(env, SIGNING_DOMAIN));
    msg.append(&Bytes::from_slice(env, &device_pubkey.to_array()));
    msg.append(&Bytes::from_slice(env, &data_seq.to_be_bytes()));
    msg.append(&Bytes::from_slice(env, &delta_units.to_be_bytes()));
    msg.append(&Bytes::from_slice(env, &timestamp.to_be_bytes()));

    // A forged or tampered signature aborts the transaction under the Soroban
    // host (the host traps into a failed InvokeHostFunction).
    env.crypto().ed25519_verify(device_pubkey, &msg, sig);
    Ok(())
}
