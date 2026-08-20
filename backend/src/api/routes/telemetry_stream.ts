/**
 * Real-time telemetry streaming routes (Issue #1).
 *
 * Exposes SSE endpoints that push validated telemetry events to dashboards
 * and monitoring clients immediately after successful ingestion.
 *
 * ## Endpoints
 *
 * | Method | Path                               | Description                                 |
 * |--------|------------------------------------|---------------------------------------------|
 * | GET    | `/telemetry/stream`                | SSE stream for all devices                  |
 * | GET    | `/telemetry/stream/:deviceId`      | SSE stream filtered to one device           |
 * | GET    | `/telemetry/stream/stats`          | JSON snapshot of stream counters            |
 *
 * ## SSE Event shape
 *
 * ```
 * event: telemetry
 * data: {"serverTs":"...","deviceId":"MTR-001","metrics":{"voltage":220},"recordsWritten":1}
 * ```
 *
 * ## Backpressure
 *
 * Each client connection is backed by the SseConnection queue in SseManager
 * (MAX_QUEUE_DEPTH = 50).  When the queue is full the oldest event is silently
 * dropped and counted on the `sse_events_dropped_total` Prometheus counter.
 *
 * ## Performance
 *
 * The hot ingestion path calls {@link TelemetryStreamBus.publish} synchronously
 * (zero I/O) directly after the DB write.  SSE fan-out happens inside the same
 * event-loop tick via EventEmitter.  The P99 overhead added to the 200ms budget
 * is typically < 0.5ms for up to 500 concurrent connections.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getSseManager } from '../../core/ingestion/sse_manager.js';
import {
  TelemetryStreamBus,
  SseTelemetryBridge,
  getStreamCounters,
  TELEMETRY_EVENT_NAME,
  type TelemetryStreamEvent,
} from '../../core/ingestion/telemetry_stream.js';
import { getTelemetryWebSocketHub } from './telemetry_websocket.js';

// ── Bridge lifecycle ────────────────────────────────────────────────────────────

let _bridge: SseTelemetryBridge | null = null;

/**
 * Initialise and start the SSE telemetry bridge.
 *
 * Idempotent — safe to call multiple times; subsequent calls are no-ops.
 * Call this once during server startup, before the first request arrives.
 */
export function startTelemetryBridge(): void {
  if (_bridge !== null) return;
  _bridge = new SseTelemetryBridge(TelemetryStreamBus.getInstance(), getSseManager());
  _bridge.start();
}

/**
 * Stop and dispose the bridge (shutdown / test teardown).
 */
export function stopTelemetryBridge(): void {
  _bridge?.stop();
  _bridge = null;
}

// ── Route registration ──────────────────────────────────────────────────────────

export function registerTelemetryStreamRoutes(app: FastifyInstance): void {
  // ── GET /telemetry/stream/stats ──────────────────────────────────────────
  // Must be registered before `:deviceId` to avoid ambiguous match.
  app.get('/telemetry/stream/stats', async (_req, reply: FastifyReply) => {
    const counters = getStreamCounters();
    const sseManager = getSseManager();
    return reply.status(200).send({
      stream: counters,
      websocket: getTelemetryWebSocketHub().getStats(),
      connections: sseManager.getConnectionCount(),
      timestamp: new Date().toISOString(),
    });
  });

  // ── GET /telemetry/stream ────────────────────────────────────────────────
  app.get('/telemetry/stream', async (req: FastifyRequest, reply: FastifyReply) => {
    await streamTelemetryEvents(req, reply, '*');
  });

  // ── GET /telemetry/stream/:deviceId ─────────────────────────────────────
  app.get<{ Params: { deviceId: string } }>(
    '/telemetry/stream/:deviceId',
    async (req: FastifyRequest<{ Params: { deviceId: string } }>, reply: FastifyReply) => {
      const { deviceId } = req.params;
      if (typeof deviceId !== 'string' || deviceId.trim() === '') {
        return reply.status(400).send({ error: 'Invalid deviceId parameter' });
      }
      await streamTelemetryEvents(req, reply, deviceId);
    },
  );
}

// ── Shared SSE handler ──────────────────────────────────────────────────────────

/**
 * Set SSE response headers and wire up a per-client telemetry subscription.
 *
 * The function hijacks the reply stream directly (like the existing admin SSE
 * endpoint) and returns a pending promise that resolves when the client
 * disconnects.
 *
 * @param deviceId - `"*"` for all devices, or a specific device serial.
 */
async function streamTelemetryEvents(
  req: FastifyRequest,
  reply: FastifyReply,
  deviceId: string,
): Promise<void> {
  // Set SSE headers on the raw response before any data is written.
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  reply.raw.flushHeaders();

  const bus = TelemetryStreamBus.getInstance();
  const sseManager = getSseManager();

  // Register this client with the SSE manager (handles backpressure, keepalives).
  const clientId = sseManager.addClient(reply);

  // Subscribe to telemetry events for the requested device scope.
  const unsubscribe = bus.subscribe(deviceId, (event: TelemetryStreamEvent) => {
    sseManager.sendToClient(clientId, TELEMETRY_EVENT_NAME, event);
  });

  // Send an initial connection-acknowledged event so the client can detect
  // a successful subscription without waiting for the first telemetry event.
  sseManager.sendToClient(clientId, 'connected', {
    clientId,
    deviceFilter: deviceId,
    timestamp: new Date().toISOString(),
  });

  req.log.info({ clientId, deviceFilter: deviceId }, 'SSE telemetry stream opened');

  // Wait for the client to disconnect.
  await new Promise<void>((resolve) => {
    reply.raw.once('close', () => {
      unsubscribe();
      sseManager.removeClient(clientId);
      req.log.info({ clientId }, 'SSE telemetry stream closed');
      resolve();
    });

    reply.raw.once('error', () => {
      unsubscribe();
      sseManager.removeClient(clientId);
      resolve();
    });
  });
}
