// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WalletProvider, useWallet } from '@/components/providers/WalletProvider';
import type { ReactNode } from 'react';

const { mockAddresses, nextMockAddress } = vi.hoisted(() => {
  const addrs = [
    'GA7QYNF7SOWQ3GLR2JGMGEKOV7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7AAA1',
    'GA7QYNF7SOWQ3GLR2JGMGEKOV7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7BBB2',
    'GA7QYNF7SOWQ3GLR2JGMGEKOV7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7CCC3',
    'GA7QYNF7SOWQ3GLR2JGMGEKOV7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7DDD4',
    'GA7QYNF7SOWQ3GLR2JGMGEKOV7Y2QH7Y2QH7Y2QH7Y2QH7Y2QH7EEE5',
  ];
  let idx = 0;
  return {
    mockAddresses: addrs,
    nextMockAddress: () => {
      const addr = addrs[idx % addrs.length];
      idx++;
      return addr;
    },
  };
});

vi.mock('@stellar/freighter-api', () => {
  class MockWatchWalletChanges {
    watch = vi.fn();
    stop = vi.fn();
  }
  
  return {
    WatchWalletChanges: MockWatchWalletChanges,
    getAddress: vi.fn(() => Promise.resolve({ address: nextMockAddress(), error: undefined })),
    getNetwork: vi.fn(() =>
      Promise.resolve({
        network: 'testnet',
        networkPassphrase: 'Test SDF Network ; September 2015',
        error: undefined,
      }),
    ),
  };
});

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <WalletProvider>{children}</WalletProvider>
      </QueryClientProvider>
    );
  };
}

describe('WalletProvider race condition prevention', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify([{ asset: 'XLM', balance: '100', decimals: 7 }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('discards stale connect responses from 5 rapid calls and commits only the last key', async () => {
    const { result } = renderHook(() => useWallet(), { wrapper: createWrapper() });

    expect(result.current.metrics).toBeNull();

    await act(async () => {
      await Promise.all(Array.from({ length: 5 }, () => result.current.connect()));
    });

    await waitFor(() => {
      expect(result.current.metrics?.publicKey).toBe(mockAddresses[4]);
    });
    expect(result.current.metrics?.isConnected).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('resets state on disconnect', async () => {
    const { result } = renderHook(() => useWallet(), { wrapper: createWrapper() });

    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.metrics).not.toBeNull();

    await act(async () => {
      await result.current.disconnect();
    });
    expect(result.current.metrics).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('surfaces connection errors', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('Network request failed')));

    const { result } = renderHook(() => useWallet(), { wrapper: createWrapper() });

    await act(async () => {
      await result.current.connect();
    });

    await waitFor(() => {
      expect(result.current.error).toBe('Network request failed');
    });
    expect(result.current.metrics).toBeNull();
  });
});
