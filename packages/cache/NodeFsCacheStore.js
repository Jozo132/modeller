// packages/cache/NodeFsCacheStore.js — Filesystem-backed cache store
//
// Stores CBREP payloads as individual files in a directory, keyed by
// content hash. Safe for concurrent reads; writes use atomic rename.

import { CacheStore } from './CacheStore.js';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

/**
 * Filesystem-backed CacheStore implementation.
 *
 * Directory layout:
 *   <cacheDir>/<hex-key>.cbrep
 */
export class NodeFsCacheStore extends CacheStore {
  /**
   * @param {string} cacheDir — directory for cache files (created if absent)
   */
  constructor(cacheDir) {
    super();
    this._dir = cacheDir;
    this._ready = fs.mkdir(cacheDir, { recursive: true });
  }

  _path(key) {
    // Sanitize key to safe filename chars
    const safe = key.replace(/[^a-f0-9]/gi, '');
    return join(this._dir, `${safe}.cbrep`);
  }

  async get(key) {
    await this._ready;
    try {
      const data = await fs.readFile(this._path(key));
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    } catch {
      return null;
    }
  }

  async put(key, buf) {
    await this._ready;
    const p = this._path(key);
    const tmp = p + '.tmp';
    await fs.writeFile(tmp, Buffer.from(buf));
    await fs.rename(tmp, p);
  }

  async has(key) {
    await this._ready;
    try {
      await fs.access(this._path(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key) {
    await this._ready;
    try {
      await fs.unlink(this._path(key));
      return true;
    } catch {
      return false;
    }
  }

  async keys() {
    await this._ready;
    try {
      const files = await fs.readdir(this._dir);
      return files
        .filter(f => f.endsWith('.cbrep'))
        .map(f => f.slice(0, -6));
    } catch {
      return [];
    }
  }
}
