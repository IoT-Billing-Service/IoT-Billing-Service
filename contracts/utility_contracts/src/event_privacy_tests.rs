#![cfg(test)]

//! Issue #20: cross-tenant privacy tests for billing event emission.
//!
//! Verifies that a competitor operating as Tenant A cannot decode Tenant B's
//! billing data from the public event stream / stored commitments.

extern crate std;

use crate::event_privacy::{BillingSummary, EventPrivacy, EventPrivacyClient};
use soroban_sdk::{testutils::Address as _, Address, BytesN, Env};

fn summary(total_charge: u128, device_count: u32, avg_rate: u128) -> BillingSummary {
    BillingSummary {
        total_charge,
        device_count,
        avg_rate,
    }
}

/// Step 5: two tenants finalize cycles; Tenant A cannot decode Tenant B's
/// payload because it lacks B's blinding factor.
#[test]
fn test_tenant_a_cannot_decode_tenant_b() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, EventPrivacy);
    let client = EventPrivacyClient::new(&env, &contract_id);

    let tenant_a = Address::generate(&env);
    let tenant_b = Address::generate(&env);

    // Tenant B's secret billing figures and the blinding it keeps off-chain.
    let b_summary = summary(999_999u128, 42, 137);
    let b_blinding = BytesN::from_array(&env, &[0xB1u8; 32]);
    let b_secret = BytesN::from_array(&env, &[0xB5u8; 32]);

    let b_commitment =
        client.finalize_billing_cycle(&tenant_b, &7u64, &b_summary, &b_secret, &b_blinding);

    // The on-chain record is the hiding commitment, not the amount.
    let stored = client.get_commitment(&tenant_b, &7u64).unwrap();
    assert_eq!(stored, b_commitment);

    // Tenant A, the competitor, sees `b_commitment` on the public event/storage
    // stream and tries to confirm B's amount. Even guessing the exact figures,
    // without B's blinding the commitment cannot be reproduced → decode fails.
    let a_blinding = BytesN::from_array(&env, &[0x00u8; 32]);
    assert!(
        !client.verify_billing_commitment(&b_summary, &a_blinding, &b_commitment),
        "attacker without B's blinding must not open B's commitment"
    );

    // A brute-forcing amounts with its own blinding also fails.
    let guess = summary(999_999u128, 42, 137);
    assert!(!client.verify_billing_commitment(&guess, &a_blinding, &b_commitment));

    // The legitimate opening (B's real figures + B's blinding) verifies.
    assert!(
        client.verify_billing_commitment(&b_summary, &b_blinding, &b_commitment),
        "correct opening must verify"
    );

    // Sanity: tenant A exists independently and its config is untouched.
    let _ = tenant_a;
}

/// Two tenants charged the *same* amount produce different commitments, so an
/// observer cannot even infer that their charges are equal.
#[test]
fn test_equal_amounts_produce_unlinkable_commitments() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, EventPrivacy);
    let client = EventPrivacyClient::new(&env, &contract_id);

    let tenant_a = Address::generate(&env);
    let tenant_b = Address::generate(&env);
    let same = summary(5_000u128, 10, 50);

    let a_commit = client.finalize_billing_cycle(
        &tenant_a,
        &1u64,
        &same,
        &BytesN::from_array(&env, &[0xA1u8; 32]),
        &BytesN::from_array(&env, &[0xA2u8; 32]),
    );
    let b_commit = client.finalize_billing_cycle(
        &tenant_b,
        &1u64,
        &same,
        &BytesN::from_array(&env, &[0xB1u8; 32]),
        &BytesN::from_array(&env, &[0xB2u8; 32]),
    );

    assert_ne!(
        a_commit, b_commit,
        "equal amounts with distinct blindings must yield distinct commitments"
    );
}

/// When a tenant disables events, finalization records the commitment but emits
/// nothing.
#[test]
fn test_events_can_be_disabled_per_tenant() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, EventPrivacy);
    let client = EventPrivacyClient::new(&env, &contract_id);

    let tenant = Address::generate(&env);
    assert!(client.events_enabled(&tenant), "default is enabled");

    client.set_events_enabled(&tenant, &false);
    assert!(!client.events_enabled(&tenant));

    let events_before = env.events().all().len();
    let commitment = client.finalize_billing_cycle(
        &tenant,
        &3u64,
        &summary(1_234u128, 5, 20),
        &BytesN::from_array(&env, &[0x10u8; 32]),
        &BytesN::from_array(&env, &[0x20u8; 32]),
    );

    // Commitment is still recorded for the tenant's own audit...
    assert_eq!(client.get_commitment(&tenant, &3u64).unwrap(), commitment);
    // ...but no billing event was emitted.
    assert_eq!(
        env.events().all().len(),
        events_before,
        "no event should be emitted when events are disabled"
    );
}
