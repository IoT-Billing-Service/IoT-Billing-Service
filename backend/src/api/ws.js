import { WebSocketServer, WebSocket } from 'ws';
import { StrKey } from '@stellar/stellar-sdk';

/**
 * Live telemetry WebSocket stream backing the frontend dashboards.
 *
 * Clients may subscribe to a single device channel with
 * `/stream/telemetry?device=<G...>`; only that device's `meter_billed`
 * events are delivered. Without the param a client receives every event
 * (dashboard / operator mode).
 */
export class WebSocketHub {
  constructor(server) {
    this.wss = new WebSocketServer({ server, path: '/stream/telemetry' });
    this.wss.on('connection', (ws, req) => {
      ws.isAlive = true;
      ws.on('pong', () => (ws.isAlive = true));
      const device = new URL(
        req.url ?? '/',
        'http://localhost',
      ).searchParams.get('device');
      ws.deviceFilter =
        device && StrKey.isValidEd25519PublicKey(device) ? device : null;
      ws.send(
        JSON.stringify({
          type: 'hello',
          ts: new Date().toISOString(),
          device: ws.deviceFilter,
        }),
      );
    });
    this.heartbeat = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (!ws.isAlive) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }, 30_000);
  }

  broadcast(row) {
    const payload = JSON.stringify({ type: 'meter_billed', ...row });
    for (const ws of this.wss.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (ws.deviceFilter && ws.deviceFilter !== row.device_id) continue;
      ws.send(payload);
    }
  }

  close() {
    clearInterval(this.heartbeat);
    this.wss.close();
  }
}
