'use client';

import { useOnlineSync } from '@/hooks/useOnlineSync';

export function OfflineSyncStatus() {
  const { isOnline, pendingCount, lastSync, isSyncing, forceSync } = useOnlineSync();

  if (isOnline && pendingCount === 0) return null;

  return (
    <div className="flex items-center gap-3 rounded-md border border-yellow-700 bg-yellow-950 px-3 py-2 text-xs text-yellow-300">
      {!isOnline && <span className="font-medium">Offline</span>}
      {pendingCount > 0 && (
        <span>
          {pendingCount} offline mutation{pendingCount !== 1 ? 's' : ''} pending
        </span>
      )}
      {lastSync && (
        <span className="text-yellow-500">
          Last sync: {new Date(lastSync).toLocaleTimeString()}
        </span>
      )}
      <button
        onClick={forceSync}
        disabled={isSyncing || !isOnline}
        className="ml-auto rounded bg-yellow-700 px-2 py-0.5 font-medium hover:bg-yellow-600 disabled:opacity-50"
      >
        {isSyncing ? 'Syncing…' : 'Force Sync'}
      </button>
    </div>
  );
}
