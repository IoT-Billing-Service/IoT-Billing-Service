# Chaos Engineering Blueprint — IoT Billing Platform (Staging)

## 1. Purpose

This document describes the chaos engineering strategy for the IoT billing
platform. The goal is to verify that the billing pipeline behaves correctly
and recovers predictably under realistic failure conditions before they
appear in production.

---

## 2. Scope and Constraints

| Constraint | Value |
|---|---|
| Target environment | Staging only (`CHAOS_ENABLED=true`) |
| Performance SLO | P99 billing operation latency < 200 ms |
| Security invariant | All transactions cryptographically verified (Ed25519 + idempotency key) |
| PCI-DSS / SOC2 | Zero double-charges; billing computation runs exactly once per cycle |
| Production impact | None — `CHAOS_ENABLED` guard prevents faults from firing in production |

---

## 3. Architecture

```
┌─────────────────────────────────────────────────┐
│              ChaosExperiment definition          │
│  name · faults[] · hypothesis · durations        │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│           ExperimentRunner (3-phase)             │
│                                                  │
│  Phase 1 ─ Baseline     (observe normal state)  │
│  Phase 2 ─ FaultActive  (faults injected)        │
│  Phase 3 ─ Recovery     (faults cleared, assert) │
└──────────────────────┬──────────────────────────┘
                       │ WorkloadDriver
                       ▼
┌─────────────────────────────────────────────────┐
│         BillingWorkloadDriver                    │
│  seeds OPEN cycles → concurrent finalizers       │
│  → finalizeBillingCycle (real code under test)   │
└──────────────────────┬──────────────────────────┘
                       │ FaultInjector (in-process)
                       ▼
┌─────────────────────────────────────────────────┐
│  Active Faults Map  (type → ActiveFault)         │
│  Prometheus metrics (chaos_* namespace)          │
└─────────────────────────────────────────────────┘
```

### Key design decisions

- **No external chaos framework dependency.** The injector is pure TypeScript
  with zero new production dependencies. Faults are in-process flags.
- **Real billing code under test.** The workload driver calls the actual
  `finalizeBillingCycle` function, not a mock.
- **Kill switch.** `activateFault()` throws unless `CHAOS_ENABLED=true`. The
  env var is never set in production Dockerfiles or Kubernetes manifests.
- **Self-expiring faults.** Every fault has a `durationMs` after which it
  deactivates automatically even if `stop()` is never called.

---

## 4. Fault Catalogue

| Fault type | Effect | Key params |
|---|---|---|
| `network_latency` | Adds artificial RTT to outbound calls | `addedLatencyMs` |
| `network_partition` | Blocks all traffic to a dependency | — |
| `db_connection_exhaust` | Holds all pool connections | — |
| `db_slow_query` | Delays every query response | `delayMs` |
| `redis_latency` | Injects latency into Redis commands | `delayMs` |
| `redis_unavailable` | Makes all Redis calls throw ECONNREFUSED | — |
| `process_cpu_spike` | Busy-loops to saturate one CPU | — |
| `billing_compute_delay` | Delays the `computeFinalization` callback | `delayMs` |
| `billing_state_flip` | Forces an unexpected state on a cycle row | `targetState` |
| `payload_corruption` | Corrupts a fraction of inbound telemetry bytes | `corruptionRate` |

---

## 5. Billing Correctness Invariants

These invariants are hard-coded into `ExperimentRunner`. Any experiment that
violates them fails immediately with a descriptive error — the recovery phase
is skipped.

1. **No double-finalization.** `doubleFinalizationCount === 0` in every phase.
   - Enforced by `InMemoryBillingCycleStore.applyTransition` (optimistic CAS).
   - In production by `PgBillingCycleStore` (`UPDATE … WHERE state=? AND lock_version=?`).

2. **Exactly-once computation.** `spuriousComputations === 0` in every phase.
   - The billing computation only runs after winning the OPEN→FINALIZING CAS.

3. **Idempotency.** Replayed finalization attempts (same `idempotencyKey`) are
   no-ops enforced by the unique constraint on `billing_finalization_log`.

---

## 6. Experiment Library

### 6.1 DB Slow Query

**Hypothesis:** Billing correctness holds; P99 recovers below 200 ms after the
fault clears.

```ts
{
  name: 'db-slow-query',
  faults: [{ type: 'db_slow_query', durationMs: 800, params: { delayMs: 30 } }],
  steadyStateHypothesis: (m) =>
    m.doubleFinalizationCount === 0 &&
    m.spuriousComputations === 0 &&
    m.billingLatency.p99Ms < 200,
}
```

### 6.2 Billing Compute Delay

**Hypothesis:** No double-finalization when the `computeFinalization` callback
is slow (simulating a delayed Soroban transaction).

```ts
{
  name: 'billing-compute-delay',
  faults: [{ type: 'billing_compute_delay', durationMs: 800, params: { delayMs: 20 } }],
  steadyStateHypothesis: (m) => m.doubleFinalizationCount === 0,
}
```

### 6.3 Network Latency Spike

**Hypothesis:** System recovers to P99 < 200 ms after 50 ms added latency clears.

```ts
{
  name: 'network-latency-spike',
  faults: [{ type: 'network_latency', durationMs: 800, params: { addedLatencyMs: 50 } }],
  steadyStateHypothesis: (m) => m.billingLatency.p99Ms < 200,
}
```

### 6.4 Compound Fault (Compute Delay + Network Latency)

**Hypothesis:** Billing correctness holds under simultaneous compute and
network pressure.

### 6.5 High-Concurrency Race (100 cycles × 15 workers)

**Hypothesis:** Exactly one finalization per cycle with zero spurious
computations.

---

## 7. Monitoring and Alerting

Chaos activity is surfaced through the existing Prometheus + Grafana stack.

### 7.1 New metrics (`chaos_*`)

| Metric | Type | Description |
|---|---|---|
| `chaos_experiments_total` | Counter | Experiments run, labelled `experiment` + `result` |
| `chaos_fault_activations_total` | Counter | Fault activations by `fault_type` |
| `chaos_phase_active` | Gauge | 0=none, 1=baseline, 2=fault_injection, 3=recovery |
| `chaos_p99_billing_latency_ms` | Gauge | P99 billing latency by `phase` |
| `chaos_double_finalization_total` | Counter | **MUST stay 0** |
| `chaos_spurious_computations_total` | Counter | **MUST stay 0** |

### 7.2 Recommended Grafana alerts

```yaml
# Alert immediately on any billing correctness violation
- alert: ChaosDoubleFinalisation
  expr: increase(chaos_double_finalization_total[5m]) > 0
  severity: critical

- alert: ChaosSpuriousComputation
  expr: increase(chaos_spurious_computations_total[5m]) > 0
  severity: critical

# Alert if P99 does not recover within 60 s of fault clearance
- alert: ChaosP99SloBreached
  expr: chaos_p99_billing_latency_ms{phase="recovery"} > 200
  for: 60s
  severity: warning
```

---

## 8. Deployment

### 8.1 Environment variables (staging only)

```env
CHAOS_ENABLED=true          # Required — activateFault() throws without this
```

### 8.2 Running experiments

```bash
# Unit-level experiments (in-process, CI-safe)
npm test -- tests/unit/chaos/

# Full test suite including chaos
npm test
```

### 8.3 CI integration

The chaos unit tests run as part of `backend-unit-tests` in the existing
monorepo CI workflow (`.github/workflows/ci.yml`). No additional workflow
changes are required for unit-level experiments.

The `CHAOS_ENABLED=true` environment variable is set only within the test
runner process (via `beforeEach`) and never exported to the global CI
environment.

---

## 9. Runbook

### An experiment fails in CI

1. Check which invariant was violated: `doubleFinalizationCount` or
   `spuriousComputations`.
2. If correctness was violated: investigate `billing_cycle_repository.ts`
   CAS logic — likely a lock-version regression.
3. If only the P99 hypothesis failed: check for a slow DB migration, GC
   pause, or resource contention in the CI runner.

### Adding a new experiment

1. Define a `ChaosExperiment` object in `tests/unit/chaos/billing_chaos.test.ts`.
2. Pick the appropriate `FaultConfig` types from the fault catalogue (§4).
3. Write a `steadyStateHypothesis` that captures your SLO.
4. Run locally with `npm test -- tests/unit/chaos/` and confirm it passes.

### Promoting to staging integration

1. Replace `InMemoryBillingCycleStore` with `PgBillingCycleStore` backed by
   the staging Postgres pool in the driver options.
2. Set `CHAOS_ENABLED=true` in the staging deployment.
3. Add a step to the staging smoke-test job that calls `runExperiment`.

---

## 10. Security and Compliance Notes

- Chaos experiments are strictly opt-in via `CHAOS_ENABLED=true`.
- The guard is enforced in `fault_injector.ts`; there is no code path to
  bypass it without modifying source.
- No experiment mutates persistent storage directly — faults alter in-process
  behaviour; the billing state machine and idempotency log are unaffected.
- All finalization idempotency keys are UUIDv7 (time-ordered, unpredictable
  within the same millisecond), satisfying uniqueness requirements.
- Experiment results are ephemeral (in-memory metrics + Prometheus). No PII
  or billing data is written to chaos output.
