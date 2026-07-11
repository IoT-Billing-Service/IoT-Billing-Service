'use client';

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  WatchWalletChanges,
  getAddress as freighterGetAddress,
  getNetwork as freighterGetNetwork,
} from '@stellar/freighter-api';
import type { WalletMetrics, AssetBalance } from '@/types';
import { cacheDelete } from '@/services/indexedDbCache';
import { useLatestRequest } from '@/hooks/useLatestRequest';

interface WalletContextValue {
  metrics: WalletMetrics | null;
  isConnecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  refreshBalances: (publicKey: string) => Promise<void>;
  onWalletDisconnected?: () => void;
}

const WalletContext = createContext<WalletContextValue | null>(null);

async function getFreighterPublicKey(): Promise<string> {
  const result = await freighterGetAddress();
  if (result.error) throw new Error(result.error.message ?? 'Freighter connection failed');
  return result.address;
}

async function getFreighterNetwork(): Promise<'testnet' | 'mainnet' | 'futurenet'> {
  const result = await freighterGetNetwork();
  if (result.error) throw new Error(result.error.message ?? 'Failed to get network');
  const network = result.network;
  if (network !== 'testnet' && network !== 'mainnet' && network !== 'futurenet') {
    return 'testnet';
  }
  return network;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [metrics, setMetrics] = useState<WalletMetrics | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const publicKeyRef = useRef<string | null>(null);
  const disconnectCallbackRef = useRef<(() => void) | null>(null);
  const balanceRequest = useLatestRequest<AssetBalance[]>();

  // Instant wallet disconnection detection using WatchWalletChanges
  useEffect(() => {
    const watcher = new WatchWalletChanges(1000); // Poll every 1 second for instant detection

    watcher.watch((event) => {
      // Handle wallet lock, disconnection, or account change
      // If no address or different address, wallet was disconnected/changed
      if (!event.address || event.address !== publicKeyRef.current) {
        const previousKey = publicKeyRef.current;

        generationRef.current += 1;
        abortControllerRef.current?.abort();
        abortControllerRef.current = null;
        publicKeyRef.current = null;
        setMetrics(null);
        setError(null);
        setIsConnecting(false);

        // Immediately clear all cached data
        queryClient.clear();

        // Logout from backend if we had a session
        if (previousKey) {
          void (async () => {
            try {
              await fetch('/api/auth/logout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ publicKey: previousKey }),
              });
              await cacheDelete('authSession', previousKey);
            } catch {
              // best-effort cleanup
            }
          })();

          // Trigger callback for session monitor
          disconnectCallbackRef.current?.();
        }
      } else if (event.address && event.address !== publicKeyRef.current) {
        // Account changed to a different address
        generationRef.current += 1;
        abortControllerRef.current?.abort();
        abortControllerRef.current = null;
        publicKeyRef.current = event.address;
        setMetrics(null);
        setError(null);
        setIsConnecting(false);
        queryClient.clear();
      }
    });

    return () => {
      watcher.stop();
    };
  }, [queryClient]);

  const { run: runBalanceRequest } = balanceRequest;
  const refreshBalances = useCallback(
    async (pk: string) => {
      // Race-safe: concurrent refreshes abort the previous request, so an older
      // (slower) balances response can never overwrite a newer one.
      const balances = await runBalanceRequest(async (signal) => {
        const response = await fetch(`/api/wallet/balances?publicKey=${pk}`, { signal });
        if (!response.ok) {
          throw new Error(`Failed to fetch balances: ${response.status}`);
        }
        return (await response.json()) as AssetBalance[];
      });
      if (balances) {
        setMetrics((prev) => (prev ? { ...prev, balances } : null));
      }
    },
    [runBalanceRequest],
  );

  const connect = useCallback(async () => {
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const generation = ++generationRef.current;

    setIsConnecting(true);
    setError(null);

    try {
      const publicKey = await getFreighterPublicKey();
      if (controller.signal.aborted || generation !== generationRef.current) return;

      const network = await getFreighterNetwork();
      if (controller.signal.aborted || generation !== generationRef.current) return;

      const response = await fetch(`/api/wallet/balances?publicKey=${publicKey}`);
      const balances: AssetBalance[] = response.ok ? await response.json() : [];

      if (!controller.signal.aborted && generation === generationRef.current) {
        publicKeyRef.current = publicKey;
        queryClient.clear();
        setMetrics({ publicKey, balances, network, isConnected: true });
      }
    } catch (err) {
      if (!controller.signal.aborted && generation === generationRef.current) {
        setError(err instanceof Error ? err.message : 'Wallet connection failed');
      }
    } finally {
      if (!controller.signal.aborted && generation === generationRef.current) {
        setIsConnecting(false);
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
      }
    }
  }, [queryClient]);

  const disconnect = useCallback(async () => {
    const previousKey = publicKeyRef.current;

    generationRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    publicKeyRef.current = null;
    setMetrics(null);
    setError(null);
    queryClient.clear();

    // Logout from backend
    if (previousKey) {
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ publicKey: previousKey }),
        });
        await cacheDelete('authSession', previousKey);
      } catch {
        // best-effort cleanup
      }
    }
  }, [queryClient]);

  // Cleanup on unmount and tab close
  useEffect(() => {
    const handleBeforeUnload = () => {
      const pk = publicKeyRef.current;
      if (pk) {
        // Use sendBeacon for reliable cleanup on tab close
        const blob = new Blob([JSON.stringify({ publicKey: pk })], {
          type: 'application/json',
        });
        navigator.sendBeacon('/api/auth/logout', blob);
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      abortControllerRef.current?.abort();
    };
  }, []);

  return (
    <WalletContext.Provider
      value={{ metrics, isConnecting, error, connect, disconnect, refreshBalances }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used within WalletProvider');
  return ctx;
}
