const SOROBAN_RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';

const XLM_USD_ORACLE_URL =
  process.env.NEXT_PUBLIC_XLM_USD_ORACLE_URL ?? 'https://api.stellar.org/xlm-usd';

const CACHE_TTL_MS = 30_000;

const SIMULATION_TIMEOUT_MS = 3_000;

export { SOROBAN_RPC_URL, XLM_USD_ORACLE_URL, CACHE_TTL_MS, SIMULATION_TIMEOUT_MS };
