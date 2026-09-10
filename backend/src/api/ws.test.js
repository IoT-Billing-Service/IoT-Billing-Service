import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import http from 'node:http';
import { WebSocket } from 'ws';
import pkg from '@stellar/stellar-sdk';
import { WebSocketHub } from './ws.js';

const { Keypair } = pkg;
const DEVICE_A = Keypair.random().publicKey();
const DEVICE_B = Keypair.random().publicKey();

let server;
let hub;
let port;

before(async () => {
  server = http.createServer();
  hub = new WebSocketHub(server);
  await new Promise((r) => server.listen(0, r));
  port = server.address().port;
});

after(() => {
  hub.close();
  server.close();
});

/**
 * Connect and buffer every frame (hello is pushed immediately at handshake, so
 * it can beat the promise returned by `open`).
 */
function connect(path = '/stream/telemetry') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    const queue = [];
    const waiters = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      const waiter = waiters.shift();
      if (waiter) waiter(msg);
      else queue.push(msg);
    });
    ws.on('open', () => {
      ws.nextMessage = async () => {
        if (queue.length) return queue.shift();
        return new Promise((res) => waiters.push(res));
      };
      resolve(ws);
    });
    ws.on('error', reject);
  });
}

test('device-filtered client receives only its own device events', async () => {
  const filtered = await connect(`/stream/telemetry?device=${DEVICE_A}`);
  const catchAll = await connect('/stream/telemetry');
  try {
    // Consume hello frames.
    await filtered.nextMessage();
    await catchAll.nextMessage();

    hub.broadcast({ device_id: DEVICE_A, units: 10, cost: 100 });
    hub.broadcast({ device_id: DEVICE_B, units: 5, cost: 50 });

    const gotA = await filtered.nextMessage();
    assert.equal(gotA.device_id, DEVICE_A);

    const got1 = await catchAll.nextMessage();
    const got2 = await catchAll.nextMessage();
    assert.deepEqual(
      [got1.device_id, got2.device_id].sort(),
      [DEVICE_A, DEVICE_B].sort(),
    );
  } finally {
    filtered.close();
    catchAll.close();
  }
});

test('invalid device filter falls back to catch-all mode', async () => {
  const ws = await connect('/stream/telemetry?device=not-a-valid-address');
  try {
    const hello = await ws.nextMessage();
    assert.equal(hello.device, null);
  } finally {
    ws.close();
  }
});
