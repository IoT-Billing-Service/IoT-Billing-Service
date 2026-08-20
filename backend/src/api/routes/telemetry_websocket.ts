import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { verifySessionToken } from '../auth/session.js';
import {
  TelemetryStreamBus,
  type TelemetryStreamEvent,
} from '../../core/ingestion/telemetry_stream.js';

const MAX_BUFFERED_BYTES = 1_048_576;
const TOKEN_HINT_SECONDS = 120;

export interface TelemetryWebSocketStats {
  connections: number;
  delivered: number;
  dropped: number;
  rejected: number;
}

interface StreamQuery {
  token?: string;
  deviceId?: string;
}

interface Client {
  socket: WebSocket;
  expiryTimer: ReturnType<typeof setTimeout>;
  unsubscribe: () => void;
}

export class TelemetryWebSocketHub {
  private readonly clients = new Set<Client>();
  private readonly stats: TelemetryWebSocketStats = {
    connections: 0,
    delivered: 0,
    dropped: 0,
    rejected: 0,
  };

  constructor(private readonly bus: TelemetryStreamBus) {}

  addClient(socket: WebSocket, deviceId: string, expiresAt: number): () => void {
    const client: Client = {
      socket,
      expiryTimer: setTimeout(
        () => {
          this.sendControl(client, { type: 'token_expiring', expires_in: 0 });
        },
        Math.max(0, (expiresAt - Math.floor(Date.now() / 1000) - TOKEN_HINT_SECONDS) * 1000),
      ),
      unsubscribe: () => {},
    };

    client.unsubscribe = this.bus.subscribe(deviceId, (event) => {
      this.sendEvent(client, event);
    });
    this.clients.add(client);
    this.stats.connections = this.clients.size;

    return () => this.removeClient(client);
  }

  removeClient(client: Client): void {
    if (!this.clients.delete(client)) return;
    clearTimeout(client.expiryTimer);
    client.unsubscribe();
    this.stats.connections = this.clients.size;
  }

  handleMessage(socket: WebSocket, raw: string): void {
    try {
      const message = JSON.parse(raw) as { type?: string };
      if (message.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
    } catch {
      socket.close(1003, 'Invalid message');
    }
  }

  recordRejected(): void {
    this.stats.rejected++;
  }

  getStats(): TelemetryWebSocketStats {
    return { ...this.stats };
  }

  private sendEvent(client: Client, event: TelemetryStreamEvent): void {
    if (client.socket.readyState !== 1) return;
    if (client.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.stats.dropped++;
      return;
    }
    client.socket.send(JSON.stringify(event));
    this.stats.delivered++;
  }

  private sendControl(client: Client, message: Record<string, unknown>): void {
    if (client.socket.readyState === 1) client.socket.send(JSON.stringify(message));
  }
}

let hub: TelemetryWebSocketHub | null = null;

export function getTelemetryWebSocketHub(): TelemetryWebSocketHub {
  if (hub === null) hub = new TelemetryWebSocketHub(TelemetryStreamBus.getInstance());
  return hub;
}

export function resetTelemetryWebSocketHub(): void {
  hub = null;
}

export async function registerTelemetryWebSocketRoutes(app: FastifyInstance): Promise<void> {
  await app.register(import('@fastify/websocket'));
  const streamHub = getTelemetryWebSocketHub();

  app.get<{ Querystring: StreamQuery }>(
    '/api/billing/stream',
    { websocket: true },
    (socket, request: FastifyRequest<{ Querystring: StreamQuery }>) => {
      const token = request.query.token;
      const payload = token ? verifySessionToken(token) : null;
      if (!payload || payload.exp <= Math.floor(Date.now() / 1000)) {
        streamHub.recordRejected();
        socket.close(4001, 'Unauthorized');
        return;
      }

      const deviceId = request.query.deviceId?.trim() || '*';
      const removeClient = streamHub.addClient(socket, deviceId, payload.exp);
      socket.send(JSON.stringify({ type: 'connected', deviceFilter: deviceId }));
      socket.on('message', (raw: { toString(): string }) =>
        streamHub.handleMessage(socket, raw.toString()),
      );
      socket.on('close', removeClient);
      socket.on('error', removeClient);
    },
  );
}
