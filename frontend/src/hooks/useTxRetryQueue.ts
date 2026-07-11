'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import type { Transaction } from '@/types';
import {
  savePendingTransaction,
  getAllPendingTransactions,
  deletePendingTransaction,
  deleteCompletedTransactions,
  type PendingTransaction,
} from '@/services/indexedDbCache';

interface QueuedTx {
  tx: Transaction;
  retryCount: number;
  maxRetries: number;
  lastAttempt: number;
}

interface EnqueueParams {
  hash: string;
  contractId: string;
  amount: string;
  asset: string;
  publicKey: string;
  type: 'escrow_deposit' | 'escrow_withdrawal';
}

const RETRY_DELAY_BASE = 2000;
const MAX_RETRIES_DEFAULT = 10;
const DEDUP_WINDOW_MS = 30_000; // 30 seconds

export function useTxRetryQueue(maxRetries: number = MAX_RETRIES_DEFAULT, persistenceKey?: string) {
  const [queue, setQueue] = useState<Map<string, QueuedTx>>(new Map());
  const [pendingTxs, setPendingTxs] = useState<PendingTransaction[]>([]);
  const processingRef = useRef(false);
  const mountedRef = useRef(false);

  // Poll transaction status
  const startPollingTxStatus = useCallback(
    (id: string, hash: string) => {
      let attempts = 0;
      const MAX_POLL_ATTEMPTS = 120; // 10 minutes at 5s intervals

      const pollInterval = setInterval(async () => {
        attempts++;

        try {
          const response = await fetch(`/api/escrow/tx-status?hash=${hash}`);
          if (response.ok) {
            const data = await response.json();

            if (data.status === 'confirmed') {
              // Update state using functional form to avoid stale closure
              setPendingTxs((prev) => {
                const tx = prev.find((t) => t.id === id);
                if (tx && persistenceKey) {
                  // Save to IndexedDB
                  savePendingTransaction({
                    ...tx,
                    status: 'confirmed',
                    lastScannedLedger: data.ledger,
                    updatedAt: Date.now(),
                  });
                }
                return prev.map((t) =>
                  t.id === id
                    ? {
                        ...t,
                        status: 'confirmed' as const,
                        lastScannedLedger: data.ledger,
                        updatedAt: Date.now(),
                      }
                    : t,
                );
              });
              clearInterval(pollInterval);
            } else if (data.status === 'failed') {
              setPendingTxs((prev) => {
                const tx = prev.find((t) => t.id === id);
                if (tx && persistenceKey) {
                  savePendingTransaction({
                    ...tx,
                    status: 'failed',
                    updatedAt: Date.now(),
                  });
                }
                return prev.map((t) =>
                  t.id === id ? { ...t, status: 'failed' as const, updatedAt: Date.now() } : t,
                );
              });
              clearInterval(pollInterval);
            }
          }

          if (attempts >= MAX_POLL_ATTEMPTS) {
            clearInterval(pollInterval);
            // Mark as failed after max attempts
            setPendingTxs((prev) => {
              const tx = prev.find((t) => t.id === id);
              if (tx && persistenceKey) {
                savePendingTransaction({
                  ...tx,
                  status: 'failed',
                  updatedAt: Date.now(),
                });
              }
              return prev.map((t) =>
                t.id === id ? { ...t, status: 'failed' as const, updatedAt: Date.now() } : t,
              );
            });
          }
        } catch (error) {
          console.error('Error polling tx status:', error);
        }
      }, 5000); // Poll every 5 seconds

      return () => clearInterval(pollInterval);
    },
    [persistenceKey],
  );

  // Restore pending transactions from IndexedDB on mount
  useEffect(() => {
    if (!persistenceKey || mountedRef.current) return;
    mountedRef.current = true;

    const restorePendingTransactions = async () => {
      try {
        const restored = await getAllPendingTransactions();
        setPendingTxs(restored);

        // Start polling for pending transactions
        restored
          .filter((tx) => tx.status === 'pending')
          .forEach((tx) => {
            startPollingTxStatus(tx.id, tx.hash);
          });
      } catch (error) {
        console.error('Failed to restore pending transactions:', error);
      }
    };

    restorePendingTransactions();
  }, [persistenceKey, startPollingTxStatus]);

  // Check for duplicate within dedup window
  const findDuplicate = useCallback(
    (params: EnqueueParams): PendingTransaction | null => {
      const now = Date.now();
      const cutoff = now - DEDUP_WINDOW_MS;

      return (
        pendingTxs.find(
          (tx) =>
            tx.contractId === params.contractId &&
            tx.amount === params.amount &&
            tx.asset === params.asset &&
            tx.publicKey === params.publicKey &&
            tx.type === params.type &&
            tx.createdAt >= cutoff &&
            tx.status === 'pending',
        ) ?? null
      );
    },
    [pendingTxs],
  );

  const enqueue = useCallback(
    async (params: EnqueueParams) => {
      // Check for duplicate
      const duplicate = findDuplicate(params);
      if (duplicate) {
        console.log('Duplicate transaction detected, merging into existing entry:', duplicate.id);
        return duplicate.id;
      }

      const id = `${params.type}_${params.hash}_${Date.now()}`;
      const now = Date.now();

      const pendingTx: PendingTransaction = {
        id,
        hash: params.hash,
        contractId: params.contractId,
        amount: params.amount,
        asset: params.asset,
        publicKey: params.publicKey,
        type: params.type,
        status: 'pending',
        retryCount: 0,
        maxRetries,
        createdAt: now,
        updatedAt: now,
      };

      // Save to IndexedDB if persistence is enabled
      if (persistenceKey) {
        try {
          await savePendingTransaction(pendingTx);
        } catch (error) {
          console.error('Failed to save pending transaction:', error);
        }
      }

      // Update state
      setPendingTxs((prev) => [...prev, pendingTx]);

      // Start polling for confirmation
      startPollingTxStatus(id, params.hash);

      return id;
    },
    [findDuplicate, maxRetries, persistenceKey, startPollingTxStatus],
  );

  const remove = useCallback(
    async (txId: string) => {
      if (persistenceKey) {
        try {
          await deletePendingTransaction(txId);
        } catch (error) {
          console.error('Failed to delete pending transaction:', error);
        }
      }

      setPendingTxs((prev) => prev.filter((tx) => tx.id !== txId));
    },
    [persistenceKey],
  );

  const clearCompleted = useCallback(async () => {
    if (persistenceKey) {
      try {
        const count = await deleteCompletedTransactions();
        setPendingTxs((prev) => prev.filter((tx) => tx.status !== 'confirmed'));
        return count;
      } catch (error) {
        console.error('Failed to clear completed transactions:', error);
        return 0;
      }
    }
    return 0;
  }, [persistenceKey]);

  const retryFailed = useCallback(
    async (txHash: string, submitFn: () => Promise<string>) => {
      const entry = queue.get(txHash);
      if (!entry) throw new Error('Transaction not found in retry queue');

      if (entry.retryCount >= entry.maxRetries) {
        remove(txHash);
        throw new Error('Max retries exceeded');
      }

      const delay = RETRY_DELAY_BASE * Math.pow(2, entry.retryCount);
      await new Promise((r) => setTimeout(r, delay));

      try {
        const newHash = await submitFn();
        setQueue((prev) => {
          const next = new Map(prev);
          const existing = next.get(txHash);
          if (existing) {
            next.set(txHash, {
              ...existing,
              retryCount: existing.retryCount + 1,
              lastAttempt: Date.now(),
            });
          }
          return next;
        });
        return newHash;
      } catch {
        await remove(txHash);
        throw new Error('Retry submission failed');
      }
    },
    [queue, remove],
  );

  const processQueue = useCallback(
    async (submitFn: (tx: Transaction) => Promise<string>) => {
      if (processingRef.current) return;
      processingRef.current = true;

      try {
        const entries = Array.from(queue.entries()).filter(
          (entry) => entry[1].retryCount < entry[1].maxRetries,
        );

        for (const [hash, entry] of entries) {
          try {
            const delay = RETRY_DELAY_BASE * Math.pow(2, entry.retryCount);
            await new Promise((r) => setTimeout(r, delay));
            await submitFn(entry.tx);
            await remove(hash);
          } catch {
            setQueue((prev) => {
              const next = new Map(prev);
              const existing = next.get(hash);
              if (existing) {
                next.set(hash, {
                  ...existing,
                  retryCount: existing.retryCount + 1,
                  lastAttempt: Date.now(),
                });
              }
              return next;
            });
          }
        }
      } finally {
        processingRef.current = false;
      }
    },
    [queue, remove],
  );

  return {
    queue: Array.from(queue.values()),
    pendingTransactions: pendingTxs,
    enqueue,
    remove,
    retryFailed,
    processQueue,
    clearCompleted,
    isEmpty: queue.size === 0,
  };
}
