//! Issue #18: TTL-safe persistent storage access.
//!
//! ## The threat
//!
//! Persistent storage entries have a finite time-to-live (TTL). When a device
//! stream is inactive past its TTL, the host archives/evicts the entry. The
//! ghost sweeper reads stream keys (`prune_ghost_stream`,
//! `get_ghost_stream_candidates`, `check_stream_eligibility`) **without first
//! bumping their TTL**. An entry that expires between a `has()` check and a
//! `get()` (or that is read after expiry) yields a missing/garbage read.
//!
//! ## The fix
//!
//! - [`ttl_safe_read`] extends an entry's TTL *before* reading it and returns
//!   `None` gracefully when the key is absent — closing the check-then-read
//!   (TOCTOU) gap.
//! - [`set_with_ttl`] writes an entry and immediately pins a fresh TTL, so newly
//!   created entries (archives, statistics) are not eligible for premature GC.
//!
//! Invariant: every persistent key accessed through these helpers has, after the
//! call, TTL ≥ `now + MIN_TTL_THRESHOLD_LEDGERS`.

use soroban_sdk::{Env, IntoVal, TryFromVal, Val};

// ---------------------------------------------------------------------------
// TTL bounds (pure, unit-tested)
// ---------------------------------------------------------------------------

/// Ledger closes per day at the ~5s Stellar cadence (86_400 / 5).
///
/// Note: the issue text's "604,800 ledger closes" for 7 days conflates seconds
/// with ledgers; 7 days is 7 × `DAY_LEDGERS` = 120_960 closes at 5s/close.
pub const DAY_LEDGERS: u32 = 86_400 / 5;

/// TTL window applied to swept/created entries, in days (blueprint: 14).
pub const TTL_WINDOW_DAYS: u32 = 14;

/// How far ahead (in ledgers) to extend an entry's TTL: 14 days.
pub const TTL_EXTEND_TO_LEDGERS: u32 = TTL_WINDOW_DAYS * DAY_LEDGERS;

/// Only extend when the remaining TTL drops below this threshold (7 days). This
/// makes the bump idempotent-ish — repeated reads in a sweep do not pay the
/// extend cost every time, only when the entry is approaching eviction.
pub const MIN_TTL_THRESHOLD_LEDGERS: u32 = 7 * DAY_LEDGERS;

/// Ledgers covering `days` at the standard cadence (saturating).
pub fn ledgers_for_days(days: u32) -> u32 {
    days.saturating_mul(DAY_LEDGERS)
}

/// Whether an entry whose TTL has `remaining_ttl` ledgers left should be
/// extended, given a `threshold`.
pub fn should_extend(remaining_ttl: u32, threshold: u32) -> bool {
    remaining_ttl < threshold
}

// ---------------------------------------------------------------------------
// TTL-safe persistent storage helpers
// ---------------------------------------------------------------------------

/// Extend a persistent entry's TTL, then read it. Returns `None` if the key is
/// absent (e.g. already garbage-collected), so callers never observe a partial
/// or evicted read.
pub fn ttl_safe_read<K, V>(env: &Env, key: &K) -> Option<V>
where
    K: IntoVal<Env, Val>,
    V: TryFromVal<Env, Val>,
{
    let storage = env.storage().persistent();
    if !storage.has(key) {
        return None;
    }
    storage.extend_ttl(key, MIN_TTL_THRESHOLD_LEDGERS, TTL_EXTEND_TO_LEDGERS);
    storage.get(key)
}

/// Write a persistent entry and immediately pin a fresh 14-day TTL so the new
/// entry is not eligible for premature garbage collection.
pub fn set_with_ttl<K, V>(env: &Env, key: &K, value: &V)
where
    K: IntoVal<Env, Val>,
    V: IntoVal<Env, Val>,
{
    let storage = env.storage().persistent();
    storage.set(key, value);
    storage.extend_ttl(key, MIN_TTL_THRESHOLD_LEDGERS, TTL_EXTEND_TO_LEDGERS);
}

// ---------------------------------------------------------------------------
// Pure-logic unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn day_ledgers_is_correct_cadence() {
        assert_eq!(DAY_LEDGERS, 17_280);
        // 7 days, the default TTL, in ledger closes.
        assert_eq!(ledgers_for_days(7), 120_960);
    }

    #[test]
    fn extend_window_is_fourteen_days() {
        assert_eq!(TTL_EXTEND_TO_LEDGERS, ledgers_for_days(TTL_WINDOW_DAYS));
        assert_eq!(TTL_EXTEND_TO_LEDGERS, 241_920);
    }

    #[test]
    fn extends_only_below_threshold() {
        assert!(should_extend(0, MIN_TTL_THRESHOLD_LEDGERS));
        assert!(should_extend(MIN_TTL_THRESHOLD_LEDGERS - 1, MIN_TTL_THRESHOLD_LEDGERS));
        assert!(!should_extend(MIN_TTL_THRESHOLD_LEDGERS, MIN_TTL_THRESHOLD_LEDGERS));
        assert!(!should_extend(TTL_EXTEND_TO_LEDGERS, MIN_TTL_THRESHOLD_LEDGERS));
    }

    #[test]
    fn ledgers_for_days_saturates() {
        assert_eq!(ledgers_for_days(0), 0);
        assert_eq!(ledgers_for_days(u32::MAX), u32::MAX);
    }
}
