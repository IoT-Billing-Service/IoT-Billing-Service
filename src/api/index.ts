import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { PrismaClient } from '@prisma/client';
import { getEnv } from '../config/env.js';
import { initTelemetry, shutdownTelemetry } from '../core/diagnostics/otel.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAnalyticsRoutes } from './routes/analytics.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerTracingHooks } from './middleware/tracing.js';
import { TelemetryNotificationListener, closeTimescalePool } from '../database/pool_manager.js';
import { LedgerEventSynchronizer } from '../core/blockchain/event_listener.js';
import { registerCircuitHealth } from './health.js';

export async function buildApp(): Promise<FastifyInstance> {
  const env = getEnv();

  const app = Fastify({
    logger: true,
    bodyLimit: env.MAX_PAYLOAD_SIZE_BYTES,
  });

  registerTracingHooks(app);

  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  app.get('/health', () => {
    return { status: 'ok', timestamp: Date.now() };
  });

  registerAuthRoutes(app);
  registerAnalyticsRoutes(app);
  registerCircuitHealth(app);

  return app;
}

async function start(): Promise<void> {
  initTelemetry();

  const env = getEnv();
  const app = await buildApp();

  const prisma = new PrismaClient();
  const synchronizer = new LedgerEventSynchronizer(prisma, env.SOROBAN_RPC_URL, {
    startingLedger: env.LEDGER_START,
    concurrency: env.LEDGER_SYNC_CONCURRENCY,
  });

  registerAdminRoutes(app, synchronizer);

  const listener = new TelemetryNotificationListener();
  await listener.start();
  await synchronizer.start();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`Received ${signal}, shutting down`);
    synchronizer.stop();
    await listener.stop();
    await closeTimescalePool();
    await app.close();
    await prisma.$disconnect();
    await shutdownTelemetry();
    process.exit(0);
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    console.log(`Server running on ${env.HOST}:${String(env.PORT)}`);
  } catch (err) {
    app.log.error(err);
    synchronizer.stop();
    await listener.stop();
    await closeTimescalePool();
    await prisma.$disconnect();
    await shutdownTelemetry();
    process.exit(1);
  }
}

const isDirectEntry =
  process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url);

if (isDirectEntry) {
  void start();
}
