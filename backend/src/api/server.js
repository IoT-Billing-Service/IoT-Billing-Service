import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
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
  app.use(cors());
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ ok: true }));

  if (config) {
    app.use(createReadingsRouter({ config, storage }));
  }

  app.get('/api/devices/:id/metrics', (req, res) => {
    const { from, to, granularity } = req.query;
    const rows = storage.metricsFor(req.params.id, { from, to });
    const series = storage.aggregate(req.params.id, { from, to, granularity });
    res.json({
      device_id: req.params.id,
      series,
      samples: rows,
    });
  });

  app.get('/api/devices/:id/balance', (req, res) => {
    const rows = storage.metricsFor(req.params.id);
    const latest = rows[rows.length - 1] ?? null;
    const totalUnits = rows.reduce((a, r) => a + Number(r.units || 0), 0);
    const totalCost = rows.reduce((a, r) => a + Number(r.cost || 0), 0);
    res.json({
      device_id: req.params.id,
      on_chain_balance: latest ? Number(latest.balance_after) : null,
      latest_seq: storage.latestSequence(req.params.id),
      pending_uncommitted_units: 0,
      total_units: totalUnits,
      total_billed: totalCost,
      last_reading: latest,
    });
  });

  app.get('/api/devices', (_req, res) => {
    res.json({ devices: storage.listDevices() });
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
