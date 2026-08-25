'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

// ── Types (mirrors backend DashboardResponse) ──────────────────────────────────

export interface DashboardSummary {
  devices: {
    total: number;
    enabled: number;
    disabled: number;
  };
  billing: {
    totalRecords: number;
    pending: number;
    settled: number;
    totalUsageAmount: string;
    settledUsageAmount: string;
  };
  cycles: {
    total: number;
    open: number;
    finalizing: number;
    finalized: number;
    settled: number;
  };
  account: {
    id: string;
    stellarAddress: string;
    balance: string;
  } | null;
}

export interface RecentBillingRecord {
  id: string;
  deviceId: string;
  usageAmount: string;
  txHash: string | null;
  status: string;
  createdAt: string;
}

export interface SystemHealthSnapshot {
  eventLoopLagMs: number;
  gcPause: {
    p50: number;
    p99: number;
    count: number;
  };
  dbPool: {
    total: number;
    active: number;
    idle: number;
    waiting: number;
  };
  ledgerSync: {
    lag: number;
    lastSyncedSequence: number | null;
    latestPolledSequence: number | null;
  };
  circuitBreaker: {
    state: number;
    queueDepth: number;
  };
  ingestionQueueDepth: number;
  uptimeSeconds: number;
  timestamp: number;
}

export interface DashboardResponse {
  summary: DashboardSummary;
  recentRecords: RecentBillingRecord[];
  systemHealth: SystemHealthSnapshot;
  generatedAt: number;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

const REFRESH_INTERVAL_MS = 15_000; // Auto-refresh every 15s

export function useDashboardData() {
  const queryClient = useQueryClient();

  const query = useQuery<DashboardResponse, Error>({
    queryKey: ['ops-dashboard'],
    queryFn: async (): Promise<DashboardResponse> => {
      const response = await fetch('/api/ops/dashboard', {
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`Dashboard request failed: ${response.status} ${response.statusText}`);
      }

      return response.json() as Promise<DashboardResponse>;
    },
    refetchInterval: REFRESH_INTERVAL_MS,
    staleTime: 5_000,
    retry: 2,
    retryDelay: (attemptIndex: number) => Math.min(1000 * 2 ** attemptIndex, 10_000),
  });

  const lastUpdated = useMemo(() => {
    return query.dataUpdatedAt > 0 ? new Date(query.dataUpdatedAt) : null;
  }, [query.dataUpdatedAt]);

  const refetch = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['ops-dashboard'] });
  }, [queryClient]);

  return {
    data: query.data ?? null,
    isLoading: query.isLoading || query.isFetching,
    error: query.error?.message ?? null,
    refetch,
    lastUpdated,
  };
}
