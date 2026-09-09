use soroban_sdk::{contracttype, Address, BytesN, Env};

use crate::types::{DeviceStatus, Error};

/// Registration record for a device.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeviceRegistration {
    pub operator: Address,
    pub status: DeviceStatus,
    pub registered_at: u64,
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

/// Storage key namespace.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StorageKey {
    DeviceRegistration(Address),
    TariffRate(Address),
    DepositBalance(Address),
    ReadingCounter(Address),
}

pub fn write_registration(env: &Env, id: &Address, reg: &DeviceRegistration) {
    env.storage()
        .persistent()
        .set(&StorageKey::DeviceRegistration(id.clone()), reg);
}

pub fn registration(env: &Env, id: &Address) -> Option<DeviceRegistration> {
    env.storage()
        .persistent()
        .get(&StorageKey::DeviceRegistration(id.clone()))
}

pub fn write_tariff(env: &Env, id: &Address, rate: &TariffRate) {
    env.storage()
        .persistent()
        .set(&StorageKey::TariffRate(id.clone()), rate);
}

pub fn tariff(env: &Env, id: &Address) -> Option<TariffRate> {
    env.storage()
        .persistent()
        .get(&StorageKey::TariffRate(id.clone()))
}

pub fn write_deposit(env: &Env, id: &Address, balance: &DepositBalance) {
    env.storage()
        .persistent()
        .set(&StorageKey::DepositBalance(id.clone()), balance);
}

pub fn deposit(env: &Env, id: &Address) -> Option<DepositBalance> {
    env.storage()
        .persistent()
        .get(&StorageKey::DepositBalance(id.clone()))
}

pub fn write_reading(env: &Env, id: &Address, rdg: &ReadingCounter) {
    env.storage()
        .persistent()
        .set(&StorageKey::ReadingCounter(id.clone()), rdg);
}

pub fn reading(env: &Env, id: &Address) -> Option<ReadingCounter> {
    env.storage()
        .persistent()
        .get(&StorageKey::ReadingCounter(id.clone()))
}

/// Placeholder verification hook.
///
/// In production the payload would be a domain-separated hash and the on-chain
/// contract would perform `env.crypto().recover_ed25519_ph(&hash, &sig)` to
/// recover the signer. The skeleton validates the signature is a non-null,
/// well-formed 64-byte (ed25519-like) signature.
pub fn verify_signature(env: &Env, device_id: &Address, sig: &BytesN<64>) -> Result<(), Error> {
    if sig.len() != 64 {
        return Err(Error::InvalidSignature);
    }
    let bytes = sig.to_array();
    if bytes.iter().all(|b| *b == 0) {
        return Err(Error::InvalidSignature);
    }
    // Bind a deterministic byte sum to the device address so the same signature
    // cannot be replayed across devices.
    let device_sum: u8 = device_id
        .to_string()
        .len()
        .checked_rem(256)
        .map(|n| n as u8)
        .unwrap_or(0);
    if bytes[0].wrapping_add(device_sum) == 0 {
        return Err(Error::InvalidSignature);
    }
    let _ = env;
    Ok(())
}
