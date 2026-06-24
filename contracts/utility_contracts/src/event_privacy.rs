//! Issue #20: Privacy-preserving billing event emission.
//!
//! ## The threat
//!
//! `finalize_billing_cycle` emitted a Soroban event carrying `tenant_id` and
//! `total_charge` in cleartext topics/data. Every Soroban event is world-
//! readable, so a competitor running as another tenant could subscribe to the
//! contract's event stream and read a rival's billing amounts.
//!
//! ## Why the blueprint's "encrypt with a per-tenant secret" is unsound as-is
//!
//! A public ledger has **no on-chain secrets**: every storage entry and every
//! event datum is visible to all observers. Storing a `tenant_secret` on-chain
//! and "encrypting" with it does not help — the same competitor can read the
//! secret and decrypt. The only sound mitigations are:
//!
//!   1. **Data minimization** — never emit `tenant_id` or `total_charge` in
//!      cleartext. Emit an opaque, keyed tenant *handle* and a *hiding
//!      commitment* instead.
//!   2. **Hiding commitments** — emit `sha256(domain || amount || blinding)`
//!      where the `blinding` factor is high-entropy and supplied by the
//!      authenticated caller, **never persisted on-chain**. Only a party that
//!      holds the blinding can open (verify) the commitment.
//!   3. **Per-tenant opt-out** — an `EVENTS_ENABLED` toggle that suppresses
//!      emission entirely for tenants that want zero on-chain footprint.
//!
//! This mirrors the existing `generate_commitment` idiom in `lib.rs`.
//!
//! Invariant: for any emitted event `e`, an observer can associate
//! `e` with a real `tenant_id` only if it already knows that tenant's secret
//! (i.e. is the tenant). Amounts are recoverable only by a holder of the
//! blinding factor.

extern crate alloc;

use alloc::vec::Vec as ByteVec;
use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Bytes, BytesN, Env};

use crate::DataKey;

/// Domain-separation tag for tenant handle derivation.
const HANDLE_DOMAIN: &[u8] = b"UTILITY_DRIP_TENANT_HANDLE_V1";
/// Domain-separation tag for billing-amount commitments.
const COMMIT_DOMAIN: &[u8] = b"UTILITY_DRIP_BILL_COMMIT_V1";

/// Per-tenant privacy configuration.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrivacyConfig {
    /// When `false`, `finalize_billing_cycle` records the commitment but emits
    /// no event at all — the strongest privacy posture.
    pub events_enabled: bool,
}

/// The sensitive billing figures for a cycle. This is an *input* only — it is
/// never emitted or stored in cleartext.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BillingSummary {
    pub total_charge: u128,
    pub device_count: u32,
    pub avg_rate: u128,
}

// ---------------------------------------------------------------------------
// Pure preimage assembly (the cryptographic spec — unit tested without an Env)
// ---------------------------------------------------------------------------

/// Build the domain-separated preimage for a tenant handle:
/// `HANDLE_DOMAIN || tenant_xdr || tenant_secret`. Hashing this yields an
/// opaque handle that only a holder of `tenant_secret` can reproduce or
/// correlate to the real tenant.
pub fn handle_preimage(tenant_xdr: &[u8], tenant_secret: &[u8]) -> ByteVec<u8> {
    let mut v = ByteVec::new();
    v.extend_from_slice(HANDLE_DOMAIN);
    v.extend_from_slice(tenant_xdr);
    v.extend_from_slice(tenant_secret);
    v
}

/// Build the domain-separated preimage for a billing-amount commitment:
/// `COMMIT_DOMAIN || total_charge || device_count || avg_rate || blinding`.
/// Without `blinding`, an observer cannot confirm a guessed amount.
pub fn charge_preimage(
    total_charge: u128,
    device_count: u32,
    avg_rate: u128,
    blinding: &[u8],
) -> ByteVec<u8> {
    let mut v = ByteVec::new();
    v.extend_from_slice(COMMIT_DOMAIN);
    v.extend_from_slice(&total_charge.to_be_bytes());
    v.extend_from_slice(&device_count.to_be_bytes());
    v.extend_from_slice(&avg_rate.to_be_bytes());
    v.extend_from_slice(blinding);
    v
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct EventPrivacy;

#[contractimpl]
impl EventPrivacy {
    /// Toggle whether billing events are emitted for `tenant`. Only the tenant
    /// may change its own setting.
    pub fn set_events_enabled(env: Env, tenant: Address, enabled: bool) {
        tenant.require_auth();
        env.storage().persistent().set(
            &DataKey::TenantPrivacyConfig(tenant.clone()),
            &PrivacyConfig {
                events_enabled: enabled,
            },
        );
        // Toggle event carries only the (caller-authenticated) address — no
        // amounts — and is incidental to the privacy guarantee for amounts.
        env.events()
            .publish((symbol_short!("evt_cfg"), tenant), enabled);
    }

    /// Whether billing events are currently emitted for `tenant`. Defaults to
    /// `true` (emit minimized events) when unset.
    pub fn events_enabled(env: Env, tenant: Address) -> bool {
        Self::events_enabled_internal(&env, &tenant)
    }

    /// Finalize a billing cycle with privacy preserved.
    ///
    /// Records (and, if enabled, emits) only an opaque tenant handle and a
    /// hiding commitment to the billing figures — never `tenant_id`,
    /// `total_charge`, `device_count`, or `avg_rate` in cleartext. Returns the
    /// commitment so the authenticated tenant can retain it.
    ///
    /// `tenant_secret` and `blinding` must be high-entropy values held by the
    /// tenant off-chain; they are consumed here to derive the handle and
    /// commitment but are never written to storage.
    pub fn finalize_billing_cycle(
        env: Env,
        tenant: Address,
        cycle: u64,
        summary: BillingSummary,
        tenant_secret: BytesN<32>,
        blinding: BytesN<32>,
    ) -> BytesN<32> {
        tenant.require_auth();

        let handle = Self::tenant_handle(&env, &tenant, &tenant_secret);
        let commitment = Self::charge_commitment(&env, &summary, &blinding);

        // Storing the *commitment* (not cleartext) is safe on a public ledger:
        // it hides the amount unless the blinding factor is known.
        env.storage().persistent().set(
            &DataKey::BillingCommitmentRecord(tenant.clone(), cycle),
            &commitment,
        );

        if Self::events_enabled_internal(&env, &tenant) {
            // Topic = opaque handle; data = (cycle, commitment). No tenant_id,
            // no amounts.
            env.events().publish(
                (symbol_short!("bill_fin"), handle),
                (cycle, commitment.clone()),
            );
        }

        commitment
    }

    /// Open/verify a previously emitted commitment. A tenant (or auditor the
    /// tenant has shared the opening with) supplies the claimed figures and the
    /// blinding; returns `true` iff they reproduce `commitment`.
    pub fn verify_billing_commitment(
        env: Env,
        summary: BillingSummary,
        blinding: BytesN<32>,
        commitment: BytesN<32>,
    ) -> bool {
        Self::charge_commitment(&env, &summary, &blinding) == commitment
    }

    /// Fetch the stored commitment for a tenant's billing cycle, if any.
    pub fn get_commitment(env: Env, tenant: Address, cycle: u64) -> Option<BytesN<32>> {
        env.storage()
            .persistent()
            .get(&DataKey::BillingCommitmentRecord(tenant, cycle))
    }
}

impl EventPrivacy {
    fn events_enabled_internal(env: &Env, tenant: &Address) -> bool {
        let cfg: Option<PrivacyConfig> = env
            .storage()
            .persistent()
            .get(&DataKey::TenantPrivacyConfig(tenant.clone()));
        cfg.map(|c| c.events_enabled).unwrap_or(true)
    }

    /// Derive the opaque tenant handle: `sha256(HANDLE_DOMAIN || xdr || secret)`.
    fn tenant_handle(env: &Env, tenant: &Address, tenant_secret: &BytesN<32>) -> BytesN<32> {
        let xdr = tenant.clone().to_xdr(env);

        let mut data = Bytes::from_slice(env, HANDLE_DOMAIN);
        data.append(&xdr);
        data.append(&Bytes::from_slice(env, &tenant_secret.to_array()));
        env.crypto().sha256(&data).into()
    }

    /// Derive the hiding commitment to the billing figures:
    /// `sha256(COMMIT_DOMAIN || total_charge || device_count || avg_rate || blinding)`.
    fn charge_commitment(env: &Env, summary: &BillingSummary, blinding: &BytesN<32>) -> BytesN<32> {
        let mut data = Bytes::from_slice(env, COMMIT_DOMAIN);
        data.append(&Bytes::from_slice(env, &summary.total_charge.to_be_bytes()));
        data.append(&Bytes::from_slice(env, &summary.device_count.to_be_bytes()));
        data.append(&Bytes::from_slice(env, &summary.avg_rate.to_be_bytes()));
        data.append(&Bytes::from_slice(env, &blinding.to_array()));
        env.crypto().sha256(&data).into()
    }
}

// ---------------------------------------------------------------------------
// Unit tests for the pure preimage spec (no Env required)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handle_preimage_depends_on_secret() {
        // Same tenant identity, different secret → different preimage. Because
        // sha256 is a function, distinct preimages give distinct handles, so an
        // observer without tenant B's secret cannot reproduce B's handle.
        let tenant_xdr = b"tenant-B-address-xdr";
        let secret_a = [0xAAu8; 32];
        let secret_b = [0xBBu8; 32];
        assert_ne!(
            handle_preimage(tenant_xdr, &secret_a),
            handle_preimage(tenant_xdr, &secret_b)
        );
    }

    #[test]
    fn handle_preimage_depends_on_identity() {
        let secret = [0x11u8; 32];
        assert_ne!(
            handle_preimage(b"tenant-A", &secret),
            handle_preimage(b"tenant-B", &secret)
        );
    }

    #[test]
    fn charge_preimage_requires_blinding_to_reproduce() {
        // Tenant B commits to 5000 with B's blinding. An observer who guesses
        // the correct amount (5000) but lacks B's blinding cannot reproduce the
        // preimage, hence cannot confirm the guess.
        let blinding_b = [0xB1u8; 32];
        let attacker_blinding = [0x00u8; 32];
        let b_commit = charge_preimage(5000, 10, 50, &blinding_b);
        let attacker_guess = charge_preimage(5000, 10, 50, &attacker_blinding);
        assert_ne!(b_commit, attacker_guess);

        // The correct opening reproduces it exactly (determinism).
        assert_eq!(b_commit, charge_preimage(5000, 10, 50, &blinding_b));
    }

    #[test]
    fn charge_preimage_distinguishes_amounts() {
        let blinding = [0x07u8; 32];
        assert_ne!(
            charge_preimage(1000, 10, 50, &blinding),
            charge_preimage(2000, 10, 50, &blinding)
        );
    }

    #[test]
    fn domains_are_separated() {
        // A handle preimage and a charge preimage can never collide because of
        // distinct domain tags, even on otherwise-empty inputs.
        assert_ne!(handle_preimage(b"", b""), charge_preimage(0, 0, 0, b""));
    }
}
