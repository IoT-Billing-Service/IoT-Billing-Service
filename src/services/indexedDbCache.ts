const DB_NAME = 'iot-billing-cache';
const DB_VERSION = 3;
const STORES = [
  'telemetry',
  'transactions',
  'fleetViews',
  'authSession',
  'pendingTransactions',
  'pendingMutations',
] as const;

type StoreName = (typeof STORES)[number];

const MAX_QUEUE_SIZE = 10_000;

export interface PendingTransaction {
  id: string; // unique identifier
  hash: string; // transaction hash
  contractId: string;
  amount: string;
  asset: string;
  publicKey: string;
  type: 'escrow_deposit' | 'escrow_withdrawal';
  status: 'pending' | 'confirmed' | 'failed';
  retryCount: number;
  maxRetries: number;
  lastScannedLedger?: number;
  createdAt: number;
  updatedAt: number;
}

export interface PendingMutation {
  id: string;
  mutationType: string;
  payload: {
    url: string;
    method: string;
    body?: string;
    headers?: Record<string, string>;
  };
  createdAt: number;
  retryCount: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const oldVersion = (event as IDBVersionChangeEvent).oldVersion;

      // Create stores that don't exist
      STORES.forEach((store) => {
        if (!db.objectStoreNames.contains(store)) {
          if (store === 'pendingTransactions') {
            const objectStore = db.createObjectStore(store, { keyPath: 'id' });
            objectStore.createIndex('status', 'status', { unique: false });
            objectStore.createIndex('createdAt', 'createdAt', { unique: false });
            objectStore.createIndex('hash', 'hash', { unique: false });
          } else if (store === 'pendingMutations') {
            const objectStore = db.createObjectStore(store, { keyPath: 'id' });
            objectStore.createIndex('createdAt', 'createdAt', { unique: false });
          } else {
            db.createObjectStore(store, { keyPath: 'id' });
          }
        }
      });

      // Upgrade existing pendingTransactions store if upgrading from v1
      if (oldVersion < 2 && db.objectStoreNames.contains('pendingTransactions')) {
        // Note: Can't modify object store in same version, indexes already created above
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function cachePut<T>(
  store: StoreName,
  id: string,
  data: T,
  version?: number,
): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const objectStore = tx.objectStore(store);
    let conflictDetected = false;

    if (version !== undefined) {
      const getReq = objectStore.get(id);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (existing?.version !== undefined && existing.version > version) {
          conflictDetected = true;
          tx.abort();
          return;
        }
        objectStore.put({ id, data, timestamp: Date.now(), version });
      };
    } else {
      objectStore.put({ id, data, timestamp: Date.now() });
    }

    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.onabort = () => {
      db.close();
      reject(
        conflictDetected
          ? new Error('Version conflict: remote version is newer')
          : new Error('Transaction aborted'),
      );
    };
  });
}

export async function cacheGet<T>(store: StoreName, id: string): Promise<T | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(id);
    req.onsuccess = () => {
      db.close();
      resolve(req.result?.data ?? null);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

export async function cacheDelete(store: StoreName, id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(id);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function cacheClear(store: StoreName): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

// Pending transactions operations
export async function savePendingTransaction(tx: PendingTransaction): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('pendingTransactions', 'readwrite');
    transaction.objectStore('pendingTransactions').put(tx);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
}

export async function getPendingTransaction(id: string): Promise<PendingTransaction | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pendingTransactions', 'readonly');
    const req = tx.objectStore('pendingTransactions').get(id);
    req.onsuccess = () => {
      db.close();
      resolve(req.result ?? null);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

export async function getAllPendingTransactions(): Promise<PendingTransaction[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pendingTransactions', 'readonly');
    const req = tx.objectStore('pendingTransactions').getAll();
    req.onsuccess = () => {
      db.close();
      resolve(req.result ?? []);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

export async function getPendingTransactionsByStatus(
  status: 'pending' | 'confirmed' | 'failed',
): Promise<PendingTransaction[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pendingTransactions', 'readonly');
    const index = tx.objectStore('pendingTransactions').index('status');
    const req = index.getAll(status);
    req.onsuccess = () => {
      db.close();
      resolve(req.result ?? []);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

export async function deletePendingTransaction(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pendingTransactions', 'readwrite');
    tx.objectStore('pendingTransactions').delete(id);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function deleteCompletedTransactions(): Promise<number> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pendingTransactions', 'readwrite');
    const store = tx.objectStore('pendingTransactions');
    const index = store.index('status');
    const req = index.openCursor(IDBKeyRange.only('confirmed'));
    let count = 0;

    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
        count++;
        cursor.continue();
      }
    };

    tx.oncomplete = () => {
      db.close();
      resolve(count);
    };

    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

// Pending mutations operations (offline queue)
export async function savePendingMutation(mutation: PendingMutation): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pendingMutations', 'readwrite');
    tx.objectStore('pendingMutations').put(mutation);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function getAllPendingMutations(): Promise<PendingMutation[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pendingMutations', 'readonly');
    const req = tx.objectStore('pendingMutations').getAll();
    req.onsuccess = () => {
      db.close();
      resolve(req.result ?? []);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

export async function deletePendingMutation(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pendingMutations', 'readwrite');
    tx.objectStore('pendingMutations').delete(id);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function getPendingMutationsCount(): Promise<number> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pendingMutations', 'readonly');
    const req = tx.objectStore('pendingMutations').count();
    req.onsuccess = () => {
      db.close();
      resolve(req.result);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

async function deleteOldestPendingMutation(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pendingMutations', 'readwrite');
    const index = tx.objectStore('pendingMutations').index('createdAt');
    const req = index.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
      }
    };
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function withOfflineQueue<T>(
  fn: () => Promise<T>,
  mutationType: string,
  payload: PendingMutation['payload'],
): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof TypeError) {
      const count = await getPendingMutationsCount();
      if (count >= MAX_QUEUE_SIZE) {
        console.warn(`Offline queue full (${MAX_QUEUE_SIZE}). Dropping oldest entry.`);
        await deleteOldestPendingMutation();
      }
      await savePendingMutation({
        id: `${mutationType}_${Date.now()}`,
        mutationType,
        payload,
        createdAt: Date.now(),
        retryCount: 0,
      });
      return null;
    }
    throw error;
  }
}
