import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  extractTenantId,
  isPoolContentionError,
  sendPoolContentionResponse,
} from '../../src/api/middleware/tenant.js';
import { PoolContentionError } from '../../src/database/pool_manager.js';

describe('tenant middleware', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = Fastify();
    app.get('/tenant-check', { preHandler: extractTenantId }, (request) => {
      return { tenantId: request.tenantId };
    });
  });

  it('extracts x-tenant-id header', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/tenant-check',
      headers: { 'x-tenant-id': 'acme-corp' },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ tenantId: 'acme-corp' });
  });

  it('returns 400 when x-tenant-id is missing', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/tenant-check',
    });

    expect(response.statusCode).toBe(400);
  });

  it('maps PoolContentionError to 429 response', async () => {
    app.get('/contention', async (_request, reply) => {
      const error = new PoolContentionError('acme', 501);
      if (isPoolContentionError(error)) {
        await sendPoolContentionResponse(reply, error);
        return;
      }
      await reply.status(500).send({ error: 'unexpected' });
    });

    const response = await app.inject({
      method: 'GET',
      url: '/contention',
    });

    expect(response.statusCode).toBe(429);
    const body = JSON.parse(response.body) as { tenantId: string; waitMs: number };
    expect(body.tenantId).toBe('acme');
    expect(body.waitMs).toBe(501);
  });
});
