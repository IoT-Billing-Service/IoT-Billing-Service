use soroban_sdk::{contracterror, contracttype};

/// Billing-specific error codes surfaced to clients and the indexer.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotRegistered = 1,
    AlreadyRegistered = 2,
    InvalidRate = 3,
    InvalidAmount = 4,
    InsufficientBalance = 5,
    ZeroReading = 6,
    Overflow = 7,
    InvalidSignature = 8,
    InvalidSequence = 9,
    InsufficientEarnings = 10,
    DeviceNotActive = 11,
    NotInitialized = 12,
}

/// Operational status of a registered device.
#[contracttype]
#[derive(Clone, Debug, Copy, PartialEq, Eq)]
pub enum DeviceStatus {
    Active,
    Suspended,
    Retired,
}
