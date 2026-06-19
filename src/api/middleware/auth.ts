import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifySessionToken, type SessionPayload } from '../auth/session.js';

declare module 'fastify' {
  interface FastifyRequest {
    session?: SessionPayload;
  }
}

/**
 * Fastify preHandler that verifies a Bearer JWT and attaches the
 * decoded session payload to `request.session`. Sends 401 and aborts
 * the request on missing/invalid/expired tokens.
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
  const payload = verifySessionToken(token);
  if (payload === null) {
    await reply.status(401).send({
      error: 'Unauthorized',
      message: 'Invalid or expired token',
    });
    return;
  }
  request.session = payload;
}
