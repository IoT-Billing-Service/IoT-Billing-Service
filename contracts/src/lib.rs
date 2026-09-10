//! IoT Billing contract
//!
//! Micro-billing for connected devices powered by the Stellar/Soroban ledger.
//!
//! Devices are registered with a fixed tariff rate (stroops per unit of work)
//! and an ed25519 public key used to authorize telemetry. Operators pre-fund an
//! escrow deposit *in the contract's SEP-41 token* (moved from the device into
//! contract custody on `deposit_funds`); each signature-verified
//! `submit_reading` deducts `delta_units * rate` from the deposit and credits
//! the utility operator's settlement ledger. `settle_balance` transfers earned
//! funds back out to the operator in that same token — it cannot touch device
//! deposits.

#![no_std]

use soroban_sdk::token;
use soroban_sdk::{contract, contractimpl, Address, BytesN, Env, Symbol};

use crate::storage::{
    deposit, read_operator_balance, reading, registration, set_token, tariff, token,
    verify_signature, write_deposit, write_operator_balance, write_reading, write_registration,
    write_tariff, DepositBalance, DeviceRegistration, OperatorBalance, ReadingCounter, TariffRate,
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
    /// Configure the contract with the SEP-41 token used for deposits and
    /// settlements. Invoked once at deployment.
    pub fn __constructor(env: Env, billing_token: Address) {
        set_token(&env, &billing_token);
    }

    /// Register a hardware device with a billing rate.
    ///
    /// # Arguments
    /// * `device_id`      - Unique on-chain address of the device.
    /// * `device_pubkey`  - Raw ed25519 public key authorized to sign readings.
    /// * `operator`       - Utility operator that receives the billing revenue.
    /// * `rate_per_unit`  - Price in stroops charged per reported unit.
    pub fn register_device(
        env: Env,
        device_id: Address,
        device_pubkey: BytesN<32>,
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
                device_pubkey: device_pubkey.clone(),
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
    ///
    /// Transfers `amount` of the contract's SEP-41 billing token from the
    /// device into contract custody, then credits the device's internal deposit
    /// ledger. The device must authorize both the escrow entry and the token
    /// transfer (same signature covers `device_id.require_auth()` in both).
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

        let billing_token = token(&env).ok_or(Error::NotInitialized)?;
        token::Client::new(&env, &billing_token).transfer(
            &device_id,
            &env.current_contract_address(),
            &amount,
        );

        write_deposit(&env, &device_id, &bal);

        env.events().publish(
            (topic(&env, TOPIC_DEPOSIT), device_id, amount, new_balance),
            (),
        );

        Ok(true)
    }

    /// Submit a signed telemetry reading on behalf of a device.
    ///
    /// The caller is a relayer (NOT the device). Authorization is delegated to
    /// an ed25519 signature over
    /// `SIGNING_DOMAIN || device_pubkey || data_seq || delta_units || timestamp`,
    /// recovered against the public key stored at registration. `data_seq` must
    /// be the strictly-next sequence for the device, which defeats replay of a
    /// captured signature.
    ///
    /// Emits a ticker event with topics `[Symbol("meter"), device_id]` and data
    /// `(delta_units, total_cost, balance_after, seq, ledger_ts)` for the
    /// indexer.
    pub fn submit_reading(
        env: Env,
        device_id: Address,
        delta_units: u64,
        data_seq: u64,
        timestamp: u64,
        sig: BytesN<64>,
    ) -> Result<i128, Error> {
        let reg = registration(&env, &device_id).ok_or(Error::NotRegistered)?;
        if reg.status != DeviceStatus::Active {
            return Err(Error::DeviceNotActive);
        }
        if delta_units == 0 {
            return Err(Error::ZeroReading);
        }

        // Replay protection: the signed sequence must be the next counter value.
        let mut rdg = reading(&env, &device_id).unwrap_or(ReadingCounter {
            last_seq: 0,
            last_ts: 0,
            cumulative_units: 0,
        });
        let expected_seq = rdg.last_seq.checked_add(1).ok_or(Error::Overflow)?;
        if data_seq != expected_seq {
            return Err(Error::InvalidSequence);
        }

        verify_signature(
            &env,
            &reg.device_pubkey,
            data_seq,
            delta_units,
            timestamp,
            &sig,
        )?;

        let tp = tariff(&env, &device_id).ok_or(Error::NotRegistered)?;
        if tp.rate_per_unit < 0 {
            return Err(Error::InvalidRate);
        }

        let total_cost = i128::from(delta_units)
            .checked_mul(tp.rate_per_unit)
            .ok_or(Error::Overflow)?;

        // Deduct the cost from the device's escrow deposit...
        let mut bal = deposit(&env, &device_id).ok_or(Error::NotRegistered)?;
        if total_cost > bal.amount {
            return Err(Error::InsufficientBalance);
        }
        bal.amount -= total_cost;
        write_deposit(&env, &device_id, &bal);

        // ...and credit the device's operator's settlement ledger.
        let mut op_bal = read_operator_balance(&env, &reg.operator);
        op_bal.total_earned = op_bal
            .total_earned
            .checked_add(total_cost)
            .ok_or(Error::Overflow)?;
        write_operator_balance(&env, &reg.operator, &op_bal);

        let now = env.ledger().timestamp();
        rdg.last_seq = data_seq;
        rdg.last_ts = now;
        rdg.cumulative_units = rdg
            .cumulative_units
            .checked_add(delta_units)
            .ok_or(Error::Overflow)?;
        write_reading(&env, &device_id, &rdg);

        // Typed billing event consumed by the backend indexer:
        // (delta_units, total_cost, balance_after, seq, ledger_ts).
        env.events().publish(
            (topic(&env, TOPIC_METER), device_id),
            (delta_units, total_cost, bal.amount, data_seq, now),
        );

        Ok(total_cost)
    }

    /// Operator settlement withdrawal — moves *earned* fees out of the operator
    /// settlement ledger and pays them in the contract's SEP-41 billing token.
    /// Device deposits are never withdrawable by operators. If the contract's
    /// token custody is drained below the requested amount, the transfer fails
    /// and the entire transaction reverts.
    pub fn settle_balance(env: Env, operator: Address, amount: i128) -> Result<bool, Error> {
        operator.require_auth();

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let mut bal = read_operator_balance(&env, &operator);
        let withdrawable = bal.total_earned.saturating_sub(bal.total_settled);
        if amount > withdrawable {
            return Err(Error::InsufficientEarnings);
        }

        let billing_token = token(&env).ok_or(Error::NotInitialized)?;
        token::Client::new(&env, &billing_token).transfer(
            &env.current_contract_address(),
            &operator,
            &amount,
        );

        bal.total_settled = bal
            .total_settled
            .checked_add(amount)
            .ok_or(Error::Overflow)?;
        write_operator_balance(&env, &operator, &bal);

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

    pub fn get_operator_balance(env: Env, operator: Address) -> OperatorBalance {
        read_operator_balance(&env, &operator)
    }
}
