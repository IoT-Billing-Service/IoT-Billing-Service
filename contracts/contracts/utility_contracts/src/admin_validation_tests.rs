#![cfg(test)]

//! Issue #16: admin address validation tests — every invalid admin variant is
//! rejected at `set_admin`, and `recover_admin` honours the recovery window.

extern crate std;

use crate::admin_validation::{ZERO_ACCOUNT_STRKEY, RECOVERY_WINDOW};
use crate::{UtilityContract, UtilityContractClient};
use soroban_sdk::{testutils::Address as _, testutils::Ledger as _, Address, Env, String};

fn setup() -> (Env, Address, UtilityContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register_contract(None, UtilityContract);
    let client = UtilityContractClient::new(&env, &id);
    (env, id, client)
}

fn zero_address(env: &Env) -> Address {
    Address::from_string(&String::from_str(env, ZERO_ACCOUNT_STRKEY))
}

/// A normal external account can be installed as admin.
#[test]
fn test_valid_admin_is_accepted() {
    let (env, _id, client) = setup();
    let admin = Address::generate(&env);
    assert!(client.try_set_admin(&admin).is_ok());
}

/// Blueprint step 4: the canonical zero account is rejected.
#[test]
fn test_zero_account_admin_is_rejected() {
    let (env, _id, client) = setup();
    let zero = zero_address(&env);
    assert!(
        client.try_set_admin(&zero).is_err(),
        "zero account must not be installable as admin"
    );
}

/// The contract's own address cannot be the admin (would lock out governance).
#[test]
fn test_contract_id_admin_is_rejected() {
    let (env, id, client) = setup();
    assert!(
        client.try_set_admin(&id).is_err(),
        "contract id must not be installable as admin"
    );
}

/// `recover_admin` works inside the window and fails once it has elapsed.
#[test]
fn test_recover_admin_within_and_after_window() {
    let (env, _id, client) = setup();

    // Anchor the recovery window by setting an initial admin at the current seq.
    env.ledger().with_mut(|li| li.sequence_number = 1_000);
    let first_admin = Address::generate(&env);
    client.set_admin(&first_admin);

    // Within the window: recovery to a fresh admin succeeds.
    env.ledger().with_mut(|li| li.sequence_number = 1_000 + RECOVERY_WINDOW);
    let recovered = Address::generate(&env);
    assert!(client.try_recover_admin(&recovered).is_ok());

    // Past the window: recovery is refused.
    env.ledger().with_mut(|li| li.sequence_number = 1_000 + RECOVERY_WINDOW + 1);
    let too_late = Address::generate(&env);
    assert!(
        client.try_recover_admin(&too_late).is_err(),
        "recovery must be refused after the window closes"
    );
}

/// Recovery still validates the proposed admin (zero account refused).
#[test]
fn test_recover_admin_rejects_zero_account() {
    let (env, _id, client) = setup();
    env.ledger().with_mut(|li| li.sequence_number = 5);
    client.set_admin(&Address::generate(&env));

    env.ledger().with_mut(|li| li.sequence_number = 7);
    assert!(client.try_recover_admin(&zero_address(&env)).is_err());
}
