#![cfg(test)]

extern crate std;

use crate::reentrancy_guard::{validate_entry, GuardEntryError};
use std::vec::Vec as StdVec;

#[derive(Clone, Copy)]
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn range(&mut self, lo: u32, hi: u32) -> u32 {
        lo + (self.next() % u64::from(hi - lo + 1)) as u32
    }
}

#[test]
fn fuzz_cross_contract_call_graphs_reject_nested_guarded_frames() {
    for seed in 0..512u64 {
        let mut rng = Rng(seed ^ 0xC0DE_5AFE);
        let node_count = rng.range(3, 8);
        let max_steps = rng.range(3, 10);
        let mut active_stack: StdVec<u32> = StdVec::new();
        let mut active_depth = 0u32;

        for step in 0..max_steps {
            let function_id = rng.range(0, node_count - 1);
            let already_active = active_stack.contains(&function_id);

            let decision = validate_entry(active_depth, active_stack.len() as u32, already_active);
            if step == 0 {
                assert_eq!(decision, Ok(1), "seed {seed}: first frame must enter");
                active_depth = 1;
                active_stack.push(function_id);
                continue;
            }

            assert_eq!(
                decision,
                Err(GuardEntryError::ReentrantFrame),
                "seed {seed}: nested call to function {function_id} was admitted"
            );

            assert_eq!(
                active_depth, 1,
                "seed {seed}: depth changed after rejection"
            );
            assert_eq!(
                active_stack.len(),
                1,
                "seed {seed}: stack changed after rejection"
            );
        }
    }
}

#[test]
fn fuzz_call_stack_depth_cap_rejects_host_limit_overflow() {
    for len in 10..64u32 {
        assert_eq!(
            validate_entry(0, len, false),
            Err(GuardEntryError::CallDepthExceeded)
        );
    }
}
