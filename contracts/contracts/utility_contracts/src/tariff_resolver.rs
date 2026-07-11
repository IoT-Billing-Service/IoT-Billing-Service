//! Issue #14: Iterative, depth-bounded tariff chain resolution.
//!
//! ## The threat
//!
//! Tariff rules chain: a base rate triggers a surcharge rule which triggers a
//! discount rule, etc. The original resolver was **recursive** —
//! `compute_tariff` → `lookup_dependency` → `compute_tariff` → … — so a tariff
//! chain deeper than Soroban's host call-depth limit (10) panicked with
//! `DepthLimitExceeded`, reverting the whole invocation: the billing cycle
//! failed and no bill was produced. A misconfigured chain could also be
//! **cyclic**, recursing until the depth limit.
//!
//! ## The fix
//!
//! - Resolution is **iterative** (an explicit loop, not recursion), so host
//!   call depth is constant regardless of chain length.
//! - A `visited` set detects cycles → `TariffError::CycleDetected`.
//! - The chain length is capped at [`MAX_TARIFF_DEPTH`] (8 = host limit − 2);
//!   exceeding it returns `TariffError::DepthExceeded` **instead of panicking**,
//!   so the caller can fall back to a flat rate ([`effective_rate_or_flat`]).
//! - Configuration validates the resulting chain depth up front.
//!
//! The same iterative `resolve_chain` primitive generalizes to any
//! dependency-chain resolution (e.g. `oracle_flow::resolve_price_feed`, blueprint
//! step 4): pass a different lookup closure.
//!
//! Invariant: `tariff_chain_depth(id) <= MAX_TARIFF_DEPTH <= MAX_SOROBAN_DEPTH − 2`.

extern crate alloc;

use alloc::vec::Vec as StdVec;
use soroban_sdk::{contract, contracterror, contractimpl, contracttype, symbol_short, Env, Map};

/// Host-enforced Soroban maximum call depth.
pub const MAX_SOROBAN_DEPTH: u32 = 10;

/// Maximum tariff chain depth, kept two below the host limit for headroom.
pub const MAX_TARIFF_DEPTH: u32 = MAX_SOROBAN_DEPTH - 2; // 8

/// Basis-point scale (10_000 = 1.0×).
pub const BPS_SCALE: i128 = 10_000;

/// Errors from tariff resolution — returned, never panicked, so billing can
/// fall back gracefully.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum TariffError {
    /// Chain longer than `MAX_TARIFF_DEPTH`.
    DepthExceeded = 1,
    /// Chain contains a cycle.
    CycleDetected = 2,
    /// A referenced tariff id is not in the registry.
    NotFound = 3,
}

/// A node in a tariff chain: a multiplicative adjustment (in bps) and an
/// optional dependency that is applied next.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TariffNode {
    /// Multiplicative adjustment in basis points (11_000 = +10%, 9_500 = −5%).
    pub adjust_bps: i128,
    /// Next tariff in the chain, if any.
    pub dependency: Option<u64>,
}

// ---------------------------------------------------------------------------
// Pure, iterative resolution (unit-tested without an Env)
// ---------------------------------------------------------------------------

/// Apply a basis-point multiplier to a rate (saturating).
pub fn apply_bps(rate: i128, bps: i128) -> i128 {
    rate.saturating_mul(bps) / BPS_SCALE
}

/// Resolve a tariff chain **iteratively**, starting from `start_id` with
/// `base_rate`, applying each node's bps adjustment in order. Bounded by
/// `max_depth` and cycle-safe; returns an error instead of recursing/panicking.
///
/// Generic over a `lookup` closure so the same primitive serves storage-backed
/// resolution and price-feed chains alike.
pub fn resolve_chain<F>(
    start_id: u64,
    base_rate: i128,
    max_depth: u32,
    lookup: F,
) -> Result<i128, TariffError>
where
    F: Fn(u64) -> Option<TariffNode>,
{
    let mut visited: StdVec<u64> = StdVec::new();
    let mut current = Some(start_id);
    let mut rate = base_rate;

    while let Some(id) = current {
        if visited.len() as u32 >= max_depth {
            return Err(TariffError::DepthExceeded);
        }
        if visited.contains(&id) {
            return Err(TariffError::CycleDetected);
        }
        visited.push(id);

        let node = lookup(id).ok_or(TariffError::NotFound)?;
        rate = apply_bps(rate, node.adjust_bps);
        current = node.dependency;
    }

    Ok(rate)
}

/// Compute the depth of a chain (number of nodes), for configuration-time
/// validation. Errors on a chain that is too deep or cyclic.
pub fn chain_depth<F>(start_id: u64, max_depth: u32, lookup: F) -> Result<u32, TariffError>
where
    F: Fn(u64) -> Option<TariffNode>,
{
    let mut visited: StdVec<u64> = StdVec::new();
    let mut current = Some(start_id);

    while let Some(id) = current {
        if visited.len() as u32 >= max_depth {
            return Err(TariffError::DepthExceeded);
        }
        if visited.contains(&id) {
            return Err(TariffError::CycleDetected);
        }
        visited.push(id);
        let node = lookup(id).ok_or(TariffError::NotFound)?;
        current = node.dependency;
    }

    Ok(visited.len() as u32)
}

/// Resolve the effective rate, falling back to `flat_rate` on any resolution
/// error (depth/cycle/missing) — so a misconfigured chain never blocks billing.
pub fn effective_rate_or_flat<F>(
    start_id: u64,
    base_rate: i128,
    flat_rate: i128,
    max_depth: u32,
    lookup: F,
) -> i128
where
    F: Fn(u64) -> Option<TariffNode>,
{
    resolve_chain(start_id, base_rate, max_depth, lookup).unwrap_or(flat_rate)
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct TariffResolver;

#[contractimpl]
impl TariffResolver {
    /// Configure a tariff node. Validates that the resulting chain depth stays
    /// within `MAX_TARIFF_DEPTH` (and is acyclic) before storing — rejecting a
    /// chain that would later blow the call-depth limit.
    pub fn configure_tariff(
        env: Env,
        id: u64,
        adjust_bps: i128,
        dependency: Option<u64>,
    ) -> Result<(), TariffError> {
        let mut map = Self::load(&env);
        map.set(id, TariffNode { adjust_bps, dependency });

        // Validate depth from this node using the would-be registry.
        let snapshot = map.clone();
        chain_depth(id, MAX_TARIFF_DEPTH, |q| snapshot.get(q))?;

        Self::store(&env, &map);
        Ok(())
    }

    /// Compute the effective rate for `tariff_id` applied to `base_rate`,
    /// iteratively and depth-bounded. Returns an error (never panics) on a
    /// too-deep or cyclic chain.
    pub fn compute_tariff(
        env: Env,
        tariff_id: u64,
        base_rate: i128,
    ) -> Result<i128, TariffError> {
        let map = Self::load(&env);
        resolve_chain(tariff_id, base_rate, MAX_TARIFF_DEPTH, |q| map.get(q))
    }

    /// Compute the charge for `usage` at `tariff_id`, falling back to
    /// `flat_rate` if the chain cannot be resolved — so the billing cycle always
    /// produces a bill.
    pub fn compute_charge_or_flat(
        env: Env,
        usage: i128,
        tariff_id: u64,
        base_rate: i128,
        flat_rate: i128,
    ) -> i128 {
        let map = Self::load(&env);
        let rate = effective_rate_or_flat(tariff_id, base_rate, flat_rate, MAX_TARIFF_DEPTH, |q| {
            map.get(q)
        });
        usage.saturating_mul(rate)
    }
}

impl TariffResolver {
    fn load(env: &Env) -> Map<u64, TariffNode> {
        env.storage()
            .persistent()
            .get(&symbol_short!("tariffs"))
            .unwrap_or_else(|| Map::new(env))
    }

    fn store(env: &Env, map: &Map<u64, TariffNode>) {
        env.storage()
            .persistent()
            .set(&symbol_short!("tariffs"), map);
    }
}

// ---------------------------------------------------------------------------
// Pure-logic unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    extern crate std;
    use std::vec::Vec;

    // Array-backed registry: index == id, None means absent.
    fn lookup_from(nodes: &Vec<Option<TariffNode>>) -> impl Fn(u64) -> Option<TariffNode> + '_ {
        move |id: u64| nodes.get(id as usize).and_then(|n| n.clone())
    }

    fn node(adjust_bps: i128, dependency: Option<u64>) -> Option<TariffNode> {
        Some(TariffNode { adjust_bps, dependency })
    }

    #[test]
    fn resolves_a_simple_chain() {
        // 0: +10% -> 1: -5% -> 2: ×1.0 (end)
        let nodes = std::vec![
            node(11_000, Some(1)),
            node(9_500, Some(2)),
            node(10_000, None),
        ];
        // base 1000 → 1100 → 1045 → 1045
        let r = resolve_chain(0, 1_000, MAX_TARIFF_DEPTH, lookup_from(&nodes)).unwrap();
        assert_eq!(r, 1_045);
    }

    #[test]
    fn depth_twelve_chain_is_rejected_not_panicked() {
        // Linear chain 0->1->...->11->None (12 nodes), exceeds MAX_TARIFF_DEPTH (8).
        let mut nodes: Vec<Option<TariffNode>> = Vec::new();
        for i in 0..12u64 {
            let dep = if i < 11 { Some(i + 1) } else { None };
            nodes.push(node(10_000, dep));
        }
        assert_eq!(
            resolve_chain(0, 1_000, MAX_TARIFF_DEPTH, lookup_from(&nodes)),
            Err(TariffError::DepthExceeded)
        );
    }

    #[test]
    fn cycle_is_detected() {
        // 0 -> 1 -> 0 ...
        let nodes = std::vec![node(11_000, Some(1)), node(9_000, Some(0))];
        assert_eq!(
            resolve_chain(0, 1_000, MAX_TARIFF_DEPTH, lookup_from(&nodes)),
            Err(TariffError::CycleDetected)
        );
    }

    #[test]
    fn missing_dependency_errors() {
        let nodes = std::vec![node(11_000, Some(9))]; // 9 absent
        assert_eq!(
            resolve_chain(0, 1_000, MAX_TARIFF_DEPTH, lookup_from(&nodes)),
            Err(TariffError::NotFound)
        );
    }

    #[test]
    fn fallback_to_flat_on_error() {
        let nodes = std::vec![node(11_000, Some(0))]; // self-cycle
        let r = effective_rate_or_flat(0, 1_000, 777, MAX_TARIFF_DEPTH, lookup_from(&nodes));
        assert_eq!(r, 777);
    }

    #[test]
    fn chain_depth_counts_nodes() {
        let nodes = std::vec![node(1, Some(1)), node(1, Some(2)), node(1, None)];
        assert_eq!(chain_depth(0, MAX_TARIFF_DEPTH, lookup_from(&nodes)), Ok(3));
    }
}
