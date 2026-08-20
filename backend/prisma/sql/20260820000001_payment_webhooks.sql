-- Durable, tenant-scoped webhook outbox for payment lifecycle events.
-- Secrets are stored as hashes; the encrypted secret is kept in the secret manager.

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  url TEXT NOT NULL,
  event_types TEXT[] NOT NULL,
  secret_hash TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhook_subscriptions_account_enabled_idx
  ON webhook_subscriptions (account_id, enabled);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES webhook_subscriptions(id),
  event_type TEXT NOT NULL,
  event_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, event_id)
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_ready_idx
  ON webhook_deliveries (status, next_attempt_at);