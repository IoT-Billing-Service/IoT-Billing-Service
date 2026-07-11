#![cfg(test)]

//! Issue #23: Property-based overflow fuzzing for the U256 usage accumulator.
//!
//! These tests exercise the path that replaced the saturating `u128`
//! accumulator in cross-device usage aggregation. There are two distinct
//! guarantees:
//!
//!   1. **Within the enforced bounds** (`MAX_DEVICE_READING` per device, up to
//!      `MAX_DEVICES_PER_TENANT` devices) the aggregate is exact *and* provably
//!      fits in `u128` — the saturating-under-charge bug cannot occur, and the
//!      result agrees with an independent `u128` oracle.
//!
//!   2. **For the raw accumulator** fed readings near `u128::MAX` (the issue's
//!      "industrial devices near the overflow boundary" scenario), the 256-bit
//!      accumulator stays exact and never saturates. Where the true sum exceeds
//!      `u128`, the final conversion *errors* instead of silently reporting
//!      `u128::MAX` — which is exactly the under-charge the old code produced.

extern crate std;

use crate::u256::{
    aggregate_tenant_usage, aggregate_tenant_usage_batched, finalize_payable_u128,
    AggregationError, U256, MAX_DEVICE_READING, MAX_DEVICES_PER_TENANT,
};
use proptest::prelude::*;
use std::vec;
use std::vec::Vec;

/// Independent oracle: sum readings with checked `u128` arithmetic. Returns
/// `Some(total)` when the true sum fits in `u128`, `None` when it would
/// overflow. Because readings are non-negative the running sum is monotonic, so
/// `None` is equivalent to "the true total exceeds `u128::MAX`". This is
/// deliberately *not* the U256 implementation, so agreement is meaningful.
fn u128_checked_sum(readings: &[u128]) -> Option<u128> {
    let mut acc: u128 = 0;
    for &r in readings {
        acc = acc.checked_add(r)?;
    }
    Some(acc)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    /// Guarantee 1: within the per-device bound and device count, the U256
    /// aggregate is exact, fits in u128, and agrees with the independent u128
    /// oracle. The batched path produces the identical result.
    #[test]
    fn prop_aggregate_exact_within_bounds(
        readings in proptest::collection::vec(0u128..=MAX_DEVICE_READING, 0..=2_000usize),
    ) {
        let total = aggregate_tenant_usage(&readings).unwrap();

        // Under the enforced bounds the true sum fits in u128.
        let oracle = u128_checked_sum(&readings).expect("bounded sum must fit u128");
        prop_assert_eq!(total.to_u128(), Some(oracle));
        prop_assert_eq!(finalize_payable_u128(total), Ok(oracle));

        let batched = aggregate_tenant_usage_batched(&readings).unwrap();
        prop_assert_eq!(total, batched);
    }

    /// Guarantee 2: the raw 256-bit accumulator stays exact for readings spread
    /// across the entire u128 range. Where the true sum exceeds u128, the
    /// accumulator preserves it (hi limb set) and the payment conversion errors
    /// rather than saturating to u128::MAX.
    #[test]
    fn prop_accumulator_exact_for_large_readings(
        readings in proptest::collection::vec(any::<u128>(), 2..=500usize),
    ) {
        // 500 * u128::MAX is far below 2^256, so checked_add never overflows.
        let mut total = U256::ZERO;
        for &r in &readings {
            total = total.checked_add(U256::from_u128(r)).unwrap();
        }

        match u128_checked_sum(&readings) {
            Some(oracle) => {
                prop_assert_eq!(total.to_u128(), Some(oracle));
                prop_assert_eq!(finalize_payable_u128(total), Ok(oracle));
            }
            None => {
                prop_assert!(total.hi != 0, "total should exceed u128 range");
                prop_assert_eq!(
                    finalize_payable_u128(total),
                    Err(AggregationError::TotalExceedsU128)
                );
                // The old saturating accumulator would have reported u128::MAX;
                // the exact total must be strictly larger.
                let saturating = readings
                    .iter()
                    .fold(0u128, |a, &r| a.saturating_add(r));
                prop_assert!(total > U256::from_u128(saturating));
            }
        }
    }

    /// Adding one more reading never decreases the running total — saturation
    /// or wrapping would violate this monotonicity.
    #[test]
    fn prop_accumulation_is_monotonic(
        readings in proptest::collection::vec(any::<u128>(), 1..=500usize),
    ) {
        let mut running = U256::ZERO;
        for &r in &readings {
            let next = running.checked_add(U256::from_u128(r)).unwrap();
            prop_assert!(next >= running, "accumulator must be monotonic");
            running = next;
        }
    }
}

/// Blueprint step 4: 10,000 readings each near the u128 overflow boundary — the
/// issue's industrial-device scenario. A saturating u128 accumulator caps at
/// u128::MAX (under-charging by ~10,000x); the U256 accumulator is exact and
/// the conversion errors instead of silently reporting the capped value.
#[test]
fn fuzz_ten_thousand_max_readings_no_saturation() {
    let readings: Vec<u128> = vec![u128::MAX; MAX_DEVICES_PER_TENANT];

    let mut total = U256::ZERO;
    for &r in &readings {
        total = total.checked_add(U256::from_u128(r)).unwrap();
    }

    // Exact: 10_000 * u128::MAX.
    let expected = U256::from_u128(u128::MAX)
        .checked_mul_u128(MAX_DEVICES_PER_TENANT as u128)
        .unwrap();
    assert_eq!(total, expected);

    // Far exceeds u128 — the true total is preserved, not saturated.
    assert!(total.hi != 0);
    assert_eq!(
        finalize_payable_u128(total),
        Err(AggregationError::TotalExceedsU128)
    );

    // What the buggy saturating path would have produced, for contrast.
    let saturating: u128 = readings.iter().fold(0u128, |a, &r| a.saturating_add(r));
    assert_eq!(saturating, u128::MAX);
    assert!(
        total > U256::from_u128(saturating),
        "exact total must exceed the saturated u128 value"
    );
}

/// Within the enforced device bound, aggregating 10,000 maxed-out *valid*
/// readings is exact and fits u128 — the saturating bug cannot occur on the
/// validated path.
#[test]
fn fuzz_ten_thousand_bounded_readings_fit_u128() {
    let readings: Vec<u128> = vec![MAX_DEVICE_READING; MAX_DEVICES_PER_TENANT];

    let total = aggregate_tenant_usage(&readings).unwrap();
    let expected = U256::from_u128(MAX_DEVICE_READING)
        .checked_mul_u128(MAX_DEVICES_PER_TENANT as u128)
        .unwrap();
    assert_eq!(total, expected);
    assert!(total.to_u128().is_some(), "bounded aggregate must fit u128");
    assert_eq!(total, aggregate_tenant_usage_batched(&readings).unwrap());
}

/// Exceeding the device cap is a hard error, not a truncated aggregation.
#[test]
fn fuzz_rejects_too_many_devices() {
    let readings: Vec<u128> = vec![1u128; MAX_DEVICES_PER_TENANT + 1];
    assert_eq!(
        aggregate_tenant_usage(&readings),
        Err(AggregationError::TooManyDevices)
    );
    assert_eq!(
        aggregate_tenant_usage_batched(&readings),
        Err(AggregationError::TooManyDevices)
    );
}
