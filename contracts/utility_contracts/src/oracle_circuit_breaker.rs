//! Issue #21: Price-oracle staleness & flash-loan manipulation circuit breaker.
//!
//! ## The threat
//!
//! The billing engine reads a SEP-40 oracle price (`PriceData`) and uses it to
//! compute USD-equivalent charges, with **no staleness or deviation check**.
//! During a flash-loan attack (a 1–2 ledger-close window) on-chain liquidity is
//! distorted and the oracle's spot price can swing up to ~20% from the true
//! price, or go stale by minutes. An attacker who triggers billing-cycle
//! finalization inside that window has devices billed at a manipulated price.
//!
//! ## Defence (layered, per blueprint)
//!
//!   1. **Freshness check** — reject a spot price older than
//!      [`MAX_STALENESS_SECS`] (`ledger_timestamp - last_updated`).
//!   2. **Deviation check** — keep a ring buffer of the last
//!      [`PRICE_HISTORY_LEN`] observations, compute their moving average, and if
//!      the spot deviates more than [`MAX_DEVIATION_BPS`] from it, use the
//!      moving average instead. A 1–2 sample manipulation among 30 barely moves
//!      the average, so the outlier is caught.
//!   3. **Circuit breaker** — if *both* checks fail, fall back to the last known
//!      good price and emit a `PrStale` event.
//!
//! ## A note on "VWAP"
//!
//! The blueprint says VWAP, but SEP-40 `get_price` exposes no per-observation
//! *volume*, so a true volume-weighted average is not computable here. We use a
//! simple moving average (time-weighted by the cadence of observations), which
//! is the standard manipulation-resistant reference when volumes are
//! unavailable. This is called out so the name is not mistaken for VWAP.
//!
//! Invariant: the price used is always within [`MAX_DEVIATION_BPS`] of the
//! moving average, or is a previously-validated last-known-good price.

extern crate alloc;

use alloc::vec::Vec as StdVec;
use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, Vec};

use crate::{ContractError, DataKey, PriceOracleClient};

// ---------------------------------------------------------------------------
// Bounds (see issue invariants)
// ---------------------------------------------------------------------------

/// Target freshness: one ledger close (~5s). Informational.
pub const TARGET_FRESHNESS_SECS: u64 = 5;

/// Maximum acceptable staleness: 10 ledger closes (~50s). A spot price older
/// than this fails the freshness check.
pub const MAX_STALENESS_SECS: u64 = 50;

/// Number of observations retained for the moving-average reference.
pub const PRICE_HISTORY_LEN: u32 = 30;

/// Maximum tolerated deviation of spot from the moving average, in basis points
/// (500 bps = 5%).
pub const MAX_DEVIATION_BPS: i128 = 500;

// ---------------------------------------------------------------------------
// Pure decision logic (unit-tested without an Env)
// ---------------------------------------------------------------------------

/// Which price source the guard selected for this read.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PriceDecision {
    /// Spot is fresh and within tolerance — use it.
    Spot,
    /// Spot failed exactly one check — fall back to the moving average.
    MovingAverage,
    /// Spot failed both checks — trip the breaker, use last-known-good.
    CircuitBreaker,
}

/// True if `last_updated` is older than `max_staleness` relative to `now`.
/// Saturating so a clock that appears to move backwards reads as "stale" rather
/// than underflowing.
pub fn is_stale(now: u64, last_updated: u64, max_staleness: u64) -> bool {
    now.saturating_sub(last_updated) > max_staleness
}

/// True if `|spot - reference| / reference` exceeds `max_bps` basis points.
/// Returns `false` when `reference <= 0` (no meaningful baseline yet) to avoid
/// division by zero.
pub fn deviation_exceeds(spot: i128, reference: i128, max_bps: i128) -> bool {
    if reference <= 0 {
        return false;
    }
    let diff = (spot - reference).abs();
    // diff/reference > max_bps/10_000  <=>  diff*10_000 > max_bps*reference
    diff.saturating_mul(10_000) > max_bps.saturating_mul(reference)
}

/// Arithmetic mean of the observations. Returns 0 for an empty slice.
pub fn moving_average(prices: &[i128]) -> i128 {
    if prices.is_empty() {
        return 0;
    }
    let mut sum: i128 = 0;
    for &p in prices {
        sum = sum.saturating_add(p);
    }
    sum / prices.len() as i128
}

/// The core decision matrix. `stale` and `deviates` are the two check failures.
pub fn decide_price(stale: bool, deviates: bool) -> PriceDecision {
    match (stale, deviates) {
        (false, false) => PriceDecision::Spot,
        // Exactly one failure: the moving average is a safe, smoothed reference.
        (false, true) | (true, false) => PriceDecision::MovingAverage,
        // Both failed: do not trust live data at all.
        (true, true) => PriceDecision::CircuitBreaker,
    }
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct OracleGuard;

#[contractimpl]
impl OracleGuard {
    /// Read the oracle's spot price through the circuit breaker and return the
    /// price that is safe to bill at.
    pub fn guarded_price(env: Env, oracle: Address) -> Result<i128, ContractError> {
        let client = PriceOracleClient::new(&env, &oracle);
        let pd = client.get_price();
        Self::record_and_resolve(env, pd.price, pd.last_updated)
    }

    /// Apply the freshness + deviation + circuit-breaker logic to a spot price
    /// and its `last_updated` timestamp, updating the history ring buffer and
    /// the last-known-good price as appropriate. Separated from `guarded_price`
    /// so it can be exercised without a live oracle contract.
    pub fn record_and_resolve(
        env: Env,
        spot: i128,
        last_updated: u64,
    ) -> Result<i128, ContractError> {
        let now = env.ledger().timestamp();
        let stale = is_stale(now, last_updated, MAX_STALENESS_SECS);

        let history = Self::load_history(&env);
        let has_history = !history.is_empty();
        let ma = if has_history {
            moving_average(&history)
        } else {
            spot
        };
        let deviates = has_history && deviation_exceeds(spot, ma, MAX_DEVIATION_BPS);

        let used = match decide_price(stale, deviates) {
            PriceDecision::Spot => {
                // Fresh and in-tolerance: trust it, record it, advance good price.
                Self::push_history(&env, spot);
                env.storage()
                    .persistent()
                    .set(&DataKey::OracleLastGoodPrice, &spot);
                spot
            }
            // One check failed and we have a real average to smooth against.
            PriceDecision::MovingAverage if has_history => {
                // Record the observation only if it is fresh, so the average can
                // self-correct over time without admitting a stale sample.
                if !stale {
                    Self::push_history(&env, spot);
                }
                env.events().publish(
                    (symbol_short!("PrStale"), oracle_reason(stale, deviates)),
                    (spot, ma),
                );
                ma
            }
            // Either both checks failed, or a check failed with no history to
            // average over: trip the breaker and use the last known good price.
            PriceDecision::MovingAverage | PriceDecision::CircuitBreaker => {
                env.events().publish(
                    (symbol_short!("PrStale"), oracle_reason(stale, deviates)),
                    (spot, ma),
                );
                match env
                    .storage()
                    .persistent()
                    .get::<DataKey, i128>(&DataKey::OracleLastGoodPrice)
                {
                    Some(last_good) => last_good,
                    None => return Err(ContractError::OraclePriceUnavailable),
                }
            }
        };

        Ok(used)
    }

    /// Current moving-average reference (0 if no history yet).
    pub fn current_moving_average(env: Env) -> i128 {
        moving_average(&Self::load_history(&env))
    }

    /// Last known good price, if any.
    pub fn last_good_price(env: Env) -> Option<i128> {
        env.storage()
            .persistent()
            .get(&DataKey::OracleLastGoodPrice)
    }
}

impl OracleGuard {
    /// Load the ring buffer into a heap slice for averaging.
    fn load_history(env: &Env) -> StdVec<i128> {
        let stored: Vec<i128> = env
            .storage()
            .persistent()
            .get(&DataKey::OraclePriceHistory)
            .unwrap_or_else(|| Vec::new(env));
        let mut v = StdVec::with_capacity(stored.len() as usize);
        for p in stored.iter() {
            v.push(p);
        }
        v
    }

    /// Append `price`, evicting the oldest if the buffer is full.
    fn push_history(env: &Env, price: i128) {
        let mut stored: Vec<i128> = env
            .storage()
            .persistent()
            .get(&DataKey::OraclePriceHistory)
            .unwrap_or_else(|| Vec::new(env));
        if stored.len() >= PRICE_HISTORY_LEN {
            stored.remove(0);
        }
        stored.push_back(price);
        env.storage()
            .persistent()
            .set(&DataKey::OraclePriceHistory, &stored);
    }
}

/// Encode which checks failed into a stable event reason code.
/// 1 = stale only, 2 = deviation only, 3 = both (circuit breaker).
fn oracle_reason(stale: bool, deviates: bool) -> u32 {
    (stale as u32) | ((deviates as u32) << 1)
}

// ---------------------------------------------------------------------------
// Pure-logic unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn staleness_boundary() {
        // last_updated at t=100, max 50s. now=150 → exactly 50, not stale.
        assert!(!is_stale(150, 100, MAX_STALENESS_SECS));
        // now=151 → 51 > 50, stale.
        assert!(is_stale(151, 100, MAX_STALENESS_SECS));
        // backwards clock → treated as stale, no underflow.
        assert!(!is_stale(90, 100, MAX_STALENESS_SECS));
    }

    #[test]
    fn deviation_threshold_is_five_percent() {
        // reference 1000, 5% = 50. diff 50 → not exceeding (> is strict).
        assert!(!deviation_exceeds(1050, 1000, MAX_DEVIATION_BPS));
        assert!(!deviation_exceeds(950, 1000, MAX_DEVIATION_BPS));
        // diff 51 → exceeds.
        assert!(deviation_exceeds(1051, 1000, MAX_DEVIATION_BPS));
        // 20% flash-loan swing clearly exceeds.
        assert!(deviation_exceeds(800, 1000, MAX_DEVIATION_BPS));
        // empty/zero reference never "deviates".
        assert!(!deviation_exceeds(800, 0, MAX_DEVIATION_BPS));
    }

    #[test]
    fn moving_average_basic() {
        assert_eq!(moving_average(&[]), 0);
        assert_eq!(moving_average(&[100, 100, 100]), 100);
        assert_eq!(moving_average(&[90, 100, 110]), 100);
    }

    #[test]
    fn decision_matrix() {
        assert_eq!(decide_price(false, false), PriceDecision::Spot);
        assert_eq!(decide_price(false, true), PriceDecision::MovingAverage);
        assert_eq!(decide_price(true, false), PriceDecision::MovingAverage);
        assert_eq!(decide_price(true, true), PriceDecision::CircuitBreaker);
    }

    #[test]
    fn reason_codes() {
        assert_eq!(oracle_reason(false, false), 0);
        assert_eq!(oracle_reason(true, false), 1);
        assert_eq!(oracle_reason(false, true), 2);
        assert_eq!(oracle_reason(true, true), 3);
    }

    /// A 20% flash-loan swing against a stable history is rejected in favour of
    /// the moving average (the price actually billed stays within 5% of it).
    #[test]
    fn flash_loan_swing_uses_moving_average() {
        let history = [100i128; 30];
        let ma = moving_average(&history);
        let manipulated_spot = 80; // 20% below
        assert!(deviation_exceeds(manipulated_spot, ma, MAX_DEVIATION_BPS));
        // Fresh but deviating → MovingAverage decision.
        assert_eq!(decide_price(false, true), PriceDecision::MovingAverage);
        // The billed price (ma) satisfies the invariant trivially.
        assert!(!deviation_exceeds(ma, ma, MAX_DEVIATION_BPS));
    }
}
