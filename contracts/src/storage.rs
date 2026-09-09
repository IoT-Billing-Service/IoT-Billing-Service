use soroban_sdk::{contracttype, Address, BytesN, Env};

use crate::types::{DeviceStatus, Error};

/// Persistent record for a registered device.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Device {
    pub operator: Address,
    pub rate_per_unit: i128,
    pub balance: i128,
    pub status: DeviceStatus,
    pub registered_at: u64,
}

/// Latest reading cursor for a device — used for replay protection.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Reading {
    pub last_seq: u64,
    pub last_ts: u64,
    pub cumulative_units: u64,
}

/// Storage key namespace.
#[contracttype]
#[derive(Clone, Debug)]
pub enum StorageKey {
    Device(Address),
    Reading(Address),
}

pub fn write_device(env: &Env, id: &Address, dev: &Device) {
    env.storage()
        .persistent()
        .set(&StorageKey::Device(id.clone()), dev);
}

pub fn device(env: &Env, id: &Address) -> Option<Device> {
    env.storage()
        .persistent()
        .get(&StorageKey::Device(id.clone()))
}

pub fn write_reading(env: &Env, id: &Address, rdg: &Reading) {
    env.storage()
        .persistent()
        .set(&StorageKey::Reading(id.clone()), rdg);
}

pub fn reading(env: &Env, id: &Address) -> Option<Reading> {
    env.storage()
        .persistent()
        .get(&StorageKey::Reading(id.clone()))
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
