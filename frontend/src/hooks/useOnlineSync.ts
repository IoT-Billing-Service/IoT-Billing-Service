'use client';

import { useState, useCallback, useEffect } from 'react';
import {
  getAllPendingMutations,
  deletePendingMutation,
  getPendingMutationsCount,
  type PendingMutation,
} from '@/services/indexedDbCache';

async function replayMutation(mutation: PendingMutation): Promise<void> {
  const { url, method, body, headers } = mutation.payload;
  const res = await fetch(url, { method, body, headers });
  if (!res.ok) throw new Error(`Replay failed: ${res.status}`);
}

export function useOnlineSync() {
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  const [pendingCount, setPendingCount] = useState(0);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);

  const refreshCount = useCallback(async () => {
    const count = await getPendingMutationsCount();
    setPendingCount(count);
  }, []);

  const drainQueue = useCallback(async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    try {
      const mutations = await getAllPendingMutations();
      mutations.sort((a, b) => a.createdAt - b.createdAt);
      for (const mutation of mutations) {
        try {
          await replayMutation(mutation);
          await deletePendingMutation(mutation.id);
        } catch {
          // leave failed replays for next sync
        }
      }
      setLastSync(Date.now());
    } finally {
      setIsSyncing(false);
      await refreshCount();
    }
  }, [isSyncing, refreshCount]);

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      drainQueue();
    };
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    const loadInitialCount = async () => {
      const count = await getPendingMutationsCount();
      setPendingCount(count);
    };
    loadInitialCount();

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [drainQueue]);

  return { isOnline, pendingCount, lastSync, isSyncing, forceSync: drainQueue };
}
