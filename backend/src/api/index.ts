import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { PrismaClient } from '@prisma/client';
import { getEnv } from '../config/env.js';
import { stopConfigWatcher } from '../config/index.js';
import { getRedis } from '../database/redis.js';
import { initTelemetry, shutdownTelemetry } from '../core/diagnostics/otel.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAnalyticsRoutes } from './routes/analytics.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerGeoPricingRoutes } from './routes/geo_pricing.js';
import { registerCongestionPricingRoutes } from './routes/congestion_pricing.js';
import { registerPaymentChannelRoutes } from './routes/payment_channel.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerMultiCurrencyRoutes } from './routes/multi_currency.js';
import { registerOpsRoutes } from './routes/ops.js';
import { registerTracingHooks } from './middleware/tracing.js';
import {
  registerTelemetryStreamRoutes,
  startTelemetryBridge,
  stopTelemetryBridge,
} from './routes/telemetry_stream.js';
import { registerIngestionRoutes } from './routes/ingestion.js';
import { registerAttestationRoutes, initAttestationService } from './routes/attestation.js';
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
  updateRequestQueueDepth,
  updateActiveRequestCount,
} from './metrics/prometheus.js';
import { registerCircuitHealth } from './health.js';
import {
  initializeFeatureFlagWatcher,
  stopFeatureFlagWatcher,
} from '../core/feature_flags/index.js';
import { getSheddingStatus } from '../core/capacity_shedding/index.js';
import { GcPauseMonitor } from './metrics/gc_monitor.js';
import { PoolMetricsCollector } from './metrics/pool_metrics_collector.js';
import { getSseManager } from '../core/ingestion/sse_manager.js';
import { getReplicationMonitor } from '../replication/replication_monitor.js';
import { getConsumerLagMonitor } from '../stream/consumer_lag_monitor.js';
import { createIncidentResponseModule } from '../incident_response/index.js';
import { registerIncidentResponseRoutes } from '../incident_response/routes.js';
import { RenewalCron } from '../billing/renewal_cron.js';
import { registerTelemetryWebSocketRoutes } from './routes/telemetry_websocket.js';
import { initSecretManager, getSecretManager } from '../security/index.js';
import {
  registerHealthDashboardRoutes,
  registerHealthDashboardWebSocket,
} from './routes/health_dashboard.js';
import { initializeHealthDashboard } from '../core/diagnostics/health_dashboard.js';

const DEFAULT_LEDGER_SYNC_ID = 'primary';

export function registerSheddingStatusRoute(app: FastifyInstance): void {
  app.get('/shedding-status', () => {
    const status = getSheddingStatus();
    updateRequestQueueDepth(status.queueDepth);
    updateActiveRequestCount(status.activeRequests);
    return {
      queueDepth: status.queueDepth,
      activeRequests: status.activeRequests,
      sheddingLevel: status.degradationProfile.shedNonCritical
        ? 'critical'
        : status.degradationProfile.disabledFlags.length > 5
          ? 'high'
          : status.degradationProfile.disabledFlags.length > 0
            ? 'medium'
            : 'normal',
      activePriority: status.degradationProfile.activePriority,
      disabledFlags: status.degradationProfile.disabledFlags,
      maxQueueDepth: status.config.maxQueueDepth,
      maxConcurrency: status.config.maxConcurrency,
    };
  });
}

export async function buildApp(
  tenantRateLimitMiddleware?: (request: any, reply: any) => Promise<void>,
): Promise<FastifyInstance> {
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
  registerIngestionRoutes(app, tenantRateLimitMiddleware);
  registerCircuitHealth(app);
  registerGeoPricingRoutes(app);
  registerCongestionPricingRoutes(app);
  registerPaymentChannelRoutes(app);
  registerAuditRoutes(app);
  registerMultiCurrencyRoutes(app);
  registerSheddingStatusRoute(app);
  registerTelemetryStreamRoutes(app);
  await registerTelemetryWebSocketRoutes(app);
  await registerHealthDashboardRoutes(app);
  await registerHealthDashboardWebSocket(app);

  // Issue #3: register hardware attestation endpoints.
  // Initialize a default in-memory attestation service for local/dev usage;
  // production startup swaps this for the Prisma-backed implementation below.
  initAttestationService();
  registerAttestationRoutes(app);

  // Initialise the SSE manager singleton early so the admin event-stream
  // endpoint can register clients immediately on first request.
  getSseManager();

  return app;
}

async function start(): Promise<void> {
  initTelemetry();

  await initSecretManager();

  await runMigrationWithDistributedLock();

  const app = await buildApp();

  // Initialize the health dashboard service
  initializeHealthDashboard();

  const env = getEnv();
  const prisma = new PrismaClient();
  initAttestationService(undefined, undefined, undefined, prisma);
  const renewalCron = new RenewalCron(buildPrismaSubscriptionStore(prisma));
  renewalCron.start();

  const redis = getRedis();
  await initializeFeatureFlagWatcher(redis);

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

  // Issue #1: start the SSE telemetry bridge so validated ingest events are
  // forwarded to all connected SSE clients in real-time.
  startTelemetryBridge();

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

  // Issue #66: start the consumer group lag monitor for auto-scaling and
  // alerting on Redis Streams consumer group backlog.
  const consumerLagMonitor = getConsumerLagMonitor();
  consumerLagMonitor.start();

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
    stopTelemetryBridge();
    gcMonitor.stop();
    poolCollector.stop();
    replicationMonitor.stop();
    consumerLagMonitor.stop();
    stopConfigWatcher();
    stopFeatureFlagWatcher();
    incidentResponse.stop();
    getSecretManager().stop();
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
    stopTelemetryBridge();
    gcMonitor.stop();
    poolCollector.stop();
    replicationMonitor.stop();
    consumerLagMonitor.stop();
    stopConfigWatcher();
    stopFeatureFlagWatcher();
    incidentResponse.stop();
    getSecretManager().stop();
    await listener.stop();
    await closeTimescalePool();
    await prisma.$disconnect();
    await shutdownTelemetry();
    process.exit(1);
  }
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
  const subModel = (prisma as unknown as { subscription: any }).subscription;
  return {
    async getSubscription(id: string): Promise<SubscriptionRow | null> {
      const s = await subModel.findUnique({ where: { id } });
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
      const rows = await subModel.findMany({
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
      return rows.map(
        (s: {
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
        }),
      );
    },
  };
}

const isDirectEntry =
  process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url);

if (isDirectEntry) {
  void start();
}
