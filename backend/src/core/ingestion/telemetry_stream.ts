/**
 * Telemetry real-time streaming bridge (Issue #1).
 *
 * This module connects the ingestion pipeline to the SSE manager so that
 * successfully ingested telemetry events are broadcast in real time to all
 * connected SSE clients.
 *
 * Design goals:
 *  - < 200ms P99 from ingest to client delivery (local hot path).
 *  - Per-device channel filtering: clients can subscribe to a specific
 *    deviceId or receive all events ("*" wildcard).
 *  - Backpressure: events that cannot be delivered (queue full) are dropped
 *    and counted via Prometheus, never blocking the ingestion path.
 *  - PCI-DSS / SOC2: metric values are included only when the event passes
 *    full cryptographic validation (signature + ZK proof already verified
 *    upstream by IngestionService).
 */

import { EventEmitter } from 'node:events';
import type { SseManager } from './sse_manager.js';

// ── Types ──────────────────────────────────────────────────────────────────────

/** Telemetry event published to all SSE clients after successful ingestion. */
export interface TelemetryStreamEvent {
  /** ISO-8601 timestamp of when the event was generated server-side. */
  serverTs: string;
  /** Device serial / ID from the ingest payload. */
  deviceId: string;
  /** Validated metric name-value pairs. */
  metrics: Record<string, number>;
  /** Number of records written to the database for this payload. */
  recordsWritten: number;
}

/** SSE event name used for telemetry stream events. */
export const TELEMETRY_EVENT_NAME = 'telemetry';

/** SSE event name used for telemetry pipeline error events. */
export const TELEMETRY_ERROR_EVENT_NAME = 'telemetry_error';

// ── TelemetryStreamBus ─────────────────────────────────────────────────────────

/**
 * In-process event bus for telemetry stream events.
 *
 * The ingestion route publishes events here via {@link publish}. Registered
 * SSE bridge instances listen and forward them to their connected clients.
 *
 * Keeping this as an EventEmitter rather than calling the SseManager directly
 * decouples the ingestion hot path from SSE client state and makes the bridge
 * fully testable without Fastify.
 */
export class TelemetryStreamBus extends EventEmitter {
  private static instance: TelemetryStreamBus | null = null;

  /** Get (or create) the process-level singleton. */
  static getInstance(): TelemetryStreamBus {
    if (TelemetryStreamBus.instance === null) {
      TelemetryStreamBus.instance = new TelemetryStreamBus();
      // Increase default max listeners to accommodate many SSE connections.
      TelemetryStreamBus.instance.setMaxListeners(500);
    }
    return TelemetryStreamBus.instance;
  }

  /** Reset the singleton (for testing). */
  static reset(): void {
    TelemetryStreamBus.instance?.removeAllListeners();
    TelemetryStreamBus.instance = null;
  }

  /**
   * Publish a validated telemetry event.
   *
   * Called by the ingestion pipeline immediately after successful persistence.
   * Synchronous emit keeps latency on the hot path near zero.
   */
  publish(event: TelemetryStreamEvent): void {
    this.emit(TELEMETRY_EVENT_NAME, event);
  }

  /**
   * Subscribe to all telemetry events or to events for a specific device.
   *
   * @param deviceId - subscribe to events for this device only. Pass `"*"` to
   *   receive events for all devices.
   * @param handler - called with every matching event.
   * @returns a cleanup function that removes the subscription.
   */
  subscribe(deviceId: string, handler: (event: TelemetryStreamEvent) => void): () => void {
    const listener = (event: TelemetryStreamEvent): void => {
      if (deviceId === '*' || event.deviceId === deviceId) {
        handler(event);
      }
    };

    this.on(TELEMETRY_EVENT_NAME, listener);
    return () => {
      this.off(TELEMETRY_EVENT_NAME, listener);
    };
  }
}

// ── SseTelemetryBridge ─────────────────────────────────────────────────────────

/**
 * Bridges the {@link TelemetryStreamBus} to the {@link SseManager}.
 *
 * When started, it subscribes to all telemetry events and broadcasts them to
 * all connected SSE clients. Each client receives events for all devices or
 * only those matching their subscription filter (see
 * {@link registerTelemetryStreamRoutes}).
 */
export class SseTelemetryBridge {
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly bus: TelemetryStreamBus,
    private readonly sse: SseManager,
  ) {}

  /** Start forwarding telemetry events to SSE clients. */
  start(): void {
    if (this.unsubscribe !== null) return; // already started

    this.unsubscribe = this.bus.subscribe('*', (event) => {
      this.sse.broadcast(TELEMETRY_EVENT_NAME, event);
    });
  }

  /** Stop forwarding events. */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

// ── Metrics counters ────────────────────────────────────────────────────────────

/** Counters for telemetry stream monitoring (Prometheus-compatible). */
const _counters = {
  published: 0,
  delivered: 0,
  errors: 0,
};

/** Increment the published event counter. */
export function incrementStreamPublished(): void {
  _counters.published++;
}

/** Increment the delivered event counter. */
export function incrementStreamDelivered(n = 1): void {
  _counters.delivered += n;
}

/** Increment the stream error counter. */
export function incrementStreamErrors(): void {
  _counters.errors++;
}

/** Read current telemetry stream counters (for health endpoints / tests). */
export function getStreamCounters(): Readonly<typeof _counters> {
  return { ..._counters };
}

/** Reset counters (for testing). */
export function resetStreamCounters(): void {
  _counters.published = 0;
  _counters.delivered = 0;
  _counters.errors = 0;
}
