import { EventEmitter } from 'node:events';

export enum BackpressureLevel {
  NORMAL = 0,
  WARNING = 1,
  CRITICAL = 2,
}

export interface BackpressureMetrics {
  taskQueueDepth: number;
  memoryUsageBytes: number;
  dbConnectionUtilization: number;
}

export interface ShedConnectionEvent {
  connectionId: string;
  reason: string;
}

const MAX_QUEUE_DEPTH = 10_000;
const MAX_MEMORY_BYTES = 512 * 1024 * 1024;
const MAX_DB_UTILIZATION = 0.85;

export class BackpressureController extends EventEmitter {
  private level: BackpressureLevel = BackpressureLevel.NORMAL;
  private metrics: BackpressureMetrics = {
    taskQueueDepth: 0,
    memoryUsageBytes: 0,
    dbConnectionUtilization: 0,
  };

  evaluate(metrics: BackpressureMetrics): BackpressureLevel {
    this.metrics = metrics;

    if (
      metrics.taskQueueDepth > MAX_QUEUE_DEPTH ||
      metrics.memoryUsageBytes > MAX_MEMORY_BYTES ||
      metrics.dbConnectionUtilization > MAX_DB_UTILIZATION
    ) {
      this.level = BackpressureLevel.CRITICAL;
    } else if (
      metrics.taskQueueDepth > MAX_QUEUE_DEPTH * 0.7 ||
      metrics.memoryUsageBytes > MAX_MEMORY_BYTES * 0.7 ||
      metrics.dbConnectionUtilization > MAX_DB_UTILIZATION * 0.7
    ) {
      this.level = BackpressureLevel.WARNING;
    } else {
      this.level = BackpressureLevel.NORMAL;
    }

    this.emit('levelChanged', this.level);
    return this.level;
  }

  getLevel(): BackpressureLevel {
    return this.level;
  }

  shouldThrottle(): boolean {
    return this.level >= BackpressureLevel.WARNING;
  }

  shouldPause(): boolean {
    return this.level >= BackpressureLevel.CRITICAL;
  }

  shedConnection(connectionId: string, reason = 'connection_memory_budget_exceeded'): void {
    this.emit('shedConnection', { connectionId, reason } satisfies ShedConnectionEvent);
  }
}
