import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  savePendingTransaction,
  getPendingTransaction,
  getAllPendingTransactions,
  getPendingTransactionsByStatus,
  deletePendingTransaction,
  deleteCompletedTransactions,
  type PendingTransaction,
} from './indexedDbCache';

describe('IndexedDB Cache - Pending Transactions', () => {
  beforeEach(async () => {
    // Clean up before each test
    if (typeof indexedDB !== 'undefined') {
      const dbs = await indexedDB.databases?.();
      if (dbs) {
        for (const db of dbs) {
          if (db.name) {
            indexedDB.deleteDatabase(db.name);
          }
        }
      }
    }
  });

  afterEach(async () => {
    // Clean up database after each test
    if (typeof indexedDB !== 'undefined') {
      const dbs = await indexedDB.databases?.();
      if (dbs) {
        for (const db of dbs) {
          if (db.name) {
            indexedDB.deleteDatabase(db.name);
          }
        }
      }
    }
  });

  it('should save and retrieve a pending transaction', async () => {
    const tx: PendingTransaction = {
      id: 'test-tx-1',
      hash: 'abc123',
      contractId: 'contract-1',
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

    await savePendingTransaction(tx);
    const retrieved = await getPendingTransaction('test-tx-1');

    expect(retrieved).toEqual(tx);
  });

  it('should return null for non-existent transaction', async () => {
    const retrieved = await getPendingTransaction('non-existent');
    expect(retrieved).toBeNull();
  });

  it('should get all pending transactions', async () => {
    const tx1: PendingTransaction = {
      id: 'tx-1',
      hash: 'hash1',
      contractId: 'contract-1',
      amount: '100',
      asset: 'XLM',
      publicKey: 'GTEST1',
      type: 'escrow_deposit',
      status: 'pending',
      retryCount: 0,
      maxRetries: 10,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const tx2: PendingTransaction = {
      id: 'tx-2',
      hash: 'hash2',
      contractId: 'contract-2',
      amount: '200',
      asset: 'USDC',
      publicKey: 'GTEST2',
      type: 'escrow_withdrawal',
      status: 'confirmed',
      retryCount: 0,
      maxRetries: 10,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await savePendingTransaction(tx1);
    await savePendingTransaction(tx2);

    const all = await getAllPendingTransactions();
    expect(all).toHaveLength(2);
    expect(all.map((t) => t.id)).toContain('tx-1');
    expect(all.map((t) => t.id)).toContain('tx-2');
  });

  it('should filter transactions by status', async () => {
    const pending: PendingTransaction = {
      id: 'pending-tx',
      hash: 'hash-pending',
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
    };

    const confirmed: PendingTransaction = {
      id: 'confirmed-tx',
      hash: 'hash-confirmed',
      contractId: 'contract-2',
      amount: '200',
      asset: 'USDC',
      publicKey: 'GTEST',
      type: 'escrow_withdrawal',
      status: 'confirmed',
      retryCount: 0,
      maxRetries: 10,
      lastScannedLedger: 1000000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await savePendingTransaction(pending);
    await savePendingTransaction(confirmed);

    const pendingTxs = await getPendingTransactionsByStatus('pending');
    expect(pendingTxs).toHaveLength(1);
    expect(pendingTxs[0]?.id).toBe('pending-tx');

    const confirmedTxs = await getPendingTransactionsByStatus('confirmed');
    expect(confirmedTxs).toHaveLength(1);
    expect(confirmedTxs[0]?.id).toBe('confirmed-tx');
  });

  it('should delete a specific transaction', async () => {
    const tx: PendingTransaction = {
      id: 'delete-me',
      hash: 'hash-delete',
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
    };

    await savePendingTransaction(tx);
    let retrieved = await getPendingTransaction('delete-me');
    expect(retrieved).not.toBeNull();

    await deletePendingTransaction('delete-me');
    retrieved = await getPendingTransaction('delete-me');
    expect(retrieved).toBeNull();
  });

  it('should delete all completed transactions', async () => {
    const pending: PendingTransaction = {
      id: 'pending-1',
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
    };

    const confirmed1: PendingTransaction = {
      id: 'confirmed-1',
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
    };

    const confirmed2: PendingTransaction = {
      id: 'confirmed-2',
      hash: 'hash3',
      contractId: 'contract-3',
      amount: '300',
      asset: 'XLM',
      publicKey: 'GTEST',
      type: 'escrow_deposit',
      status: 'confirmed',
      retryCount: 0,
      maxRetries: 10,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await savePendingTransaction(pending);
    await savePendingTransaction(confirmed1);
    await savePendingTransaction(confirmed2);

    const count = await deleteCompletedTransactions();
    expect(count).toBe(2);

    const remaining = await getAllPendingTransactions();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe('pending-1');
  });

  it('should update existing transaction', async () => {
    const tx: PendingTransaction = {
      id: 'update-me',
      hash: 'hash-update',
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
    };

    await savePendingTransaction(tx);

    const updated = {
      ...tx,
      status: 'confirmed' as const,
      lastScannedLedger: 1000000,
      updatedAt: Date.now(),
    };

    await savePendingTransaction(updated);

    const retrieved = await getPendingTransaction('update-me');
    expect(retrieved?.status).toBe('confirmed');
    expect(retrieved?.lastScannedLedger).toBe(1000000);
  });
});
