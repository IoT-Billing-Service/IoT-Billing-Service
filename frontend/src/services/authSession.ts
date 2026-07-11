'use client';

import type { Web3AuthSession } from '@/types';
import { cacheGet, cachePut } from '@/services/indexedDbCache';

function decodeJwtSubject(jwt: string): string | null {
  try {
    const payload = jwt.split('.')[0];
    if (!payload) return null;
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(atob(normalized));
    return typeof decoded.sub === 'string' ? decoded.sub : null;
  } catch {
    return null;
  }
}

export async function getCurrentAuthSession(): Promise<Web3AuthSession | null> {
  const querySession =
    typeof window !== 'undefined' ? window.__IOT_BILLING_AUTH_SESSION__ : undefined;
  if (querySession) return querySession;

  const publicKey = typeof window !== 'undefined' ? window.__IOT_BILLING_PUBLIC_KEY__ : undefined;
  if (!publicKey) return null;
  return cacheGet<Web3AuthSession>('authSession', publicKey);
}

declare global {
  interface Window {
    __IOT_BILLING_AUTH_SESSION__?: Web3AuthSession;
    __IOT_BILLING_PUBLIC_KEY__?: string;
  }
}

export async function refreshToken(): Promise<Web3AuthSession> {
  const session = await getCurrentAuthSession();
  if (!session) throw new Error('No auth session available for token refresh');

  const response = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey: session.publicKey, jwt: session.jwt }),
  });

  if (!response.ok) throw new Error(`Token refresh failed: ${response.status}`);
  const nextSession = (await response.json()) as Web3AuthSession;
  await cachePut('authSession', nextSession.publicKey, nextSession);
  if (typeof window !== 'undefined') {
    window.__IOT_BILLING_AUTH_SESSION__ = nextSession;
    window.__IOT_BILLING_PUBLIC_KEY__ = nextSession.publicKey;
  }
  return nextSession;
}

export async function validateToken(jwt: string): Promise<boolean> {
  const response = await fetch('/api/auth/validate', {
    method: 'HEAD',
    headers: { Authorization: `Bearer ${jwt}` },
  });
  return response.ok;
}

export function getPublicKeyFromJwt(jwt: string): string | null {
  return decodeJwtSubject(jwt);
}
