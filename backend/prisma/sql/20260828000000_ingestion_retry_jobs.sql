-- Fault-Tolerant Telemetry Ingestion with Retry Logic (issue #292).
--
-- Durable retry queue for validated telemetry payloads whose persistence
-- failed transiently. A row is inserted ONLY AFTER the payload has passed the
-- full cryptographic verification pipeline (PoW, Ed25519 signature + nonce,
-- ZK range proof, metric bounds), so the retry worker can safely re-persist
-- the stored request without re-running the expensive checks.
--
-- Security / compliance notes (PCI-DSS, SOC2):
--   • `state_data` stores the verified request plus a SHA-256 payload digest;
--     the worker re-verifies the digest and the Ed25519 signature before
--     persisting, so a tampered queued payload can never be written.
--   • The table is append-only in practice: rows transition through
--     pending -> processing -> completed | failed and are never hard-deleted,
--     preserving an audit trail of every deferred ingestion.
--   • `(status, next_attempt_at)` is indexed so the worker can claim due jobs
--     with a single indexed range scan on every poll.

CREATE TABLE IF NOT EXISTS ingestion_jobs (
    id              TEXT        NOT NULL,
    device_id       TEXT        NOT NULL,
    status          TEXT        NOT NULL DEFAULT 'pending',
    retry_count     INTEGER     NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error      TEXT,
    state_data      JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ingestion_jobs_pkey PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS ingestion_jobs_status_next_attempt_idx
    ON ingestion_jobs (status, next_attempt_at);
