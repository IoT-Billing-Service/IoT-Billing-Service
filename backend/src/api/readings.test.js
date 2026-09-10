import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import http from 'node:http';
import crypto from 'node:crypto';
import { CacheStore } from '../db/store.js';
import { createApi } from './server.js';

const SIGNING_DOMAIN = Buffer.from('iot-billing-v1', 'utf8');

function deriveKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'jwk' }).x;
  const pubkey = Buffer.from(raw, 'base64url');
  return { publicKey, privateKey, pubkey };
}

function u64be(n) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(n));
  return buf;
}

function signPayload({ privateKey, pubkey }, seq, deltaUnits, ts) {
  const message = Buffer.concat([
    SIGNING_DOMAIN,
    pubkey,
    u64be(seq),
    u64be(deltaUnits),
    u64be(ts),
  ]);
  const signature = crypto.sign(null, message, privateKey);
  return { pubkey, signature };
}

let store;
let server;
let keys;
let port;

before(async () => {
  store = await new CacheStore({ dbPath: ':memory:' }).ready();
  keys = deriveKeys();
  const app = createApi({
    storage: store,
    telemetryBus: null,
    config: { frontendDist: null, contractId: '', relayerSecret: '' },
  });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  port = server.address().port;
});

after(async () => {
  server.close();
  await store.close();
});

test('POST /api/readings accepts a valid signed reading (202, not relayed)', async () => {
  const { pubkey, signature } = signPayload(keys, 1, 10, 1700000000000);
  const res = await fetch(`http://127.0.0.1:${port}/api/readings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_id: 'D1',
      device_pubkey: pubkey.toString('hex'),
      seq: 1,
      delta_units: 10,
      timestamp_ms: 1700000000000,
      signature: signature.toString('hex'),
    }),
  });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.relayed, false);
  assert.match(body.device_id, /^G/);
});

test('POST /api/readings rejects a tampered signature', async () => {
  const { pubkey, signature } = signPayload(keys, 1, 10, 1700000000000);
  const bad = Buffer.from(signature);
  bad[0] ^= 0xff;
  const res = await fetch(`http://127.0.0.1:${port}/api/readings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_id: 'D1',
      device_pubkey: pubkey.toString('hex'),
      seq: 1,
      delta_units: 10,
      timestamp_ms: 1700000000000,
      signature: bad.toString('hex'),
    }),
  });
  assert.equal(res.status, 401);
});

test('POST /api/readings rejects missing fields', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/readings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seq: 1 }),
  });
  assert.equal(res.status, 400);
});

test('readings persisted to pending_readings for audit trail', async () => {
  const rows = await store.pendingReadings();
  assert.equal(rows.length, 1);
});
