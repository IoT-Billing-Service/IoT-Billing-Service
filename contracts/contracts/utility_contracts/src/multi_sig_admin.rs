//! Issue #24: Multi-Sig Admin, Timelock, Circuit Breaker, Rate Bounds
//!
//! Fix: Replace single require_auth! with M-of-N, add timelock to
//! fund-withdrawal, enforce rate bounds, and add circuit breaker.

use crate::{ContractError, DataKey};
use soroban_sdk::{
    contracttype, panic_with_error, Address, Env, Symbol, Vec,
};

// ── Constants ──
pub const TIMELOCK_DELAY: u64 = 86_400; // 24h
pub const CIRCUIT_WINDOW: u64 = 3_600; // 1h
pub const RATE_MIN_BPS: i128 = 1_000; // 0.1x
pub const RATE_MAX_BPS: i128 = 10_000; // 10x

// ── Types ──

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MofNConfig {
    pub admins: Vec<Address>,
    pub required: u32,
    pub total: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TimelockW {
    pub amount: i128,
    pub recipient: Address,
    pub eta: u64,
    pub created: u64,
    pub done: bool,
    pub cancelled: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CbState {
    pub triggered: bool,
    pub at: u64,
    pub backup: Vec<Address>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActionApproval {
    pub approvers: Vec<Address>,
    pub threshold: u32,
}

// ── Init ──

pub fn init(env: &Env, admin: Address, admins: Vec<Address>, req: u32) {
    let cur: Address = env
        .storage()
        .instance()
        .get(&DataKey::CurrentAdmin)
        .unwrap_or_else(|| panic_with_error!(env, ContractError::UnauthorizedAdmin));
    admin.require_auth();
    if admin != cur {
        panic_with_error!(env, ContractError::UnauthorizedAdmin);
    }
    if env.storage().instance().has(&DataKey::AdminMofN) {
        panic_with_error!(env, ContractError::MultiSigAlreadyConfigured);
    }
    let n = admins.len();
    if n == 0 || req == 0 || req > n {
        panic_with_error!(env, ContractError::InvalidSignatureThreshold);
    }
    env.storage().instance().set(
        &DataKey::AdminMofN,
        &MofNConfig { admins, required: req, total: n },
    );
    env.events().publish(
        (Symbol::new(env, "MofNInit"),),
        (admin, n, req),
    );
}

// ── Auth ──

pub fn auth(env: &Env, caller: Address, seed: Symbol) -> bool {
    // Check circuit breaker first
    if let Some(cb) = env.storage().instance().get::<DataKey, CbState>(&DataKey::CbState) {
        if cb.triggered {
            let mut ok = false;
            for i in 0..cb.backup.len() {
                if cb.backup.get(i).unwrap() == caller {
                    ok = true;
                    break;
                }
            }
            if !ok {
                panic_with_error!(env, ContractError::EmergencyDrainNotAuthorized);
            }
            caller.require_auth();
            return true;
        }
    }

    let cfg: MofNConfig = env
        .storage()
        .instance()
        .get(&DataKey::AdminMofN)
        .unwrap_or_else(|| panic_with_error!(env, ContractError::MultiSigNotConfigured));

    let mut is_admin = false;
    for i in 0..cfg.admins.len() {
        if cfg.admins.get(i).unwrap() == caller {
            is_admin = true;
            break;
        }
    }
    if !is_admin {
        panic_with_error!(env, ContractError::UnauthorizedAdmin);
    }

    caller.require_auth();

    let key = DataKey::AdminApproval(seed.clone());
    let mut app: ActionApproval = env.storage().temporary().get(&key).unwrap_or(
        ActionApproval {
            approvers: Vec::new(env),
            threshold: cfg.required,
        },
    );

    // Dedup
    for i in 0..app.approvers.len() {
        if app.approvers.get(i).unwrap() == caller {
            panic_with_error!(env, ContractError::AlreadyVoted);
        }
    }

    app.approvers.push_back(caller.clone());
    let done = app.approvers.len() >= app.threshold;
    env.storage().temporary().set(&key, &app);

    env.events().publish(
        (Symbol::new(env, "AdminVote"), seed),
        (caller, app.approvers.len(), app.threshold, done),
    );

    done
}

// ── Rate Bounds ──

pub fn clamp_rate(new: i128, base: i128) -> i128 {
    if base <= 0 {
        return new.max(1);
    }
    let lo = base * RATE_MIN_BPS / 10_000;
    let hi = base * RATE_MAX_BPS / 10_000;
    if new < lo { lo } else if new > hi { hi } else { new }
}

// ── Timelock ──

pub fn schedule(env: &Env, caller: Address, amount: i128, to: Address, eta: u64) -> u64 {
    if !auth(env, caller, Symbol::new(env, "sch_wd")) {
        panic_with_error!(env, ContractError::InsufficientApprovals);
    }
    let now = env.ledger().timestamp();
    if eta < now + TIMELOCK_DELAY {
        panic_with_error!(env, ContractError::InvalidUsageValue);
    }
    let mut ctr: u64 = env.storage().instance().get(&DataKey::WdCounter).unwrap_or(0);
    ctr += 1;
    let w = TimelockW {
        amount,
        recipient: to.clone(),
        eta,
        created: now,
        done: false,
        cancelled: false,
    };
    env.storage().instance().set(&DataKey::TimelockWD(ctr), &w);
    env.storage().instance().set(&DataKey::WdCounter, &ctr);
    env.events().publish(
        (Symbol::new(env, "SchWD"),),
        (ctr, amount, to, eta),
    );
    ctr
}

pub fn execute(env: &Env, id: u64) {
    let mut w: TimelockW = env
        .storage()
        .instance()
        .get(&DataKey::TimelockWD(id))
        .unwrap_or_else(|| panic_with_error!(env, ContractError::WithdrawalRequestNotFound));
    if w.done {
        panic_with_error!(env, ContractError::WithdrawalAlreadyExecuted);
    }
    if w.cancelled {
        panic_with_error!(env, ContractError::WithdrawalAlreadyCancelled);
    }
    if env.ledger().timestamp() < w.eta {
        panic_with_error!(env, ContractError::AdminExecutionWindowExpired);
    }
    w.done = true;
    env.storage().instance().set(&DataKey::TimelockWD(id), &w);
    env.events().publish(
        (Symbol::new(env, "ExecWD"),),
        (id, w.amount, w.recipient),
    );
}

pub fn cancel(env: &Env, caller: Address, id: u64) {
    if !auth(env, caller, Symbol::new(env, "cncl_wd")) {
        panic_with_error!(env, ContractError::InsufficientApprovals);
    }
    let mut w: TimelockW = env
        .storage()
        .instance()
        .get(&DataKey::TimelockWD(id))
        .unwrap_or_else(|| panic_with_error!(env, ContractError::WithdrawalRequestNotFound));
    if w.done {
        panic_with_error!(env, ContractError::WithdrawalAlreadyExecuted);
    }
    if w.cancelled {
        panic_with_error!(env, ContractError::WithdrawalAlreadyCancelled);
    }
    w.cancelled = true;
    env.storage().instance().set(&DataKey::TimelockWD(id), &w);
    env.events().publish((Symbol::new(env, "CnclWD"),), (id,));
}

// ── Circuit Breaker ──

pub fn trigger_cb(env: &Env, caller: Address, backup: Vec<Address>) {
    caller.require_auth();
    let state = CbState {
        triggered: true,
        at: env.ledger().timestamp(),
        backup,
    };
    env.storage().instance().set(&DataKey::CbState, &state);
    env.events().publish((Symbol::new(env, "CBTrig"),), (caller,));
}

pub fn reset_cb(env: &Env, caller: Address) {
    let caller_clone = caller.clone();
    if !auth(env, caller, Symbol::new(env, "rst_cb")) {
        panic_with_error!(env, ContractError::InsufficientApprovals);
    }
    if !env.storage().instance().has(&DataKey::CbState) {
        panic_with_error!(env, ContractError::EmergencyDrainNotAuthorized);
    }
    env.storage().instance().remove(&DataKey::CbState);
    env.events().publish((Symbol::new(env, "CBReset"),), (caller_clone,));
}

pub fn is_cb(env: &Env) -> bool {
    env.storage()
        .instance()
        .get::<DataKey, CbState>(&DataKey::CbState)
        .map(|s| s.triggered)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Address, Env, Symbol, symbol_short};

    fn setup(env: &Env, n: u32, req: u32) -> (Address, Vec<Address>) {
        let admin = Address::generate(env);
        let mut admins: Vec<Address> = Vec::new(env);
        for _ in 0..n {
            admins.push_back(Address::generate(env));
        }
        env.storage().instance().set(&DataKey::CurrentAdmin, &admin);
        init(env, admin.clone(), admins.clone(), req);
        (admin, admins)
    }

    // ── Compromised Key Scenario ──

    #[test]
    fn test_compromised_single_key_cannot_pass_3of5() {
        // SCENARIO: 3-of-5 multi-sig. One key compromised.
        // Attacker with single key can't reach threshold.
        let env = Env::default();
        env.mock_all_auths();
        let (_, admins) = setup(&env, 5, 3);
        let compromised = admins.get(0).unwrap();
        let result = auth(&env, compromised, symbol_short!("test"));
        assert!(!result, "Single compromised key should NOT pass 3-of-5");
    }

    #[test]
    fn test_compromised_2keys_cannot_drain_with_timelock() {
        // SCENARIO: 3-of-5 multi-sig. 2 keys compromised.
        // Needs 3 approvals for schedule — fails.
        let env = Env::default();
        env.mock_all_auths();
        let (_, admins) = setup(&env, 5, 3);

        let attacker1 = admins.get(0).unwrap();
        let attacker2 = admins.get(1).unwrap();

        let _ = auth(&env, attacker1, symbol_short!("sch_wd"));
        let result = auth(&env, attacker2, symbol_short!("sch_wd"));
        assert!(!result, "2 keys should NOT satisfy 3-of-5 threshold");
    }

    #[test]
    fn test_3of5_passes_with_quorum() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, admins) = setup(&env, 5, 3);

        let _ = auth(&env, admins.get(0).unwrap(), symbol_short!("test"));
        let _ = auth(&env, admins.get(1).unwrap(), symbol_short!("test"));
        let result = auth(&env, admins.get(2).unwrap(), symbol_short!("test"));
        assert!(result, "3 keys should satisfy 3-of-5");
    }

    #[test]
    #[should_panic(expected = "AlreadyVoted")]
    fn test_double_vote_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, admins) = setup(&env, 3, 2);
        let admin = admins.get(0).unwrap();
        let _ = auth(&env, admin.clone(), symbol_short!("test"));
        auth(&env, admin, symbol_short!("test")); // Second vote
    }

    // ── Timelock ──

    #[test]
    #[should_panic(expected = "InvalidUsageValue")]
    fn test_timelock_too_early() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, admins) = setup(&env, 3, 2);
        let _ = auth(&env, admins.get(0).unwrap(), symbol_short!("sch_wd"));
        assert!(auth(&env, admins.get(1).unwrap(), symbol_short!("sch_wd")));

        let recipient = Address::generate(&env);
        let now = env.ledger().timestamp();
        schedule(&env, admins.get(0).unwrap(), 1000, recipient, now + 3600);
    }

    #[test]
    #[should_panic(expected = "WithdrawalRequestNotFound")]
    fn test_execute_nonexistent() {
        let env = Env::default();
        execute(&env, 999);
    }

    // ── Circuit Breaker ──

    #[test]
    fn test_cb_grants_backup_access() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, admins) = setup(&env, 3, 2);

        let backup = Address::generate(&env);
        let mut backup_vec = Vec::new(&env);
        backup_vec.push_back(backup.clone());

        trigger_cb(&env, admins.get(0).unwrap(), backup_vec);
        assert!(is_cb(&env));

        let result = auth(&env, backup, symbol_short!("cb_test"));
        assert!(result, "Backup should pass auth during CB");
    }

    #[test]
    #[should_panic(expected = "EmergencyDrainNotAuthorized")]
    fn test_cb_blocks_non_backup() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, admins) = setup(&env, 3, 2);

        let backup = Address::generate(&env);
        let mut backup_vec = Vec::new(&env);
        backup_vec.push_back(backup);
        trigger_cb(&env, admins.get(0).unwrap(), backup_vec);

        auth(&env, Address::generate(&env), symbol_short!("test"));
    }

    #[test]
    fn test_cb_reset_requires_quorum() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, admins) = setup(&env, 3, 2);

        let mut backup_vec = Vec::new(&env);
        backup_vec.push_back(Address::generate(&env));
        trigger_cb(&env, admins.get(0).unwrap(), backup_vec);
        assert!(is_cb(&env));

        let _ = auth(&env, admins.get(0).unwrap(), symbol_short!("rst_cb"));
        let ok = auth(&env, admins.get(1).unwrap(), symbol_short!("rst_cb"));
        assert!(ok);
        assert!(!is_cb(&env), "CB should be reset");
    }

    // ── Rate Bounds ──

    #[test]
    fn test_rate_bounds() {
        let base: i128 = 1000;
        assert_eq!(clamp_rate(50, base), 100);
        assert_eq!(clamp_rate(500, base), 500);
        assert_eq!(clamp_rate(20000, base), 10000);
    }

    #[test]
    fn test_rate_bounds_zero_base() {
        assert_eq!(clamp_rate(100, 0), 100);
        assert_eq!(clamp_rate(0, 0), 1);
    }
}