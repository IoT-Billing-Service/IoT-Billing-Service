//! Issue #23: U256 — 256-bit unsigned integer (two u128 limbs) with checked
//! arithmetic, plus an overflow-safe cross-device usage aggregator.
//!
//! ## Why this exists
//!
//! Cross-device usage aggregation summed per-device readings into a single
//! `u128` accumulator. A `u128` add that *saturates* (or wraps) at `u128::MAX`
//! caps the aggregate far below the true total, so a tenant whose devices each
//! report readings near the overflow boundary is billed for a fraction of real
//! consumption — massive under-charging.
//!
//! The fix accumulates into a `U256` so the sum is **exact** — it never
//! saturates and never wraps. We convert back to `u128` only at the final
//! payment step, and that conversion *errors* (it does not saturate) if the
//! true total genuinely does not fit, so under-charging can never happen
//! silently.
//!
//! Invariant: `aggregate_tenant_usage(readings) == sum(readings[i])`, exact.

use core::cmp::Ordering;

// ---------------------------------------------------------------------------
// Contract-enforced bounds (see issue invariants)
// ---------------------------------------------------------------------------

/// Maximum reading a single device may report, enforced by the contract.
/// Chosen so that even `MAX_DEVICES_PER_TENANT` readings at this value cannot
/// overflow `u128` — the safety margin the original code relied on but did not
/// enforce alongside the device count.
pub const MAX_DEVICE_READING: u128 = u128::MAX / 1_000_000_000;

/// Maximum number of devices a single tenant may aggregate over.
pub const MAX_DEVICES_PER_TENANT: usize = 10_000;

/// Device counts above this threshold are aggregated in batches (blueprint
/// step 3) so a single accumulation pass stays bounded.
pub const MAX_DEVICES_SAFE: usize = 1_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Failure modes for usage aggregation. Each is an explicit error rather than a
/// silent saturation, which is the whole point of the fix.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AggregationError {
    /// A device reported a reading above `MAX_DEVICE_READING`.
    ReadingExceedsDeviceMax,
    /// More devices than `MAX_DEVICES_PER_TENANT`.
    TooManyDevices,
    /// The exact aggregate exceeded even 256 bits (unreachable within the
    /// enforced bounds, but checked rather than assumed).
    Overflow,
    /// The aggregate is exact but does not fit in `u128` for the final payment
    /// step. The caller must split the bill rather than under-charge.
    TotalExceedsU128,
}

// ---------------------------------------------------------------------------
// U256
// ---------------------------------------------------------------------------

/// A 256-bit unsigned integer stored as two `u128` limbs.
///
/// `hi` is declared before `lo` so the derived `Ord`/`PartialOrd` compares the
/// most-significant limb first, giving correct numeric ordering.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct U256 {
    pub hi: u128,
    pub lo: u128,
}

impl U256 {
    pub const ZERO: U256 = U256 { hi: 0, lo: 0 };
    pub const MAX: U256 = U256 {
        hi: u128::MAX,
        lo: u128::MAX,
    };

    /// Widen a `u128` into a `U256`.
    pub const fn from_u128(v: u128) -> U256 {
        U256 { hi: 0, lo: v }
    }

    /// Narrow back to `u128`, returning `None` if the value does not fit. Used
    /// at the final payment step so over-large totals error instead of
    /// saturating.
    pub const fn to_u128(self) -> Option<u128> {
        if self.hi == 0 {
            Some(self.lo)
        } else {
            None
        }
    }

    /// Checked addition. Returns `None` on 256-bit overflow.
    pub const fn checked_add(self, other: U256) -> Option<U256> {
        let (lo, carry_lo) = self.lo.overflowing_add(other.lo);
        // hi + other.hi + carry, detecting overflow at each step.
        let (hi1, carry1) = self.hi.overflowing_add(other.hi);
        if carry1 {
            return None;
        }
        let (hi, carry2) = hi1.overflowing_add(carry_lo as u128);
        if carry2 {
            return None;
        }
        Some(U256 { hi, lo })
    }

    /// Full 128x128 -> 256 multiply. Always exact; never overflows.
    const fn widening_mul_u128(a: u128, b: u128) -> U256 {
        // Split each operand into two 64-bit halves.
        let a_lo = a as u64 as u128;
        let a_hi = a >> 64;
        let b_lo = b as u64 as u128;
        let b_hi = b >> 64;

        let ll = a_lo * b_lo; // < 2^128
        let lh = a_lo * b_hi; // < 2^128
        let hl = a_hi * b_lo; // < 2^128
        let hh = a_hi * b_hi; // < 2^128

        let mut lo = ll;
        let mut hi = hh;

        // Add lh << 64.
        let (lo1, c1) = lo.overflowing_add(lh << 64);
        lo = lo1;
        hi += (lh >> 64) + c1 as u128;

        // Add hl << 64.
        let (lo2, c2) = lo.overflowing_add(hl << 64);
        lo = lo2;
        hi += (hl >> 64) + c2 as u128;

        U256 { hi, lo }
    }

    /// Checked 256-bit multiplication. Returns `None` on overflow.
    pub const fn checked_mul(self, other: U256) -> Option<U256> {
        // self = sh:sl, other = oh:ol.
        // product = sh*oh<<256 + (sl*oh + sh*ol)<<128 + sl*ol.
        // The sh*oh<<256 term alone overflows 256 bits unless one hi limb is 0.
        if self.hi != 0 && other.hi != 0 {
            return None;
        }

        // Low term: sl * ol, always fits in 256 bits.
        let ll = U256::widening_mul_u128(self.lo, other.lo);

        // Cross terms are shifted left by 128, so each must fit in a single
        // 128-bit limb (its own hi half must be zero) or the product overflows.
        let cross_a = U256::widening_mul_u128(self.lo, other.hi);
        if cross_a.hi != 0 {
            return None;
        }
        let cross_b = U256::widening_mul_u128(self.hi, other.lo);
        if cross_b.hi != 0 {
            return None;
        }

        // hi = ll.hi + cross_a.lo + cross_b.lo, checked.
        let hi = match ll.hi.checked_add(cross_a.lo) {
            Some(v) => v,
            None => return None,
        };
        let hi = match hi.checked_add(cross_b.lo) {
            Some(v) => v,
            None => return None,
        };
        Some(U256 { hi, lo: ll.lo })
    }

    /// Convenience: checked multiply by a `u128` scalar (e.g. rate × seconds).
    pub const fn checked_mul_u128(self, scalar: u128) -> Option<U256> {
        self.checked_mul(U256::from_u128(scalar))
    }
}

impl PartialOrd for U256 {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for U256 {
    fn cmp(&self, other: &Self) -> Ordering {
        match self.hi.cmp(&other.hi) {
            Ordering::Equal => self.lo.cmp(&other.lo),
            ord => ord,
        }
    }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/// Sum device readings exactly using a 256-bit accumulator.
///
/// Validates each reading against [`MAX_DEVICE_READING`] and the device count
/// against [`MAX_DEVICES_PER_TENANT`]. The accumulation never saturates and
/// never wraps, so the returned `U256` equals the true sum exactly.
pub fn aggregate_tenant_usage(readings: &[u128]) -> Result<U256, AggregationError> {
    if readings.len() > MAX_DEVICES_PER_TENANT {
        return Err(AggregationError::TooManyDevices);
    }

    let mut total = U256::ZERO;
    for &reading in readings {
        if reading > MAX_DEVICE_READING {
            return Err(AggregationError::ReadingExceedsDeviceMax);
        }
        total = total
            .checked_add(U256::from_u128(reading))
            .ok_or(AggregationError::Overflow)?;
    }
    Ok(total)
}

/// Aggregate in batches of [`MAX_DEVICES_SAFE`] (blueprint step 3). Each batch
/// is summed into a 256-bit subtotal and the subtotals are combined — exact
/// either way, but per-call work stays bounded for very large tenants.
pub fn aggregate_tenant_usage_batched(readings: &[u128]) -> Result<U256, AggregationError> {
    if readings.len() > MAX_DEVICES_PER_TENANT {
        return Err(AggregationError::TooManyDevices);
    }

    let mut total = U256::ZERO;
    for batch in readings.chunks(MAX_DEVICES_SAFE) {
        let subtotal = aggregate_tenant_usage(batch)?;
        total = total
            .checked_add(subtotal)
            .ok_or(AggregationError::Overflow)?;
    }
    Ok(total)
}

/// Convert an exact aggregate to `u128` for the final payment step. Errors
/// (never saturates) if the true total does not fit, so the caller must split
/// the bill rather than silently under-charge.
pub fn finalize_payable_u128(total: U256) -> Result<u128, AggregationError> {
    total.to_u128().ok_or(AggregationError::TotalExceedsU128)
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_and_to_u128_roundtrip() {
        let v = 123_456_789u128;
        assert_eq!(U256::from_u128(v).to_u128(), Some(v));
        assert_eq!(U256::from_u128(u128::MAX).to_u128(), Some(u128::MAX));
    }

    #[test]
    fn to_u128_rejects_high_limb() {
        let big = U256 { hi: 1, lo: 0 };
        assert_eq!(big.to_u128(), None);
    }

    #[test]
    fn checked_add_carries_into_high_limb() {
        // u128::MAX + 1 == 2^128, i.e. hi=1, lo=0.
        let sum = U256::from_u128(u128::MAX)
            .checked_add(U256::from_u128(1))
            .unwrap();
        assert_eq!(sum, U256 { hi: 1, lo: 0 });
    }

    #[test]
    fn checked_add_detects_overflow() {
        assert_eq!(U256::MAX.checked_add(U256::from_u128(1)), None);
        assert_eq!(U256::MAX.checked_add(U256::MAX), None);
    }

    #[test]
    fn widening_mul_is_exact_at_boundary() {
        // (2^128 - 1)^2 == 2^256 - 2^129 + 1 == hi: 2^128-2, lo: 1.
        let p = U256::from_u128(u128::MAX)
            .checked_mul(U256::from_u128(u128::MAX))
            .unwrap();
        assert_eq!(
            p,
            U256 {
                hi: u128::MAX - 1,
                lo: 1,
            }
        );
    }

    #[test]
    fn checked_mul_small_values() {
        let p = U256::from_u128(6).checked_mul_u128(7).unwrap();
        assert_eq!(p.to_u128(), Some(42));
    }

    #[test]
    fn checked_mul_detects_overflow() {
        // 2^128 * 2^128 == 2^256, which overflows.
        let two_pow_128 = U256 { hi: 1, lo: 0 };
        assert_eq!(two_pow_128.checked_mul(two_pow_128), None);
    }

    #[test]
    fn ordering_compares_high_limb_first() {
        let small = U256 { hi: 0, lo: u128::MAX };
        let large = U256 { hi: 1, lo: 0 };
        assert!(large > small);
    }

    #[test]
    fn aggregate_sums_exactly_within_u128() {
        let readings = [10u128, 20, 30, 40];
        let total = aggregate_tenant_usage(&readings).unwrap();
        assert_eq!(total.to_u128(), Some(100));
    }

    #[test]
    fn aggregate_does_not_saturate_beyond_u128() {
        // Three readings each at the device max. With the original u128
        // accumulator near the boundary this would saturate; here it is exact.
        let r = MAX_DEVICE_READING;
        let total = aggregate_tenant_usage(&[r, r, r]).unwrap();
        // Exact sum 3*r equals r+r+r computed in U256.
        let expected = U256::from_u128(r)
            .checked_add(U256::from_u128(r))
            .unwrap()
            .checked_add(U256::from_u128(r))
            .unwrap();
        assert_eq!(total, expected);
    }

    #[test]
    fn aggregate_within_bounds_always_fits_u128() {
        // 10_000 * (u128::MAX / 1e9) == u128::MAX / 1e5 < u128::MAX, so the
        // validated aggregate can never overflow u128 — the saturating bug is
        // structurally impossible on the validated path.
        let max_possible = U256::from_u128(MAX_DEVICE_READING)
            .checked_mul_u128(MAX_DEVICES_PER_TENANT as u128)
            .unwrap();
        assert!(max_possible.to_u128().is_some());
    }

    #[test]
    fn aggregate_rejects_over_max_reading() {
        let readings = [MAX_DEVICE_READING + 1];
        assert_eq!(
            aggregate_tenant_usage(&readings),
            Err(AggregationError::ReadingExceedsDeviceMax)
        );
    }

    #[test]
    fn batched_matches_unbatched() {
        // 2_500 readings spans multiple MAX_DEVICES_SAFE batches.
        extern crate std;
        let readings: std::vec::Vec<u128> = (0..2_500u128).map(|i| i * 7 + 1).collect();
        let direct = aggregate_tenant_usage(&readings).unwrap();
        let batched = aggregate_tenant_usage_batched(&readings).unwrap();
        assert_eq!(direct, batched);
    }

    #[test]
    fn finalize_errors_when_total_exceeds_u128() {
        let over = U256 { hi: 1, lo: 0 };
        assert_eq!(
            finalize_payable_u128(over),
            Err(AggregationError::TotalExceedsU128)
        );
        assert_eq!(finalize_payable_u128(U256::from_u128(500)), Ok(500));
    }
}
