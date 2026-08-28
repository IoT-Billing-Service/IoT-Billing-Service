#![cfg(test)]

/// Escrow Contract Gas Metering & Performance Metrics
///
/// Provides automated gas measurement, latency tracking, and performance
/// validation for escrow contract billing operations. Designed to verify
/// the P99 < 200ms target for billing operations.
///
/// ## Performance Targets
///
/// | Operation               | P99 Target |
/// |-------------------------|------------|
/// | initialize_escrow       | < 200ms    |
/// | deposit                 | < 200ms    |
/// | charge_meter_usage      | < 200ms    |
/// | charge_group_usage      | < 200ms    |
/// | get_escrow_balance      | < 200ms    |
/// | get_meter_usage         | < 200ms    |
/// | execute_release         | < 200ms    |
///
/// ## Usage
///
/// ```rust,no_run
/// use escrow::gas_metrics::{EscrowGasMeter, load_test_harness};
/// use escrow::EscrowContract;
///
/// let mut harness = load_test_harness();
/// harness.run_billing_load_test(1000, std::time::Duration::from_millis(200));
/// harness.report.print_summary();
/// ```
extern crate std;

use std::collections::BTreeMap;
use std::fmt;
use std::string::{String, ToString};
use std::time::{Duration, Instant};
use std::vec::Vec;

// ============================================================================
// Constants for Escrow Operation Gas Baselines
// ============================================================================

/// Baseline gas costs for escrow operations (in approximate stroops)
pub struct EscrowGasBaseline;

impl EscrowGasBaseline {
    /// Initialize a new escrow
    pub const INITIALIZE_ESCROW: i128 = 5_000_000;
    /// Deposit tokens into escrow
    pub const DEPOSIT: i128 = 8_000_000;
    /// Charge meter usage from escrow
    pub const CHARGE_METER: i128 = 10_000_000;
    /// Charge group usage from escrow
    pub const CHARGE_GROUP: i128 = 10_000_000;
    /// Get escrow balance
    pub const GET_BALANCE: i128 = 2_000_000;
    /// Get escrow info
    pub const GET_INFO: i128 = 2_000_000;
    /// Register meter
    pub const REGISTER_METER: i128 = 5_000_000;
    /// Register group
    pub const REGISTER_GROUP: i128 = 5_000_000;
    /// Execute release
    pub const EXECUTE_RELEASE: i128 = 12_000_000;
}

// ============================================================================
// Latency Measurement
// ============================================================================

/// Latency percentile results for a set of measurements
#[derive(Clone, Debug)]
pub struct LatencyPercentiles {
    pub p50: Duration,
    pub p90: Duration,
    pub p95: Duration,
    pub p99: Duration,
    pub min: Duration,
    pub max: Duration,
    pub mean: Duration,
    pub count: usize,
    pub total: Duration,
}

impl LatencyPercentiles {
    pub fn from_sorted(sorted: &[Duration]) -> Self {
        if sorted.is_empty() {
            return LatencyPercentiles {
                p50: Duration::ZERO,
                p90: Duration::ZERO,
                p95: Duration::ZERO,
                p99: Duration::ZERO,
                min: Duration::ZERO,
                max: Duration::ZERO,
                mean: Duration::ZERO,
                count: 0,
                total: Duration::ZERO,
            };
        }

        let count = sorted.len();
        let total: Duration = sorted.iter().sum();
        let mean = total / count as u32;

        LatencyPercentiles {
            p50: percentile(sorted, 50.0),
            p90: percentile(sorted, 90.0),
            p95: percentile(sorted, 95.0),
            p99: percentile(sorted, 99.0),
            min: sorted[0],
            max: sorted[count - 1],
            mean,
            count,
            total,
        }
    }

    pub fn passes_p99_target(&self, target: Duration) -> bool {
        self.p99 <= target
    }
}

fn percentile(sorted: &[Duration], p: f64) -> Duration {
    if sorted.is_empty() {
        return Duration::ZERO;
    }
    let idx = ((p / 100.0) * (sorted.len() - 1) as f64).round() as usize;
    sorted[idx]
}

// ============================================================================
// Gas Measurement
// ============================================================================

/// A single gas + latency measurement for an escrow operation
#[derive(Clone, Debug)]
pub struct EscrowMeasurement {
    pub operation_name: String,
    pub estimated_gas: i128,
    pub actual_gas: i128,
    pub latency: Duration,
    pub timestamp: Instant,
    pub test_name: String,
}

impl EscrowMeasurement {
    pub fn gas_efficiency(&self) -> f64 {
        if self.estimated_gas == 0 {
            return 1.0;
        }
        (self.actual_gas as f64) / (self.estimated_gas as f64)
    }
}

// ============================================================================
// Operation Statistics
// ============================================================================

/// Statistics for a group of measurements on the same operation
#[derive(Clone, Debug)]
pub struct OperationStats {
    pub operation_name: String,
    pub count: usize,
    pub total_gas: i128,
    pub min_gas: i128,
    pub max_gas: i128,
    pub avg_gas: i128,
    pub latency: LatencyPercentiles,
    pub total_estimated_gas: i128,
}

impl OperationStats {
    pub fn gas_efficiency_ratio(&self) -> f64 {
        if self.total_estimated_gas == 0 {
            return 1.0;
        }
        (self.total_gas as f64) / (self.total_estimated_gas as f64)
    }
}

// ============================================================================
// Global Gas Meter
// ============================================================================

/// Global gas meter for collecting escrow operation metrics
pub struct EscrowGasMeter {
    measurements: std::sync::Mutex<Vec<EscrowMeasurement>>,
    test_stack: std::sync::Mutex<Vec<String>>,
}

impl EscrowGasMeter {
    pub fn new() -> Self {
        EscrowGasMeter {
            measurements: std::sync::Mutex::new(Vec::new()),
            test_stack: std::sync::Mutex::new(Vec::new()),
        }
    }

    /// Record a gas + latency measurement
    pub fn record(
        &self,
        operation_name: &str,
        estimated_gas: i128,
        actual_gas: i128,
        latency: Duration,
    ) {
        let test_name = self
            .test_stack
            .lock()
            .unwrap()
            .last()
            .cloned()
            .unwrap_or_else(|| "unknown".to_string());

        let measurement = EscrowMeasurement {
            operation_name: operation_name.to_string(),
            estimated_gas,
            actual_gas,
            latency,
            timestamp: Instant::now(),
            test_name,
        };

        self.measurements.lock().unwrap().push(measurement);
    }

    /// Record latency only (for load tests where gas is not tracked per-call)
    pub fn record_latency(&self, operation_name: &str, latency: Duration) {
        let test_name = self
            .test_stack
            .lock()
            .unwrap()
            .last()
            .cloned()
            .unwrap_or_else(|| "unknown".to_string());

        let measurement = EscrowMeasurement {
            operation_name: operation_name.to_string(),
            estimated_gas: 0,
            actual_gas: 0,
            latency,
            timestamp: Instant::now(),
            test_name,
        };

        self.measurements.lock().unwrap().push(measurement);
    }

    /// Begin a test context
    pub fn push_test(&self, test_name: &str) {
        self.test_stack.lock().unwrap().push(test_name.to_string());
    }

    /// End a test context
    pub fn pop_test(&self) {
        self.test_stack.lock().unwrap().pop();
    }

    /// Get latency percentiles for an operation
    pub fn get_latency_percentiles(&self, operation_name: &str) -> LatencyPercentiles {
        let measurements = self.measurements.lock().unwrap();
        let mut latencies: Vec<Duration> = measurements
            .iter()
            .filter(|m| m.operation_name == operation_name)
            .map(|m| m.latency)
            .collect();
        latencies.sort();
        LatencyPercentiles::from_sorted(&latencies)
    }

    /// Get operation statistics
    pub fn get_operation_stats(&self, operation_name: &str) -> Option<OperationStats> {
        let measurements = self.measurements.lock().unwrap();
        let ops: Vec<&EscrowMeasurement> = measurements
            .iter()
            .filter(|m| m.operation_name == operation_name)
            .collect();

        if ops.is_empty() {
            return None;
        }

        let count = ops.len();
        let total_gas: i128 = ops.iter().map(|m| m.actual_gas).sum();
        let total_estimated: i128 = ops.iter().map(|m| m.estimated_gas).sum();
        let min_gas = ops.iter().map(|m| m.actual_gas).min().unwrap_or(0);
        let max_gas = ops.iter().map(|m| m.actual_gas).max().unwrap_or(0);
        let avg_gas = if count > 0 {
            total_gas / count as i128
        } else {
            0
        };

        let mut latencies: Vec<Duration> = ops.iter().map(|m| m.latency).collect();
        latencies.sort();

        Some(OperationStats {
            operation_name: operation_name.to_string(),
            count,
            total_gas,
            min_gas,
            max_gas,
            avg_gas,
            latency: LatencyPercentiles::from_sorted(&latencies),
            total_estimated_gas: total_estimated,
        })
    }

    /// Get statistics for all operations
    pub fn get_all_stats(&self) -> BTreeMap<String, OperationStats> {
        let measurements = self.measurements.lock().unwrap();
        let names: std::collections::HashSet<String> = measurements
            .iter()
            .map(|m| m.operation_name.clone())
            .collect();
        drop(measurements);

        names
            .into_iter()
            .filter_map(|name| self.get_operation_stats(&name).map(|s| (name, s)))
            .collect()
    }

    /// Generate a full performance report
    pub fn generate_report(&self) -> EscrowPerformanceReport {
        let measurements = self.measurements.lock().unwrap().clone();
        let all_stats = self.get_all_stats();

        let all_latencies: Vec<Duration> = measurements.iter().map(|m| m.latency).collect();
        let mut sorted_latencies = all_latencies;
        sorted_latencies.sort();
        let global_latency = LatencyPercentiles::from_sorted(&sorted_latencies);

        let total_gas: i128 = measurements.iter().map(|m| m.actual_gas).sum();
        let total_estimated: i128 = measurements.iter().map(|m| m.estimated_gas).sum();

        EscrowPerformanceReport {
            total_measurements: measurements.len(),
            total_gas,
            total_estimated_gas: total_estimated,
            global_latency,
            operation_stats: all_stats,
        }
    }

    /// Clear all measurements
    pub fn clear(&self) {
        self.measurements.lock().unwrap().clear();
        self.test_stack.lock().unwrap().clear();
    }
}

// ============================================================================
// Global Instance
// ============================================================================

lazy_static::lazy_static! {
    pub static ref ESCROW_GAS_METER: EscrowGasMeter = EscrowGasMeter::new();
}

// ============================================================================
// Performance Report
// ============================================================================

/// Full performance report for escrow contract load testing
#[derive(Clone, Debug)]
pub struct EscrowPerformanceReport {
    pub total_measurements: usize,
    pub total_gas: i128,
    pub total_estimated_gas: i128,
    pub global_latency: LatencyPercentiles,
    pub operation_stats: BTreeMap<String, OperationStats>,
}

impl EscrowPerformanceReport {
    pub fn print_summary(&self) {
        std::println!("\n========================================");
        std::println!("  ESCROW CONTRACT PERFORMANCE REPORT");
        std::println!("========================================");
        std::println!("  Total Measurements: {}", self.total_measurements);
        std::println!("  Total Gas: {} stroops", self.total_gas);
        std::println!("  P99 Latency: {:?}", self.global_latency.p99);
        std::println!("  P99 Target: {:?}", Duration::from_millis(200));
        std::println!(
            "  P99 Pass: {}",
            if self
                .global_latency
                .passes_p99_target(Duration::from_millis(200))
            {
                "YES"
            } else {
                "NO"
            }
        );
        std::println!("========================================");

        std::println!("\n--- Operation Latency ---");
        std::println!(
            "{:<25} {:>7} {:>10} {:>10} {:>10} {:>10} {:>10}",
            "Operation",
            "Count",
            "P50",
            "P90",
            "P95",
            "P99",
            "Max"
        );
        std::println!("{:=<85}", "");

        for (name, stats) in &self.operation_stats {
            std::println!(
                "{:<25} {:>7} {:>10.2?} {:>10.2?} {:>10.2?} {:>10.2?} {:>10.2?}",
                name,
                stats.count,
                stats.latency.p50,
                stats.latency.p90,
                stats.latency.p95,
                stats.latency.p99,
                stats.latency.max,
            );
        }

        std::println!("{:=<85}", "");

        // Gas breakdown
        std::println!("\n--- Gas Consumption ---");
        std::println!(
            "{:<25} {:>7} {:>10} {:>10} {:>10}",
            "Operation",
            "Count",
            "Avg Gas",
            "Min Gas",
            "Max Gas"
        );
        std::println!("{:=<65}", "");

        for (name, stats) in &self.operation_stats {
            if stats.total_gas > 0 {
                std::println!(
                    "{:<25} {:>7} {:>10} {:>10} {:>10}",
                    name,
                    stats.count,
                    stats.avg_gas,
                    stats.min_gas,
                    stats.max_gas,
                );
            }
        }

        std::println!("{:=<65}", "");
    }

    /// Export metrics in Prometheus-compatible text format
    pub fn to_prometheus(&self) -> String {
        let mut lines = Vec::new();

        lines.push(std::format!(
            "escrow_p99_latency_ms {}",
            self.global_latency.p99.as_secs_f64() * 1000.0
        ));
        lines.push(std::format!(
            "escrow_p50_latency_ms {}",
            self.global_latency.p50.as_secs_f64() * 1000.0
        ));
        lines.push(std::format!(
            "escrow_p90_latency_ms {}",
            self.global_latency.p90.as_secs_f64() * 1000.0
        ));
        lines.push(std::format!(
            "escrow_p95_latency_ms {}",
            self.global_latency.p95.as_secs_f64() * 1000.0
        ));
        lines.push(std::format!(
            "escrow_total_measurements {}",
            self.total_measurements
        ));
        lines.push(std::format!("escrow_total_gas {}", self.total_gas));

        for (name, stats) in &self.operation_stats {
            let op = name.replace('-', "_");
            lines.push(std::format!(
                "escrow_op_latency_p99_ms{{operation=\"{}\"}} {}",
                op,
                stats.latency.p99.as_secs_f64() * 1000.0
            ));
            lines.push(std::format!(
                "escrow_op_latency_p50_ms{{operation=\"{}\"}} {}",
                op,
                stats.latency.p50.as_secs_f64() * 1000.0
            ));
            lines.push(std::format!(
                "escrow_op_count{{operation=\"{}\"}} {}",
                op,
                stats.count
            ));
            if stats.total_gas > 0 {
                lines.push(std::format!(
                    "escrow_op_gas_avg{{operation=\"{}\"}} {}",
                    op,
                    stats.avg_gas
                ));
            }
        }

        let passed = self
            .global_latency
            .passes_p99_target(Duration::from_millis(200));
        lines.push(std::format!(
            "escrow_p99_target_passed {}",
            if passed { 1 } else { 0 }
        ));

        lines.join("\n")
    }
}

impl fmt::Display for EscrowPerformanceReport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "EscrowPerformanceReport({} measurements)",
            self.total_measurements
        )
    }
}

// ============================================================================
// Test Guard
// ============================================================================

/// Guard that automatically manages test context for the global gas meter
pub struct EscrowTestGuard {
    test_name: String,
}

impl EscrowTestGuard {
    pub fn new(test_name: &str) -> Self {
        let name = test_name.to_string();
        ESCROW_GAS_METER.push_test(&name);
        EscrowTestGuard { test_name: name }
    }
}

impl Drop for EscrowTestGuard {
    fn drop(&mut self) {
        ESCROW_GAS_METER.pop_test();
    }
}

// ============================================================================
// Unit Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_latency_percentiles_empty() {
        let p = LatencyPercentiles::from_sorted(&[]);
        assert_eq!(p.count, 0);
        assert_eq!(p.p99, Duration::ZERO);
    }

    #[test]
    fn test_latency_percentiles_single() {
        let p = LatencyPercentiles::from_sorted(&[Duration::from_millis(100)]);
        assert_eq!(p.count, 1);
        assert_eq!(p.p50, Duration::from_millis(100));
        assert_eq!(p.p99, Duration::from_millis(100));
    }

    #[test]
    fn test_latency_percentiles_multiple() {
        let mut data: Vec<Duration> = (0..100).map(|i| Duration::from_millis(i)).collect();
        data.sort();
        let p = LatencyPercentiles::from_sorted(&data);
        assert_eq!(p.count, 100);
        assert!(p.p50 <= Duration::from_millis(51));
        assert!(p.p99 >= Duration::from_millis(98));
    }

    #[test]
    fn test_p99_target_pass() {
        let p = LatencyPercentiles {
            p50: Duration::from_millis(10),
            p90: Duration::from_millis(50),
            p95: Duration::from_millis(100),
            p99: Duration::from_millis(150),
            min: Duration::from_millis(1),
            max: Duration::from_millis(200),
            mean: Duration::from_millis(50),
            count: 100,
            total: Duration::from_secs(5),
        };
        assert!(p.passes_p99_target(Duration::from_millis(200)));
    }

    #[test]
    fn test_p99_target_fail() {
        let p = LatencyPercentiles {
            p50: Duration::from_millis(10),
            p90: Duration::from_millis(150),
            p95: Duration::from_millis(200),
            p99: Duration::from_millis(250),
            min: Duration::from_millis(1),
            max: Duration::from_millis(300),
            mean: Duration::from_millis(100),
            count: 100,
            total: Duration::from_secs(10),
        };
        assert!(!p.passes_p99_target(Duration::from_millis(200)));
    }

    #[test]
    fn test_gas_efficiency() {
        let m = EscrowMeasurement {
            operation_name: "deposit".to_string(),
            estimated_gas: 1_000_000,
            actual_gas: 800_000,
            latency: Duration::from_millis(10),
            timestamp: Instant::now(),
            test_name: "test".to_string(),
        };
        assert!((m.gas_efficiency() - 0.8).abs() < 0.001);
    }

    #[test]
    fn test_prometheus_export() {
        let meter = EscrowGasMeter::new();
        meter.record("deposit", 1_000_000, 800_000, Duration::from_millis(10));
        meter.record("deposit", 1_000_000, 900_000, Duration::from_millis(15));
        let report = meter.generate_report();
        let prom = report.to_prometheus();
        assert!(prom.contains("escrow_p99_latency_ms"));
        assert!(prom.contains("escrow_op_latency_p99_ms"));
        assert!(prom.contains("operation=\"deposit\""));
    }

    #[test]
    fn test_operation_stats() {
        let meter = EscrowGasMeter::new();
        for i in 0..10 {
            meter.record(
                "initialize_escrow",
                5_000_000,
                5_000_000 + i * 100_000,
                Duration::from_millis(5 + i as u64),
            );
        }
        let stats = meter.get_operation_stats("initialize_escrow").unwrap();
        assert_eq!(stats.count, 10);
        assert!(stats.latency.p99 >= stats.latency.p50);
    }
}
