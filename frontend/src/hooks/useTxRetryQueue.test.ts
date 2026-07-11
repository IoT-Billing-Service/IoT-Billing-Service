import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useTxRetryQueue } from './useTxRetryQueue';
import * as indexedDbCache from '@/services/indexedDbCache';

// Mock the indexedDbCache module
vi.mock('@/services/indexedDbCache', () => ({
  savePendingTransaction: vi.fn().mockResolvedValue(undefined),
  getAllPendingTransactions: vi.fn().mockResolvedValue([]),
  deletePendingTransaction: vi.fn().mockResolvedValue(undefined),
  deleteCompletedTransactions: vi.fn().mockResolvedValue(0),
  getPendingTransaction: vi.fn().mockResolvedValue(null),
  getPendingTransactionsByStatus: vi.fn().mockResolvedValue([]),
}));

// Mock fetch for transaction status polling
global.fetch = vi.fn();

describe('useTxRetryQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'pending' }),
    });
  });

  it('should initialize with empty queue', () => {
    const { result } = renderHook(() => useTxRetryQueue());

    expect(result.current.queue).toEqual([]);
    expect(result.current.pendingTransactions).toEqual([]);
    expect(result.current.isEmpty).toBe(true);
  });

  it('should enqueue a transaction', async () => {
    const { result } = renderHook(() => useTxRetryQueue(10, 'test-queue'));

    const params = {
      hash: 'test-hash',
      contractId: 'contract-123',
      amount: '1000',
      asset: 'USDC',
      publicKey: 'GTEST123',
      type: 'escrow_deposit' as const,
    };

    await waitFor(async () => {
      const id = await result.current.enqueue(params);
      expect(id).toBeTruthy();
    });

    expect(indexedDbCache.savePendingTransaction).toHaveBeenCalled();
  });

  it('should detect and merge duplicate transactions', async () => {
    const existingTx: indexedDbCache.PendingTransaction = {
      id: 'existing-tx',
      hash: 'hash1',
      contractId: 'contract-123',
      amount: '1000',
      asset: 'USDC',
      publicKey: 'GTEST123',
      type: 'escrow_deposit',
      status: 'pending',
      retryCount: 0,
      maxRetries: 10,
      createdAt: Date.now() - 10000, // 10 seconds ago
      updatedAt: Date.now() - 10000,
    };

    vi.mocked(indexedDbCache.getAllPendingTransactions).mockResolvedValue([existingTx]);

    const { result } = renderHook(() => useTxRetryQueue(10, 'test-queue'));

    // Wait for initial restoration
    await waitFor(() => {
      expect(result.current.pendingTransactions.length).toBe(1);
    });

    const duplicateParams = {
      hash: 'hash2', // Different hash
      contractId: 'contract-123',
      amount: '1000',
      asset: 'USDC',
      publicKey: 'GTEST123',
      type: 'escrow_deposit' as const,
    };

    const id = await result.current.enqueue(duplicateParams);

    // Should return existing transaction ID (merged)
    expect(id).toBe('existing-tx');
    // Should not save a new transaction
    expect(vi.mocked(indexedDbCache.savePendingTransaction)).not.toHaveBeenCalled();
  });

  it('should not detect duplicate if outside dedup window', async () => {
    const oldTx: indexedDbCache.PendingTransaction = {
      id: 'old-tx',
      hash: 'hash1',
      contractId: 'contract-123',
      amount: '1000',
      asset: 'USDC',
      publicKey: 'GTEST123',
      type: 'escrow_deposit',
      status: 'pending',
      retryCount: 0,
      maxRetries: 10,
      createdAt: Date.now() - 40000, // 40 seconds ago (outside 30s window)
      updatedAt: Date.now() - 40000,
    };

    vi.mocked(indexedDbCache.getAllPendingTransactions).mockResolvedValue([oldTx]);

    const { result } = renderHook(() => useTxRetryQueue(10, 'test-queue'));

    await waitFor(() => {
      expect(result.current.pendingTransactions.length).toBe(1);
    });

    const newParams = {
      hash: 'hash2',
      contractId: 'contract-123',
      amount: '1000',
      asset: 'USDC',
      publicKey: 'GTEST123',
      type: 'escrow_deposit' as const,
    };

    await waitFor(async () => {
      await result.current.enqueue(newParams);
    });

    // Should save a new transaction (not a duplicate)
    expect(vi.mocked(indexedDbCache.savePendingTransaction)).toHaveBeenCalled();
  });

  it('should poll transaction status', async () => {
    vi.mocked(indexedDbCache.getAllPendingTransactions).mockResolvedValue([]);

    const { result } = renderHook(() => useTxRetryQueue(10, 'test-queue'));

    const params = {
      hash: 'test-hash-poll',
      contractId: 'contract-123',
      amount: '1000',
      asset: 'USDC',
      publicKey: 'GTEST123',
      type: 'escrow_deposit' as const,
    };

    await waitFor(async () => {
      await result.current.enqueue(params);
    });

    // Wait a bit for polling to start
    await waitFor(
      () => {
        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringContaining('/api/escrow/tx-status?hash=test-hash-poll'),
        );
      },
      { timeout: 10000 },
    );
  }, 15000); // Increase test timeout to 15 seconds

  it('should update transaction status when confirmed', async () => {
    const pendingTx: indexedDbCache.PendingTransaction = {
      id: 'pending-tx',
      hash: 'hash-confirm',
      contractId: 'contract-123',
      amount: '1000',
      asset: 'USDC',
      publicKey: 'GTEST123',
      type: 'escrow_deposit',
      status: 'pending',
      retryCount: 0,
      maxRetries: 10,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    vi.mocked(indexedDbCache.getAllPendingTransactions).mockResolvedValue([pendingTx]);

    // Mock fetch to return confirmed status immediately
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'confirmed', ledger: 1000000 }),
    });

    const { result } = renderHook(() => useTxRetryQueue(10, 'test-queue'));

    // Wait for initial state to be populated
    await waitFor(() => {
      expect(result.current.pendingTransactions.length).toBe(1);
    });

    // Wait for the fetch call to happen
    await waitFor(
      () => {
        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringContaining('/api/escrow/tx-status?hash=hash-confirm'),
        );
      },
      { timeout: 8000 },
    );

    // Wait for the state update to complete
    await waitFor(
      () => {
        const tx = result.current.pendingTransactions.find((t) => t.id === 'pending-tx');
        expect(tx?.status).toBe('confirmed');
      },
      { timeout: 8000 },
    );
  }, 20000); // Increase test timeout to 20 seconds

  it('should clear completed transactions', async () => {
    vi.mocked(indexedDbCache.deleteCompletedTransactions).mockResolvedValue(3);

    const { result } = renderHook(() => useTxRetryQueue(10, 'test-queue'));

    const count = await result.current.clearCompleted();

    expect(count).toBe(3);
    expect(indexedDbCache.deleteCompletedTransactions).toHaveBeenCalled();
  });

  it('should remove a transaction by ID', async () => {
    const { result } = renderHook(() => useTxRetryQueue(10, 'test-queue'));

    await result.current.remove('tx-123');

    expect(indexedDbCache.deletePendingTransaction).toHaveBeenCalledWith('tx-123');
  });

  it('should restore pending transactions on mount', async () => {
    const restoredTxs: indexedDbCache.PendingTransaction[] = [
      {
        id: 'restored-1',
        hash: 'hash1',
        contractId: 'contract-1',
        amount: '100',
        asset: 'XLM',
        publicKey: 'GTEST',
        type: 'escrow_deposit',
        status: 'pending',
        retryCount: 0,
        maxRetries: 10,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: 'restored-2',
        hash: 'hash2',
        contractId: 'contract-2',
        amount: '200',
        asset: 'USDC',
        publicKey: 'GTEST',
        type: 'escrow_withdrawal',
        status: 'confirmed',
        retryCount: 0,
        maxRetries: 10,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    vi.mocked(indexedDbCache.getAllPendingTransactions).mockResolvedValue(restoredTxs);

    const { result } = renderHook(() => useTxRetryQueue(10, 'restore-queue'));

    await waitFor(() => {
      expect(result.current.pendingTransactions.length).toBe(2);
    });

    expect(indexedDbCache.getAllPendingTransactions).toHaveBeenCalled();
  });
});
