// packages/cache/BrowserIdbCacheStore.js — IndexedDB-backed cache store
//
// Stores CBREP payloads in an IndexedDB object store, keyed by content hash.
// Designed for browser environments. Falls back gracefully if IndexedDB is
// unavailable.

import { CacheStore } from './CacheStore.js';

const DB_NAME = 'cbrep-cache';
const DB_VERSION = 1;
const STORE_NAME = 'blobs';

/**
 * Open (or create) the IndexedDB database.
 * @returns {Promise<IDBDatabase>}
 */
function _openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      return reject(new Error('IndexedDB not available'));
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * IndexedDB-backed CacheStore implementation.
 */
export class BrowserIdbCacheStore extends CacheStore {
  constructor() {
    super();
    this._dbPromise = null;
  }

  _db() {
    if (!this._dbPromise) this._dbPromise = _openDb();
    return this._dbPromise;
  }

  async get(key) {
    try {
      const db = await this._db();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return null;
    }
  }

  async put(key, buf) {
    try {
      const db = await this._db();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(buf, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // Silently fail if IDB not available
    }
  }

  async has(key) {
    try {
      const db = await this._db();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).count(key);
        req.onsuccess = () => resolve(req.result > 0);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return false;
    }
  }

  async delete(key) {
    try {
      const db = await this._db();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      return false;
    }
  }

  async keys() {
    try {
      const db = await this._db();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).getAllKeys();
        req.onsuccess = () => resolve(req.result.map(String));
        req.onerror = () => reject(req.error);
      });
    } catch {
      return [];
    }
  }
}
