-- Billing-cycle state machine schema (issue #42).
--
-- A billing cycle transitions OPEN -> FINALIZING -> FINALIZED -> SETTLED.
-- Concurrent finalization (event pipeline + scheduler) is made safe by an
-- optimistic-lock column: every state write is guarded by the row's current
-- lock_version and bumps it, so a lost update collapses to a 0-row UPDATE
-- rather than a duplicate finalization.
--
-- This DDL mirrors prisma/schema.prisma (models BillingCycle /
-- BillingFinalizationLog) and is safe to run standalone via psql; the Prisma
-- migration is the schema of record once `prisma migrate` is run against a DB.

CREATE TABLE IF NOT EXISTS billing_cycles (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts (id),
  state         TEXT NOT NULL DEFAULT 'OPEN'
                CHECK (state IN ('OPEN', 'FINALIZING', 'FINALIZED', 'SETTLED')),
  lock_version  INTEGER NOT NULL DEFAULT 1,
  period_start  TIMESTAMPTZ NOT NULL,
  period_end    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_cycles_state_idx ON billing_cycles (state);

-- Append-only idempotency log. The UNIQUE constraint on idempotency_key makes
-- a replayed finalization a no-op (INSERT ... ON CONFLICT DO NOTHING).
CREATE TABLE IF NOT EXISTS billing_finalization_log (
  id              TEXT PRIMARY KEY,
  cycle_id        TEXT NOT NULL REFERENCES billing_cycles (id),
  idempotency_key TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT billing_finalization_log_idempotency_key_key UNIQUE (idempotency_key)
);

-- Optional link from a produced record back to the cycle that finalized it.
ALTER TABLE billing_records
  ADD COLUMN IF NOT EXISTS cycle_id TEXT REFERENCES billing_cycles (id);
