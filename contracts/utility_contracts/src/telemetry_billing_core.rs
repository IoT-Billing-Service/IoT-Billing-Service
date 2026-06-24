// Issue #19: pure, dependency-free billing math.
//
// This file contains ONLY core/std-level arithmetic (no soroban_sdk), so it can
// be include!d both by the `telemetry_billing` contract module and by the
// standalone `telemetry-determinism-check` CI crate — a single source of truth
// for the order-invariant rollup, verifiable without compiling the wider
// `utility_contracts` crate.
//
// NOTE: uses only `//` comments (not inner `//!` doc comments) because `include!`
// places this content mid-file, where inner doc comments are not allowed.

/// Tier-1 / Tier-2 boundary, in consumption units.
pub const TIER1_THRESHOLD: i128 = 1000;

/// Apply the two-tier rate to a cumulative unit total: units up to
/// [`TIER1_THRESHOLD`] at `tier1_rate`, the excess at `tier2_rate`.
pub fn tiered_charge(total_units: i128, tier1_rate: i128, tier2_rate: i128) -> i128 {
    if total_units <= TIER1_THRESHOLD {
        total_units.saturating_mul(tier1_rate)
    } else {
        let tier1 = TIER1_THRESHOLD.saturating_mul(tier1_rate);
        let tier2 = (total_units - TIER1_THRESHOLD).saturating_mul(tier2_rate);
        tier1.saturating_add(tier2)
    }
}

/// Order-invariant cycle rollup: sum units (commutative) then tier the total.
/// This is the function that satisfies `billing(E) = billing(π(E))`.
pub fn billing_cycle_rollup_units(units: &[i128], tier1_rate: i128, tier2_rate: i128) -> i128 {
    let total = units.iter().fold(0i128, |acc, &u| acc.saturating_add(u));
    tiered_charge(total, tier1_rate, tier2_rate)
}

/// The *buggy* legacy model, kept only so tests can demonstrate it is
/// order-sensitive (and that the fix above is not). Charges each event at the
/// tier implied by the running cumulative *before* the event — so an event that
/// straddles the threshold is billed differently depending on its position.
pub fn naive_sequential_charge(units: &[i128], tier1_rate: i128, tier2_rate: i128) -> i128 {
    let mut cumulative = 0i128;
    let mut bill = 0i128;
    for &u in units {
        let rate = if cumulative >= TIER1_THRESHOLD {
            tier2_rate
        } else {
            tier1_rate
        };
        bill = bill.saturating_add(u.saturating_mul(rate));
        cumulative = cumulative.saturating_add(u);
    }
    bill
}
