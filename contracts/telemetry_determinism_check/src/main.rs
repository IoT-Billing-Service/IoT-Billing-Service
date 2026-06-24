//! Issue #19: standalone guard for the billing-ordering invariant
//! `billing(E) = billing(π(E))`.
//!
//! This binary `include!`s the exact pure billing functions used by the
//! `telemetry_billing` contract module (single source of truth) and verifies
//! the invariant:
//!   * **exhaustively** for all 8! = 40,320 permutations of a worst-case
//!     dataset that straddles the tier boundary, and
//!   * for **randomized** larger datasets seeded by `PROPTEST_SEED`, so CI
//!     shakes out latent order-sensitivity across runs.
//!
//! It lives outside the `utility_contracts` crate on purpose: that crate has
//! pre-existing, repo-wide build breakage, so a `cargo test` against it cannot
//! run in CI. The billing math is shared verbatim via `include!`, so there is
//! no logic drift.

include!("../../utility_contracts/src/telemetry_billing_core.rs");

use std::process;

/// Lexicographic next-permutation over indices; false at the last permutation.
fn next_permutation(a: &mut [usize]) -> bool {
    if a.len() < 2 {
        return false;
    }
    let mut i = a.len() - 1;
    while i > 0 && a[i - 1] >= a[i] {
        i -= 1;
    }
    if i == 0 {
        return false;
    }
    let mut j = a.len() - 1;
    while a[j] <= a[i - 1] {
        j -= 1;
    }
    a.swap(i - 1, j);
    a[i..].reverse();
    true
}

/// Tiny deterministic PRNG (SplitMix64-ish) so a given seed is reproducible.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^ (z >> 31)
    }
    fn range(&mut self, lo: i128, hi: i128) -> i128 {
        lo + (self.next() % ((hi - lo + 1) as u64)) as i128
    }
    fn shuffle(&mut self, v: &mut [i128]) {
        for i in (1..v.len()).rev() {
            let j = (self.next() % (i as u64 + 1)) as usize;
            v.swap(i, j);
        }
    }
}

fn fail(msg: &str) -> ! {
    eprintln!("DETERMINISM CHECK FAILED: {msg}");
    process::exit(1);
}

fn main() {
    let (t1, t2) = (1i128, 3i128);

    // --- Exhaustive 8! sweep over a tier-straddling dataset ---------------
    let units: [i128; 8] = [300, 1200, 50, 800, 1500, 10, 999, 400];
    let expected = billing_cycle_rollup_units(&units, t1, t2);
    let mut idx: [usize; 8] = [0, 1, 2, 3, 4, 5, 6, 7];
    let mut perms = 0u64;
    loop {
        let permuted: Vec<i128> = idx.iter().map(|&i| units[i]).collect();
        if billing_cycle_rollup_units(&permuted, t1, t2) != expected {
            fail(&format!("permutation {idx:?} produced a different bill"));
        }
        perms += 1;
        if !next_permutation(&mut idx) {
            break;
        }
    }
    if perms != 40_320 {
        fail(&format!("expected 40320 permutations, visited {perms}"));
    }

    // Sanity: the invariance proven above is non-vacuous — the buggy legacy
    // model genuinely varies with order on this dataset.
    let asc: Vec<i128> = {
        let mut v = units.to_vec();
        v.sort();
        v
    };
    let desc: Vec<i128> = {
        let mut v = asc.clone();
        v.reverse();
        v
    };
    if naive_sequential_charge(&asc, t1, t2) == naive_sequential_charge(&desc, t1, t2) {
        fail("naive model did not vary with order — dataset is not a real test");
    }

    // --- Randomized larger-N invariance (seeded by PROPTEST_SEED) ---------
    let seed: u64 = std::env::var("PROPTEST_SEED")
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0xC0FFEE);
    let mut rng = Rng(seed ^ 0xD1CE_5EED_1234_5678);

    let mut cases = 0u64;
    for _ in 0..2_000 {
        let n = (rng.next() % 64 + 1) as usize; // 1..=64 events
        let base: Vec<i128> = (0..n).map(|_| rng.range(0, 2_500)).collect();
        let baseline = billing_cycle_rollup_units(&base, t1, t2);
        // A few random shuffles must all agree with the baseline.
        for _ in 0..8 {
            let mut shuffled = base.clone();
            rng.shuffle(&mut shuffled);
            if billing_cycle_rollup_units(&shuffled, t1, t2) != baseline {
                fail(&format!("randomized case (seed {seed}) was order-sensitive"));
            }
            cases += 1;
        }
    }

    println!(
        "OK: billing(E) == billing(pi(E)) for all 8! = {perms} permutations \
         and {cases} randomized shuffles (seed {seed})."
    );
}
