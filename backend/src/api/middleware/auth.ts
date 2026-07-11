import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifySessionToken, secondsUntilExpiry, type SessionPayload } from '../auth/session.js';
import { getRedis } from '../../database/redis.js';
import { getEnv } from '../../config/env.js';

declare module 'fastify' {
  interface FastifyRequest {
    session?: SessionPayload;
  }
}

const REFRESH_URL = '/api/auth/refresh';

/**
 * Attach proactive-refresh hint headers when a still-valid token is close to
 * expiry (issue #59). The device can refresh asynchronously while continuing to
 * send telemetry, avoiding a hard 401 + reconnect at the TTL boundary.
 */
function setRefreshHintHeaders(reply: FastifyReply, secondsLeft: number, hintWindow: number): void {
  if (secondsLeft <= hintWindow) {
    void reply.header('X-Token-Refresh', REFRESH_URL);
    void reply.header('X-Token-Expires-In', String(Math.max(0, secondsLeft)));
  }
}

/**
 * Fastify preHandler that verifies a Bearer JWT and attaches the
 * decoded session payload to `request.session`. Sends 401 and aborts
 * the request on missing/invalid/expired tokens.
 *
 * A short grace period (issue #59) keeps recently-expired tokens usable once,
 * flagged with `X-Token-Expiring: true`, so a frame arriving just after expiry
 * is not dropped and the device can refresh out-of-band.
 */
export async function verifyJwt(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization;
  if (header === undefined) {
    await reply.status(401).send({
      error: 'Unauthorized',
      message: 'Missing or malformed Authorization header',
    });
    return;
  }
  if (!header.startsWith('Bearer ')) {
    await reply.status(401).send({
      error: 'Unauthorized',
      message: 'Missing or malformed Authorization header',
    });
    return;
  }
  const token = header.slice('Bearer '.length).trim();
  if (token.length === 0) {
    await reply.status(401).send({
      error: 'Unauthorized',
      message: 'Empty Bearer token',
    });
    return;
  }
  const env = getEnv();
  const payload = verifySessionToken(token, false);
  if (payload !== null) {
    request.session = payload;
    setRefreshHintHeaders(reply, secondsUntilExpiry(payload), env.TOKEN_REFRESH_HINT_SECONDS);
    return;
  }

  // Token is not valid as-is: either malformed/forged, or merely expired.
  const expiredPayload = verifySessionToken(token, true);
  if (expiredPayload === null) {
    // Bad signature or structurally invalid — never honoured.
    await reply.status(401).send({
      error: 'Unauthorized',
      message: 'Invalid or expired token',
    });
    return;
  }

  // A refresh already in flight: ask the client to retry rather than stampede.
  const redis = getRedis();
  const lockKey = `refresh_lock:${expiredPayload.session_id}`;
  const isLocked = await redis.exists(lockKey);
  if (isLocked) {
    await reply.header('Retry-After', '1').status(429).send({
      error: 'Too Many Requests',
      message: 'Session refresh in progress',
    });
    return;
  }

  // Grace period: honour a token expired by no more than the configured window
  // once, signalling the client to refresh asynchronously (issue #59).
  const secondsSinceExpiry = -secondsUntilExpiry(expiredPayload);
  if (secondsSinceExpiry >= 0 && secondsSinceExpiry <= env.TOKEN_GRACE_PERIOD_SECONDS) {
    request.session = expiredPayload;
    void reply.header('X-Token-Expiring', 'true');
    void reply.header('X-Token-Refresh', REFRESH_URL);
    return;
  }

  await reply.status(401).send({
    error: 'Unauthorized',
    message: 'Invalid or expired token',
  });
}
