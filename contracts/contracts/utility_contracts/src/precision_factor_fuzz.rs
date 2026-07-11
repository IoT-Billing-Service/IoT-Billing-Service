#![cfg(test)]

//! Issue #9: precision/dust fuzz tests for the remainder-carry billing path.
//! (The blueprint names `precision_factor_fuzz.rs`, created here.)
//!
//! Asserts the carry accumulator is exact over long runs and that the residual
//! dust per device stays strictly sub-unit — across 1,000,000 cycles and over
//! random multi-cycle sequences.

extern crate std;

use crate::remainder_accumulator::{
    apply_with_carry, naive_truncating, RemainderAccumulator, PRECISION_FACTOR,
};
use proptest::prelude::*;

const RATE: u128 = 1;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(500))]

    /// Over any sequence of readings, the carried total equals the exact floor
    /// of the summed value, and the reservoir never reaches one unit.
    #[test]
    fn prop_carry_is_exact_and_subunit(
        readings in proptest::collection::vec(0u128..100_000_000u128, 1..500),
    ) {
        let mut acc = RemainderAccumulator::new();
        let mut billed_total = 0u128;
        let mut value_total = 0u128;
        for &r in &readings {
            billed_total += acc.apply(r, RATE, PRECISION_FACTOR);
            value_total += r * RATE;
            prop_assert!(acc.reservoir < PRECISION_FACTOR);
        }
        prop_assert_eq!(billed_total, value_total / PRECISION_FACTOR);
        prop_assert_eq!(acc.reservoir, value_total % PRECISION_FACTOR);

        // The carry never bills less than naive truncation.
        let naive: u128 = readings.iter().map(|&r| naive_truncating(r, RATE, PRECISION_FACTOR)).sum();
        prop_assert!(billed_total >= naive);
    }
}

/// Blueprint step 4: 1,000,000 cycles just above the 7-decimal floor — the
/// accumulated error stays under one unit and the billed total is exact.
#[test]
fn fuzz_one_million_cycles_error_under_one_unit() {
    let reading = 10_000_001u128; // 1.0000001 units
    let cycles = 1_000_000u128;

    let mut reservoir = 0u128;
    let mut billed = 0u128;
    for _ in 0..cycles {
        billed += apply_with_carry(reading, RATE, PRECISION_FACTOR, &mut reservoir);
    }

    let exact = (reading * cycles) / PRECISION_FACTOR;
    assert_eq!(billed, exact, "carry billing must be exact over 1e6 cycles");
    assert!(reservoir < PRECISION_FACTOR, "residual dust must be sub-unit");

    // Contrast: naive truncation drops the remainder every cycle.
    let naive = cycles * naive_truncating(reading, RATE, PRECISION_FACTOR);
    // The dropped value the carry preserves (0.0000001 * 1e6 = 0.1 unit here).
    assert!(billed >= naive);
    assert_eq!(billed - naive, (reading % PRECISION_FACTOR) * cycles / PRECISION_FACTOR);
}
