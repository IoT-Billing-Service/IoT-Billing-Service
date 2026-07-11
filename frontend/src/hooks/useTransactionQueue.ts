import { useState, useEffect } from 'react';

export interface QueuedTransaction {
  id: string;
  nodeId: string;
  payload: string;
  cost: number;
  timestamp: number;
  retries: number;
}

export function useTransactionQueue() {
  const [queue, setQueue] = useState<QueuedTransaction[]>([]);
  const [db, setDb] = useState<IDBDatabase | null>(null);

  // Initialize IndexedDB
  useEffect(() => {
    const request = indexedDB.open('IoT_Billing_Offline_Queue', 1);

    request.onupgradeneeded = (event) => {
      const targetDb = (event.target as IDBOpenDBRequest).result;
      if (!targetDb.objectStoreNames.contains('transactions')) {
        targetDb.createObjectStore('transactions', { keyPath: 'id' });
      }
    };

    request.onsuccess = (event) => {
      const targetDb = (event.target as IDBOpenDBRequest).result;
      setDb(targetDb);
      loadQueue(targetDb);
    };

    request.onerror = () => {
      console.error('Failed to open local IndexedDB offline storage');
    };
  }, []);

  // Helper: Read queue items
  const loadQueue = (targetDb: IDBDatabase) => {
    const transaction = targetDb.transaction('transactions', 'readonly');
    const store = transaction.objectStore('transactions');
    const request = store.getAll();

    request.onsuccess = () => {
      setQueue(request.result || []);
    };
  };

  // Push transaction to offline queue
  const bufferTransaction = (tx: Omit<QueuedTransaction, 'timestamp' | 'retries'>) => {
    if (!db) return;

    const newTx: QueuedTransaction = {
      ...tx,
      timestamp: Date.now(),
      retries: 0,
    };

    const transaction = db.transaction('transactions', 'readwrite');
    const store = transaction.objectStore('transactions');
    const request = store.add(newTx);

    request.onsuccess = () => {
      setQueue(prev => [...prev, newTx]);
    };
  };

  // Dequeue/Remove synced transaction
  const dequeueTransaction = (id: string) => {
    if (!db) return;

    const transaction = db.transaction('transactions', 'readwrite');
    const store = transaction.objectStore('transactions');
    const request = store.delete(id);

    request.onsuccess = () => {
      setQueue(prev => prev.filter(tx => tx.id !== id));
    };
  };

  // Increment retry count
  const incrementRetry = (id: string) => {
    if (!db) return;

    const transaction = db.transaction('transactions', 'readwrite');
    const store = transaction.objectStore('transactions');
    
    const getRequest = store.get(id);
    getRequest.onsuccess = () => {
      const tx = getRequest.result as QueuedTransaction;
      if (tx) {
        tx.retries += 1;
        store.put(tx);
        setQueue(prev => prev.map(item => item.id === id ? { ...item, retries: item.retries + 1 } : item));
      }
    };
  };

  return {
    queue,
    bufferTransaction,
    dequeueTransaction,
    incrementRetry,
    refreshQueue: () => db && loadQueue(db),
  };
}
