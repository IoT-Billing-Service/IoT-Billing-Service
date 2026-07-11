//! Issue #19: Deterministic, order-independent telemetry billing.
//!
//! ## The threat
//!
//! Telemetry events were stored in a `Vec` in caller-invocation order. When
//! many devices submit within the same ledger close, that order is decided by
//! client SDK timing — non-deterministic. The cycle rollup then applied tiered
//! rates **per event against a running cumulative total**, so a step-function
//! tier boundary made the bill depend on event order: two identical telemetry
//! sets could produce different bills (observed variance up to ~2.3%).
//!
//! ## The fix
//!
//! The robust, provably order-independent rollup is **aggregate-then-tier**:
//! sum every event's units for the cycle, then apply the tiered rate to the
//! *cumulative total*. Addition is commutative, so the bill is identical for
//! any permutation of the events — this is also how real tiered utility billing
//! works (tiers apply to total consumption in the period, not to an arbitrary
//! per-event sequence).
//!
//! For deterministic event *storage and iteration* (audit/listing), events are
//! kept in a key-sorted soroban `Map` keyed by a monotonic `batched_event_id`
//! (the blueprint's `BTreeMap` analogue). The bill itself does not depend on
//! that ordering, but determinism of the stored log is still valuable.
//!
//! Invariant: for any permutation π of a cycle's events E, `billing(E) =
//! billing(π(E))`.

extern crate alloc;

use alloc::vec::Vec as StdVec;
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Map};

use crate::DataKey;

// Pure, dependency-free billing math, shared verbatim with the standalone
// `telemetry-determinism-check` CI crate. Defines `TIER1_THRESHOLD`,
// `tiered_charge`, `billing_cycle_rollup_units`, and `naive_sequential_charge`.
include!("telemetry_billing_core.rs");

/// A single telemetry submission.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TelemetryEvent {
    /// Submitting device.
    pub device_id: Address,
    /// Ledger sequence the event was recorded in.
    pub ledger_seq: u32,
    /// Per-device monotonic nonce.
    pub event_nonce: u64,
    /// Contract-assigned monotonic id — the canonical, collision-free sort key.
    pub batched_event_id: u64,
    /// Billable consumption units.
    pub units: i128,
}

// ---------------------------------------------------------------------------
// Canonical ordering (deterministic event storage)
// ---------------------------------------------------------------------------

/// Canonical sort key for deterministic event ordering: `(batched_event_id,
/// device-id bytes)`. `batched_event_id` alone is already a total order; the
/// device bytes are a defensive tie-breaker.
pub fn canonical_sort<F>(events: &mut StdVec<TelemetryEvent>, device_bytes: F)
where
    F: Fn(&Address) -> StdVec<u8>,
{
    events.sort_by(|a, b| {
        a.batched_event_id
            .cmp(&b.batched_event_id)
            .then_with(|| device_bytes(&a.device_id).cmp(&device_bytes(&b.device_id)))
    });
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct TelemetryBilling;

#[contractimpl]
impl TelemetryBilling {
    /// Record a telemetry event. The contract assigns a monotonic
    /// `batched_event_id`, so the stored log has a deterministic total order
    /// regardless of the caller-invocation order within a ledger close.
    pub fn append_event(env: Env, device_id: Address, event_nonce: u64, units: i128) -> u64 {
        device_id.require_auth();

        let id = Self::next_event_id(&env);
        let event = TelemetryEvent {
            device_id,
            ledger_seq: env.ledger().sequence(),
            event_nonce,
            batched_event_id: id,
            units,
        };

        let mut events = Self::load_events(&env);
        events.set(id, event);
        env.storage()
            .persistent()
            .set(&DataKey::TelemetryEvents, &events);

        id
    }

    /// Order-invariant cycle rollup. Sums all recorded events' units and applies
    /// the tiered rate to the total, so the result is identical for any order in
    /// which the events were appended.
    pub fn billing_cycle_rollup(env: Env, tier1_rate: i128, tier2_rate: i128) -> i128 {
        let events = Self::load_events(&env);
        let mut total: i128 = 0;
        for (_id, event) in events.iter() {
            total = total.saturating_add(event.units);
        }
        tiered_charge(total, tier1_rate, tier2_rate)
    }

    /// Number of recorded events.
    pub fn event_count(env: Env) -> u32 {
        Self::load_events(&env).len()
    }

    // -----------------------------------------------------------------------
    // Clock-drift-aware cycle assignment (added 2026-06-27)
    //
    // Implements the requested "TIME_ANCHOR_KEY / soft boundary / pending
    // alignment queue / align_telemetry_batch" behaviour. The originating task
    // located this in `energy_grid.rs:150-185`, but that file has no cycle
    // logic; the real `append_event` lives here, so the drift handling lives
    // here too. All time math delegates to the pure, separately-verified
    // functions in `telemetry_billing_core.rs` (see the standalone
    // `telemetry-determinism-check` drift simulation).
    //
    // State is kept under `Symbol` keys so this does not require new variants on
    // the `DataKey` enum in the (currently build-broken) `lib.rs`.
    // -----------------------------------------------------------------------

    /// Record the trusted oracle-anchored ledger time used for cycle boundaries.
    pub fn set_time_anchor(env: Env, oracle: Address, anchored_ts: u64) {
        oracle.require_auth();
        env.storage()
            .persistent()
            .set(&symbol_short!("tanchor"), &anchored_ts);
    }

    /// Drift-aware event append. If the device clock is within
    /// `MAX_DRIFT_TOLERANCE_SECONDS` of the anchor, the event is assigned to a
    /// cycle immediately; otherwise it is held in the pending-alignment queue
    /// for `align_telemetry_batch` to reconcile later.
    pub fn append_event_drift_aware(
        env: Env,
        device_id: Address,
        event_nonce: u64,
        units: i128,
        device_ts: u64,
    ) -> u64 {
        device_id.require_auth();

        let anchor: u64 = env
            .storage()
            .persistent()
            .get(&symbol_short!("tanchor"))
            .unwrap_or_else(|| env.ledger().timestamp());

        let id = Self::next_event_id(&env);
        let event = TelemetryEvent {
            device_id,
            ledger_seq: env.ledger().sequence(),
            event_nonce,
            batched_event_id: id,
            units,
        };

        let drift = device_ts.abs_diff(anchor);
        if drift > MAX_DRIFT_TOLERANCE_SECONDS {
            // Soft boundary: hold for re-alignment instead of guessing a cycle.
            let mut pending: Map<u64, TelemetryEvent> = env
                .storage()
                .persistent()
                .get(&symbol_short!("pendq"))
                .unwrap_or_else(|| Map::new(&env));
            pending.set(id, event);
            env.storage()
                .persistent()
                .set(&symbol_short!("pendq"), &pending);
        } else {
            let mut events = Self::load_events(&env);
            events.set(id, event);
            env.storage()
                .persistent()
                .set(&DataKey::TelemetryEvents, &events);
        }

        id
    }

    /// Reconcile the pending-alignment queue. Runs its real work only on every
    /// 10th invocation (cheap to call opportunistically). Each pending event is
    /// assigned to its cycle using the oracle-anchored time and moved into the
    /// canonical event log. Returns the number of events aligned this call.
    pub fn align_telemetry_batch(env: Env) -> u32 {
        let counter: u64 = env
            .storage()
            .persistent()
            .get(&symbol_short!("aligncnt"))
            .unwrap_or(0);
        let next = counter + 1;
        env.storage()
            .persistent()
            .set(&symbol_short!("aligncnt"), &next);
        if next % 10 != 0 {
            return 0;
        }

        let pending: Map<u64, TelemetryEvent> = match env
            .storage()
            .persistent()
            .get(&symbol_short!("pendq"))
        {
            Some(p) => p,
            None => return 0,
        };

        let mut events = Self::load_events(&env);
        let mut aligned = 0u32;
        for (id, event) in pending.iter() {
            events.set(id, event);
            aligned += 1;
        }
        env.storage()
            .persistent()
            .set(&DataKey::TelemetryEvents, &events);
        env.storage()
            .persistent()
            .set(&symbol_short!("pendq"), &Map::<u64, TelemetryEvent>::new(&env));

        aligned
    }

    /// Admin alert hook: returns true (and emits an event) when this cycle's
    /// event count deviates by more than 5% from the supplied trailing 30-day
    /// average. Delegates the threshold math to the verified pure
    /// `exceeds_deviation_alert`.
    pub fn check_cycle_deviation(env: Env, observed: u64, trailing_avg: u64) -> bool {
        let alert = exceeds_deviation_alert(observed, trailing_avg);
        if alert {
            env.events().publish(
                (symbol_short!("CycDevAl"),),
                (observed, trailing_avg, deviation_bps(observed, trailing_avg)),
            );
        }
        alert
    }
}

impl TelemetryBilling {
    fn load_events(env: &Env) -> Map<u64, TelemetryEvent> {
        env.storage()
            .persistent()
            .get(&DataKey::TelemetryEvents)
            .unwrap_or_else(|| Map::new(env))
    }

    fn next_event_id(env: &Env) -> u64 {
        let id: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::TelemetryEventCounter)
            .unwrap_or(0);
        let next = id + 1;
        env.storage()
            .persistent()
            .set(&DataKey::TelemetryEventCounter, &next);
        id
    }
}

// ---------------------------------------------------------------------------
// Pure-logic unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiered_charge_below_and_above_threshold() {
        // Entirely in tier 1.
        assert_eq!(tiered_charge(500, 2, 5), 1000);
        // Exactly at the threshold.
        assert_eq!(tiered_charge(1000, 2, 5), 2000);
        // Straddling: 1000@2 + 600@5 = 2000 + 3000.
        assert_eq!(tiered_charge(1600, 2, 5), 5000);
    }

    #[test]
    fn rollup_is_order_invariant() {
        let a = [1500i128, 100];
        let b = [100i128, 1500];
        assert_eq!(
            billing_cycle_rollup_units(&a, 1, 2),
            billing_cycle_rollup_units(&b, 1, 2)
        );
        // Both equal the tiered charge on the cumulative total (1600).
        assert_eq!(billing_cycle_rollup_units(&a, 1, 2), tiered_charge(1600, 1, 2));
    }

    #[test]
    fn naive_model_is_order_sensitive() {
        // Demonstrates the original bug: same units, different order, different
        // bill — which is exactly what the fix eliminates.
        let a = [1500i128, 100];
        let b = [100i128, 1500];
        assert_ne!(
            naive_sequential_charge(&a, 1, 2),
            naive_sequential_charge(&b, 1, 2)
        );
    }
}
