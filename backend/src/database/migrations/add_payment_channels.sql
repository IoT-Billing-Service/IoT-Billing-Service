-- Peer-to-Peer Payment Channels for Microtransactions Migration (issue #295)
-- PCI-DSS & SOC2 compliant schema for off-chain cryptographically verified payment channels.

CREATE TABLE IF NOT EXISTS payment_channels (
    id VARCHAR(255) PRIMARY KEY,
    channel_id VARCHAR(255) UNIQUE NOT NULL,
    sender_address VARCHAR(255) NOT NULL,
    recipient_address VARCHAR(255) NOT NULL,
    total_deposit BIGINT NOT NULL CHECK (total_deposit >= 0),
    settled_amount BIGINT NOT NULL DEFAULT 0 CHECK (settled_amount >= 0),
    sequence INT NOT NULL DEFAULT 0,
    status VARCHAR(32) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSING', 'DISPUTED', 'SETTLED', 'EXPIRED')),
    dispute_period_seconds INT NOT NULL DEFAULT 86400,
    dispute_expires_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_channel_vouchers (
    id VARCHAR(255) PRIMARY KEY,
    channel_id VARCHAR(255) NOT NULL REFERENCES payment_channels(channel_id) ON DELETE CASCADE,
    sequence INT NOT NULL CHECK (sequence > 0),
    cumulative_amount BIGINT NOT NULL CHECK (cumulative_amount >= 0),
    nonce VARCHAR(255) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    signature TEXT NOT NULL,
    signer_public_key VARCHAR(255) NOT NULL,
    digest VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_channel_sequence UNIQUE (channel_id, sequence)
);

CREATE TABLE IF NOT EXISTS payment_channel_disputes (
    id VARCHAR(255) PRIMARY KEY,
    channel_id VARCHAR(255) NOT NULL REFERENCES payment_channels(channel_id) ON DELETE CASCADE,
    initiated_by VARCHAR(255) NOT NULL,
    claimed_sequence INT NOT NULL CHECK (claimed_sequence >= 0),
    claimed_amount BIGINT NOT NULL CHECK (claimed_amount >= 0),
    challenge_deadline TIMESTAMPTZ NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RESOLVED', 'OVERRULED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- High throughput indexes
CREATE INDEX IF NOT EXISTS idx_payment_channels_sender ON payment_channels(sender_address);
CREATE INDEX IF NOT EXISTS idx_payment_channels_recipient ON payment_channels(recipient_address);
CREATE INDEX IF NOT EXISTS idx_payment_channels_status ON payment_channels(status);
CREATE INDEX IF NOT EXISTS idx_payment_channel_vouchers_channel ON payment_channel_vouchers(channel_id);
CREATE INDEX IF NOT EXISTS idx_payment_channel_disputes_channel_status ON payment_channel_disputes(channel_id, status);
