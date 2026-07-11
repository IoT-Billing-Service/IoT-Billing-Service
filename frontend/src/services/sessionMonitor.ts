import { cacheGet, cacheClear } from './indexedDbCache';
import type { Web3AuthSession } from '@/types';
import type { QueryClient } from '@tanstack/react-query';

const HEARTBEAT_INTERVAL = 55_000; // 55 seconds
const HEARTBEAT_TIMEOUT = 60_000; // Backend invalidates after 60 seconds of no heartbeat
const EXPIRY_BUFFER = 60_000;

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let lastHeartbeatTime = 0;

async function terminateSession(publicKey: string, queryClient?: QueryClient): Promise<void> {
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey }),
    });
  } catch {
    // best-effort server logout
  }
  await cacheClear('authSession');

  // Clear all query cache if available
  if (queryClient) {
    queryClient.clear();
  }
}

async function sendHeartbeat(jwt: string): Promise<boolean> {
  try {
    const response = await fetch('/api/auth/heartbeat', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${jwt}`,
      },
    });

    if (response.ok) {
      lastHeartbeatTime = Date.now();
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export interface SessionMonitorOptions {
  onExpired?: () => void;
  queryClient?: QueryClient;
}

/**
 * Starts a heartbeat-based session monitor
 * Sends heartbeat every 55 seconds to keep session alive
 * If heartbeat fails or session expires, triggers logout
 */
export function startSessionMonitor(
  publicKey: string,
  options?: SessionMonitorOptions,
): () => void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }

  const { onExpired, queryClient } = options ?? {};
  lastHeartbeatTime = Date.now();

  heartbeatInterval = setInterval(async () => {
    try {
      const session = await cacheGet<Web3AuthSession>('authSession', publicKey);

      // No session found
      if (!session) {
        onExpired?.();
        stopSessionMonitor();
        return;
      }

      // Check if session is about to expire
      if (Date.now() > session.expiresAt - EXPIRY_BUFFER) {
        await terminateSession(publicKey, queryClient);
        onExpired?.();
        stopSessionMonitor();
        return;
      }

      // Send heartbeat to backend
      const heartbeatSuccess = await sendHeartbeat(session.jwt);

      if (!heartbeatSuccess) {
        // Heartbeat failed - session might be invalid on backend
        await terminateSession(publicKey, queryClient);
        onExpired?.();
        stopSessionMonitor();
        return;
      }

      // Check if we've missed a heartbeat window (e.g., laptop was suspended)
      if (Date.now() - lastHeartbeatTime > HEARTBEAT_TIMEOUT) {
        await terminateSession(publicKey, queryClient);
        onExpired?.();
        stopSessionMonitor();
      }
    } catch {
      // monitor check failed - terminate session to be safe
      await terminateSession(publicKey, queryClient);
      onExpired?.();
      stopSessionMonitor();
    }
  }, HEARTBEAT_INTERVAL);

  return () => {
    stopSessionMonitor();
  };
}

export function stopSessionMonitor(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  lastHeartbeatTime = 0;
}
