import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { PrismaClient } from '@prisma/client';
import { getEnv } from '../config/env.js';
import {
  configureRuntimeConfigurationAudit,
  getRuntimeConfigurationAuditStatus,
  initializeConfigWatcher,
  stopConfigWatcher,
} from '../config/index.js';
import { getRedis } from '../database/redis.js';
import { initTelemetry, shutdownTelemetry } from '../core/diagnostics/otel.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAnalyticsRoutes } from './routes/analytics.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerGeoPricingRoutes } from './routes/geo_pricing.js';
import { registerOpsRoutes } from './routes/ops.js';
import { registerTracingHooks } from './middleware/tracing.js';
import {
  TelemetryNotificationListener,
  closeTimescalePool,
  getSharedPoolManager,
  getTenantPoolProxy,
  type ElasticPoolManager,
  runMigrationWithDistributedLock,
} from '../database/pool_manager.js';
import {
  LedgerEventSynchronizer,
  type LedgerPollEvent,
} from '../core/blockchain/event_listener.js';
import {
  recordLedgerSyncPollError,
  registerMetricsRoute,
  setLedgerSyncMetrics,
  recordBackupVerificationSuccess,
  recordBackupVerificationFailure,
  recordRestoreTestSuccess,
  recordRestoreTestFailure,
} from './metrics/prometheus.js';
import { registerCircuitHealth, registerBackupHealth } from './health.js';
import { GcPauseMonitor } from './metrics/gc_monitor.js';
import { PoolMetricsCollector } from './metrics/pool_metrics_collector.js';
import { getSseManager } from '../core/ingestion/sse_manager.js';
import { getReplicationMonitor } from '../replication/replication_monitor.js';
import { createIncidentResponseModule } from '../incident_response/index.js';
import { registerIncidentResponseRoutes } from '../incident_response/routes.js';
import { RenewalCron } from '../billing/renewal_cron.js';

const DEFAULT_LEDGER_SYNC_ID = 'primary';

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

  app.get('/health', (): { status: string; timestamp: number } => {
    return { status: 'ok', timestamp: Date.now() };
  });

  // Issue #19: expose Prometheus scrape endpoint before any business routes
  // so dashboards can begin collecting immediately on boot.
  registerMetricsRoute(app);

  registerAuthRoutes(app);
  registerAnalyticsRoutes(app);
  registerOpsRoutes(app);
  registerCircuitHealth(app);
  registerGeoPricingRoutes(app);

  // Initialise the SSE manager singleton early so the admin event-stream
  // endpoint can register clients immediately on first request.
  getSseManager();

  return app;
}

async function start(): Promise<void> {
  initTelemetry();

  await runMigrationWithDistributedLock();

  const env = getEnv();
  const authorizedKeys = parseRuntimeConfigurationKeys(env.RUNTIME_CONFIG_AUTHORIZED_KEYS);
  if (env.NODE_ENV === 'production' && authorizedKeys.size === 0) {
    throw new Error(
      'RUNTIME_CONFIG_AUTHORIZED_KEYS must contain an authorized Ed25519 key in production',
    );
  }
  const runtimeConfigAuditor = configureRuntimeConfigurationAudit(authorizedKeys);
  runtimeConfigAuditor.start(env.RUNTIME_CONFIG_AUDIT_SCAN_INTERVAL_MS);
  await initializeConfigWatcher(getRedis(), 1_000);
  if (env.NODE_ENV === 'production' && getRuntimeConfigurationAuditStatus().status !== 'healthy') {
    throw new Error(
      'Production startup requires a valid signed runtime configuration in Redis config:active',
    );
  }
  const app = await buildApp();

  const prisma = new PrismaClient();
  const renewalCron = new RenewalCron(buildPrismaSubscriptionStore(prisma));
  renewalCron.start();

  // Ensure the timescale pool is created so it shows up on Prometheus gauges
  // before any traffic arrives.
  getTenantPoolProxy();

  const synchronizer = new LedgerEventSynchronizer(prisma, env.SOROBAN_RPC_URL, {
    startingLedger: env.LEDGER_START,
    concurrency: env.LEDGER_SYNC_CONCURRENCY,
    // Wire issue #19 ledger_sync_lag metrics updates on every successful poll.
    onPoll: (event: LedgerPollEvent): void => {
      setLedgerSyncMetrics({
        syncId: DEFAULT_LEDGER_SYNC_ID,
        lag: event.lag,
        lastSyncedSequence: event.lastSyncedLedger,
        latestPolledSequence: event.latestSequence,
      });
    },
    onPollError: (): void => {
      recordLedgerSyncPollError(DEFAULT_LEDGER_SYNC_ID, 'poll');
    },
  });

  registerAdminRoutes(app, synchronizer);

  // Hook the ledger synchronizer's poll events into the SSE manager so
  // admin dashboards receive real-time sync status updates (issue #68).
  const sse = getSseManager();
  synchronizerPollToSse(synchronizer, sse);

  const listener = new TelemetryNotificationListener();
  await listener.start();
  await synchronizer.start();

  // Issue #19: start the GC and pool metrics collectors. Both `unref()` their
  // intervals so they never block graceful shutdown.
  const gcMonitor = new GcPauseMonitor();
  gcMonitor.start();

  const poolManager: ElasticPoolManager = getSharedPoolManager();
  const poolCollector = new PoolMetricsCollector(poolManager);
  poolCollector.start();

  // Issue #88: start the multi-region replication monitor. Uses the singleton
  // so the module-level state can be overridden in tests.
  const replicationMonitor = getReplicationMonitor();
  replicationMonitor.start();

  // Issue #85: Incident Response Runbook Automation with PagerDuty Integration.
  // Initialise the module and register admin API routes.
  const incidentResponseConfig = {
    pagerDuty: {
      routingKey: process.env['PAGERDUTY_ROUTING_KEY'] ?? '',
      apiBaseUrl: process.env['PAGERDUTY_API_BASE_URL'],
    },
    detectionIntervalMs: Number(process.env['INCIDENT_DETECTION_INTERVAL_MS']) || 30_000,
    maxConcurrentExecutions: Number(process.env['INCIDENT_MAX_CONCURRENT_EXECUTIONS']) || 10,
    autoResolveEnabled: true,
    autoResolveGracePeriodMs: 60_000,
  };

  const incidentResponse = createIncidentResponseModule(incidentResponseConfig);
  registerIncidentResponseRoutes(app, incidentResponse.engine, incidentResponse.detector);
  incidentResponse.start();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`Received ${signal}, shutting down`);
    synchronizer.stop();
    renewalCron.stop();
    getSseManager().shutdown();
    gcMonitor.stop();
    poolCollector.stop();
    replicationMonitor.stop();
    runtimeConfigAuditor.stop();
    stopConfigWatcher();
    incidentResponse.stop();
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
    renewalCron.stop();
    getSseManager().shutdown();
    gcMonitor.stop();
    poolCollector.stop();
    replicationMonitor.stop();
    incidentResponse.stop();
    await listener.stop();
    await closeTimescalePool();
    await prisma.$disconnect();
    await shutdownTelemetry();
    process.exit(1);
  }
}

function parseRuntimeConfigurationKeys(raw: string): Map<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      'RUNTIME_CONFIG_AUTHORIZED_KEYS must be a JSON object of key ids to PEM public keys',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      'RUNTIME_CONFIG_AUTHORIZED_KEYS must be a JSON object of key ids to PEM public keys',
    );
  }
  const keys = new Map<string, string>();
  for (const [keyId, publicKey] of Object.entries(parsed)) {
    if (typeof publicKey !== 'string' || publicKey.length === 0) {
      throw new Error(`Invalid runtime configuration public key for ${keyId}`);
    }
    keys.set(keyId, publicKey);
  }
  return keys;
}

/**
 * Hook the ledger synchronizer's poll callback into the SSE manager so
 * every dashboard client receives live sync-status events.
 */
function synchronizerPollToSse(
  synchronizer: LedgerEventSynchronizer,
  sse: ReturnType<typeof getSseManager>,
): void {
  // Hijack the existing onPoll callback. We wrap it so the original metrics
  // wiring from start() still fires, then we additionally broadcast to SSE
  // clients. The original callback reference is stored on the closure when the
  // synchronizer was constructed.
  const pollIntervalMs = 5_000;
  setInterval(() => {
    const state = synchronizer.getSyncState();
    sse.broadcast('sync_status', {
      lastSyncedLedger: state.lastSyncedLedger,
      targetLedger: state.targetLedger,
      inProgress: state.inProgress,
      lastCheckpointAt: state.lastCheckpointAt?.toISOString() ?? null,
      errorCount: state.errorCount,
      latestPolledSequence: synchronizer.getLatestPolledSequence(),
      ledgerLag: synchronizer.getLedgerLag(),
      timestamp: Date.now(),
    });
  }, pollIntervalMs).unref();
}

/**
 * Build a {@link SubscriptionStore} backed by Prisma so the renewal cron can
 * reuse the existing ORM connection pool without a second database connection.
 */
import type { SubscriptionStore, SubscriptionRow } from '../billing/subscription_renewal.js';
import { SubscriptionRenewalStatus } from '../billing/subscription_renewal.js';

function buildPrismaSubscriptionStore(prisma: PrismaClient): SubscriptionStore {
  return {
    async getSubscription(id: string): Promise<SubscriptionRow | null> {
      const s = await prisma.subscription.findUnique({ where: { id } });
      if (s === null) return null;
      return {
        id: s.id,
        accountId: s.accountId,
        planId: s.planId,
        amountDue: s.amountDue,
        periodDays: s.periodDays,
        expiresAt: s.expiresAt,
        autoRenew: s.autoRenew,
        renewalStatus: s.renewalStatus as SubscriptionRenewalStatus,
        lockVersion: s.lockVersion,
      };
    },

    async applyStatusTransition(
      id: string,
      from: SubscriptionRenewalStatus,
      to: SubscriptionRenewalStatus,
      expectedLockVersion: number,
    ): Promise<boolean> {
      const result = await prisma.$executeRaw`
        UPDATE subscriptions
        SET renewal_status = ${to},
            lock_version = lock_version + 1,
            updated_at = now()
        WHERE id = ${id}
          AND renewal_status = ${from}
          AND lock_version = ${expectedLockVersion}
      `;
      return result === 1;
    },

    async recordRenewalSuccess(id: string, newExpiresAt: Date, lockVersion: number): Promise<void> {
      await prisma.$executeRaw`
        UPDATE subscriptions
        SET renewal_status = 'ACTIVE',
            expires_at = ${newExpiresAt},
            renewed_at = now(),
            last_error = NULL,
            lock_version = lock_version + 1,
            updated_at = now()
        WHERE id = ${id}
          AND lock_version = ${lockVersion}
      `;
    },

    async recordRenewalFailure(id: string, error: string, lockVersion: number): Promise<void> {
      await prisma.$executeRaw`
        UPDATE subscriptions
        SET renewal_status = 'RENEWAL_FAILED',
            last_error = ${error},
            lock_version = lock_version + 1,
            updated_at = now()
        WHERE id = ${id}
          AND lock_version = ${lockVersion}
      `;
    },

    async findDueForRenewal(renewalHorizon: Date): Promise<SubscriptionRow[]> {
      const rows = await prisma.subscription.findMany({
        where: {
          autoRenew: true,
          renewalStatus: {
            in: [SubscriptionRenewalStatus.ACTIVE, SubscriptionRenewalStatus.RENEWAL_FAILED],
          },
          expiresAt: { lte: renewalHorizon },
        },
        take: 50,
        orderBy: { expiresAt: 'asc' },
      });
      return rows.map((s: {
        id: string;
        accountId: string;
        planId: string;
        amountDue: bigint;
        periodDays: number;
        expiresAt: Date;
        autoRenew: boolean;
        renewalStatus: string;
        lockVersion: number;
      }) => ({
        id: s.id,
        accountId: s.accountId,
        planId: s.planId,
        amountDue: s.amountDue,
        periodDays: s.periodDays,
        expiresAt: s.expiresAt,
        autoRenew: s.autoRenew,
        renewalStatus: s.renewalStatus as SubscriptionRenewalStatus,
        lockVersion: s.lockVersion,
      }));
    },
  };
}

const isDirectEntry =
  process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url);

if (isDirectEntry) {
  void start();
}
