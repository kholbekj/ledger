import { HybridClock } from './hlc';
import type { Operation, StoredOperation } from './types';

const DB_VERSION = 1;

/**
 * IndexedDB persistence layer for database file and operations log
 */
export class Storage {
  private dbName: string;
  private db: IDBDatabase | null = null;

  constructor(dbName: string) {
    this.dbName = dbName;
  }

  async open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, DB_VERSION);

      request.onerror = () => reject(request.error);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Store for the SQLite database file
        if (!db.objectStoreNames.contains('database')) {
          db.createObjectStore('database');
        }

        // Store for operations log
        if (!db.objectStoreNames.contains('operations')) {
          const opStore = db.createObjectStore('operations', { keyPath: 'id' });
          opStore.createIndex('table', 'table', { unique: false });
        }

        // Store for sync metadata
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta');
        }
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };
    });
  }

  private getDb(): IDBDatabase {
    if (!this.db) throw new Error('Database not opened');
    return this.db;
  }

  // Database file operations

  async saveDatabase(data: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.getDb().transaction('database', 'readwrite');
      const store = tx.objectStore('database');
      const request = store.put(data, 'main');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async loadDatabase(): Promise<Uint8Array | null> {
    return new Promise((resolve, reject) => {
      const tx = this.getDb().transaction('database', 'readonly');
      const store = tx.objectStore('database');
      const request = store.get('main');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || null);
    });
  }

  // Operations log

  async saveOperation(op: Operation): Promise<void> {
    const stored: StoredOperation = {
      ...op,
      id: HybridClock.toString(op.hlc)
    };

    return new Promise((resolve, reject) => {
      const tx = this.getDb().transaction('operations', 'readwrite');
      const store = tx.objectStore('operations');
      const request = store.put(stored);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async getOperations(afterId?: string): Promise<StoredOperation[]> {
    return new Promise((resolve, reject) => {
      const tx = this.getDb().transaction('operations', 'readonly');
      const store = tx.objectStore('operations');

      const range = afterId
        ? IDBKeyRange.lowerBound(afterId, true)
        : undefined;

      const request = store.getAll(range);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }

  async getOperationCount(): Promise<number> {
    return new Promise((resolve, reject) => {
      const tx = this.getDb().transaction('operations', 'readonly');
      const store = tx.objectStore('operations');
      const request = store.count();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }

  // Metadata

  async saveMeta(key: string, value: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.getDb().transaction('meta', 'readwrite');
      const store = tx.objectStore('meta');
      const request = store.put(value, key);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async getMeta<T>(key: string): Promise<T | null> {
    return new Promise((resolve, reject) => {
      const tx = this.getDb().transaction('meta', 'readonly');
      const store = tx.objectStore('meta');
      const request = store.get(key);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result ?? null);
    });
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
