import type { FastifyRequest, FastifyReply } from 'fastify';
import {
  isFlagEnabledSync,
  FeatureFlag,
  FlagPriority,
  computeDegradationProfile,
  type DegradationProfile,
} from '../feature_flags/index.js';
import { observeSheddedRequests, setCapacitySheddingLevel } from '../../api/metrics/prometheus.js';

export enum RequestPriority {
  CRITICAL = 0,
  HIGH = 1,
  MEDIUM = 2,
  LOW = 3,
  BULK = 4,
}

export enum SheddingAction {
  ALLOW = 'allow',
  SHED = 'shed',
  THROTTLE = 'throttle',
  QUEUE = 'queue',
}

export interface SheddingDecision {
  action: SheddingAction;
  priority: RequestPriority;
  reason: string | null;
}

interface SheddingConfig {
  maxQueueDepth: number;
  maxConcurrency: number;
  cpuHighThreshold: number;
  memoryHighThreshold: number;
  queueTimeoutMs: number;
}

const DEFAULT_SHEDDING_CONFIG: SheddingConfig = {
  maxQueueDepth: 10_000,
  maxConcurrency: 500,
  cpuHighThreshold: 0.8,
  memoryHighThreshold: 0.85,
  queueTimeoutMs: 30_000,
};

const requestPriorities = new WeakMap<FastifyRequest, RequestPriority>();
const activeRequests = new Set<string>();
const requestQueue: Array<{
  id: string;
  priority: RequestPriority;
  request: FastifyRequest;
  reply: FastifyReply;
  handler: () => Promise<void>;
  queuedAt: number;
}> = [];
let currentConfig: SheddingConfig = { ...DEFAULT_SHEDDING_CONFIG };
let lastMetricsUpdate = 0;
let currentDegradationProfile: DegradationProfile = {
  shedNonCritical: false,
  disabledFlags: [],
  activePriority: FlagPriority.LOW,
};

const PATH_PRIORITY_MAP: Record<string, RequestPriority> = {
  '/health': RequestPriority.CRITICAL,
  '/circuit-health': RequestPriority.CRITICAL,
  '/config-status': RequestPriority.CRITICAL,
  '/backup-health': RequestPriority.CRITICAL,
  '/aggregate-health': RequestPriority.CRITICAL,
  '/metrics': RequestPriority.CRITICAL,
  '/api/auth': RequestPriority.CRITICAL,
  '/api/billing': RequestPriority.HIGH,
  '/api/telemetry': RequestPriority.HIGH,
  '/api/ingestion': RequestPriority.HIGH,
  '/api/analytics': RequestPriority.MEDIUM,
  '/api/admin': RequestPriority.HIGH,
  '/api/geo-pricing': RequestPriority.MEDIUM,
  '/api/webhook': RequestPriority.MEDIUM,
  '/api/reports': RequestPriority.LOW,
  '/api/audit': RequestPriority.LOW,
};

function getRequestPriority(request: FastifyRequest): RequestPriority {
  const cached = requestPriorities.get(request);
  if (cached !== undefined) return cached;

  const url = request.url ?? '';
  for (const [prefix, priority] of Object.entries(PATH_PRIORITY_MAP)) {
    if (url.startsWith(prefix)) {
      requestPriorities.set(request, priority);
      return priority;
    }
  }

  if (request.method === 'POST' && url.includes('/api/billing')) {
    return RequestPriority.HIGH;
  }
  if (request.method === 'GET') {
    return RequestPriority.MEDIUM;
  }

  return RequestPriority.LOW;
}

function getSystemLoad(): { cpuLoadPercent: number; memoryPressure: boolean } {
  const memUsage = process.memoryUsage();
  const heapUsed = memUsage.heapUsed;
  const heapTotal = memUsage.heapTotal;
  const memoryPressure = heapTotal > 0 && heapUsed / heapTotal > currentConfig.memoryHighThreshold;

  const cpuUsage = process.cpuUsage();
  const totalCpu = cpuUsage.user + cpuUsage.system;
  const cpuLoadPercent = Math.min(100, (totalCpu / 1_000_000) * 100);

  return { cpuLoadPercent, memoryPressure };
}

function getQueueDepth(): number {
  return requestQueue.length;
}

export function setSheddingConfig(config: Partial<SheddingConfig>): void {
  currentConfig = { ...currentConfig, ...config };
}

export function getSheddingConfig(): Readonly<SheddingConfig> {
  return { ...currentConfig };
}

export function getSheddingStatus(): {
  queueDepth: number;
  activeRequests: number;
  degradationProfile: DegradationProfile;
  config: SheddingConfig;
} {
  return {
    queueDepth: requestQueue.length,
    activeRequests: activeRequests.size,
    degradationProfile: currentDegradationProfile,
    config: { ...currentConfig },
  };
}

export function computeSheddingDecision(request: FastifyRequest): SheddingDecision {
  const priority = getRequestPriority(request);
  const now = Date.now();

  if (now - lastMetricsUpdate > 5000) {
    const load = getSystemLoad();
    currentDegradationProfile = computeDegradationProfile(
      load.cpuLoadPercent,
      load.memoryPressure,
      getQueueDepth(),
      currentConfig.maxQueueDepth,
    );
    setCapacitySheddingLevel(
      currentDegradationProfile.shedNonCritical
        ? 3
        : currentDegradationProfile.disabledFlags.length > 5
          ? 2
          : currentDegradationProfile.disabledFlags.length > 0
            ? 1
            : 0,
    );
    lastMetricsUpdate = now;
  }

  const profile = currentDegradationProfile;

  if (profile.shedNonCritical && priority > RequestPriority.HIGH) {
    observeSheddedRequests(priority, 'capacity');
    return { action: SheddingAction.SHED, priority, reason: 'capacity_shedding_active' };
  }

  if (priority >= RequestPriority.LOW && activeRequests.size >= currentConfig.maxConcurrency) {
    observeSheddedRequests(priority, 'concurrency');
    return {
      action: SheddingAction.SHED,
      priority,
      reason: 'max_concurrency_exceeded',
    };
  }

  if (getQueueDepth() >= currentConfig.maxQueueDepth && priority >= RequestPriority.MEDIUM) {
    observeSheddedRequests(priority, 'queue_full');
    return { action: SheddingAction.SHED, priority, reason: 'queue_capacity_exceeded' };
  }

  if (priority >= RequestPriority.BULK && getQueueDepth() > currentConfig.maxQueueDepth * 0.7) {
    observeSheddedRequests(priority, 'bulk_throttled');
    return { action: SheddingAction.THROTTLE, priority, reason: 'bulk_request_throttled' };
  }

  if (!isFlagEnabledSync(FeatureFlag.ADVANCED_RATE_LIMITING) && priority === RequestPriority.BULK) {
    observeSheddedRequests(priority, 'flag_disabled');
    return { action: SheddingAction.SHED, priority, reason: 'advanced_rate_limiting_disabled' };
  }

  return { action: SheddingAction.ALLOW, priority, reason: null };
}

function processQueue(): void {
  if (requestQueue.length === 0 || activeRequests.size >= currentConfig.maxConcurrency) return;

  const now = Date.now();
  requestQueue.sort((a, b) => a.priority - b.priority);

  const staleIds = new Set<string>();
  for (let i = requestQueue.length - 1; i >= 0; i--) {
    if (now - requestQueue[i].queuedAt > currentConfig.queueTimeoutMs) {
      staleIds.add(requestQueue[i].id);
      requestQueue.splice(i, 1);
    }
  }

  while (requestQueue.length > 0 && activeRequests.size < currentConfig.maxConcurrency) {
    const next = requestQueue.shift();
    if (next === undefined) break;
    if (staleIds.has(next.id)) continue;

    activeRequests.add(next.id);
    void next.handler().finally(() => {
      activeRequests.delete(next.id);
      processQueue();
    });
  }
}

export function enqueueRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  handler: () => Promise<void>,
): void {
  const priority = getRequestPriority(request);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  requestQueue.push({
    id,
    priority,
    request,
    reply,
    handler,
    queuedAt: Date.now(),
  });

  processQueue();
}

export function capacitySheddingHook(
  request: FastifyRequest,
  reply: FastifyReply,
): SheddingDecision | null {
  const decision = computeSheddingDecision(request);

  if (decision.action === SheddingAction.SHED) {
    void reply.status(503).send({
      error: 'service_unavailable',
      message: 'Capacity shedding active - try again later',
      retryAfter: 5,
      reason: decision.reason,
    });
    return decision;
  }

  if (decision.action === SheddingAction.THROTTLE) {
    void reply.header('Retry-After', '2');
    void reply.status(429).send({
      error: 'too_many_requests',
      message: 'Request throttled due to system load',
      retryAfter: 2,
      reason: decision.reason,
    });
    return decision;
  }

  return null;
}

export function resetCapacitySheddingForTesting(): void {
  requestQueue.length = 0;
  activeRequests.clear();
  currentConfig = { ...DEFAULT_SHEDDING_CONFIG };
  currentDegradationProfile = {
    shedNonCritical: false,
    disabledFlags: [],
    activePriority: FlagPriority.LOW,
  };
  lastMetricsUpdate = 0;
}
