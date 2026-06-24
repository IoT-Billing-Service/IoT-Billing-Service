//! Issue #16: Admin address validation against the zero-account / lock-out
//! attack.
//!
//! ## The threat
//!
//! `set_admin` stored the supplied address as `DataKey::AdminAddress` with no
//! validation. If the Stellar zero account
//! (`GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF`) — or the
//! contract's own address — were installed as admin, governance would be
//! permanently bricked (the zero account has no controlling key, so no one can
//! satisfy `require_auth` for it; and a contract-id admin can never sign).
//!
//! ## The fix
//!
//! [`validate_admin`] enforces, before any admin address is stored:
//!   1. The proposed admin **proves control** via `require_auth()`. The zero
//!      account cannot produce a signature, so it can never be installed — this
//!      is the primary, soroban-idiomatic guard.
//!   2. The proposed admin is **not the contract's own address**.
//!   3. Defense-in-depth: the proposed admin is **not the canonical zero
//!      account** strkey.
//!
//! [`within_recovery_window`] backs `recover_admin`, an emergency override
//! callable only within [`RECOVERY_WINDOW`] ledgers of the first admin set, so a
//! botched deployment can be corrected before the window closes.
//!
//! Invariant: after construction, `admin != zero account` and
//! `admin != contract_id`.

use soroban_sdk::{Address, Env, String};

use crate::ContractError;

/// The Stellar all-zero ed25519 account (strkey form).
pub const ZERO_ACCOUNT_STRKEY: &str =
    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/// Number of ledgers after the first admin set during which `recover_admin` may
/// be invoked.
pub const RECOVERY_WINDOW: u32 = 10;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested without an Env)
// ---------------------------------------------------------------------------

/// Whether a strkey is the canonical zero account.
pub fn is_zero_account_strkey(strkey: &str) -> bool {
    strkey == ZERO_ACCOUNT_STRKEY
}

/// Whether `now_ledger` is still within `window` ledgers of `init_ledger`.
/// Saturating, so a clock that appears to move backward never under/overflows.
pub fn within_recovery_window(init_ledger: u32, now_ledger: u32, window: u32) -> bool {
    now_ledger <= init_ledger.saturating_add(window)
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/// Validate a proposed admin address before it is stored. Panics via
/// `ContractError::InvalidAdminAddress` for a zero/contract-id admin, and
/// requires the proposed admin to authorize (proving control).
pub fn validate_admin(env: &Env, proposed: &Address) {
    // 1. Primary guard: the proposed admin must prove control. The zero account
    //    cannot sign, so it can never pass here.
    proposed.require_auth();

    // 2. The admin must not be the contract's own address.
    if proposed == &env.current_contract_address() {
        soroban_sdk::panic_with_error!(env, ContractError::InvalidAdminAddress);
    }

    // 3. Defense-in-depth: reject the canonical zero account explicitly.
    let zero = Address::from_string(&String::from_str(env, ZERO_ACCOUNT_STRKEY));
    if proposed == &zero {
        soroban_sdk::panic_with_error!(env, ContractError::InvalidAdminAddress);
    }
}

// ---------------------------------------------------------------------------
// Pure-logic unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_strkey_is_recognized() {
        assert!(is_zero_account_strkey(ZERO_ACCOUNT_STRKEY));
        assert!(!is_zero_account_strkey(
            "GBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        ));
        assert!(!is_zero_account_strkey(""));
    }

    #[test]
    fn zero_strkey_constant_has_expected_shape() {
        // Stellar account strkeys are 56 chars and start with 'G'.
        assert_eq!(ZERO_ACCOUNT_STRKEY.len(), 56);
        assert!(ZERO_ACCOUNT_STRKEY.starts_with('G'));
    }

    #[test]
    fn recovery_window_boundary() {
        // init at ledger 100, window 10 → open through 110 inclusive.
        assert!(within_recovery_window(100, 100, RECOVERY_WINDOW));
        assert!(within_recovery_window(100, 110, RECOVERY_WINDOW));
        assert!(!within_recovery_window(100, 111, RECOVERY_WINDOW));
    }

    #[test]
    fn recovery_window_saturates() {
        assert!(within_recovery_window(u32::MAX, u32::MAX, RECOVERY_WINDOW));
        // A backward clock (now < init) is trivially within the window.
        assert!(within_recovery_window(100, 50, RECOVERY_WINDOW));
    }
}
