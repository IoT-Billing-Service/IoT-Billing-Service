// Shared session store for all auth routes
// In production, replace with Redis or similar distributed cache

export interface NonceEntry {
  nonce: string;
  expiresAt: number;
}

export interface SessionEntry {
  jwt: string;
  expiresAt: number;
  lastHeartbeat: number;
}

// In-memory stores (replace with Redis in production)
export const nonceStore = new Map<string, NonceEntry>();
export const sessionStore = new Map<string, SessionEntry>();

// Cleanup expired nonces every 10 minutes
setInterval(
  () => {
    const now = Date.now();
    for (const [key, value] of nonceStore.entries()) {
      if (now > value.expiresAt) {
        nonceStore.delete(key);
      }
    }
  },
  10 * 60 * 1000,
);

// Cleanup expired or inactive sessions every 5 minutes
setInterval(
  () => {
    const now = Date.now();
    const HEARTBEAT_TIMEOUT = 60_000; // 60 seconds

    for (const [key, value] of sessionStore.entries()) {
      // Remove if expired or no heartbeat for too long
      if (now > value.expiresAt || now - value.lastHeartbeat > HEARTBEAT_TIMEOUT) {
        sessionStore.delete(key);
      }
    }
  },
  5 * 60 * 1000,
);
