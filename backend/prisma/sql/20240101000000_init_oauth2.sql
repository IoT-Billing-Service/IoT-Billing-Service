-- Migration: issue #57 — OAuth2 Integration for Third-Party Billing Access
-- Creates three tables that implement the OAuth 2.0 Authorization Code + PKCE
-- flow for delegated read/write access to the IoT billing platform.
--
-- Security properties baked into the schema:
--   • client_secret_hash  — bcrypt hash only; plaintext never stored.
--   • code_hash           — SHA-256 of the raw auth code; plaintext not stored.
--   • token_hash          — SHA-256 of the raw bearer token; plaintext not stored.
--   • code_challenge      — PKCE S256 verifier hash to prevent auth-code interception.
--   • revoked_at          — soft-revocation; rows are never hard-deleted so the
--                           audit trail survives for PCI-DSS / SOC2 compliance.

-- ----------------------------------------------------------------------------
-- oauth2_clients
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "oauth2_clients" (
    "id"                   TEXT        NOT NULL,
    "name"                 TEXT        NOT NULL,
    "client_secret_hash"   TEXT,
    "redirect_uris"        TEXT        NOT NULL,
    "allowed_scopes"       TEXT        NOT NULL,
    "active"               BOOLEAN     NOT NULL DEFAULT true,
    "owner_wallet"         TEXT        NOT NULL,
    "created_at"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "oauth2_clients_pkey" PRIMARY KEY ("id")
);

-- ----------------------------------------------------------------------------
-- oauth2_auth_codes
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "oauth2_auth_codes" (
    "id"                     TEXT        NOT NULL,
    "client_id"              TEXT        NOT NULL,
    "wallet_address"         TEXT        NOT NULL,
    "redirect_uri"           TEXT        NOT NULL,
    "granted_scopes"         TEXT        NOT NULL,
    "code_challenge"         TEXT        NOT NULL,
    "code_challenge_method"  TEXT        NOT NULL DEFAULT 'S256',
    "code_hash"              TEXT        NOT NULL,
    "used"                   BOOLEAN     NOT NULL DEFAULT false,
    "expires_at"             TIMESTAMPTZ NOT NULL,
    "created_at"             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "oauth2_auth_codes_pkey"      PRIMARY KEY ("id"),
    CONSTRAINT "oauth2_auth_codes_code_hash" UNIQUE ("code_hash")
);

CREATE INDEX IF NOT EXISTS "oauth2_auth_codes_client_id_idx"      ON "oauth2_auth_codes" ("client_id");
CREATE INDEX IF NOT EXISTS "oauth2_auth_codes_wallet_address_idx" ON "oauth2_auth_codes" ("wallet_address");

ALTER TABLE "oauth2_auth_codes"
    ADD CONSTRAINT "oauth2_auth_codes_client_id_fkey"
    FOREIGN KEY ("client_id")
    REFERENCES "oauth2_clients" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- oauth2_tokens
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "oauth2_tokens" (
    "id"               TEXT        NOT NULL,
    "client_id"        TEXT        NOT NULL,
    "wallet_address"   TEXT        NOT NULL,
    "token_type"       TEXT        NOT NULL,   -- 'access' | 'refresh'
    "token_hash"       TEXT        NOT NULL,
    "scopes"           TEXT        NOT NULL,
    "expires_at"       TIMESTAMPTZ NOT NULL,
    "revoked_at"       TIMESTAMPTZ,
    "parent_token_id"  TEXT,
    "created_at"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "oauth2_tokens_pkey"       PRIMARY KEY ("id"),
    CONSTRAINT "oauth2_tokens_token_hash" UNIQUE ("token_hash")
);

CREATE INDEX IF NOT EXISTS "oauth2_tokens_client_id_idx"      ON "oauth2_tokens" ("client_id");
CREATE INDEX IF NOT EXISTS "oauth2_tokens_wallet_address_idx" ON "oauth2_tokens" ("wallet_address");
CREATE INDEX IF NOT EXISTS "oauth2_tokens_token_type_idx"     ON "oauth2_tokens" ("token_type");

ALTER TABLE "oauth2_tokens"
    ADD CONSTRAINT "oauth2_tokens_client_id_fkey"
    FOREIGN KEY ("client_id")
    REFERENCES "oauth2_clients" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "oauth2_tokens"
    ADD CONSTRAINT "oauth2_tokens_parent_token_id_fkey"
    FOREIGN KEY ("parent_token_id")
    REFERENCES "oauth2_tokens" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
