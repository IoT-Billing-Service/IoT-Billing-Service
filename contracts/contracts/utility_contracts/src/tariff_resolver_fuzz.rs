#![cfg(test)]

//! Issue #14: fuzz the iterative tariff resolver over random DAGs/graphs and
//! assert it always terminates with a result — never a `DepthLimitExceeded`
//! panic or an unbounded loop.

extern crate std;

use crate::tariff_resolver::{
    chain_depth, resolve_chain, TariffError, TariffNode, MAX_TARIFF_DEPTH,
};
use proptest::prelude::*;
use std::vec::Vec;

/// Build an array-backed lookup. Each entry is `(adjust_bps, dependency)`;
/// `dependency` may point anywhere (including backwards → cycles).
fn make_lookup(graph: &Vec<(i128, Option<u64>)>) -> impl Fn(u64) -> Option<TariffNode> + '_ {
    move |id: u64| {
        graph
            .get(id as usize)
            .map(|&(adjust_bps, dependency)| TariffNode { adjust_bps, dependency })
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2_000))]

    /// Blueprint step 5: random graphs of up to 20 nodes, each with an arbitrary
    /// dependency edge (so cycles and deep chains occur). Resolution from every
    /// node must always terminate with `Ok` or a graceful `TariffError` — never
    /// panic, never loop forever.
    #[test]
    fn prop_random_graphs_never_panic(
        graph in proptest::collection::vec(
            (
                1_000i128..20_000i128,
                proptest::option::of(0u64..20u64),
            ),
            1..=20usize,
        ),
    ) {
        let n = graph.len() as u64;
        let lookup = make_lookup(&graph);

        for start in 0..n {
            let result = resolve_chain(start, 1_000, MAX_TARIFF_DEPTH, &lookup);
            match result {
                Ok(rate) => {
                    // A resolved chain visited at most MAX_TARIFF_DEPTH nodes.
                    prop_assert!(rate >= 0);
                    // Depth computation agrees that the chain was within bounds.
                    prop_assert!(chain_depth(start, MAX_TARIFF_DEPTH, &lookup).is_ok());
                }
                Err(TariffError::DepthExceeded)
                | Err(TariffError::CycleDetected)
                | Err(TariffError::NotFound) => {
                    // Graceful, expected failure modes.
                }
            }
        }
    }

    /// The resolver never visits more than `MAX_TARIFF_DEPTH` nodes: on success
    /// the chain depth is within the cap.
    #[test]
    fn prop_success_implies_within_depth(
        graph in proptest::collection::vec(
            (1_000i128..20_000i128, proptest::option::of(0u64..20u64)),
            1..=20usize,
        ),
    ) {
        let n = graph.len() as u64;
        let lookup = make_lookup(&graph);
        for start in 0..n {
            if let Ok(depth) = chain_depth(start, MAX_TARIFF_DEPTH, &lookup) {
                prop_assert!(depth <= MAX_TARIFF_DEPTH);
            }
        }
    }
}

/// Deterministic worst case from the issue: a 12-deep chain returns
/// `DepthExceeded`, not a panic.
#[test]
fn depth_twelve_chain_is_graceful() {
    let mut graph: Vec<(i128, Option<u64>)> = Vec::new();
    for i in 0..12u64 {
        graph.push((10_000, if i < 11 { Some(i + 1) } else { None }));
    }
    let lookup = make_lookup(&graph);
    assert_eq!(
        resolve_chain(0, 1_000, MAX_TARIFF_DEPTH, &lookup),
        Err(TariffError::DepthExceeded)
    );
}
