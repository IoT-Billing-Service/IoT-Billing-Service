//! Deterministic gas-budget accounting for nested cross-contract calls.
//!
//! Soroban does not expose a per-call budget limiter through the call path used
//! by `secure_call_interface.rs` in this repository. This module therefore
//! enforces the contract's own preflight allowance before a nested oracle call
//! is attempted, and exposes pure helpers for batch splitting decisions.

/// Modeled Soroban host CPU budget per top-level invocation.
pub const HOST_FUNCTION_BUDGET: u64 = 10_000_000;

/// Measured upper bound for one oracle proof/verification call.
pub const ORACLE_MAX_COST: u64 = 850_000;

/// Stop starting nested calls below this remaining budget.
pub const EMERGENCY_THRESHOLD: u64 = 500_000;

/// Errors returned by deterministic budget accounting.
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum GasBudgetError {
    /// The requested reserve would consume the emergency remainder.
    InsufficientBudget,
}

/// Minimal remaining-budget model for one top-level invocation.
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub struct GasBudget {
    remaining: u64,
}

impl GasBudget {
    /// Build a budget from the configured call allowance, capped to the modeled
    /// host budget so contract configuration cannot exceed the top-level limit.
    pub const fn new(allowance: u64) -> Self {
        Self {
            remaining: if allowance > HOST_FUNCTION_BUDGET {
                HOST_FUNCTION_BUDGET
            } else {
                allowance
            },
        }
    }

    /// Return the currently modeled remaining budget.
    pub const fn remaining(&self) -> u64 {
        self.remaining
    }

    /// Reserve a fixed amount while preserving the emergency threshold.
    pub fn reserve(&mut self, amount: u64) -> Result<(), GasBudgetError> {
        let Some(after_reserve) = self.remaining.checked_sub(amount) else {
            return Err(GasBudgetError::InsufficientBudget);
        };

        if after_reserve < EMERGENCY_THRESHOLD {
            return Err(GasBudgetError::InsufficientBudget);
        }

        self.remaining = after_reserve;
        Ok(())
    }

    /// Return the measured upper-bound budget required before starting one
    /// oracle verification call.
    pub fn next_oracle_reserve(&self) -> u64 {
        ORACLE_MAX_COST
    }

    /// Reserve budget for one nested oracle/cross-contract verification call.
    pub fn reserve_oracle_call(&mut self) -> Result<u64, GasBudgetError> {
        let reserve = self.next_oracle_reserve();
        self.reserve(reserve)?;
        Ok(reserve)
    }
}

/// Summary of how many top-level invocations are needed to process nested
/// oracle calls without crossing the emergency threshold.
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub struct OracleBatchPlan {
    pub requested_calls: u32,
    pub completed_calls: u32,
    pub batches: u32,
    pub max_calls_per_batch: u32,
    pub min_remaining_budget: u64,
}

/// Model chunking a run of oracle calls into multiple top-level invocations.
///
/// The loop is linear in `requested_calls`, which is acceptable for the
/// bounded planning path and keeps the reserve semantics identical to runtime.
pub fn plan_oracle_batches(
    requested_calls: u32,
    per_invocation_budget: u64,
) -> Result<OracleBatchPlan, GasBudgetError> {
    if requested_calls == 0 {
        return Ok(OracleBatchPlan {
            requested_calls,
            completed_calls: 0,
            batches: 0,
            max_calls_per_batch: 0,
            min_remaining_budget: core::cmp::min(per_invocation_budget, HOST_FUNCTION_BUDGET),
        });
    }

    let mut completed_calls = 0;
    let mut batches = 0;
    let mut max_calls_per_batch = 0;
    let mut min_remaining_budget = HOST_FUNCTION_BUDGET;

    while completed_calls < requested_calls {
        batches += 1;
        let mut calls_in_batch = 0;
        let mut budget = GasBudget::new(per_invocation_budget);

        while completed_calls < requested_calls && budget.reserve_oracle_call().is_ok() {
            completed_calls += 1;
            calls_in_batch += 1;
        }

        if calls_in_batch == 0 {
            return Err(GasBudgetError::InsufficientBudget);
        }

        max_calls_per_batch = core::cmp::max(max_calls_per_batch, calls_in_batch);
        min_remaining_budget = core::cmp::min(min_remaining_budget, budget.remaining());
    }

    Ok(OracleBatchPlan {
        requested_calls,
        completed_calls,
        batches,
        max_calls_per_batch,
        min_remaining_budget,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oracle_reserve_uses_measured_max_cost() {
        let budget = GasBudget::new(HOST_FUNCTION_BUDGET);
        assert_eq!(budget.next_oracle_reserve(), ORACLE_MAX_COST);
    }

    #[test]
    fn low_remaining_budget_rejects_measured_max_cost() {
        let mut budget = GasBudget::new(1_000_000);
        assert_eq!(
            budget.reserve_oracle_call(),
            Err(GasBudgetError::InsufficientBudget)
        );
        assert_eq!(budget.remaining(), 1_000_000);
    }

    #[test]
    fn reserve_preserves_emergency_threshold() {
        let mut budget = GasBudget::new(600_000);
        assert_eq!(
            budget.reserve_oracle_call(),
            Err(GasBudgetError::InsufficientBudget)
        );
        assert_eq!(budget.remaining(), 600_000);
    }

    #[test]
    fn one_hundred_oracle_calls_are_split_across_safe_batches() {
        let plan = plan_oracle_batches(100, HOST_FUNCTION_BUDGET).unwrap();
        assert_eq!(plan.completed_calls, 100);
        assert!(plan.batches > 1);
        assert_eq!(plan.max_calls_per_batch, 11);
        assert!(plan.min_remaining_budget >= EMERGENCY_THRESHOLD);
    }

    #[test]
    fn twelfth_call_in_one_budget_is_rejected() {
        let mut budget = GasBudget::new(HOST_FUNCTION_BUDGET);
        for _ in 0..11 {
            budget.reserve_oracle_call().unwrap();
        }

        assert_eq!(budget.remaining(), 650_000);
        assert_eq!(
            budget.reserve_oracle_call(),
            Err(GasBudgetError::InsufficientBudget)
        );
    }
}
