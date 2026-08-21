# Configurable Billing Cycles and Pro-Rata Charges

**Status:** Implemented

## Design

Each `BillingCycle` stores `cycleUnit` and an optional `customDurationMs` in
addition to its materialized UTC `periodStart` and `periodEnd`. Supported units
are daily, weekly, monthly, annual, and custom. Calendar units use UTC calendar
arithmetic; custom cycles require a positive safe integer duration. Materializing
the window makes invoice and audit queries deterministic even if configuration
changes later.

`resolveBillingCycleWindow()` is the single source of truth for deriving the
window. `calculateProratedChargeAt()` computes the elapsed fraction with integer
micro-units and floor rounding, capped at the cycle end. No floating-point
currency arithmetic or database access is used in the hot calculation path.

## Integrity and compliance

Usage units, rates, balances, and durations are rejected when negative,
non-finite, or outside safe integer bounds. Estimates include a SHA-256 digest
over their output fields; settlement and dispute workflows must call
`verifyEstimateIntegrity()` before trusting a transmitted or cached estimate.
Device usage transactions continue to require the existing Ed25519/EIP-712
verification and nonce replay protection. Billing-cycle finalization remains
idempotent through the unique finalization key and optimistic state transition.

The append-only finalization log, materialized cycle window, pricing-table
digest, and deployment audit trail provide the evidence needed for PCI-DSS and
SOC2 review. Payment card data must remain outside this service; only token or
ledger references belong in billing records.

## Performance and monitoring

The estimator is O(1), synchronous, and uses bounded BigInt arithmetic. The
existing `billing_operation_duration_ms` histogram is the SLO source for the
less-than-200ms P99 target. Alert when the P99 exceeds 200ms for 10 minutes,
when finalization errors increase, or when integrity verification fails.
Prometheus metrics and OpenTelemetry traces remain enabled through the existing
backend deployment manifests and `/metrics` endpoint.

## Rollout and rollback

1. Apply `20260820000000_configurable_billing_cycles.sql` and regenerate the
   Prisma client.
2. Deploy the backend with the normal Render/Railway migration command.
3. Backfill or create cycles with an explicit unit; keep existing cycles on the
   monthly default until audited.
4. Verify the health endpoint, metrics endpoint, billing P99, signature errors,
   and digest verification failures before enabling non-monthly plans.

Rollback is application-first: stop creating new non-monthly cycles and deploy
the previous backend. The additive columns are retained so already materialized
windows and audit records remain readable; remove them only in a separately
approved destructive migration.

## Tests

The unit suite covers UTC daily and weekly windows, calendar-month behavior,
custom windows, pro-rata floor/cap behavior, invalid inputs, usage projection,
prepaid balance warnings, and estimate tamper detection.