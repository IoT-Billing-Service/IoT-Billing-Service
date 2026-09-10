import http from 'node:http';
import config from './config.js';
import { CacheStore } from './db/store.js';
import { EventIndexer } from './indexer/indexer.js';
import { createApi, TelemetryBus } from './api/server.js';
import { WebSocketHub } from './api/ws.js';

// 1. Cache layer
const storage = await new CacheStore({
  dbPath: config.dbPath,
  databaseUrl: config.databaseUrl,
}).ready();

// 2. Telemetry bus: indexer -> WS clients
const bus = new TelemetryBus();

// 3. HTTP + WS server
const server = http.createServer();
const app = createApi({ storage, telemetryBus: bus, config });
server.on('request', app);
const hub = new WebSocketHub(server);
bus.subscribe((row) => hub.broadcast(row));

// 4. Event indexer
const indexer = new EventIndexer({
  rpcUrl: config.sorobanRpcUrl,
  contractId: config.contractId,
  storage,
  pollIntervalMs: config.pollIntervalMs,
  onEvent: (row) => bus.publish(row),
});
indexer.start();

server.listen(config.httpPort, () => {
  console.log(`[api] listening on :${config.httpPort} (ws /stream/telemetry)`);
});

const shutdown = async () => {
  indexer.stop();
  hub.close();
  await storage.close();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
