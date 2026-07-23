/**
 * ConsumerGroupLagMonitor — polls Redis Streams consumer group lag and
 * exposes Prometheus metrics for auto-scaling and alerting.
 *
 * ## Background (Issue #66)
 *
 * The billing platform uses Redis Streams with consumer groups for durable,
 * ordered ledger-event delivery. When consumers are overloaded or disconnected,
 * entries accumulate in the pending-entries list (PEL), increasing lag. This
 * monitor tracks pending-entry counts, active consumer counts, and idle times
 * per consumer group so operators can:
 *
 * - **Alert** on lag thresholds via Prometheus alert rules.
 * - **Auto-scale** consumer replicas via K8s HPA driven by the
 *   `stream_consumer_group_pending_entries` metric.
 * - **Detect** stale/disconnected consumers via idle-time tracking.
 *
 * ## Design
 *
 * - Poling loop at `CONSUMER_LAG_POLL_INTERVAL_MS` (default 10s).
 * - Uses existing Redis connection from `getRedis()` — zero new dependencies.
 * - Follows the same pattern as `ReplicationMonitor` and `PoolMetricsCollector`.
 * - Metrics are registered in `prometheus.ts` for consistency.
 *
 * ## PCI-DSS / SOC2 alignment
 *
 * - No billing data is read or written by the monitor.
 * - No secrets are logged; only metric names and consumer group identifiers
 *   (which are static constants) appear in logs.
 */

import type { Redis } from 'ioredis';
import { getRedis } from '../database/redis.js';
import { getEnv } from '../config/env.js';
import {
  setConsumerGroupPendingEntries,
  setConsumerGroupConsumers,
  setConsumerGroupIdleTimeMs,
  setConsumerGroupLagHealth,
} from '../api/metrics/prometheus.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConsumerGroupState {
  /** Consumer group name. */
  groupName: string;
  /** Stream key the group reads from. */
  streamKey: string;
  /** Total pending entries across all consumers in this group. */
  pendingEntries: number;
  /** Number of active consumers in the group. */
  consumerCount: number;
  /** Max idle time (ms) across consumers. -1 if no consumers. */
  maxIdleMs: number;
  /** Individual consumer idle times, keyed by consumer name. */
  consumerIdleMs: Record<string, number>;
  /** Timestamp of this reading. */
  checkedAt: Date;
  /** Whether the group was reachable. */
  healthy: boolean;
  /** Error message if the probe failed. */
  error?: string;
}

export interface ConsumerLagMonitorOptions {
  /** Override poll interval (default: env.CONSUMER_LAG_POLL_INTERVAL_MS). */
  pollIntervalMs?: number;
  /** Pending entries threshold: warn (default: env.CONSUMER_LAG_WARN_ENTRIES). */
  warnEntries?: number;
  /** Pending entries threshold: critical (default: env.CONSUMER_LAG_CRITICAL_ENTRIES). */
  criticalEntries?: number;
  /** Consumer idle threshold: warn (ms). Default: 60_000 (1 min). */
  warnIdleMs?: number;
  /** Consumer idle threshold: critical (ms). Default: 300_000 (5 min). */
  criticalIdleMs?: number;
  /** Stream + group pairs to monitor. Default: single billing stream/group. */
  targets?: Array<{ streamKey: string; groupName: string }>;
  /**
   * Injectable Redis client for testing. If not provided, uses `getRedis()`.
   */
  redis?: Redis;
}

// ---------------------------------------------------------------------------
// Default targets
// ---------------------------------------------------------------------------

import {
  LEDGER_STREAM_KEY,
  LEDGER_CONSUMER_GROUP,
} from '../core/blockchain/ledger_event_bus.js';

const DEFAULT_TARGETS = [
  { streamKey: LEDGER_STREAM_KEY, groupName: LEDGER_CONSUMER_GROUP },
];

// ---------------------------------------------------------------------------
// Monitor class
// ---------------------------------------------------------------------------

/**
 * Polls Redis Streams consumer group lag and exposes state through Prometheus
 * metrics. A single instance should be created per process; call `start()`
 * after the server is ready and `stop()` during shutdown.
 */
export class ConsumerGroupLagMonitor {
  private readonly redis: Redis;
  private readonly pollIntervalMs: number;
  private readonly warnEntries: number;
  private readonly criticalEntries: number;
  private readonly warnIdleMs: number;
  private readonly criticalIdleMs: number;
  private readonly targets: Array<{ streamKey: string; groupName: string }>;

  private _timer: ReturnType<typeof setInterval> | null = null;
  private readonly _lastState = new Map<string, ConsumerGroupState>();
  private _running = false;

  constructor(opts: ConsumerLagMonitorOptions = {}) {
    const env = getEnv();
    this.redis = opts.redis ?? getRedis();
    this.pollIntervalMs = opts.pollIntervalMs ?? env.CONSUMER_LAG_POLL_INTERVAL_MS;
    this.warnEntries = opts.warnEntries ?? env.CONSUMER_LAG_WARN_ENTRIES;
    this.criticalEntries = opts.criticalEntries ?? env.CONSUMER_LAG_CRITICAL_ENTRIES;
    this.warnIdleMs = opts.warnIdleMs ?? env.CONSUMER_LAG_WARN_IDLE_MS;
    this.criticalIdleMs = opts.criticalIdleMs ?? env.CONSUMER_LAG_CRITICAL_IDLE_MS;
    this.targets = opts.targets ?? DEFAULT_TARGETS;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Start the polling loop. Idempotent — calling `start()` twice is safe.
   * An initial poll is executed immediately.
   */
  start(): void {
    if (this._timer !== null) return;

    // Immediate poll.
    void this._poll();
    this._timer = setInterval(() => void this._poll(), this.pollIntervalMs);
    (this._timer as unknown as { unref?: () => void }).unref?.();
  }

  /** Stop the polling loop cleanly. Idempotent. */
  stop(): void {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /** Snapshot of the last state for each consumer group. */
  getLastState(): Map<string, ConsumerGroupState> {
    return new Map(this._lastState);
  }

  /** Return whether the monitor is currently in a poll cycle. */
  get isRunning(): boolean {
    return this._running;
  }

  // ---------------------------------------------------------------------------
  // Internal poll
  // ---------------------------------------------------------------------------

  /** Run one probe cycle against all configured targets. */
  private async _poll(): Promise<void> {
    if (this._running) return;
    this._running = true;

    try {
      for (const target of this.targets) {
        const state = await this._probeGroup(target.streamKey, target.groupName);
        const key = `${target.streamKey}:${target.groupName}`;
        this._lastState.set(key, state);

        // Push to Prometheus.
        setConsumerGroupPendingEntries(
          target.streamKey,
          target.groupName,
          state.pendingEntries,
        );
        setConsumerGroupConsumers(
          target.streamKey,
          target.groupName,
          state.consumerCount,
        );
        setConsumerGroupIdleTimeMs(
          target.streamKey,
          target.groupName,
          state.maxIdleMs,
        );

        // Classify health and push.
        const lagHealth = this._classifyLag(state.pendingEntries);
        setConsumerGroupLagHealth(
          target.streamKey,
          target.groupName,
          lagHealth,
        );

        // Log warnings for degraded/unhealthy states.
        if (lagHealth !== 'healthy') {
          console.warn(
            JSON.stringify({
              level: 'warn',
              event: 'ConsumerGroupLagDegraded',
              stream: target.streamKey,
              group: target.groupName,
              pendingEntries: state.pendingEntries,
              consumerCount: state.consumerCount,
              maxIdleMs: state.maxIdleMs,
              health: lagHealth,
              warnThreshold: this.warnEntries,
              criticalThreshold: this.criticalEntries,
            }),
          );
        }
      }
    } catch (err) {
      console.error(
        '[consumer-lag-monitor] Poll cycle failed:',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      this._running = false;
    }
  }

  /** Probe a single consumer group and return its state. */
  private async _probeGroup(
    streamKey: string,
    groupName: string,
  ): Promise<ConsumerGroupState> {
    let pendingEntries = 0;
    let consumerCount = 0;
    let maxIdleMs = -1;
    const consumerIdleMs: Record<string, number> = {};
    let healthy = true;
    let error: string | undefined;

    try {
      // XPENDING summary: [total, minId, maxId, [[consumer, count], ...]]
      const summary = (await this.redis.xpending(streamKey, groupName)) as [
        number,
        string | null,
        string | null,
        Array<[string, string]> | null,
      ];

      pendingEntries = typeof summary[0] === 'number' ? summary[0] : 0;

      // Per-consumer pending count from XPENDING summary.
      const perConsumer = summary[3];
      if (perConsumer && Array.isArray(perConsumer)) {
        consumerCount = perConsumer.length;

        for (const [consumerName, _pendingCount] of perConsumer) {
          // XPENDING with per-consumer detail returns count but not idle time.
          // We need XINFO CONSUMERS for idle times.
          let idle = -1;
          try {
            // XINFO CONSUMERS returns arrays of field-value pairs in ioredis,
            // e.g. [["name","c1","idle","1200"], ["name","c2","idle","3400"]].
            // We convert each flat array into a Record for easy lookup.
            const rawConsumers = (await this.redis.xinfo(
              'CONSUMERS',
              streamKey,
              groupName,
            )) as unknown as string[][];

            for (const entry of rawConsumers) {
              const obj: Record<string, string> = {};
              for (let i = 0; i + 1 < entry.length; i += 2) {
                obj[entry[i]] = entry[i + 1];
              }
              if (obj['name'] === consumerName) {
                idle = Number(obj['idle'] ?? -1);
                break;
              }
            }
          } catch {
            // XINFO CONSUMERS may not be available or may fail — safe fallback.
            idle = -1;
          }

          consumerIdleMs[consumerName] = idle;
          if (idle > maxIdleMs) {
            maxIdleMs = idle;
          }
        }
      }
    } catch (err) {
      healthy = false;
      error = err instanceof Error ? err.message : String(err);
      pendingEntries = -1;
      consumerCount = -1;
    }

    return {
      groupName,
      streamKey,
      pendingEntries,
      consumerCount,
      maxIdleMs,
      consumerIdleMs,
      checkedAt: new Date(),
      healthy,
      error,
    };
  }

  /** Classify lag size into health status. */
  private _classifyLag(
    pendingEntries: number,
  ): 'healthy' | 'degraded' | 'unhealthy' {
    if (pendingEntries < 0) return 'unhealthy';
    if (pendingEntries >= this.criticalEntries) return 'unhealthy';
    if (pendingEntries >= this.warnEntries) return 'degraded';
    return 'healthy';
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let _instance: ConsumerGroupLagMonitor | null = null;

/** Return (and lazily create) the process-level singleton monitor. */
export function getConsumerLagMonitor(
  opts?: ConsumerLagMonitorOptions,
): ConsumerGroupLagMonitor {
  if (_instance === null) {
    _instance = new ConsumerGroupLagMonitor(opts);
  }
  return _instance;
}

/** Replace the singleton. Used in tests. */
export function setConsumerLagMonitor(monitor: ConsumerGroupLagMonitor): void {
  _instance?.stop();
  _instance = monitor;
}

/** Reset the singleton (for tests). */
export function resetConsumerLagMonitor(): void {
  _instance?.stop();
  _instance = null;
}
