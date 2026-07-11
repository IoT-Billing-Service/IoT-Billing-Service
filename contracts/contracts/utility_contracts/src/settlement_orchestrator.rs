use soroban_sdk::{
    contract, contractimpl, contracttype, panic_with_error, symbol_short, Address, Env, Map, Symbol,
    Vec,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum StepStatus {
    Pending,
    Committed,
    RolledBack,
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum SettlementStep {
    AssetDebit,
    InsuranceCredit,
    StreamFinalize,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SettlementJournalEntry {
    pub tx_id: u64,
    pub asset_contract: Address,
    pub insurance_contract: Address,
    pub stream_contract: Address,
    pub asset_debit_status: StepStatus,
    pub insurance_credit_status: StepStatus,
    pub stream_finalize_status: StepStatus,
    pub created_at: u64,
    pub timeout_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SettlementSummary {
    pub total: u64,
    pub pending: u64,
    pub fully_committed: u64,
    pub any_rolled_back: u64,
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

pub const SETTLEMENT_TIMEOUT_SECONDS: u64 = 3600;
pub const RECOVERY_SCAN_LIMIT: u64 = 50;

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct SettlementManager;

#[contractimpl]
impl SettlementManager {
    /// Create a new settlement journal entry with all steps Pending.
    pub fn init_settlement(
        env: Env,
        tx_id: u64,
        asset_contract: Address,
        insurance_contract: Address,
        stream_contract: Address,
    ) -> u64 {
        if env.storage().persistent().has(&symbol_short!("stlm")) {
            let existing: Map<u64, SettlementJournalEntry> = env
                .storage()
                .persistent()
                .get(&symbol_short!("stlm"))
                .unwrap();
            if existing.get(tx_id).is_some() {
                panic_with_error!(&env, ContractError::SettlementTxIdCollision);
            }
        }

        let now = env.ledger().timestamp();
        let entry = SettlementJournalEntry {
            tx_id,
            asset_contract,
            insurance_contract,
            stream_contract,
            asset_debit_status: StepStatus::Pending,
            insurance_credit_status: StepStatus::Pending,
            stream_finalize_status: StepStatus::Pending,
            created_at: now,
            timeout_at: now.saturating_add(SETTLEMENT_TIMEOUT_SECONDS),
        };

        let mut journal: Map<u64, SettlementJournalEntry> = env
            .storage()
            .persistent()
            .get(&symbol_short!("stlm"))
            .unwrap_or_else(|| Map::new(&env));
        journal.set(tx_id, entry);
        env.storage()
            .persistent()
            .set(&symbol_short!("stlm"), &journal);

        env.events()
            .publish((symbol_short!("SInit"),), (tx_id, now));
        tx_id
    }

    /// Execute the full three-step settlement with journaled rollback.
    /// Steps: asset debit → insurance credit → stream finalize.
    /// Returns true if all three steps committed.
    pub fn execute_settlement(
        env: Env,
        tx_id: u64,
        debit_args: Vec<Val>,
        credit_args: Vec<Val>,
        finalize_args: Vec<Val>,
    ) -> bool {
        let journal: Map<u64, SettlementJournalEntry> = env
            .storage()
            .persistent()
            .get(&symbol_short!("stlm"))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::SettlementNotFound));
        let mut entry = journal
            .get(tx_id)
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::SettlementNotFound));

        // Step 1: Asset Debit
        let debit_ok = Self::try_step(
            &env,
            &mut entry,
            tx_id,
            SettlementStep::AssetDebit,
            &entry.asset_contract,
            "debit",
            debit_args.clone(),
        );
        if !debit_ok {
            return false;
        }

        // Step 2: Insurance Credit
        let credit_ok = Self::try_step(
            &env,
            &mut entry,
            tx_id,
            SettlementStep::InsuranceCredit,
            &entry.insurance_contract,
            "credit",
            credit_args.clone(),
        );
        if !credit_ok {
            Self::rollback_one_step(&env, &mut entry, tx_id, SettlementStep::AssetDebit, &entry.asset_contract, debit_args.clone());
            return false;
        }

        // Step 3: Stream Finalize
        let finalize_ok = Self::try_step(
            &env,
            &mut entry,
            tx_id,
            SettlementStep::StreamFinalize,
            &entry.stream_contract,
            "finalize",
            finalize_args.clone(),
        );
        if !finalize_ok {
            Self::rollback_one_step(&env, &mut entry, tx_id, SettlementStep::InsuranceCredit, &entry.insurance_contract, credit_args.clone());
            Self::rollback_one_step(&env, &mut entry, tx_id, SettlementStep::AssetDebit, &entry.asset_contract, debit_args.clone());
            return false;
        }

        true
    }

    /// Manually commit a specific step (for recovery).
    pub fn commit_step(env: Env, tx_id: u64, step: SettlementStep) {
        let journal: Map<u64, SettlementJournalEntry> = env
            .storage()
            .persistent()
            .get(&symbol_short!("stlm"))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::SettlementNotFound));
        let mut entry = journal
            .get(tx_id)
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::SettlementNotFound));

        Self::set_step_status(&mut entry, step, StepStatus::Committed);
        Self::persist_step(&env, tx_id, &entry);

        env.events()
            .publish((symbol_short!("SCommit"),), (tx_id, step as u32));
    }

    /// Manually roll back a specific step (for recovery).
    pub fn rollback_step(env: Env, tx_id: u64, step: SettlementStep) {
        let journal: Map<u64, SettlementJournalEntry> = env
            .storage()
            .persistent()
            .get(&symbol_short!("stlm"))
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::SettlementNotFound));
        let mut entry = journal
            .get(tx_id)
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::SettlementNotFound));

        Self::set_step_status(&mut entry, step, StepStatus::RolledBack);
        Self::persist_step(&env, tx_id, &entry);

        env.events()
            .publish((symbol_short!("SRollBk"),), (tx_id, step as u32));
    }

    /// Scan for timed-out Pending entries and attempt recovery.
    /// Returns (recovered, rolled_back).
    pub fn recovery_orchestrator(env: Env) -> (u64, u64) {
        let now = env.ledger().timestamp();
        let journal: Map<u64, SettlementJournalEntry> = env
            .storage()
            .persistent()
            .get(&symbol_short!("stlm"))
            .unwrap_or_else(|| Map::new(&env));

        let mut recovered: u64 = 0;
        let mut rolled_back: u64 = 0;
        let mut scanned: u64 = 0;

        for (tx_id, entry) in journal.iter() {
            if scanned >= RECOVERY_SCAN_LIMIT {
                break;
            }
            scanned += 1;

            if entry.timeout_at > now || all_committed(&entry) || any_rolled_back(&entry) {
                continue;
            }

            // If debit + credit committed, attempt finalize recovery
            if entry.asset_debit_status == StepStatus::Committed
                && entry.insurance_credit_status == StepStatus::Committed
            {
                let func = Symbol::new(&env, "finalize");
                let result = env.try_invoke_contract::<(), _>(
                    &entry.stream_contract,
                    &func,
                    Vec::new(&env),
                );
                if result.is_ok() {
                    Self::set_step_status(
                        &mut entry.clone(),
                        SettlementStep::StreamFinalize,
                        StepStatus::Committed,
                    );
                    Self::persist_step(&env, tx_id, &entry.clone());
                    recovered += 1;
                    continue;
                }
            }

            // Roll back any committed steps
            Self::rollback_committed_steps(&env, &mut entry.clone(), tx_id);
            rolled_back += 1;

            env.events().publish(
                (symbol_short!("SRecov"),),
                (tx_id, recovered, rolled_back),
            );
        }

        (recovered, rolled_back)
    }

    /// Read the settlement journal entry for a tx_id.
    pub fn get_settlement(env: Env, tx_id: u64) -> Option<SettlementJournalEntry> {
        let journal: Map<u64, SettlementJournalEntry> = env
            .storage()
            .persistent()
            .get(&symbol_short!("stlm"))
            .unwrap_or_else(|| Map::new(&env));
        journal.get(tx_id)
    }

    /// Summary counts across the journal.
    pub fn settlement_summary(env: Env) -> SettlementSummary {
        let journal: Map<u64, SettlementJournalEntry> = env
            .storage()
            .persistent()
            .get(&symbol_short!("stlm"))
            .unwrap_or_else(|| Map::new(&env));

        let total = journal.len() as u64;
        let mut pending: u64 = 0;
        let mut fully_committed: u64 = 0;
        let mut any_rolled_back: u64 = 0;

        for (_tx_id, entry) in journal.iter() {
            if all_committed(&entry) {
                fully_committed += 1;
            } else if any_rolled_back(&entry) {
                any_rolled_back += 1;
            } else {
                pending += 1;
            }
        }

        SettlementSummary {
            total,
            pending,
            fully_committed,
            any_rolled_back,
        }
    }
}

// ---------------------------------------------------------------------------
// Internal helpers (private)
// ---------------------------------------------------------------------------

impl SettlementManager {
    /// Execute one settlement step. Returns true on success, false on failure.
    fn try_step(
        env: &Env,
        entry: &mut SettlementJournalEntry,
        tx_id: u64,
        step: SettlementStep,
        contract: &Address,
        func_name: &str,
        args: Vec<Val>,
    ) -> bool {
        let func = Symbol::new(env, func_name);
        let result = env.try_invoke_contract::<(), _>(contract, &func, args);

        match result {
            Ok(_) => {
                Self::set_step_status(entry, step, StepStatus::Committed);
                Self::persist_step(env, tx_id, entry);
                env.events()
                    .publish((symbol_short!("SCommit"),), (tx_id, step as u32));
                true
            }
            Err(_) => {
                Self::set_step_status(entry, step, StepStatus::RolledBack);
                Self::persist_step(env, tx_id, entry);
                env.events()
                    .publish((symbol_short!("SFail"),), (tx_id, step as u32));
                false
            }
        }
    }

    /// Roll back one previously committed step (used during sequential rollback).
    fn rollback_one_step(
        env: &Env,
        entry: &mut SettlementJournalEntry,
        tx_id: u64,
        step: SettlementStep,
        contract: &Address,
        args: Vec<Val>,
    ) {
        let rollback_name = match step {
            SettlementStep::AssetDebit => "rollback_debit",
            SettlementStep::InsuranceCredit => "rollback_credit",
            SettlementStep::StreamFinalize => "rollback_finalize",
        };
        let func = Symbol::new(env, rollback_name);
        let _ = env.try_invoke_contract::<(), _>(contract, &func, args);
        Self::set_step_status(entry, step, StepStatus::RolledBack);
        Self::persist_step(env, tx_id, entry);
        env.events()
            .publish((symbol_short!("SRollBk"),), (tx_id, step as u32));
    }

    /// Roll back all committed steps in an entry (used by recovery).
    fn rollback_committed_steps(env: &Env, entry: &mut SettlementJournalEntry, tx_id: u64) {
        let rollback_plan = [
            (
                SettlementStep::StreamFinalize,
                &entry.stream_finalize_status,
                &entry.stream_contract,
                "rollback_finalize",
            ),
            (
                SettlementStep::InsuranceCredit,
                &entry.insurance_credit_status,
                &entry.insurance_contract,
                "rollback_credit",
            ),
            (
                SettlementStep::AssetDebit,
                &entry.asset_debit_status,
                &entry.asset_contract,
                "rollback_debit",
            ),
        ];

        for (step, status, contract_addr, func_name) in &rollback_plan {
            if *status != StepStatus::Committed {
                continue;
            }
            let func = Symbol::new(env, func_name);
            let _ = env.try_invoke_contract::<(), _>(contract_addr, &func, Vec::new(env));
            Self::set_step_status(entry, *step, StepStatus::RolledBack);
        }
        Self::persist_step(env, tx_id, entry);
    }

    fn set_step_status(
        entry: &mut SettlementJournalEntry,
        step: SettlementStep,
        status: StepStatus,
    ) {
        match step {
            SettlementStep::AssetDebit => entry.asset_debit_status = status,
            SettlementStep::InsuranceCredit => entry.insurance_credit_status = status,
            SettlementStep::StreamFinalize => entry.stream_finalize_status = status,
        }
    }

    fn persist_step(env: &Env, tx_id: u64, entry: &SettlementJournalEntry) {
        let mut journal: Map<u64, SettlementJournalEntry> = env
            .storage()
            .persistent()
            .get(&symbol_short!("stlm"))
            .unwrap_or_else(|| Map::new(env));
        journal.set(tx_id, entry.clone());
        env.storage()
            .persistent()
            .set(&symbol_short!("stlm"), &journal);
    }
}

// ---------------------------------------------------------------------------
// Free helpers
// ---------------------------------------------------------------------------

fn all_committed(entry: &SettlementJournalEntry) -> bool {
    entry.asset_debit_status == StepStatus::Committed
        && entry.insurance_credit_status == StepStatus::Committed
        && entry.stream_finalize_status == StepStatus::Committed
}

fn any_rolled_back(entry: &SettlementJournalEntry) -> bool {
    entry.asset_debit_status == StepStatus::RolledBack
        || entry.insurance_credit_status == StepStatus::RolledBack
        || entry.stream_finalize_status == StepStatus::RolledBack
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ContractError {
    SettlementNotFound = 1,
    SettlementTxIdCollision = 2,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::vec;

    fn make_env() -> Env {
        let env = Env::default();
        env.mock_all_auths();
        env
    }

    fn register_manager(env: &Env) -> SettlementManagerClient {
        let contract_id = env.register_contract(None, SettlementManager);
        SettlementManagerClient::new(env, &contract_id)
    }

    #[test]
    fn init_and_retrieve_settlement() {
        let env = make_env();
        let client = register_manager(&env);

        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let c = Address::generate(&env);

        let tx = client.init_settlement(&1u64, &a, &b, &c);
        assert_eq!(tx, 1u64);

        let entry = client.get_settlement(&1u64).unwrap();
        assert_eq!(entry.tx_id, 1);
        assert_eq!(entry.asset_debit_status, StepStatus::Pending);
        assert_eq!(entry.insurance_credit_status, StepStatus::Pending);
        assert_eq!(entry.stream_finalize_status, StepStatus::Pending);
    }

    #[test]
    fn commit_and_rollback_steps() {
        let env = make_env();
        let client = register_manager(&env);

        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let c = Address::generate(&env);

        client.init_settlement(&1u64, &a, &b, &c);
        client.commit_step(&1u64, &SettlementStep::AssetDebit);
        client.commit_step(&1u64, &SettlementStep::InsuranceCredit);
        client.rollback_step(&1u64, &SettlementStep::StreamFinalize);

        let entry = client.get_settlement(&1u64).unwrap();
        assert_eq!(entry.asset_debit_status, StepStatus::Committed);
        assert_eq!(entry.insurance_credit_status, StepStatus::Committed);
        assert_eq!(entry.stream_finalize_status, StepStatus::RolledBack);
    }

    #[test]
    fn settlement_summary_counts() {
        let env = make_env();
        let client = register_manager(&env);

        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let c = Address::generate(&env);

        client.init_settlement(&1u64, &a, &b, &c);
        client.init_settlement(&2u64, &a, &b, &c);
        client.init_settlement(&3u64, &a, &b, &c);

        client.commit_step(&1u64, &SettlementStep::AssetDebit);
        client.commit_step(&1u64, &SettlementStep::InsuranceCredit);
        client.commit_step(&1u64, &SettlementStep::StreamFinalize);

        client.rollback_step(&2u64, &SettlementStep::AssetDebit);

        let s = client.settlement_summary();
        assert_eq!(s.total, 3);
        assert_eq!(s.fully_committed, 1);
        assert_eq!(s.any_rolled_back, 1);
        assert_eq!(s.pending, 1);
    }

    #[test]
    fn execute_settlement_with_failure_rolls_back() {
        let env = make_env();
        let client = register_manager(&env);

        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let c = Address::generate(&env);

        client.init_settlement(&1u64, &a, &b, &c);

        let empty_args = vec![&env];

        let result = client.execute_settlement(&1u64, &empty_args, &empty_args, &empty_args);
        assert!(!result);

        let entry = client.get_settlement(&1u64).unwrap();
        assert_eq!(entry.asset_debit_status, StepStatus::RolledBack);
    }

    #[test]
    fn recovery_orchestrator_skips_recent_entries() {
        let env = make_env();
        let client = register_manager(&env);

        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let c = Address::generate(&env);

        client.init_settlement(&1u64, &a, &b, &c);

        let (recovered, rolled_back) = client.recovery_orchestrator();
        assert_eq!(recovered, 0);
        assert_eq!(rolled_back, 0);
    }
}
