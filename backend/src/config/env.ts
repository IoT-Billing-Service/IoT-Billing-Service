import dotenv from 'dotenv';
import { z } from 'zod';
import { compactPath, formatZodIssues } from '../core/utils/zod_path.js';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  TIMESCALEDB_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  SOROBAN_RPC_URL: z.string().url(),
  SOROBAN_NETWORK_PASSPHRASE: z.string(),
  CONTRACT_ID: z.string().optional(),
  ADMIN_SECRET_KEY: z.string().optional(),
  JWT_SECRET: z.string().min(32),
  // Legacy informational value; access-token lifetime is now driven by the
  // jittered, keepalive-aligned settings below (issue #59).
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  CHALLENGE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  // --- Session lifecycle / WebSocket keepalive alignment (issue #59) ---------
  // The WebSocket keepalive interval. The access-token lifetime must comfortably
  // exceed this so a token can never expire silently between two keepalive
  // pings (invariant: token_expiry > last_frame_timestamp + keepalive).
  WS_KEEPALIVE_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  // Base access-token TTL, aligned with the keepalive interval
  // (keepalive * N + buffer). Default 1260s (21m) keeps the token valid across
  // many keepalive windows instead of the old 15m boundary that raced them.
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(1260),
  // Per-token random expiry spread. Each token expires at base + random(0,
  // jitter) seconds so 100k devices do not all expire on the same instant and
  // stampede the auth endpoint. Default spreads load across a 2-minute window.
  ACCESS_TOKEN_JITTER_SECONDS: z.coerce.number().int().nonnegative().default(120),
  // Tokens expired by no more than this are still honoured once, with an
  // `X-Token-Expiring` hint, so a device can refresh asynchronously without
  // dropping the in-flight telemetry frame.
  TOKEN_GRACE_PERIOD_SECONDS: z.coerce.number().int().nonnegative().default(30),
  // When a still-valid token is within this many seconds of expiry, the auth
  // layer asks the client to refresh proactively (via response headers).
  TOKEN_REFRESH_HINT_SECONDS: z.coerce.number().int().nonnegative().default(120),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().default('iot-billing-backend'),
  MAX_PAYLOAD_SIZE_BYTES: z.coerce.number().int().positive().default(65536),
  NONCE_WINDOW_MS: z.coerce.number().int().positive().default(5000),
  LEDGER_START: z.coerce.number().int().nonnegative().default(0),
  LEDGER_SYNC_CONCURRENCY: z.coerce.number().int().positive().default(10),
  SKIP_MIGRATION_ON_STARTUP: z.coerce.boolean().default(true),
  // Telemetry hypertable retention (must match add_retention_policy in
  // timescale_setup.sql) and a safety margin kept clear of the retention
  // boundary. Continuous-aggregate refreshes never touch data older than
  // (retention - margin) days, so a refresh can't race a chunk drop (issue #51).
  TELEMETRY_RETENTION_DAYS: z.coerce.number().int().positive().default(365),
  RETENTION_SAFETY_MARGIN_DAYS: z.coerce.number().int().nonnegative().default(5),
  TELEMETRY_TARGET_CHUNK_SIZE_GB: z.coerce.number().min(1).max(10).default(5),
  TELEMETRY_COMPRESSION_DAYS: z.coerce.number().int().positive().default(7),
  TELEMETRY_NUM_PARTITIONS: z.coerce.number().int().positive().default(8),

  // ---------------------------------------------------------------------------
  // OAuth2 — Issue #57: Third-party billing access
  // ---------------------------------------------------------------------------
  // Lifetime of the short-lived authorisation code (seconds). RFC 6749 §4.1.2
  // recommends ≤ 10 minutes; we default to 5 for tighter security.
  OAUTH2_AUTH_CODE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  // Lifetime of an issued OAuth2 access token (seconds). Default 15 minutes,
  // well under the 200ms P99 billing SLA — the token itself never touches the
  // hot path, only the verification step does.
  OAUTH2_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  // Lifetime of an OAuth2 refresh token (seconds). Default 30 days.
  OAUTH2_REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(2592000),
  // Signing secret for OAuth2 access tokens (HMAC-SHA256).  Must be at least
  // 32 bytes.  Defaults to the platform JWT_SECRET so single-secret deployments
  // work out of the box; production deployments SHOULD set a separate value.
  OAUTH2_TOKEN_SECRET: z.string().min(32).optional(),
  // Maximum number of active OAuth2 tokens per client (guards against runaway
  // token issuance that could indicate a compromised client_secret).
  OAUTH2_MAX_TOKENS_PER_CLIENT: z.coerce.number().int().positive().default(100),
});

export type Env = z.infer<typeof envSchema>;

/** One environment-validation failure, preserving the field, code, and reason. */
export interface EnvValidationIssue {
  path: string;
  code: string;
  message: string;
}

/**
 * Convert a {@link z.ZodError} into one structured entry per issue.
 *
 * Unlike `error.flatten()`, this preserves the issue `code` and the full,
 * compacted path for *every* failure, so no failing field is collapsed away or
 * hidden behind truncation. Callers can log each entry as its own structured
 * record. Built on the shared {@link formatZodIssues} helper.
 */
export function formatEnvIssues(error: z.ZodError): EnvValidationIssue[] {
  return formatZodIssues(error).map(({ path, code, message }) => ({ path, code, message }));
}

// Re-exported so existing callers (and tests) can import the path helper here.
export { compactPath };

let cachedEnv: Env | null = null;

export function loadEnv(): Env {
  if (cachedEnv) return cachedEnv;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = formatEnvIssues(parsed.error);
    const detail = issues.map((issue) => `  ${issue.path}: ${issue.message} (${issue.code})`);
    throw new Error(['Environment validation failed:', ...detail].join('\n'));
  }
  cachedEnv = parsed.data;
  return cachedEnv;
}

export function getEnv(): Env {
  if (!cachedEnv) return loadEnv();
  return cachedEnv;
}

export function clearEnvCache(): void {
  cachedEnv = null;
}
