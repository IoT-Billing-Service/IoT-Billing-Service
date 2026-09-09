import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import http from 'node:http';
import { CacheStore } from '../db/store.js';
import { createApi } from './server.js';

let store;
let server;

before(async () => {
  store = new CacheStore(':memory:');
  store.ingest({
    event_id: 'e1',
    contract_id: 'c1',
    ledger: 100,
    device_id: 'D1',
    operator: 'OP1',
    units: 100,
    rate_per_unit: 10,
    cost: 1000,
    balance_after: 999000,
    seq: 1,
    emitted_at: '2026-01-02T10:00:00Z',
    raw: '{}',
  });
  const app = createApi({ storage: store, telemetryBus: null });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
});

after(() => {
  server.close();
  store.close();
});

test('GET /api/devices/D1/metrics returns series', async () => {
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/devices/D1/metrics`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.series.length, 1);
  assert.equal(body.series[0].total_units, 100);
  assert.equal(body.series[0].total_cost, 1000);
});

test('GET /api/devices/D1/balance returns aggregated balance', async () => {
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/devices/D1/balance`);
  const body = await res.json();
  assert.equal(body.on_chain_balance, 999000);
  assert.equal(body.total_units, 100);
  assert.equal(body.total_billed, 1000);
  assert.equal(body.latest_seq, 1);
});

test('GET /health returns ok', async () => {
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.deepEqual(await res.json(), { ok: true });
});

test('aggregate buckets by day and hour', () => {
  const daily = store.aggregate('D1', { granularity: 'day' });
  assert.equal(daily.length, 1);
  const hourly = store.aggregate('D1', { granularity: 'hour' });
  assert.equal(hourly.length, 1);
});
