import pg from 'pg';
import { getEnv } from '../config/env.js';
import { ElasticPoolManager, GLOBAL_MIN_CONNECTIONS, GLOBAL_MAX_CONNECTIONS } from './pool_manager.js';

export interface PoolHealthProbeConfig {
  checkIntervalMs: number;
  cooldownPeriodMs: number;
  healthyLatencyMs: number;
  degradedLatencyMs: number;
  criticalLatencyMs: number;
  maxErrorRate: number;
  targetUtilization: number;
  scaleUpThreshold: number;
  scaleDownThreshold: number;
  minPoolSize: number;
  maxPoolSize: number;
  scaleStep: number;
}

export interface PoolHealthSnapshot {
  poolName: string;
  totalConnections: number;
  idleConnections: number;
  waitingClients: number;
  utilization: number;
  avgLatencyMs: number;
  errorRate: number;
  status: 'healthy' | 'degraded' | 'critical';
  score: number;
  timestamp: number;
}

export interface PoolHealthProbeOptions {
  manager: ElasticPoolManager;
  poolName: string;
  config?: Partial<PoolHealthProbeConfig>;
  probeConnection?: () => Promise<number>;
  onStatusChange?: (snapshot: PoolHealthSnapshot) => void;
}

const DEFAULT_CONFIG: PoolHealthProbeConfig = {
  checkIntervalMs: 10000,
  cooldownPeriodMs: 30000,
  healthyLatencyMs: 50,
  degradedLatencyMs: 200,
  criticalLatencyMs: 500,
  maxErrorRate: 0.05,
  targetUtilization: 0.75,
  scaleUpThreshold: 0.85,
  scaleDownThreshold: 0.40,
  minPoolSize: GLOBAL_MIN_CONNECTIONS,
  maxPoolSize: GLOBAL_MAX_CONNECTIONS,
  scaleStep: 5,
};

function scoreFromMetrics(
  avgLatencyMs: number,
  utilization: number,
  errorRate: number,
  waitingClients: number,
): { score: number; status: PoolHealthSnapshot['status'] } {
  let score = 100;

  if (avgLatencyMs > 500) score -= 40;
  else if (avgLatencyMs > 200) score -= 20;
  else if (avgLatencyMs > 50) score -= 10;

  if (utilization > 0.95) score -= 30;
  else if (utilization > 0.85) score -= 15;
  else if (utilization < 0.2) score -= 5;

  if (errorRate > 0.05) score -= 25;
  else if (errorRate > 0.02) score -= 10;

  if (waitingClients > 10) score -= 20;
  else if (waitingClients > 5) score -= 10;
  else if (waitingClients > 0) score -= 5;

  score = Math.max(0, Math.min(100, score));

  let status: PoolHealthSnapshot['status'] = 'healthy';
  if (score < 30 || avgLatencyMs >= 500 || errorRate > 0.05) {
    status = 'critical';
  } else if (score < 60 || avgLatencyMs >= 200 || utilization > 0.95) {
    status = 'degraded';
  }

  return { score, status };
}

export class PoolHealthProbe {
  private readonly manager: ElasticPoolManager;
  private readonly poolName: string;
  private readonly config: PoolHealthProbeConfig;
  private readonly onStatusChange?: (snapshot: PoolHealthSnapshot) => void;
  private readonly probeConnection: () => Promise<number>;

  private lastSnapshot: PoolHealthSnapshot | null = null;
  private currentMin = GLOBAL_MIN_CONNECTIONS;
  private currentMax = GLOBAL_MAX_CONNECTIONS;
  private lastScaleTime = 0;
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private previousStatus: PoolHealthSnapshot['status'] | null = null;
  private latencyHistory: number[] = [];
  private errorCount = 0;
  private totalProbes = 0;

  constructor(options: PoolHealthProbeOptions) {
    this.manager = options.manager;
    this.poolName = options.poolName;
    this.config = { ...DEFAULT_CONFIG, ...options.config };
    this.onStatusChange = options.onStatusChange;
    this.probeConnection = options.probeConnection ?? this.defaultProbe.bind(this);
  }

  start(): void {
    if (this.probeTimer) return;
    console.log(`[PoolHealthProbe] Starting health probe for pool "${this.poolName}" (interval: ${this.config.checkIntervalMs}ms)`);
    this.probeTimer = setInterval(() => {
      void this.probe();
    }, this.config.checkIntervalMs);
    void this.probe();
  }

  stop(): void {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
  }

  getLastSnapshot(): PoolHealthSnapshot | null {
    return this.lastSnapshot;
  }

  getCurrentConfig(): PoolHealthProbeConfig {
    return { ...this.config };
  }

  getCurrentPoolBounds(): { min: number; max: number } {
    return { min: this.currentMin, max: this.currentMax };
  }

  private async defaultProbe(): Promise<number> {
    const pool = this.manager.getPool(this.poolName);
    if (!pool) return -1;
    const start = Date.now();
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    return Date.now() - start;
  }

  private recordLatency(latencyMs: number): void {
    this.latencyHistory.push(latencyMs);
    if (this.latencyHistory.length > 100) {
      this.latencyHistory.shift();
    }
    this.totalProbes++;
    if (latencyMs < 0) {
      this.errorCount++;
    }
  }

  private getAverageLatency(): number {
    if (this.latencyHistory.length === 0) return 0;
    return this.latencyHistory.reduce((a, b) => a + b, 0) / this.latencyHistory.length;
  }

  private getErrorRate(): number {
    if (this.totalProbes === 0) return 0;
    return this.errorCount / this.totalProbes;
  }

  private computeAdaptiveSize(
    utilization: number,
    waitingClients: number,
    avgLatencyMs: number,
  ): { min: number; max: number } {
    let { min, max } = { min: this.currentMin, max: this.currentMax };

    if (utilization > this.config.scaleUpThreshold || waitingClients > 5 || avgLatencyMs > this.config.degradedLatencyMs) {
      max = Math.min(max + this.config.scaleStep, this.config.maxPoolSize);
      min = Math.min(min + Math.ceil(this.config.scaleStep / 2), max);
      console.log(`[PoolHealthProbe] Scaling UP pool "${this.poolName}" to min=${min} max=${max} (util=${(utilization * 100).toFixed(0)}%, wait=${waitingClients}, latency=${avgLatencyMs.toFixed(0)}ms)`);
    } else if (
      utilization < this.config.scaleDownThreshold &&
      waitingClients === 0 &&
      avgLatencyMs < this.config.healthyLatencyMs
    ) {
      max = Math.max(max - this.config.scaleStep, this.config.minPoolSize);
      min = Math.max(min - Math.ceil(this.config.scaleStep / 2), this.config.minPoolSize);
      console.log(`[PoolHealthProbe] Scaling DOWN pool "${this.poolName}" to min=${min} max=${max} (util=${(utilization * 100).toFixed(0)}%)`);
    }

    const now = Date.now();
    if (now - this.lastScaleTime >= this.config.cooldownPeriodMs) {
      if (min !== this.currentMin || max !== this.currentMax) {
        this.currentMin = min;
        this.currentMax = max;
        this.lastScaleTime = now;
        try {
          this.manager.adjustPoolSize(min, max);
        } catch {
          this.currentMin = this.manager.getGlobalMin();
          this.currentMax = this.manager.getGlobalMax();
        }
      }
    }

    return { min: this.currentMin, max: this.currentMax };
  }

  async probe(): Promise<PoolHealthSnapshot> {
    const pool = this.manager.getPool(this.poolName);
    if (!pool) {
      const snapshot: PoolHealthSnapshot = {
        poolName: this.poolName,
        totalConnections: 0,
        idleConnections: 0,
        waitingClients: 0,
        utilization: 0,
        avgLatencyMs: -1,
        errorRate: 1,
        status: 'critical',
        score: 0,
        timestamp: Date.now(),
      };
      this.lastSnapshot = snapshot;
      console.warn(`[PoolHealthProbe] Pool "${this.poolName}" not found, reporting critical`);
      return snapshot;
    }

    let latencyMs: number;
    try {
      latencyMs = await this.probeConnection();
    } catch {
      latencyMs = this.config.criticalLatencyMs * 2;
      this.errorCount++;
    }
    this.totalProbes++;
    this.recordLatency(latencyMs);

    const total = pool.totalCount;
    const idle = pool.idleCount;
    const waiting = pool.waitingCount;
    const utilization = total > 0 ? (total - idle) / total : 0;
    const avgLatency = this.getAverageLatency();
    const errorRate = this.getErrorRate();

    const { score, status } = scoreFromMetrics(avgLatency, utilization, errorRate, waiting);

    const snapshot: PoolHealthSnapshot = {
      poolName: this.poolName,
      totalConnections: total,
      idleConnections: idle,
      waitingClients: waiting,
      utilization,
      avgLatencyMs: avgLatency,
      errorRate,
      status,
      score,
      timestamp: Date.now(),
    };

    this.computeAdaptiveSize(utilization, waiting, avgLatency);

    if (this.previousStatus !== null && status !== this.previousStatus) {
      console.log(
        `[PoolHealthProbe] Pool "${this.poolName}" status changed: ${this.previousStatus} -> ${status} (score: ${score})`,
      );
    }
    this.previousStatus = status;
    this.lastSnapshot = snapshot;

    if (this.onStatusChange) {
      try {
        this.onStatusChange(snapshot);
      } catch {
        // isolate listener failures
      }
    }

    return snapshot;
  }

  resetMetrics(): void {
    this.latencyHistory = [];
    this.errorCount = 0;
    this.totalProbes = 0;
    this.lastSnapshot = null;
    this.previousStatus = null;
  }
}
