import 'dotenv/config';

const config = {
  sorobanRpcUrl:
    process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
  networkPassphrase:
    process.env.NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
  contractId: process.env.CONTRACT_ID || '',
  relayerSecret: process.env.RELAYER_SECRET || '',
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 5000),
  dbPath: process.env.DB_PATH || './data/billing.db',
  databaseUrl: process.env.DATABASE_URL || null,
  httpPort: Number(process.env.HTTP_PORT || 8080),
  wsPort: Number(process.env.WS_PORT || 8080),
  frontendDist: process.env.FRONTEND_DIST || '../frontend/dist',
  get pollEnabled() {
    return Boolean(this.contractId);
  },
};

export default config;