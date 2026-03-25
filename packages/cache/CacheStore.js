// packages/cache/CacheStore.js — Minimal common cache interface
//
// All cache stores implement this interface. Keys are content-hash hex
// strings produced by hashCbrep(). Values are ArrayBuffer payloads.

/**
 * @interface CacheStore
 *
 * Minimal cache store interface for CBREP binary payloads.
 *
 * Methods:
 *   async get(key: string) → ArrayBuffer | null
 *   async put(key: string, buf: ArrayBuffer) → void
 *   async has(key: string) → boolean
 *   async delete(key: string) → boolean
 *   async keys() → string[]
 */

/**
 * Base class providing the CacheStore contract.
 * Subclasses must override all methods.
 */
export class CacheStore {
  /**
   * Retrieve a cached CBREP payload.
   * @param {string} key — content-hash hex string
   * @returns {Promise<ArrayBuffer|null>}
   */
  async get(key) {
    throw new Error('CacheStore.get() not implemented');
  }

  /**
   * Store a CBREP payload.
   * @param {string} key
   * @param {ArrayBuffer} buf
   * @returns {Promise<void>}
   */
  async put(key, buf) {
    throw new Error('CacheStore.put() not implemented');
  }

  /**
   * Check if a key exists.
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  async has(key) {
    throw new Error('CacheStore.has() not implemented');
  }

  /**
   * Delete a cached entry.
   * @param {string} key
   * @returns {Promise<boolean>} true if deleted
   */
  async delete(key) {
    throw new Error('CacheStore.delete() not implemented');
  }

  /**
   * List all cache keys.
   * @returns {Promise<string[]>}
   */
  async keys() {
    throw new Error('CacheStore.keys() not implemented');
  }
}
