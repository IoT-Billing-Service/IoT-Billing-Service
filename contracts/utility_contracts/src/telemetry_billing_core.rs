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

// ===========================================================================
// Billing-cycle assignment under clock drift
// ===========================================================================
//
// Pure, dependency-free time-alignment logic (no soroban_sdk), so it is shared
// verbatim by the `telemetry_billing` contract module and the standalone
// `telemetry-determinism-check` CI crate — and can be exercised even though the
// wider `utility_contracts` crate has pre-existing build breakage.
//
// Provenance (added 2026-06-27): implements the cycle-drift handling requested
// as "energy_grid.rs:150-185 / append_event / align_telemetry_batch". Those
// exact locations/symbols did not exist (energy_grid.rs is 79 lines of peak/
// off-peak rate logic; the real `append_event` lives in telemetry_billing.rs).
// The engineering intent — assign telemetry to the correct billing cycle when
// device clocks and ledger time drift — is implemented here as the verifiable
// single source of truth.

/// Billing cycle length in seconds (30 days).
pub const BILLING_CYCLE_SECONDS: u64 = 2_592_000;

/// Maximum tolerated drift between a device-local timestamp and the trusted
/// oracle-anchored ledger time before the device clock is deemed unreliable for
/// cycle assignment (5 minutes — the measured max ledger drift).
pub const MAX_DRIFT_TOLERANCE_SECONDS: u64 = 300;

/// Window-boundary tolerance: +/- 10 ledger closes (~50 seconds) is acceptable.
pub const BOUNDARY_TOLERANCE_SECONDS: u64 = 50;

/// Cycle index a timestamp falls into, relative to `epoch_origin`.
pub fn cycle_index(timestamp: u64, epoch_origin: u64) -> u64 {
    timestamp.saturating_sub(epoch_origin) / BILLING_CYCLE_SECONDS
}

/// Reconcile a device-local timestamp against the trusted oracle-anchored time.
///
/// If the device clock is within `max_drift` of the anchor, the device
/// timestamp is trusted (it reliably reflects when consumption occurred).
/// Otherwise the device clock is too far off to be trustworthy, so the anchored
/// time is used instead. This is the core of the fix: a single, consistent
/// clock reference for cycle boundaries rather than each device's wall clock.
pub fn reconcile_timestamp(device_ts: u64, anchored_ts: u64, max_drift: u64) -> u64 {
    let drift = device_ts.abs_diff(anchored_ts);
    if drift <= max_drift {
        device_ts
    } else {
        anchored_ts
    }
}

/// True if `timestamp` lies within `tol` seconds of a cycle boundary relative to
/// `epoch_origin` — the "soft boundary" zone where drift could push an event
/// into an adjacent cycle, so it warrants holding for re-alignment.
pub fn near_cycle_boundary(timestamp: u64, epoch_origin: u64, tol: u64) -> bool {
    let offset = timestamp.saturating_sub(epoch_origin) % BILLING_CYCLE_SECONDS;
    offset <= tol || offset >= BILLING_CYCLE_SECONDS.saturating_sub(tol)
}

/// Final cycle assignment for an event: reconcile the device timestamp against
/// the anchored time, then map to a cycle index. This is what callers should use
/// instead of `cycle_index(device_ts, ..)` on the raw device clock.
pub fn assign_cycle(device_ts: u64, anchored_ts: u64, epoch_origin: u64) -> u64 {
    let t = reconcile_timestamp(device_ts, anchored_ts, MAX_DRIFT_TOLERANCE_SECONDS);
    cycle_index(t, epoch_origin)
}

/// Relative deviation (in basis points) of an observed event count from a
/// trailing average. Used to raise an admin alert when a cycle's event count
/// deviates by more than 5% (500 bps) from the trailing 30-day average.
/// Returns `0` when `trailing_avg == 0` (no baseline yet).
pub fn deviation_bps(observed: u64, trailing_avg: u64) -> u64 {
    if trailing_avg == 0 {
        return 0;
    }
    let diff = observed.abs_diff(trailing_avg);
    diff.saturating_mul(10_000) / trailing_avg
}

/// Whether an observed count should trigger the >5% deviation admin alert.
pub fn exceeds_deviation_alert(observed: u64, trailing_avg: u64) -> bool {
    deviation_bps(observed, trailing_avg) > 500
}
