'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { Web3AuthSession } from '@/types';
import { cachePut, cacheGet, cacheDelete } from '@/services/indexedDbCache';
import { startSessionMonitor, stopSessionMonitor } from '@/services/sessionMonitor';

async function fetchNonce(publicKey: string): Promise<string> {
  const response = await fetch(`/api/auth/nonce?publicKey=${publicKey}`);
  if (!response.ok) throw new Error('Failed to fetch nonce');
  const data = await response.json();
  return data.nonce as string;
}

async function signChallenge(publicKey: string, nonce: string): Promise<string> {
  try {
    const { signMessage } = await import('@stellar/freighter-api');
    const result = await signMessage(nonce, { address: publicKey });
    if (result.error) throw new Error(result.error.message ?? 'Signing rejected');
    const signed = result.signedMessage;
    if (!signed) throw new Error('Empty signature returned');
    return typeof signed === 'string' ? signed : signed.toString('hex');
  } catch {
    throw new Error('Wallet signature was rejected or unavailable');
  }
}

async function verifySignature(params: {
  publicKey: string;
  signedChallenge: string;
  nonce: string;
}): Promise<Web3AuthSession> {
  const response = await fetch('/api/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!response.ok) throw new Error('Signature verification failed');
  return response.json();
}

export function useWeb3Auth() {
  const queryClient = useQueryClient();

  const authenticateMutation = useMutation({
    mutationFn: async (publicKey: string) => {
      const nonce = await fetchNonce(publicKey);
      const signedChallenge = await signChallenge(publicKey, nonce);
      const session = await verifySignature({ publicKey, signedChallenge, nonce });
      await cachePut('authSession', publicKey, session);

      // Start session monitor with heartbeat
      startSessionMonitor(publicKey, {
        onExpired: () => {
          queryClient.setQueryData(['authSession'], null);
          queryClient.clear();
        },
        queryClient,
      });

      return session;
    },
    onSuccess: (session) => {
      queryClient.setQueryData(['authSession'], session);
    },
  });

  const logoutMutation = useMutation({
    mutationFn: async (publicKey: string) => {
      stopSessionMonitor();

      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey }),
      });
      await cacheDelete('authSession', publicKey);
      queryClient.clear();
    },
    onSuccess: () => {
      queryClient.setQueryData(['authSession'], null);
    },
  });

  // Cleanup session monitor on unmount
  useEffect(() => {
    return () => {
      stopSessionMonitor();
    };
  }, []);

  return {
    authenticate: authenticateMutation,
    logout: logoutMutation,
    isLoading: authenticateMutation.isPending,
    session: queryClient.getQueryData<Web3AuthSession>(['authSession']),
  };
}

export async function restoreSession(publicKey: string): Promise<Web3AuthSession | null> {
  return cacheGet<Web3AuthSession>('authSession', publicKey);
}
