-- Migration: Geographic Pricing Tiers (issue #54)
-- Adds country_code to devices and a geo_pricing_snapshots audit table.

-- 1. Add country_code column to devices (nullable; existing devices fall back
--    to the ROW tier with a 1.0× multiplier until explicitly set).
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS country_code CHAR(2);

-- Index for fast region-based reporting queries.
CREATE INDEX IF NOT EXISTS idx_devices_country_code
  ON devices (country_code)
  WHERE country_code IS NOT NULL;

-- 2. Audit table for geo pricing snapshots captured at finalization time.
--    One row per billing cycle; cycleId is UNIQUE so there is at most one
--    snapshot per cycle, enforced at the DB level.
CREATE TABLE IF NOT EXISTS geo_pricing_snapshots (
  id            TEXT        NOT NULL PRIMARY KEY,
  cycle_id      TEXT        NOT NULL UNIQUE REFERENCES billing_cycles (id),
  table_digest  TEXT        NOT NULL,
  table_json    JSONB       NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE geo_pricing_snapshots IS
  'Audit log of pricing tier table state captured at billing cycle finalization (issue #54). '
  'The table_digest (SHA-256 hex) lets auditors verify the rate table was not mutated '
  'between charge calculation and settlement, satisfying PCI-DSS and SOC2 requirements.';
