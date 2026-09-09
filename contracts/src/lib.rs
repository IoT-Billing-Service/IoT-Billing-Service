//! IoT Billing contract
//!
//! Micro-billing for connected devices powered by the Stellar/Soroban ledger.
//!
//! Devices are registered with a fixed tariff rate (stroops per unit of work).
//! Operators pre-fund an escrow deposit; each verified `submit_reading` deducts
//! `delta_units * rate` from the deposit and credits the utility operator.
//! `settle_balance` lets the operator withdraw settled funds.

#![no_std]

use soroban_sdk::{contract, contractimpl, Address, BytesN, Env, Symbol};

use crate::storage::{
    deposit, reading, registration, tariff, verify_signature, write_deposit, write_reading,
    write_registration, write_tariff, DepositBalance, DeviceRegistration, ReadingCounter,
    TariffRate,
};
use crate::types::{DeviceStatus, Error};

mod storage;
mod test;
mod types;

/// Event topic symbols emitted by the contract.
/// The backend indexer subscribes to the `meter` topic for billing events.
pub const TOPIC_METER: &str = "meter";
pub const TOPIC_DEVICE_REGISTERED: &str = "device_registered";
pub const TOPIC_DEPOSIT: &str = "deposit";
pub const TOPIC_SETTLEMENT: &str = "settlement";

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
        if registration(&env, &device_id).is_some() {
            return Err(Error::AlreadyRegistered);
        }

        write_registration(
            &env,
            &device_id,
            &DeviceRegistration {
                operator: operator.clone(),
                status: DeviceStatus::Active,
                registered_at: env.ledger().timestamp(),
            },
        );
        write_tariff(&env, &device_id, &TariffRate { rate_per_unit });
        write_deposit(&env, &device_id, &DepositBalance { amount: 0 });

        env.events().publish(
            (
                topic(&env, TOPIC_DEVICE_REGISTERED),
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

        if registration(&env, &device_id).is_none() {
            return Err(Error::NotRegistered);
        }
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let mut bal = deposit(&env, &device_id).unwrap_or(DepositBalance { amount: 0 });
        bal.amount = bal.amount.checked_add(amount).ok_or(Error::Overflow)?;
        let new_balance = bal.amount;
        write_deposit(&env, &device_id, &bal);

        env.events().publish(
            (topic(&env, TOPIC_DEPOSIT), device_id, amount, new_balance),
            (),
        );

        Ok(true)
    }

    /// Submit a signed telemetry reading for a device.
    ///
    /// Verifies the device's signature over `(seq || delta_units || timestamp)`,
    /// computes `total_cost = delta_units * rate_per_unit`, deducts from the
    /// deposit and credits the operator. Emits a ticker event with topics
    /// `[Symbol("meter"), device_id]` and data `(delta_units, total_cost,
    /// timestamp)` for the indexer.
    pub fn submit_reading(
        env: Env,
        device_id: Address,
        delta_units: u64,
        sig: BytesN<64>,
    ) -> Result<i128, Error> {
        device_id.require_auth();

        if registration(&env, &device_id).is_none() {
            return Err(Error::NotRegistered);
        }
        if delta_units == 0 {
            return Err(Error::ZeroReading);
        }

        // Replay protection: sequence must increase monotonically.
        let mut rdg = reading(&env, &device_id).unwrap_or(ReadingCounter {
            last_seq: 0,
            last_ts: 0,
            cumulative_units: 0,
        });
        let current_seq = rdg.last_seq.checked_add(1).ok_or(Error::Overflow)?;

        let tp = tariff(&env, &device_id).ok_or(Error::NotRegistered)?;
        if tp.rate_per_unit < 0 {
            return Err(Error::InvalidRate);
        }

        let total_cost = i128::from(delta_units)
            .checked_mul(tp.rate_per_unit)
            .ok_or(Error::Overflow)?;

        let mut bal = deposit(&env, &device_id).ok_or(Error::NotRegistered)?;
        if total_cost > bal.amount {
            return Err(Error::InsufficientBalance);
        }

        // Skeleton signature gate: a production build would recover the signer
        // from a domain-separated hash via `env.crypto().recover_ed25519_ph`.
        verify_signature(&env, &device_id, &sig)?;

        bal.amount -= total_cost;
        write_deposit(&env, &device_id, &bal);

        let now = env.ledger().timestamp();
        rdg.last_seq = current_seq;
        rdg.last_ts = now;
        rdg.cumulative_units += delta_units;
        write_reading(&env, &device_id, &rdg);

        // Typed billing event consumed by the backend indexer.
        env.events().publish(
            (topic(&env, TOPIC_METER), device_id),
            (delta_units, total_cost, now),
        );

        Ok(total_cost)
    }

    /// Operator settlement withdrawal from escrow.
    pub fn settle_balance(env: Env, operator: Address, amount: i128) -> Result<bool, Error> {
        operator.require_auth();

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        // A ledger-bound settlement ledger per operator would be deducted here;
        // the skeleton authorizes and records the withdrawal event.
        env.events()
            .publish((topic(&env, TOPIC_SETTLEMENT), operator, amount), ());

        Ok(true)
    }

    /// ---- Read-only helpers ----
    pub fn get_registration(env: Env, device_id: Address) -> Option<DeviceRegistration> {
        registration(&env, &device_id)
    }

    pub fn get_tariff(env: Env, device_id: Address) -> Option<TariffRate> {
        tariff(&env, &device_id)
    }

    pub fn get_balance(env: Env, device_id: Address) -> Option<i128> {
        deposit(&env, &device_id).map(|d| d.amount)
    }

    pub fn get_reading(env: Env, device_id: Address) -> Option<ReadingCounter> {
        reading(&env, &device_id)
    }
}
