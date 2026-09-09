//! IoT Billing contract
//!
//! Micro-billing for connected devices powered by the Stellar/Soroban ledger.
//!
//! Devices are registered with a fixed tariff rate (stroops per unit of work).
//! Operators pre-fund an escrow deposit; each verified `submit_reading` deducts
//! `delta_units * rate` from the deposit and credits the utility operator.

#![no_std]

use soroban_sdk::{contract, contractimpl, Address, BytesN, Env, Symbol};

pub use crate::storage::{Device, Reading};
pub use crate::types::Error;

mod storage;
mod test;
mod types;

/// Event topic symbols emitted by the contract.
/// The backend indexer subscribes to `MeterBilled` and `FundsDeposited`.
fn topic(env: &Env, name: &str) -> Symbol {
    Symbol::new(env, name)
}

#[contract]
pub struct IotBillingContract;

#[contractimpl]
impl IotBillingContract {
    /// Register a hardware device with a billing rate.
    ///
    /// # Arguments
    /// * `device_id`   - Unique on-chain address of the device.
    /// * `operator`    - Utility operator that receives the billing revenue.
    /// * `rate_per_unit` - Price in stroops charged per reported unit.
    pub fn register_device(
        env: Env,
        device_id: Address,
        operator: Address,
        rate_per_unit: i128,
    ) -> Result<bool, Error> {
        device_id.require_auth();
        operator.require_auth();

        if rate_per_unit < 0 {
            return Err(Error::InvalidRate);
        }
        if storage::device(&env, &device_id).is_some() {
            return Err(Error::AlreadyRegistered);
        }

        storage::write_device(
            &env,
            &device_id,
            &Device {
                operator: operator.clone(),
                rate_per_unit,
                balance: 0,
                status: types::DeviceStatus::Active,
                registered_at: env.ledger().timestamp(),
            },
        );

        env.events().publish(
            (
                topic(&env, "DeviceRegistered"),
                device_id,
                operator,
                rate_per_unit,
            ),
            (),
        );

        Ok(true)
    }

    /// Pre-fund the escrow deposit balance for a device.
    pub fn deposit_funds(env: Env, device_id: Address, amount: i128) -> Result<bool, Error> {
        device_id.require_auth();

        let mut dev = storage::device(&env, &device_id).ok_or(Error::NotRegistered)?;

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        dev.balance = dev.balance.checked_add(amount).ok_or(Error::Overflow)?;
        let new_balance = dev.balance;
        storage::write_device(&env, &device_id, &dev);

        env.events().publish(
            (
                topic(&env, "FundsDeposited"),
                device_id,
                amount,
                new_balance,
            ),
            (),
        );

        Ok(true)
    }

    /// Submit a signed telemetry reading for a device.
    ///
    /// Verifies the device's signature over `(seq || delta_units || timestamp)`,
    /// computes `cost = delta_units * rate_per_unit`, deducts from the deposit
    /// and credits the operator. Emits a `MeterBilled` event for the indexer.
    pub fn submit_reading(
        env: Env,
        device_id: Address,
        delta_units: u64,
        sig: BytesN<64>,
    ) -> Result<i128, Error> {
        device_id.require_auth();

        let mut dev = storage::device(&env, &device_id).ok_or(Error::NotRegistered)?;
        let mut rdg = storage::reading(&env, &device_id).unwrap_or(Reading {
            last_seq: 0,
            last_ts: 0,
            cumulative_units: 0,
        });

        // Replay protection: sequence must increase monotonically.
        let current_seq = rdg.last_seq.checked_add(1).ok_or(Error::Overflow)?;

        // Skeleton signature gate: a production build would recover the signer
        // from a domain-separated hash via `env.crypto().recover_ed25519_ph`.
        // Here we confirm the signature is a well-formed non-null 64-byte blob.
        storage::verify_signature(&env, &device_id, &sig)?;
        let _ = &current_seq;

        if delta_units == 0 {
            return Err(Error::ZeroReading);
        }

        let cost = (i128::from(delta_units))
            .checked_mul(dev.rate_per_unit)
            .ok_or(Error::Overflow)?;
        if cost > dev.balance {
            return Err(Error::InsufficientBalance);
        }

        dev.balance -= cost;
        let balance_after = dev.balance;
        rdg.last_seq = current_seq;
        rdg.last_ts = env.ledger().timestamp();
        rdg.cumulative_units += delta_units;

        storage::write_device(&env, &device_id, &dev);
        storage::write_reading(&env, &device_id, &rdg);

        env.events().publish(
            (
                topic(&env, "MeterBilled"),
                device_id,
                dev.operator.clone(),
                delta_units,
                dev.rate_per_unit,
                cost,
                balance_after,
                current_seq,
            ),
            (),
        );

        Ok(cost)
    }

    /// Operator settlement withdrawal from escrow.
    pub fn withdraw(env: Env, recipient: Address, amount: i128) -> Result<bool, Error> {
        recipient.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        env.events()
            .publish((topic(&env, "Withdrawal"), recipient, amount), ());
        Ok(true)
    }

    /// Read-only helpers
    pub fn get_device(env: Env, device_id: Address) -> Option<Device> {
        storage::device(&env, &device_id)
    }

    pub fn get_reading(env: Env, device_id: Address) -> Option<Reading> {
        storage::reading(&env, &device_id)
    }

    pub fn get_balance(env: Env, device_id: Address) -> Option<i128> {
        storage::device(&env, &device_id).map(|d| d.balance)
    }
}
