# Escrow Contract Load Testing Framework

## Overview

This framework validates that the escrow contract meets the **P99 < 200ms** performance target for all billing operations. It provides automated latency measurement, gas consumption tracking, and Prometheus-compatible metrics export.

## Architecture

```
contracts/contracts/escrow/src/
├── gas_metrics.rs          # Latency percentiles, gas metering, Prometheus export
├── load_test_harness.rs    # Workload generation, lifecycle test orchestration
├── load_tests.rs           # Comprehensive performance test suite
└── tests.rs                # Existing unit tests (unchanged)
```

## Performance Targets

| Operation               | P99 Target | Baseline |
|-------------------------|------------|----------|
| `initialize_escrow`     | < 200ms    | < 50ms   |
| `deposit`               | < 200ms    | < 50ms   |
| `charge_meter_usage`    | < 200ms    | < 50ms   |
| `charge_group_usage`    | < 200ms    | < 50ms   |
| `get_escrow_balance`    | < 200ms    | < 50ms   |
| `get_meter_usage`       | < 200ms    | < 50ms   |
| `execute_release`       | < 200ms    | < 50ms   |

## Running Tests

### All Escrow Tests (including load tests)

```bash
cd contracts/contracts
cargo test --package escrow --lib
```

### Load Tests Only

```bash
cd contracts/contracts
cargo test --package escrow --lib load_tests -- --nocapture
```

### Individual Load Tests

```bash
# Billing lifecycle (end-to-end)
cargo test --package escrow --lib test_billing_lifecycle_smoke -- --nocapture

# High-volume stress test
cargo test --package escrow --lib test_high_volume_meter_charges -- --nocapture

# Prometheus metrics export
cargo test --package escrow --lib test_prometheus_metrics_export -- --nocapture
```

## Load Test Profiles

| Profile        | Config                 | Description                        |
|----------------|------------------------|------------------------------------|
| `smoke`        | 10 users, 5 ops/user  | Quick sanity check                 |
| `steady_state` | 100 users, 10 ops/user| Sustained normal load              |
| `burst`        | 500 users, 5 ops/user | Peak load spike                    |
| `stress`       | 1000 users, 3 ops/user| Maximum concurrent operations      |

## Test Categories

### Individual Operation Load Tests

- `test_initialize_escrow_load` — 100 sequential escrow initializations
- `test_deposit_load` — 100 sequential deposits
- `test_charge_meter_usage_load` — 100 meter charges
- `test_charge_group_usage_load` — 100 group charges
- `test_get_escrow_balance_load` — 1000 balance reads

### Billing Lifecycle Tests

- `test_billing_lifecycle_smoke` — Full lifecycle: init → deposit → register → charge → read
- `test_billing_lifecycle_steady_state` — Same lifecycle at scale (100 users)
- `test_charge_billing_load` — Focused charge billing at scale

### Concurrency & Isolation Tests

- `test_concurrent_escrows_are_isolated` — 50 users, verify balance isolation
- `test_concurrent_meters_are_independent` — 20 meters, verify independent tracking

### Performance Regression Tests

- `test_initialize_escrow_gas_baseline` — < 50ms per init
- `test_deposit_gas_baseline` — < 50ms per deposit
- `test_charge_meter_usage_gas_baseline` — < 50ms per charge
- `test_charge_group_usage_gas_baseline` — < 50ms per group charge

### Stress Tests

- `test_high_volume_meter_charges` — 500 charges across 10 consumers, 50 meters

## Metrics Export

### Prometheus Format

The framework exports metrics in Prometheus text format:

```
escrow_p99_latency_ms <value>
escrow_p50_latency_ms <value>
escrow_p90_latency_ms <value>
escrow_p95_latency_ms <value>
escrow_total_measurements <count>
escrow_total_gas <stroops>
escrow_op_latency_p99_ms{operation="<op>"} <value>
escrow_op_latency_p50_ms{operation="<op>"} <value>
escrow_op_count{operation="<op>"} <count>
escrow_op_gas_avg{operation="<op>"} <stroops>
escrow_p99_target_passed <0|1>
```

### Integration with Monitoring

The following Prometheus alerts are configured in `monitoring/billing_alerts.yml`:

| Alert                        | Condition               | Severity |
|------------------------------|-------------------------|----------|
| `EscrowP99LatencyExceeded`   | P99 > 200ms             | critical |
| `EscrowP99TargetFailed`      | P99 gate = 0            | critical |
| `EscrowGasConsumptionHigh`   | Avg gas > 15M stroops   | warning  |
| `HighBillingLatency`         | Global P99 > 200ms      | critical |

## Configuration

### LoadTestConfig

```rust
pub struct LoadTestConfig {
    pub concurrent_users: usize,      // Default: 100
    pub ops_per_user: usize,          // Default: 10
    pub max_p99_latency: Duration,    // Default: 200ms
    pub ramp_up: Duration,            // Default: 100ms
    pub measure_gas: bool,            // Default: true
}
```

### Custom Configuration

```rust
let config = LoadTestConfig {
    concurrent_users: 500,
    ops_per_user: 20,
    max_p99_latency: Duration::from_millis(100),
    ..Default::default()
};
let mut harness = LoadTestHarness::with_config(config);
harness.run_billing_lifecycle_test();
harness.report.print_summary();
```

## CI Integration

The load tests are included in the `cargo test` run for the contracts workspace. The CI pipeline runs:

```yaml
- run: cargo test --workspace --locked
```

This includes all load tests as part of the standard test suite.

## PCI-DSS & SOC2 Compliance

The load testing framework supports compliance requirements:

- **Audit Trail**: All operations emit events (EscrowInit, EscrowDep, MtrChrg, GrpChrg)
- **Cryptographic Verification**: All transactions go through Ed25519 signature verification
- **Performance Monitoring**: Continuous P99 latency tracking via Prometheus
- **Gas Consumption Tracking**: Prevents gas-based DoS attacks
- **Concurrency Isolation**: Validates escrow isolation under concurrent load

## Architecture Decisions

1. **Soroban Test Environment**: Tests run in the Soroban mock environment, not against a live network
2. **Mock Tokens**: Uses `register_stellar_asset_contract_v2` for realistic token transfer behavior
3. **Global Meter**: Uses a lazy_static global for cross-test metric aggregation
4. **Latency Measurement**: Uses `std::time::Instant` for precise wall-clock timing
5. **Percentile Calculation**: Linear interpolation for P50/P90/P95/P99 from sorted samples
