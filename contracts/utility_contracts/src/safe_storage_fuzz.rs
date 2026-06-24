#![cfg(test)]

//! Issue #17: fuzz tests asserting no storage read escapes the sane charge
//! range, and that missing keys always resolve to the default.

extern crate std;

use crate::safe_storage::{
    guarded_read_charge, is_sane_charge, read_sane_charge, safe_read, safe_read_or, sanitize_charge,
    MAX_SANE_CHARGE,
};
use proptest::prelude::*;
use soroban_sdk::{contract, symbol_short, Env};

#[contract]
struct Harness;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(10_000))]

    /// Blueprint step 5: across 10,000 random storage-state combinations, a read
    /// of a (possibly non-existent) key never yields a value outside
    /// `[0, MAX_SANE_CHARGE]`, and a non-existent key always reads as 0.
    #[test]
    fn prop_no_read_escapes_sane_bounds(present in any::<bool>(), raw in any::<i128>()) {
        let value = guarded_read_charge(present, raw);

        prop_assert!(value >= 0 && value <= MAX_SANE_CHARGE);

        if !present {
            prop_assert_eq!(value, 0, "missing key must resolve to default 0");
        }
        if present && is_sane_charge(raw) {
            prop_assert_eq!(value, raw, "a sane present value must be preserved");
        }
    }

    /// `sanitize_charge` output is always in-bounds, for any i128 input.
    #[test]
    fn prop_sanitize_always_in_bounds(raw in any::<i128>()) {
        prop_assert!(is_sane_charge(sanitize_charge(raw)));
    }
}

/// On-chain: reading keys that were never written resolves to defaults, not
/// garbage — exercised through the real soroban storage API.
#[test]
fn missing_keys_read_as_defaults_on_chain() {
    let env = Env::default();
    let id = env.register_contract(None, Harness);
    env.as_contract(&id, || {
        let charge_key = symbol_short!("accCharge");
        // Never written → must read as 0, and be a sane charge.
        let charge = read_sane_charge(&env, &charge_key);
        assert_eq!(charge, 0);
        assert!(is_sane_charge(charge));

        // safe_read for a Default type, missing key → default.
        let n: u64 = safe_read(&env, &symbol_short!("count"));
        assert_eq!(n, 0);

        // safe_read_or honours the supplied default.
        let v: i128 = safe_read_or(&env, &symbol_short!("missing"), 42);
        assert_eq!(v, 42);

        // After a write, the value round-trips and is read back.
        env.storage().persistent().set(&charge_key, &1_000i128);
        assert_eq!(read_sane_charge(&env, &charge_key), 1_000);
    });
}
