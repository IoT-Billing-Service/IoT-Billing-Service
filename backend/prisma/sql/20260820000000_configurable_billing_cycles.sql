-- Configurable billing cycles and pro-rata support.
-- Existing rows remain monthly-compatible because cycle_unit defaults to monthly.

ALTER TABLE billing_cycles
  ADD COLUMN IF NOT EXISTS cycle_unit TEXT NOT NULL DEFAULT 'monthly',
  ADD COLUMN IF NOT EXISTS custom_duration_ms BIGINT;

ALTER TABLE billing_cycles
  DROP CONSTRAINT IF EXISTS billing_cycles_cycle_unit_check;

ALTER TABLE billing_cycles
  ADD CONSTRAINT billing_cycles_cycle_unit_check
  CHECK (cycle_unit IN ('daily', 'weekly', 'monthly', 'annual', 'custom'));

ALTER TABLE billing_cycles
  DROP CONSTRAINT IF EXISTS billing_cycles_custom_duration_check;

ALTER TABLE billing_cycles
  ADD CONSTRAINT billing_cycles_custom_duration_check
  CHECK (
    (cycle_unit = 'custom' AND custom_duration_ms IS NOT NULL AND custom_duration_ms > 0)
    OR (cycle_unit <> 'custom' AND custom_duration_ms IS NULL)
  );

COMMENT ON COLUMN billing_cycles.cycle_unit IS
  'UTC billing-cycle unit used to derive period_end and pro-rata denominator';
COMMENT ON COLUMN billing_cycles.custom_duration_ms IS
  'Positive duration in milliseconds, required only when cycle_unit is custom';