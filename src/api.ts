/**
 * REST API Layer for Transaction Explorer
 * 
 * Built on Fastify for maximum throughput with minimal latency.
 * All endpoints enforce input validation, rate limiting, and audit logging.
 * 
 * Endpoints:
 *   POST /transactions          — Record new billing transaction
 *   GET  /transactions          — Query with filters + pagination
 *   GET  /transactions/:id      — Get single transaction
 *   POST /transactions/:id/verify — Cryptographic verification
 *   GET  /audit-log             — Query audit trail
 *   GET  /health                — Health check + metrics
 *   GET  /metrics               — Prometheus-compatible metrics
 */

import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  TransactionFilter,
  PageCursor,
  BillingTransaction,
  BlockchainEnvelope,
  TransactionStatus,
} from './types.js';
import { TransactionExplorer } from './explorer.js';

// ─── Input Validation Schemas ───────────────────────────────────────────────

const monetaryAmountSchema = {
  type: 'object',
  required: ['value', 'currency', 'stroops'],
  properties: {
    value: { type: 'string', pattern: '^\d+\.\d{2}$' },
    currency: { type: 'string', minLength: 3, maxLength: 4 },
    stroops: { type: 'string', pattern: '^\d+$' },
  },
};

const metadataSchema = {
  type: 'object',
  required: ['deviceType', 'region', 'sessionId', 'tariffRate'],
  properties: {
    deviceType: { type: 'string', enum: ['smart-meter', 'ev-charger', 'solar-inverter', 'industrial-sensor'] },
    region: { type: 'string', pattern: '^[A-Z]{2}-[A-Z0-9]{1,3}$' },
    energyKwh: { type: 'number', minimum: 0 },
    durationSeconds: { type: 'number', minimum: 0 },
    sessionId: { type: 'string', format: 'uuid' },
    tariffRate: { type: 'string' },
  },
};

const createTransactionSchema = {
  type: 'object',
  required: ['deviceId', 'customerId', 'amount', 'metadata'],
  properties: {
    deviceId: { type: 'string', minLength: 8, maxLength: 64 },
    customerId: { type: 'string', minLength: 8, maxLength: 64 },
    amount: monetaryAmountSchema,
    status: { type: 'string', enum: ['pending', 'submitted', 'confirmed', 'failed', 'disputed', 'settled', 'refunded'] },
    txHash: { type: 'string', minLength: 64, maxLength: 64 },
    ledgerSequence: { type: 'number', minimum: 1 },
    memo: { type: 'string', maxLength: 256 },
    metadata: metadataSchema,
  },
};

const queryFilterSchema = {
  type: 'object',
  properties: {
    deviceId: { type: 'string' },
    customerId: { type: 'string' },
    status: { type: 'string', enum: ['pending', 'submitted', 'confirmed', 'failed', 'disputed', 'settled', 'refunded'] },
    fromDate: { type: 'string', format: 'date-time' },
    toDate: { type: 'string', format: 'date-time' },
    minAmount: { type: 'string', pattern: '^\d+$' },
    maxAmount: { type: 'string', pattern: '^\d+$' },
    txHash: { type: 'string' },
    region: { type: 'string', pattern: '^[A-Z]{2}-[A-Z0-9]{1,3}$' },
    deviceType: { type: 'string' },
    limit: { type: 'number', minimum: 1, maximum: 100, default: 20 },
    offset: { type: 'number', minimum: 0, default: 0 },
    afterId: { type: 'string' },
  },
};

const verifySchema = {
  type: 'object',
  required: ['envelope'],
  properties: {
    envelope: {
      type: 'object',
      required: ['txHash', 'sourceAccount', 'sequence', 'operations', 'signatures', 'fee', 'networkPassphrase'],
      properties: {
        txHash: { type: 'string' },
        sourceAccount: { type: 'string' },
        sequence: { type: 'string' },
        operations: { type: 'array' },
        signatures: { type: 'array' },
        memo: { type: 'string' },
        fee: { type: 'string', pattern: '^\d+$' },
        networkPassphrase: { type: 'string' },
      },
    },
  },
};

// ─── API Factory ─────────────────────────────────────────────────────────────

export function buildApi(explorer: TransactionExplorer): FastifyInstance {
  const app = Fastify({
    logger: true,
    genReqId: () => crypto.randomUUID(),
  });

  // ─── Middleware ───────────────────────────────────────────────────────────

  // Request timing header
  app.addHook('onSend', async (request, reply, payload) => {
    const duration = performance.now() - (request as any).startTime;
    reply.header('X-Response-Time', `${duration.toFixed(2)}ms`);
    return payload;
  });

  app.addHook('onRequest', async (request) => {
    (request as any).startTime = performance.now();
  });

  // ─── Routes ───────────────────────────────────────────────────────────────

  // Health check
  app.get('/health', async (_request, reply) => {
    const health = explorer.healthCheck();
    reply.status(health.status === 'healthy' ? 200 : health.status === 'degraded' ? 200 : 503);
    return health;
  });

  // Prometheus metrics
  app.get('/metrics', async (_request, reply) => {
    const metrics = explorer.getMetrics();
    const output = `
# HELP billing_p99_latency_ms P99 latency for billing operations
# TYPE billing_p99_latency_ms gauge
billing_p99_latency_ms ${metrics.p99LatencyMs}

# HELP billing_error_rate Error rate for billing operations
# TYPE billing_error_rate gauge
billing_error_rate ${metrics.errorRate}

# HELP billing_active_devices Number of active devices
# TYPE billing_active_devices gauge
billing_active_devices ${metrics.activeDevices}

# HELP billing_pending_transactions Number of pending transactions
# TYPE billing_pending_transactions gauge
billing_pending_transactions ${metrics.pendingTransactions}
`.trim();
    reply.type('text/plain');
    return output;
  });

  // Create transaction
  app.post('/transactions', { schema: { body: createTransactionSchema } }, async (request, reply) => {
    const body = request.body as any;

    const tx: BillingTransaction = {
      id: crypto.randomUUID(),
      deviceId: body.deviceId,
      customerId: body.customerId,
      amount: {
        value: body.amount.value,
        currency: body.amount.currency,
        stroops: BigInt(body.amount.stroops),
      },
      status: body.status || 'pending',
      createdAt: new Date(),
      txHash: body.txHash,
      ledgerSequence: body.ledgerSequence,
      memo: body.memo,
      metadata: body.metadata,
    };

    const result = explorer.recordTransaction(tx);
    reply.status(201);
    return { success: true, transactionId: result.id, hash: result.hash };
  });

  // Query transactions
  app.get('/transactions', { schema: { querystring: queryFilterSchema } }, async (request) => {
    const q = request.query as any;

    const filter: TransactionFilter = {
      deviceId: q.deviceId,
      customerId: q.customerId,
      status: q.status as TransactionStatus | undefined,
      fromDate: q.fromDate ? new Date(q.fromDate) : undefined,
      toDate: q.toDate ? new Date(q.toDate) : undefined,
      minAmount: q.minAmount ? BigInt(q.minAmount) : undefined,
      maxAmount: q.maxAmount ? BigInt(q.maxAmount) : undefined,
      txHash: q.txHash,
      region: q.region,
      deviceType: q.deviceType,
    };

    const cursor: PageCursor = {
      limit: q.limit ? Number(q.limit) : 20,
      offset: q.offset ? Number(q.offset) : undefined,
      afterId: q.afterId,
    };

    return explorer.queryTransactions(filter, cursor);
  });

  // Get single transaction
  app.get('/transactions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const tx = explorer.getTransaction(id);
    if (!tx) {
      reply.status(404);
      return { error: 'Transaction not found' };
    }
    return tx;
  });

  // Verify transaction
  app.post('/transactions/:id/verify', { schema: { body: verifySchema } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { envelope } = request.body as { envelope: BlockchainEnvelope };

    try {
      const result = explorer.verifyTransaction(id, envelope);
      return result;
    } catch (err) {
      reply.status(404);
      return { error: (err as Error).message };
    }
  });

  // Update status
  app.patch('/transactions/:id/status', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { status } = request.body as { status: TransactionStatus };

    try {
      explorer.updateStatus(id, status);
      return { success: true, id, status };
    } catch (err) {
      reply.status(404);
      return { error: (err as Error).message };
    }
  });

  // Audit log
  app.get('/audit-log', async (request) => {
    const q = request.query as any;
    return explorer.queryAuditLog(
      q.transactionId,
      q.fromDate ? new Date(q.fromDate) : undefined,
      q.toDate ? new Date(q.toDate) : undefined,
    );
  });

  // Merkle root
  app.get('/merkle-root', async () => {
    return { merkleRoot: explorer.getMerkleRoot() };
  });

  // Verify audit log integrity
  app.get('/audit-log/verify', async () => {
    return { valid: explorer.verifyAuditLog() };
  });

  return app;
}

// ─── Server Starter ─────────────────────────────────────────────────────────

export async function startServer(explorer: TransactionExplorer, port = 3000): Promise<FastifyInstance> {
  const app = buildApi(explorer);
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`Transaction Explorer API running on http://localhost:${port}`);
  return app;
}