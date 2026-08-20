-- Dynamic Pricing Based on Network Congestion Audit Logs Migration (issue #296)
-- PCI-DSS & SOC2 compliant immutable transaction audit table for network congestion pricing.

CREATE TABLE IF NOT EXISTS congestion_pricing_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id VARCHAR(255),
    congestion_score NUMERIC(5, 4) NOT NULL CHECK (congestion_score >= 0 AND congestion_score <= 1.0),
    congestion_level VARCHAR(32) NOT NULL CHECK (congestion_level IN ('LOW', 'NORMAL', 'HIGH', 'CRITICAL')),
    multiplier NUMERIC(5, 4) NOT NULL CHECK (multiplier > 0),
    base_charge_micros BIGINT NOT NULL CHECK (base_charge_micros >= 0),
    adjusted_charge_micros BIGINT NOT NULL CHECK (adjusted_charge_micros >= 0),
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    digest VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for device audit trails and timestamp range queries
CREATE INDEX IF NOT EXISTS idx_congestion_audit_device_applied ON congestion_pricing_audit_logs (device_id, applied_at DESC);
CREATE INDEX IF NOT EXISTS idx_congestion_audit_level ON congestion_pricing_audit_logs (congestion_level);
CREATE INDEX IF NOT EXISTS idx_congestion_audit_digest ON congestion_pricing_audit_logs (digest);
