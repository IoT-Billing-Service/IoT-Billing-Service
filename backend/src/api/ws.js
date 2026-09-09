import { WebSocketServer } from 'ws';

/**
 * Live telemetry WebSocket stream backing the frontend dashboards.
 */
export class WebSocketHub {
  constructor(server) {
    this.wss = new WebSocketServer({ server, path: '/stream/telemetry' });
    this.wss.on('connection', (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => (ws.isAlive = true));
      ws.send(JSON.stringify({ type: 'hello', ts: new Date().toISOString() }));
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
      if (ws.readyState === ws.OPEN) {
        ws.send(payload);
      }
    }
  }

  close() {
    clearInterval(this.heartbeat);
    this.wss.close();
  }
}
