//! Issue #10: bounded telemetry ingestion buffer.
//!
//! ## The threat
//!
//! Raw sensor readings were appended to a `Vec<TelemetryEvent>` in a single
//! ledger entry, flushed to billing every 100 events. If the downstream oracle
//! flush failed, the flush path panicked **without clearing the buffer**, so it
//! grew unbounded. Each event is ~128 bytes; past ~4096 events the entry exceeds
//! Soroban's 512 KB ledger-entry limit, and **every subsequent write fails**
//! with `StorageWriteSizeLimitExceeded` — an irreversible wedge.
//!
//! ## The fix
//!
//! - [`TelemetryBuffer::append_event`] enforces a hard cap
//!   ([`MAX_PENDING_EVENTS`]) and evicts the oldest batch to an archive entry
//!   once [`EVICTION_THRESHOLD`] is crossed, so the live entry can never
//!   approach the size limit.
//! - Flushing is **atomic two-phase**: [`take_flush_batch`] snapshots the batch
//!   without clearing; the caller invokes the oracle and then calls
//!   [`confirm_flush`] (success → remove the batch) or [`abort_flush`]
//!   (failure → events retained, nothing lost, no panic).
//! - [`repair_buffer`] lets an admin prune stale events once connectivity is
//!   restored.
//!
//! Invariant: `len(pending_events) <= MAX_PENDING_EVENTS`, hence
//! `buffer_bytes(len) <= MAX_ENTRY_BYTES` — the entry never overflows.

extern crate alloc;

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, Symbol, Vec};

/// Per-event size estimate (Address + u128 + u64 + u64 ≈ 128 bytes).
pub const EVENT_SIZE_BYTES: u32 = 128;

/// Soroban ledger-entry size limit.
pub const MAX_ENTRY_BYTES: u32 = 512 * 1024;

/// Hard cap on live pending events. 500 × 128 B = 64 KB ≪ 512 KB, and well
/// below the ~4096-event overflow point.
pub const MAX_PENDING_EVENTS: u32 = 500;

/// Normal flush batch size.
pub const FLUSH_THRESHOLD: u32 = 100;

/// Above this many live events, evict the oldest batch to the archive.
pub const EVICTION_THRESHOLD: u32 = 300;

/// Number of oldest events evicted per eviction.
pub const EVICTION_BATCH: u32 = 100;

const PENDING_KEY: Symbol = symbol_short!("pending");
const ARCHIVE_KEY: Symbol = symbol_short!("archive");

/// Errors surfaced instead of panicking, so a wedged oracle never bricks writes.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum BufferError {
    /// Buffer is at `MAX_PENDING_EVENTS`; caller must flush/repair first.
    BufferFull = 1,
    /// Caller is not the configured admin.
    Unauthorized = 2,
    /// Invalid prune range.
    InvalidRange = 3,
}

/// A single telemetry reading (~128 bytes).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TelemetryEvent {
    pub device: Address,
    pub value: u128,
    pub timestamp: u64,
    pub nonce: u64,
}

// ---------------------------------------------------------------------------
// Pure capacity math (unit-tested without an Env)
// ---------------------------------------------------------------------------

/// Bytes occupied by `len` events (saturating).
pub fn buffer_bytes(len: u32) -> u32 {
    len.saturating_mul(EVENT_SIZE_BYTES)
}

/// Whether `len` events still fit within the ledger-entry size limit.
pub fn within_entry_limit(len: u32) -> bool {
    buffer_bytes(len) <= MAX_ENTRY_BYTES
}

/// Whether the buffer is at the hard cap.
pub fn is_full(len: u32) -> bool {
    len >= MAX_PENDING_EVENTS
}

/// Whether the buffer should shed its oldest batch to the archive.
pub fn should_evict(len: u32) -> bool {
    len > EVICTION_THRESHOLD
}

/// Model of the bounded-buffer state machine, used by the stress test: run
/// `submissions` appends; a flush is attempted whenever the buffer reaches
/// `FLUSH_THRESHOLD` and fails on every `fail_every`-th attempt (0 = never).
/// Returns the maximum live length observed.
pub fn simulate_max_len(submissions: u32, fail_every: u32) -> u32 {
    let mut pending: u32 = 0;
    let mut max_len: u32 = 0;
    let mut flush_attempt: u32 = 0;

    for _ in 0..submissions {
        // append_event: cap, then evict oldest batch if over the threshold.
        if !is_full(pending) {
            pending += 1;
        }
        if should_evict(pending) {
            pending -= EVICTION_BATCH; // oldest batch archived
        }

        // flush attempt when we have a full batch.
        if pending >= FLUSH_THRESHOLD {
            flush_attempt += 1;
            let oracle_ok = fail_every == 0 || flush_attempt % fail_every != 0;
            if oracle_ok {
                // confirm_flush removes the flushed batch.
                pending -= FLUSH_THRESHOLD;
            }
            // else abort_flush: events retained, buffer unchanged.
        }

        if pending > max_len {
            max_len = pending;
        }
    }
    max_len
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct TelemetryBuffer;

#[contractimpl]
impl TelemetryBuffer {
    /// Append a reading. Rejects at the hard cap and sheds the oldest batch to
    /// the archive once `EVICTION_THRESHOLD` is crossed, so the live entry can
    /// never approach the size limit.
    pub fn append_event(env: Env, event: TelemetryEvent) -> Result<(), BufferError> {
        let mut pending = Self::load(&env, &PENDING_KEY);
        if is_full(pending.len()) {
            return Err(BufferError::BufferFull);
        }
        pending.push_back(event);

        if should_evict(pending.len()) {
            Self::evict_oldest(&env, &mut pending, EVICTION_BATCH);
        }

        Self::store(&env, &PENDING_KEY, &pending);
        Ok(())
    }

    /// Phase 1: snapshot up to `FLUSH_THRESHOLD` events to flush, **without**
    /// clearing them — so an oracle failure loses nothing.
    pub fn take_flush_batch(env: Env) -> Vec<TelemetryEvent> {
        let pending = Self::load(&env, &PENDING_KEY);
        let take = core::cmp::min(pending.len(), FLUSH_THRESHOLD);
        let mut batch = Vec::new(&env);
        for i in 0..take {
            batch.push_back(pending.get(i).unwrap());
        }
        batch
    }

    /// Phase 2a: the oracle accepted the batch — remove the flushed events.
    pub fn confirm_flush(env: Env, count: u32) {
        let pending = Self::load(&env, &PENDING_KEY);
        let remove = core::cmp::min(count, pending.len());
        let mut remaining = Vec::new(&env);
        for i in remove..pending.len() {
            remaining.push_back(pending.get(i).unwrap());
        }
        Self::store(&env, &PENDING_KEY, &remaining);
    }

    /// Phase 2b: the oracle failed — retain the batch (no-op, documented so the
    /// orchestrator's intent is explicit and no panic clears state).
    pub fn abort_flush(_env: Env) {}

    /// Admin: prune the oldest `count` stale events once connectivity is
    /// restored (e.g. after they were re-ingested elsewhere).
    pub fn repair_buffer(env: Env, admin: Address, count: u32) -> Result<(), BufferError> {
        admin.require_auth();
        let stored_admin: Option<Address> = env.storage().instance().get(&symbol_short!("admin"));
        match stored_admin {
            Some(a) if a == admin => {}
            _ => return Err(BufferError::Unauthorized),
        }
        let pending = Self::load(&env, &PENDING_KEY);
        if count > pending.len() {
            return Err(BufferError::InvalidRange);
        }
        let mut remaining = Vec::new(&env);
        for i in count..pending.len() {
            remaining.push_back(pending.get(i).unwrap());
        }
        Self::store(&env, &PENDING_KEY, &remaining);
        Ok(())
    }

    /// Set the admin allowed to call `repair_buffer`.
    pub fn set_admin(env: Env, admin: Address) {
        env.current_contract_address().require_auth();
        env.storage().instance().set(&symbol_short!("admin"), &admin);
    }

    pub fn pending_len(env: Env) -> u32 {
        Self::load(&env, &PENDING_KEY).len()
    }

    pub fn archive_len(env: Env) -> u32 {
        Self::load(&env, &ARCHIVE_KEY).len()
    }
}

impl TelemetryBuffer {
    fn load(env: &Env, key: &Symbol) -> Vec<TelemetryEvent> {
        env.storage()
            .persistent()
            .get(key)
            .unwrap_or_else(|| Vec::new(env))
    }

    fn store(env: &Env, key: &Symbol, v: &Vec<TelemetryEvent>) {
        env.storage().persistent().set(key, v);
    }

    /// Move the oldest `batch` events from `pending` into the archive entry.
    fn evict_oldest(env: &Env, pending: &mut Vec<TelemetryEvent>, batch: u32) {
        let n = core::cmp::min(batch, pending.len());
        let mut archive = Self::load(env, &ARCHIVE_KEY);
        let mut remaining = Vec::new(env);
        for i in 0..pending.len() {
            let ev = pending.get(i).unwrap();
            if i < n {
                archive.push_back(ev);
            } else {
                remaining.push_back(ev);
            }
        }
        Self::store(env, &ARCHIVE_KEY, &archive);
        *pending = remaining;
    }
}

// ---------------------------------------------------------------------------
// Pure-logic unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cap_keeps_buffer_within_entry_limit() {
        assert!(within_entry_limit(MAX_PENDING_EVENTS));
        // 64 KB at the cap, far under 512 KB.
        assert_eq!(buffer_bytes(MAX_PENDING_EVENTS), 64_000);
        // And well below the ~4096-event overflow point.
        assert!(MAX_PENDING_EVENTS < MAX_ENTRY_BYTES / EVENT_SIZE_BYTES);
    }

    #[test]
    fn full_and_evict_thresholds() {
        assert!(!is_full(MAX_PENDING_EVENTS - 1));
        assert!(is_full(MAX_PENDING_EVENTS));
        assert!(!should_evict(EVICTION_THRESHOLD));
        assert!(should_evict(EVICTION_THRESHOLD + 1));
    }

    #[test]
    fn stress_never_exceeds_entry_limit() {
        // 5000 submissions, oracle fails every 3rd flush.
        let max_len = simulate_max_len(5_000, 3);
        assert!(max_len <= MAX_PENDING_EVENTS);
        assert!(within_entry_limit(max_len));

        // Worst case: oracle always fails.
        let max_len_all_fail = simulate_max_len(5_000, 1);
        assert!(max_len_all_fail <= MAX_PENDING_EVENTS);
        assert!(within_entry_limit(max_len_all_fail));
    }
}
