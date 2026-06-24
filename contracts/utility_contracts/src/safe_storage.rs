//! Issue #17: Guarded storage reads with sane-value validation.
//!
//! ## The threat
//!
//! Billing code read keys like `accumulated_charge` with a raw
//! `storage::get(&key)` and relied on the host returning a default for a
//! never-written key. The defensive invariant the codebase should hold is:
//! **every read of a possibly-non-existent key must resolve to a known default,
//! and a charge value must be validated against a sane range before use** — so a
//! new stream can never be credited an absurd amount or trigger an arithmetic
//! panic.
//!
//! ## The fix
//!
//! - [`safe_read`] / [`safe_read_or`] — `has()`-guarded reads that resolve a
//!   missing key to a known default instead of trusting the raw read.
//! - [`read_sane_charge`] — reads an `i128` charge, defaulting a missing key to
//!   `0`, then runs it through [`sanitize_charge`] so an out-of-range value is
//!   rejected to `0` rather than billed.
//! - [`assert_sane_charge`] — a `debug_assert` guard for the billing path.
//!
//! Invariant: any value returned by [`read_sane_charge`] / [`sanitize_charge`]
//! lies in `[0, MAX_SANE_CHARGE]`.
//!
//! Note on the blueprint's "compile-time `#[permanent]`/`#[transient]` lint":
//! a true compile-time lint requires a custom proc-macro or `clippy` driver and
//! is out of scope here. Instead this module offers a runtime
//! [`StorageDurability`] classification plus the convention that transient keys
//! are read only through these helpers; the convention is enforced by review and
//! the fuzz test, not the compiler.

use soroban_sdk::{Env, IntoVal, TryFromVal, Val};

/// Defensive ceiling for a single accumulated charge. Far above any legitimate
/// cumulative bill (in stroops) yet below `u64::MAX`, so the specific garbage
/// value observed in fuzzing (`18446744073709551615` = `u64::MAX`) is flagged
/// rather than treated as a real charge.
pub const MAX_SANE_CHARGE: i128 = 1_000_000_000_000_000_000; // 1e18

/// Durability class of a storage key. Transient keys (those that can be absent
/// or evicted) must be read through [`safe_read`] / [`safe_read_or`].
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum StorageDurability {
    Permanent,
    Transient,
}

// ---------------------------------------------------------------------------
// Pure validation (unit-tested without an Env)
// ---------------------------------------------------------------------------

/// A charge is sane iff it is non-negative and within the defensive ceiling.
pub fn is_sane_charge(value: i128) -> bool {
    value >= 0 && value <= MAX_SANE_CHARGE
}

/// Clamp a charge to a trustworthy value: pass it through if sane, otherwise
/// reject to `0` (the safe default) rather than crediting garbage.
pub fn sanitize_charge(value: i128) -> i128 {
    if is_sane_charge(value) {
        value
    } else {
        0
    }
}

/// Model of the guarded read used by the fuzz test: a missing key resolves to
/// the default `0`; a present key's raw value is sanitized.
pub fn guarded_read_charge(present: bool, raw: i128) -> i128 {
    let value = if present { raw } else { 0 };
    sanitize_charge(value)
}

/// `debug_assert` guard for the billing path. No-op in release builds.
pub fn assert_sane_charge(charge: i128) {
    debug_assert!(
        is_sane_charge(charge),
        "garbage charge detected (outside [0, MAX_SANE_CHARGE])"
    );
}

// ---------------------------------------------------------------------------
// Guarded persistent storage reads
// ---------------------------------------------------------------------------

/// `has()`-guarded read that resolves a missing key to `V::default()` instead of
/// trusting a raw read of a non-existent key.
pub fn safe_read<K, V>(env: &Env, key: &K) -> V
where
    K: IntoVal<Env, Val>,
    V: TryFromVal<Env, Val> + Default,
{
    let storage = env.storage().persistent();
    if storage.has(key) {
        storage.get(key).unwrap_or_default()
    } else {
        V::default()
    }
}

/// Read a key, resolving a missing key (or a failed decode) to `default`.
pub fn safe_read_or<K, V>(env: &Env, key: &K, default: V) -> V
where
    K: IntoVal<Env, Val>,
    V: TryFromVal<Env, Val>,
{
    env.storage().persistent().get(key).unwrap_or(default)
}

/// Read an `i128` charge: missing key → `0`, then sanitize so the result is
/// always within `[0, MAX_SANE_CHARGE]`.
pub fn read_sane_charge<K>(env: &Env, key: &K) -> i128
where
    K: IntoVal<Env, Val>,
{
    sanitize_charge(safe_read_or(env, key, 0i128))
}

// ---------------------------------------------------------------------------
// Pure-logic unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_is_the_default_for_missing_keys() {
        assert_eq!(guarded_read_charge(false, 12_345), 0);
        assert_eq!(guarded_read_charge(false, i128::MAX), 0);
    }

    #[test]
    fn sane_present_values_are_preserved() {
        assert_eq!(guarded_read_charge(true, 0), 0);
        assert_eq!(guarded_read_charge(true, 1_000), 1_000);
        assert_eq!(guarded_read_charge(true, MAX_SANE_CHARGE), MAX_SANE_CHARGE);
    }

    #[test]
    fn observed_garbage_value_is_rejected() {
        // The exact value seen in fuzzing: u64::MAX (~1.8e19) exceeds the sane
        // ceiling and is rejected to 0.
        let garbage = u64::MAX as i128; // 18_446_744_073_709_551_615
        assert!(garbage > MAX_SANE_CHARGE);
        assert_eq!(sanitize_charge(garbage), 0);
    }

    #[test]
    fn negatives_and_overflow_values_are_rejected() {
        assert_eq!(sanitize_charge(-1), 0);
        assert_eq!(sanitize_charge(i128::MIN), 0);
        assert_eq!(sanitize_charge(i128::MAX), 0);
        assert_eq!(sanitize_charge(MAX_SANE_CHARGE + 1), 0);
    }

    #[test]
    fn sanitize_output_is_always_in_bounds() {
        for &v in &[i128::MIN, -1, 0, 1, MAX_SANE_CHARGE, MAX_SANE_CHARGE + 1, i128::MAX] {
            assert!(is_sane_charge(sanitize_charge(v)));
        }
    }
}
