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

// ---------------------------------------------------------------------------
// Decimal trait and types for handling different precisions
// ---------------------------------------------------------------------------

/// Trait for types that represent a decimal value with fixed precision
pub trait Decimal {
    /// Number of decimal places (precision)
    const DECIMALS: u32;
    /// The raw value (scaled integer)
    fn value(&self) -> u128;
    /// Create a new decimal from a raw scaled value
    fn from_raw(value: u128) -> Self;
}

/// 7-decimal price (SEP-40 compatible)
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Price7Dec {
    pub raw: u128,
}

impl Decimal for Price7Dec {
    const DECIMALS: u32 = 7;
    fn value(&self) -> u128 {
        self.raw
    }
    fn from_raw(value: u128) -> Self {
        Self { raw: value }
    }
}

/// 7-decimal usage (meter reading)
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Usage7Dec {
    pub raw: u128,
}

impl Decimal for Usage7Dec {
    const DECIMALS: u32 = 7;
    fn value(&self) -> u128 {
        self.raw
    }
    fn from_raw(value: u128) -> Self {
        Self { raw: value }
    }
}

/// 18-decimal token amount (Soroban compatible)
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Token18Dec {
    pub raw: u128,
}

impl Decimal for Token18Dec {
    const DECIMALS: u32 = 18;
    fn value(&self) -> u128 {
        self.raw
    }
    fn from_raw(value: u128) -> Self {
        Self { raw: value }
    }
}

// ---------------------------------------------------------------------------
// Calculate stream rate with proper decimal scaling to avoid precision loss
// ---------------------------------------------------------------------------

/// Calculate token amount (18 decimals) from price (7 decimals) and usage (7 decimals)
/// Formula: (price * 10^11) * usage / 10^7 = price * usage * 10^4 (full 18 decimals)
pub fn calculate_stream_rate(price: Price7Dec, usage: Usage7Dec) -> Token18Dec {
    // Convert price from 7 decimals to 18 decimals (multiply by 10^11)
    let price_18_dec = price.value().saturating_mul(10u128.pow(11));
    // Multiply by usage (7 decimals) → total 25 decimals
    let product = price_18_dec.saturating_mul(usage.value());
    // Divide by 10^7 to get to 18 decimals
    let token_amount = product / 10u128.pow(7);
    Token18Dec::from_raw(token_amount)
}

// ---------------------------------------------------------------------------
// Decimal consistency validation
// ---------------------------------------------------------------------------

/// Validate that two decimal precisions are compatible (mismatch ≤ 2 decimals)
pub fn validate_decimal_consistency(decimals_a: u32, decimals_b: u32) {
    let mismatch = if decimals_a > decimals_b {
        decimals_a - decimals_b
    } else {
        decimals_b - decimals_a
    };
    assert!(mismatch <= 2, "Decimal precision mismatch too large: {} vs {}", decimals_a, decimals_b);
}

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
    use proptest::prelude::*;

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

    // ---------------------------------------------------------------------------
    // Precision invariant tests for calculate_stream_rate
    // ---------------------------------------------------------------------------

    #[test]
    fn test_calculate_stream_rate_simple() {
        // Price = 1.0 (7 decimals: 10_000_000)
        let price = Price7Dec::from_raw(10_000_000);
        // Usage = 1.0 (7 decimals: 10_000_000)
        let usage = Usage7Dec::from_raw(10_000_000);
        // Expected token amount: 1.0 (18 decimals: 1_000_000_000_000_000_000)
        let expected = Token18Dec::from_raw(1_000_000_000_000_000_000);
        let result = calculate_stream_rate(price, usage);
        assert_eq!(result.value(), expected.value());
    }

    #[test]
    fn test_calculate_stream_rate_small_values() {
        // Price = 0.0000001 (7 decimals: 1)
        let price = Price7Dec::from_raw(1);
        // Usage = 0.0000001 (7 decimals: 1)
        let usage = Usage7Dec::from_raw(1);
        // Expected token amount: 0.00000000000001 (18 decimals: 10_000)
        let expected = Token18Dec::from_raw(10_000);
        let result = calculate_stream_rate(price, usage);
        assert_eq!(result.value(), expected.value());
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(1000))]

        /// Test that calculate_stream_rate has no precision loss beyond 10^-18
        #[test]
        fn prop_calculate_stream_rate_precision_invariant(
            price_raw in 0u128..1_000_000_000_000_000_000u128,
            usage_raw in 0u128..1_000_000_000_000_000_000u128
        ) {
            let price = Price7Dec::from_raw(price_raw);
            let usage = Usage7Dec::from_raw(usage_raw);
            let result = calculate_stream_rate(price, usage);
            
            // Calculate the exact value as a product, then check that the result
            // is within 1 of the exact value (since we're using integer division)
            let exact_product = price_raw.saturating_mul(usage_raw);
            let expected_token_raw = exact_product.saturating_mul(10_000); // 10^(18-7-7) = 10^4
            
            // The result should be equal to expected (since integer division is exact here)
            // Because we're multiplying first by 10^11 then dividing by 10^7 = multiply by 10^4
            prop_assert_eq!(result.value(), expected_token_raw);
        }
    }

    #[test]
    fn test_validate_decimal_consistency() {
        // Should pass (mismatch ≤ 2)
        validate_decimal_consistency(18, 16);
        validate_decimal_consistency(7, 9);
        validate_decimal_consistency(18, 18);
        
        // Should panic (mismatch > 2)
        let result = std::panic::catch_unwind(|| validate_decimal_consistency(18, 15));
        assert!(result.is_err());
        
        let result = std::panic::catch_unwind(|| validate_decimal_consistency(7, 10));
        assert!(result.is_err());
    }
}
