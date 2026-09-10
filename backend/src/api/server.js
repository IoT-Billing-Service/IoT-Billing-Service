import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import rateLimit from 'express-rate-limit';
import createReadingsRouter from './readings.js';

/**
 * REST + WebSocket API over the event cache.
 *
 * POST /api/readings              — device telemetry gateway (sig-verified relay)
 * GET  /api/devices               — listed devices observed by the indexer
 * GET  /api/devices/:id/metrics   — aggregated consumption over time
 * GET  /api/devices/:id/balance   — latest on-chain balance + pending units
 * WS   /stream/telemetry          — live device heartbeats
 */
export function createApi({ storage, telemetryBus: _telemetryBus, config }) {
  const app = express();

  // Cross-origin policy: only allow configured browser origins. Empty
  // CORS_ORIGIN keeps the dev default (any origin) so local tooling works.
  const allowedOrigins = (config?.corsOrigin ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.use(
    cors(
      allowedOrigins.length > 0
        ? {
            origin(origin, callback) {
              if (!origin || allowedOrigins.includes(origin)) {
                return callback(null, true);
              }
              return callback(new Error('origin not allowed by CORS'));
            },
          }
        : { origin: true },
    ),
  );
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ ok: true }));

  if (config) {
    // Throttle the signature-verified telemetry ingest endpoint.
    const submitted = rateLimit({
      windowMs: config.rateLimitWindowMs,
      limit: config.rateLimitMax,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'too many telemetry submissions; slow down' },
    });
    app.use('/api/readings', submitted);
    app.use(createReadingsRouter({ config, storage }));
  }

  app.get('/api/devices/:id/metrics', async (req, res) => {
    const { from, to, granularity } = req.query;
    const rows = await storage.metricsFor(req.params.id, { from, to });
    const series = await storage.aggregate(req.params.id, {
      from,
      to,
      granularity,
    });
    res.json({
      device_id: req.params.id,
      series,
      samples: rows,
    });
  });

  app.get('/api/devices/:id/balance', async (req, res) => {
    const rows = await storage.metricsFor(req.params.id);
    const latest = rows[rows.length - 1] ?? null;
    const totalUnits = rows.reduce((a, r) => a + Number(r.units || 0), 0);
    const totalCost = rows.reduce((a, r) => a + Number(r.cost || 0), 0);
    res.json({
      device_id: req.params.id,
      on_chain_balance: latest ? Number(latest.balance_after) : null,
      latest_seq: await storage.latestSequence(req.params.id),
      pending_uncommitted_units: 0,
      total_units: totalUnits,
      total_billed: totalCost,
      last_reading: latest,
    });
  });

  app.get('/api/devices', async (_req, res) => {
    res.json({ devices: await storage.listDevices() });
  });

  app.use((err, _req, res, _next) => {
    if (err.message === 'origin not allowed by CORS') {
      return res.status(403).json({ error: err.message });
    }
    console.error('[api] unhandled error:', err.message);
    res.status(500).json({ error: 'internal error' });
  });

  if (config && config.frontendDist && fs.existsSync(config.frontendDist)) {
    const dist = path.resolve(config.frontendDist);
    app.use(express.static(dist));
    app.get(/^(?!\/api|\/health|\/stream).*/, (_req, res) => {
      res.sendFile(path.join(dist, 'index.html'));
    });
  }

  return app;
}

/**
 * Minimal WebSocket hub re-exported from the real-time transport module.
 */
export { WebSocketHub } from './ws.js';

/**
 * In-process bus: indexer -> socket clients + (future) aggregations.
 */
export class TelemetryBus {
  constructor() {
    this.subscribers = new Set();
  }
  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }
  publish(row) {
    for (const fn of this.subscribers) {
      try {
        fn(row);
      } catch (err) {
        console.error('[telemetry] subscriber error:', err.message);
      }
    }
  }
}
