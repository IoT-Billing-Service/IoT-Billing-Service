#![cfg(test)]

/// Escrow Contract Load Test Harness
///
/// Provides a framework for running concurrent load tests against the
/// escrow contract in the Soroban test environment. Simulates realistic
/// billing workloads to validate P99 < 200ms performance targets.
///
/// ## Workload Profiles
///
/// | Profile          | Concurrent Ops | Description                        |
/// |------------------|----------------|------------------------------------|
/// | `smoke`          | 10             | Quick sanity check                 |
/// | `steady_state`   | 100            | Sustained normal load              |
/// | `burst`          | 500            | Peak load spike                     |
/// | `stress`         | 1000           | Maximum concurrent operations      |
///
/// ## Operations Tested
///
/// - `initialize_escrow` — Create escrow accounts
/// - `deposit` — Fund escrow balances
/// - `charge_meter_usage` — Individual meter billing
/// - `charge_group_usage` — Fleet/group billing
/// - `get_escrow_balance` — Read operations
/// - `get_meter_usage` — Read operations
///
/// ## Usage
///
/// ```rust,no_run
/// use escrow::load_test_harness::LoadTestHarness;
/// use escrow::EscrowContract;
///
/// let mut harness = LoadTestHarness::new();
/// harness.run_steady_state(100);
/// harness.report.print_summary();
/// assert!(harness.report.global_latency.passes_p99_target(
///     std::time::Duration::from_millis(200)
/// ));
/// ```
extern crate std;

use std::collections::BTreeMap;
use std::string::{String, ToString};
use std::time::{Duration, Instant};
use std::vec;
use std::vec::Vec;

use soroban_sdk::{
    testutils::Address as AddressTest, token, Address, BytesN, Env, String as SorobanString,
};

use crate::gas_metrics::{EscrowPerformanceReport, LatencyPercentiles, ESCROW_GAS_METER};
use crate::EscrowContract;

// ============================================================================
// Configuration
// ============================================================================

/// Load test configuration
#[derive(Clone, Debug)]
pub struct LoadTestConfig {
    /// Number of concurrent users to simulate
    pub concurrent_users: usize,
    /// Number of operations per user
    pub ops_per_user: usize,
    /// Maximum allowed P99 latency
    pub max_p99_latency: Duration,
    /// Ramp-up time (simulated)
    pub ramp_up: Duration,
    /// Whether to measure gas
    pub measure_gas: bool,
}

impl Default for LoadTestConfig {
    fn default() -> Self {
        LoadTestConfig {
            concurrent_users: 100,
            ops_per_user: 10,
            max_p99_latency: Duration::from_millis(200),
            ramp_up: Duration::from_millis(100),
            measure_gas: true,
        }
    }
}

impl LoadTestConfig {
    pub fn smoke() -> Self {
        LoadTestConfig {
            concurrent_users: 10,
            ops_per_user: 5,
            max_p99_latency: Duration::from_millis(500),
            ..Default::default()
        }
    }

    pub fn steady_state() -> Self {
        LoadTestConfig {
            concurrent_users: 100,
            ops_per_user: 10,
            max_p99_latency: Duration::from_millis(200),
            ..Default::default()
        }
    }

    pub fn burst() -> Self {
        LoadTestConfig {
            concurrent_users: 500,
            ops_per_user: 5,
            max_p99_latency: Duration::from_millis(200),
            ..Default::default()
        }
    }

    pub fn stress() -> Self {
        LoadTestConfig {
            concurrent_users: 1000,
            ops_per_user: 3,
            max_p99_latency: Duration::from_millis(200),
            ..Default::default()
        }
    }
}

// ============================================================================
// Workload Generator
// ============================================================================

/// Generates realistic billing workloads for load testing
pub struct WorkloadGenerator {
    env: Env,
    users: Vec<Address>,
    token: Address,
    device_ids: Vec<SorobanString>,
    group_ids: Vec<SorobanString>,
}

impl WorkloadGenerator {
    pub fn new(user_count: usize, device_count: usize) -> Self {
        let env = Env::default();
        env.mock_all_auths();

        let users: Vec<Address> = (0..user_count).map(|_| Address::generate(&env)).collect();

        // Register a mock token contract
        let token_admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin.clone())
            .address();

        // Mint tokens to all users
        let token_admin_client = token::StellarAssetClient::new(&env, &token);
        for user in &users {
            token_admin_client.mint(user, &1_000_000_000i128);
        }

        let device_ids: Vec<SorobanString> = (0..device_count)
            .map(|i| SorobanString::from_str(&env, &std::format!("MTR-{i:06}")))
            .collect();
        let group_count = (device_count / 10).max(1);
        let group_ids: Vec<SorobanString> = (0..group_count)
            .map(|i| SorobanString::from_str(&env, &std::format!("FL-{i:04}")))
            .collect();

        WorkloadGenerator {
            env,
            users,
            token,
            device_ids,
            group_ids,
        }
    }

    pub fn env(&self) -> &Env {
        &self.env
    }

    pub fn users(&self) -> &[Address] {
        &self.users
    }

    pub fn token(&self) -> &Address {
        &self.token
    }

    pub fn device_ids(&self) -> &[SorobanString] {
        &self.device_ids
    }

    pub fn group_ids(&self) -> &[SorobanString] {
        &self.group_ids
    }
}

// ============================================================================
// Load Test Harness
// ============================================================================

fn empty_report() -> EscrowPerformanceReport {
    EscrowPerformanceReport {
        total_measurements: 0,
        total_gas: 0,
        total_estimated_gas: 0,
        global_latency: LatencyPercentiles {
            p50: Duration::ZERO,
            p90: Duration::ZERO,
            p95: Duration::ZERO,
            p99: Duration::ZERO,
            min: Duration::ZERO,
            max: Duration::ZERO,
            mean: Duration::ZERO,
            count: 0,
            total: Duration::ZERO,
        },
        operation_stats: BTreeMap::new(),
    }
}

/// Main load test harness for escrow contract performance testing
pub struct LoadTestHarness {
    pub config: LoadTestConfig,
    pub report: EscrowPerformanceReport,
}

impl LoadTestHarness {
    pub fn new() -> Self {
        LoadTestHarness {
            config: LoadTestConfig::default(),
            report: empty_report(),
        }
    }

    pub fn with_config(config: LoadTestConfig) -> Self {
        LoadTestHarness {
            config,
            report: empty_report(),
        }
    }

    /// Run a complete billing lifecycle load test
    pub fn run_billing_lifecycle_test(&mut self) {
        ESCROW_GAS_METER.clear();

        let generator = WorkloadGenerator::new(
            self.config.concurrent_users,
            self.config.concurrent_users * 2,
        );

        let contract_id = generator
            .env()
            .register(EscrowContract, (dummy_wasm_hash(generator.env()),));
        let client = crate::EscrowContractClient::new(generator.env(), &contract_id);

        // Phase 1: Initialize escrows
        std::println!(
            "Phase 1: Initializing {} escrows...",
            self.config.concurrent_users
        );
        let phase1_start = Instant::now();
        for (i, user) in generator.users().iter().enumerate() {
            let token = generator.token();
            let start = Instant::now();
            client.initialize_escrow(user, token);
            let latency = start.elapsed();
            ESCROW_GAS_METER.record_latency("initialize_escrow", latency);
        }
        std::println!("  Phase 1 completed in {:?}", phase1_start.elapsed());

        // Phase 2: Deposit into escrows
        std::println!("Phase 2: Depositing into escrows...");
        let phase2_start = Instant::now();
        for (i, user) in generator.users().iter().enumerate() {
            let token = generator.token();
            let start = Instant::now();
            client.deposit(user, token, &1_000_000i128);
            let latency = start.elapsed();
            ESCROW_GAS_METER.record_latency("deposit", latency);
        }
        std::println!("  Phase 2 completed in {:?}", phase2_start.elapsed());

        // Phase 3: Register meters
        std::println!(
            "Phase 3: Registering {} meters...",
            generator.device_ids().len()
        );
        let phase3_start = Instant::now();
        for (i, device_id) in generator.device_ids().iter().enumerate() {
            let consumer = &generator.users()[i % generator.users().len()];
            let token = generator.token();
            let start = Instant::now();
            client.register_meter(device_id, consumer, token);
            let latency = start.elapsed();
            ESCROW_GAS_METER.record_latency("register_meter", latency);
        }
        std::println!("  Phase 3 completed in {:?}", phase3_start.elapsed());

        // Phase 4: Register groups
        std::println!(
            "Phase 4: Registering {} groups...",
            generator.group_ids().len()
        );
        let phase4_start = Instant::now();
        for (i, group_id) in generator.group_ids().iter().enumerate() {
            let manager = &generator.users()[i % generator.users().len()];
            let token = generator.token();
            let start = Instant::now();
            client.register_group(group_id, manager, token, &10u32);
            let latency = start.elapsed();
            ESCROW_GAS_METER.record_latency("register_group", latency);
        }
        std::println!("  Phase 4 completed in {:?}", phase4_start.elapsed());

        // Phase 5: Charge meter usage (concurrent billing simulation)
        std::println!("Phase 5: Charging meter usage...");
        let phase5_start = Instant::now();
        for (i, device_id) in generator.device_ids().iter().enumerate() {
            let consumer = &generator.users()[i % generator.users().len()];
            let amount = 100i128 + (i as i128 % 900);
            let start = Instant::now();
            let result = client.try_charge_meter_usage(device_id, consumer, &amount);
            let latency = start.elapsed();
            if result.is_ok() || result.is_err() {
                ESCROW_GAS_METER.record_latency("charge_meter_usage", latency);
            }
        }
        std::println!("  Phase 5 completed in {:?}", phase5_start.elapsed());

        // Phase 6: Read operations
        std::println!("Phase 6: Read operations...");
        let phase6_start = Instant::now();
        for (i, user) in generator.users().iter().enumerate() {
            let token = generator.token();

            let start = Instant::now();
            let _balance = client.get_escrow_balance(user, token);
            let latency = start.elapsed();
            ESCROW_GAS_METER.record_latency("get_escrow_balance", latency);

            let start = Instant::now();
            let _info = client.get_escrow_info(user, token);
            let latency = start.elapsed();
            ESCROW_GAS_METER.record_latency("get_escrow_info", latency);
        }
        for device_id in generator.device_ids().iter() {
            let start = Instant::now();
            let _usage = client.get_meter_usage(device_id);
            let latency = start.elapsed();
            ESCROW_GAS_METER.record_latency("get_meter_usage", latency);
        }
        std::println!("  Phase 6 completed in {:?}", phase6_start.elapsed());

        // Generate report
        self.report = ESCROW_GAS_METER.generate_report();
    }

    /// Run a focused charge billing load test
    pub fn run_charge_billing_test(&mut self) {
        ESCROW_GAS_METER.clear();

        let generator =
            WorkloadGenerator::new(self.config.concurrent_users, self.config.concurrent_users);

        let contract_id = generator
            .env()
            .register(EscrowContract, (dummy_wasm_hash(generator.env()),));
        let client = crate::EscrowContractClient::new(generator.env(), &contract_id);

        // Setup: Initialize and deposit for all users
        for (i, user) in generator.users().iter().enumerate() {
            let token = generator.token();
            client.initialize_escrow(user, token);
            client.deposit(user, token, &10_000_000i128);
        }

        // Setup: Register meters
        for (i, device_id) in generator.device_ids().iter().enumerate() {
            let consumer = &generator.users()[i % generator.users().len()];
            let token = generator.token();
            let _ = client.try_register_meter(device_id, consumer, token);
        }

        // Load test: Charge meter usage
        std::println!(
            "Running charge billing test: {} users, {} devices",
            generator.users().len(),
            generator.device_ids().len()
        );

        let test_start = Instant::now();
        for round in 0..self.config.ops_per_user {
            for (i, device_id) in generator.device_ids().iter().enumerate() {
                let consumer = &generator.users()[i % generator.users().len()];
                let amount = 10i128 + ((round + i) as i128 % 90);

                let start = Instant::now();
                let _ = client.try_charge_meter_usage(device_id, consumer, &amount);
                let latency = start.elapsed();
                ESCROW_GAS_METER.record_latency("charge_meter_usage", latency);
            }
        }
        std::println!("  Test completed in {:?}", test_start.elapsed());

        self.report = ESCROW_GAS_METER.generate_report();
    }

    /// Validate the report against the P99 target
    pub fn validate_p99_target(&self) -> LoadTestResult {
        let mut result = LoadTestResult {
            passed: true,
            violations: Vec::new(),
            warnings: Vec::new(),
        };

        // Check global P99
        if !self
            .report
            .global_latency
            .passes_p99_target(self.config.max_p99_latency)
        {
            result.passed = false;
            result.violations.push(std::format!(
                "Global P99 latency {:?} exceeds target {:?}",
                self.report.global_latency.p99,
                self.config.max_p99_latency
            ));
        }

        // Check per-operation P99
        for (name, stats) in &self.report.operation_stats {
            if !stats.latency.passes_p99_target(self.config.max_p99_latency) {
                result.warnings.push(std::format!(
                    "Operation '{}' P99 latency {:?} exceeds target {:?}",
                    name,
                    stats.latency.p99,
                    self.config.max_p99_latency
                ));
            }
        }

        // Check minimum sample size
        if self.report.total_measurements < 10 {
            result.warnings.push(std::format!(
                "Low sample size: {} measurements (recommended: >= 100)",
                self.report.total_measurements
            ));
        }

        result
    }

    /// Generate Prometheus-compatible metrics
    pub fn prometheus_metrics(&self) -> String {
        self.report.to_prometheus()
    }
}

impl Default for LoadTestHarness {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// Load Test Result
// ============================================================================

/// Result of a load test validation
#[derive(Clone, Debug)]
pub struct LoadTestResult {
    pub passed: bool,
    pub violations: Vec<String>,
    pub warnings: Vec<String>,
}

impl LoadTestResult {
    pub fn print_report(&self) {
        if self.passed {
            std::println!("\n✅ LOAD TEST PASSED — All P99 targets met.");
        } else {
            std::println!("\n❌ LOAD TEST FAILED — P99 target not met.");
        }

        if !self.violations.is_empty() {
            std::println!("\nViolations:");
            for v in &self.violations {
                std::println!("  ✗ {}", v);
            }
        }

        if !self.warnings.is_empty() {
            std::println!("\nWarnings:");
            for w in &self.warnings {
                std::println!("  ⚠ {}", w);
            }
        }
    }
}

// ============================================================================
// Helpers
// ============================================================================

fn dummy_wasm_hash(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0xAB_u8; 32])
}

// ============================================================================
// Unit Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_load_test_config_defaults() {
        let config = LoadTestConfig::default();
        assert_eq!(config.concurrent_users, 100);
        assert_eq!(config.max_p99_latency, Duration::from_millis(200));
    }

    #[test]
    fn test_load_test_config_smoke() {
        let config = LoadTestConfig::smoke();
        assert_eq!(config.concurrent_users, 10);
    }

    #[test]
    fn test_load_test_config_burst() {
        let config = LoadTestConfig::burst();
        assert_eq!(config.concurrent_users, 500);
    }

    #[test]
    fn test_workload_generator() {
        let gen = WorkloadGenerator::new(10, 20);
        assert_eq!(gen.users().len(), 10);
        assert_eq!(gen.device_ids().len(), 20);
        // token() returns a single mock token address
        let _ = gen.token();
    }

    #[test]
    fn test_smoke_test_runs() {
        let mut harness = LoadTestHarness::with_config(LoadTestConfig::smoke());
        harness.run_billing_lifecycle_test();
        assert!(harness.report.total_measurements > 0);
        let result = harness.validate_p99_target();
        result.print_report();
    }

    #[test]
    fn test_prometheus_output() {
        let mut harness = LoadTestHarness::with_config(LoadTestConfig::smoke());
        harness.run_billing_lifecycle_test();
        let prom = harness.prometheus_metrics();
        assert!(prom.contains("escrow_p99_latency_ms"));
        assert!(prom.contains("escrow_p99_target_passed"));
    }

    #[test]
    fn test_charge_billing_test() {
        let mut harness = LoadTestHarness::with_config(LoadTestConfig::smoke());
        harness.run_charge_billing_test();
        assert!(harness.report.total_measurements > 0);
    }
}
