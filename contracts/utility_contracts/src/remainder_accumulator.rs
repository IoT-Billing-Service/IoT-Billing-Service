//! Issue #9: exact metered billing via remainder carry.
//!
//! ## The threat
//!
//! Billing computed `reading * RATE_DENOM / PRECISION_FACTOR` with integer
//! division, **discarding the fractional remainder every cycle**. A device just
//! above the 7-decimal floor (e.g. 1.0000001 units/cycle) is billed 1.0000000
//! each cycle, losing the sub-unit remainder. Per device the loss stays < 1
//! unit, but aggregated across many devices and millions of cycles it compounds
//! into real, silent undercharging.
//!
//! ## The fix
//!
//! Carry the remainder forward. Each cycle adds the prior remainder back into
//! the numerator before dividing:
//!
//! ```text
//! scaled    = reading * RATE_DENOM + reservoir
//! billed    = scaled / PRECISION_FACTOR
//! reservoir = scaled % PRECISION_FACTOR   // < PRECISION_FACTOR, carried forward
//! ```
//!
//! This is **exact**: over any N cycles, `Σ billed == ⌊(Σ reading·RATE_DENOM) /
//! PRECISION_FACTOR⌋`, and the only unbilled value is the final `reservoir`,
//! which is always strictly less than one unit and is *retained*, not lost. It
//! subsumes the blueprint's "≥ PRECISION_FACTOR → +1 unit" step (the carry can
//! release several units at once and never drifts).
//!
//! Invariant: after any sequence of cycles, `reservoir < PRECISION_FACTOR`, so
//! cumulative undercharge for a device is `reservoir / PRECISION_FACTOR < 1`.

use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, Map};

/// 7-decimal fixed-point scale.
pub const PRECISION_FACTOR: u128 = 10_000_000; // 10^7

// ---------------------------------------------------------------------------
// Pure carry accumulator (unit-tested without an Env)
// ---------------------------------------------------------------------------

/// Carries the fractional remainder between billing cycles so no value is lost.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct RemainderAccumulator {
    /// Unbilled fractional value carried forward; always `< precision`.
    pub reservoir: u128,
}

impl RemainderAccumulator {
    pub const fn new() -> Self {
        Self { reservoir: 0 }
    }

    /// Bill one cycle, carrying the remainder forward. Returns the units billed
    /// this cycle (which may exceed `reading * rate_denom / precision` when a
    /// carried remainder pushes the reservoir over a unit boundary).
    pub fn apply(&mut self, reading: u128, rate_denom: u128, precision: u128) -> u128 {
        apply_with_carry(reading, rate_denom, precision, &mut self.reservoir)
    }
}

/// Stateless form (the blueprint's signature): bill `reading` at `rate_denom`
/// with `precision`, carrying the remainder through `reservoir`.
pub fn apply_with_carry(
    reading: u128,
    rate_denom: u128,
    precision: u128,
    reservoir: &mut u128,
) -> u128 {
    if precision == 0 {
        return 0;
    }
    let scaled = reading
        .saturating_mul(rate_denom)
        .saturating_add(*reservoir);
    let billed = scaled / precision;
    *reservoir = scaled % precision;
    billed
}

/// The naive (buggy) per-cycle truncation, kept so tests can demonstrate the
/// drift the carry eliminates.
pub fn naive_truncating(reading: u128, rate_denom: u128, precision: u128) -> u128 {
    if precision == 0 {
        return 0;
    }
    reading.saturating_mul(rate_denom) / precision
}

// ---------------------------------------------------------------------------
// Contract: metered billing with per-device carry + a dust view
// ---------------------------------------------------------------------------

#[contract]
pub struct MeteredBilling;

#[contractimpl]
impl MeteredBilling {
    /// Bill one cycle for `device` at `reading` (carry-corrected). Returns the
    /// units billed; the sub-unit remainder is persisted for the next cycle.
    pub fn bill_cycle(env: Env, device: Address, reading: u128, rate_denom: u128) -> u128 {
        let mut reservoirs = Self::reservoirs(&env);
        let mut reservoir = reservoirs.get(device.clone()).unwrap_or(0);
        let billed = apply_with_carry(reading, rate_denom, PRECISION_FACTOR, &mut reservoir);
        reservoirs.set(device, reservoir);
        Self::store_reservoirs(&env, &reservoirs);
        billed
    }

    /// The carried remainder for a device (`< PRECISION_FACTOR`).
    pub fn device_dust(env: Env, device: Address) -> u128 {
        Self::reservoirs(&env).get(device).unwrap_or(0)
    }

    /// Total carried dust across all known devices — the "dust sweeper" view.
    /// With the carry, this value is *retained* (billed once it crosses a unit),
    /// not lost, so the sweeper reports residue rather than recovering leakage.
    pub fn total_dust(env: Env) -> u128 {
        let reservoirs = Self::reservoirs(&env);
        let mut total: u128 = 0;
        for (_device, r) in reservoirs.iter() {
            total = total.saturating_add(r);
        }
        total
    }
}

impl MeteredBilling {
    fn reservoirs(env: &Env) -> Map<Address, u128> {
        env.storage()
            .persistent()
            .get(&symbol_short!("dustres"))
            .unwrap_or_else(|| Map::new(env))
    }

    fn store_reservoirs(env: &Env, m: &Map<Address, u128>) {
        env.storage().persistent().set(&symbol_short!("dustres"), m);
    }
}

// ---------------------------------------------------------------------------
// Pure-logic unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // rate_denom = PRECISION_FACTOR means "reading" is already in 7-dp units.
    const RATE: u128 = 1;

    #[test]
    fn carry_is_exact_over_many_cycles() {
        // reading = 1.0000001 units == 10_000_001 in 7-dp fixed point.
        let reading = 10_000_001u128;
        let cycles = 10_000u128;

        let mut acc = RemainderAccumulator::new();
        let mut billed_total = 0u128;
        for _ in 0..cycles {
            billed_total += acc.apply(reading, RATE, PRECISION_FACTOR);
        }

        // Exact: floor(total_value / precision).
        let expected = (reading * cycles) / PRECISION_FACTOR;
        assert_eq!(billed_total, expected);
        // Residue is sub-unit.
        assert!(acc.reservoir < PRECISION_FACTOR);
    }

    #[test]
    fn carry_beats_naive_truncation() {
        // 1.05 units/cycle: the 0.05-unit remainder per cycle crosses a full
        // billable unit every 20 cycles, so over 100 cycles the carry bills 5
        // units the naive truncation silently drops.
        let reading = 10_500_000u128; // 1.05 units in 7-dp fixed point
        let cycles = 100u128;

        let naive_total: u128 = (0..cycles)
            .map(|_| naive_truncating(reading, RATE, PRECISION_FACTOR))
            .sum();

        let mut acc = RemainderAccumulator::new();
        let mut carry_total = 0u128;
        for _ in 0..cycles {
            carry_total += acc.apply(reading, RATE, PRECISION_FACTOR);
        }

        // diff == floor((reading % precision) * cycles / precision).
        let expected_diff = (reading % PRECISION_FACTOR) * cycles / PRECISION_FACTOR;
        assert_eq!(carry_total - naive_total, expected_diff);
        assert_eq!(expected_diff, 5);
        assert!(carry_total > naive_total);
    }

    #[test]
    fn reservoir_always_below_precision() {
        let mut reservoir = 0u128;
        for reading in [0u128, 1, 9_999_999, 10_000_000, 10_000_001, 99_999_999] {
            apply_with_carry(reading, RATE, PRECISION_FACTOR, &mut reservoir);
            assert!(reservoir < PRECISION_FACTOR);
        }
    }

    #[test]
    fn exactly_on_floor_loses_nothing() {
        // 1.0 unit/cycle exactly: no remainder, no dust.
        let mut acc = RemainderAccumulator::new();
        let mut total = 0u128;
        for _ in 0..1_000 {
            total += acc.apply(PRECISION_FACTOR, RATE, PRECISION_FACTOR);
        }
        assert_eq!(total, 1_000);
        assert_eq!(acc.reservoir, 0);
    }

    #[test]
    fn million_cycle_error_under_one_unit() {
        let reading = 10_000_003u128; // 1.0000003 units
        let cycles = 1_000_000u128;
        let mut acc = RemainderAccumulator::new();
        let mut billed = 0u128;
        for _ in 0..cycles {
            billed += acc.apply(reading, RATE, PRECISION_FACTOR);
        }
        let exact = (reading * cycles) / PRECISION_FACTOR;
        assert_eq!(billed, exact);
        assert!(acc.reservoir < PRECISION_FACTOR, "residual dust must stay sub-unit");
    }
}
