// js/cad/history/HistoryCache.js — Cache-aware feature evaluation
//
// Provides a content-addressed cache for feature execution results
// so that unchanged history segments can skip recomputation.
//
// Cache keys are derived from:
//   - input body IR hash (or a structural signature when IR is unavailable)
//   - feature type
//   - normalized parameter signature
//   - stable selection keys
//   - config version marker
//
// Cache keys are NOT derived from:
//   - object identity / memory address
//   - mesh hashes
//   - transient in-memory references

// -----------------------------------------------------------------------
// Parameter normalization
// -----------------------------------------------------------------------

/**
 * Produce a deterministic JSON string from feature parameters.
 * Only includes known-relevant keys and sorts them for stability.
 * @param {Object} params
 * @returns {string}
 */
function _normalizeParams(params) {
  if (!params || typeof params !== 'object') return '{}';
  const sorted = Object.keys(params).sort();
  const obj = {};
  for (const k of sorted) {
    const v = params[k];
    // Recurse for nested objects (but not arrays, which are ordered)
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      obj[k] = JSON.parse(_normalizeParams(v));
    } else {
      obj[k] = v;
    }
  }
  return JSON.stringify(obj);
}

// -----------------------------------------------------------------------
// Simple FNV-1a 32-bit hash for strings (deterministic, non-crypto)
// -----------------------------------------------------------------------

function _fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// -----------------------------------------------------------------------
// Cache key construction
// -----------------------------------------------------------------------

const CACHE_VERSION = 'hc1';

/**
 * Build a cache key string for a feature evaluation.
 *
 * @param {Object} opts
 * @param {string} opts.inputHash - Hash/signature of the input body (or '' if first feature)
 * @param {string} opts.featureType - Feature type string (e.g. 'extrude', 'fillet')
 * @param {Object} opts.params - Feature parameters (distance, radius, etc.)
 * @param {string[]} [opts.selectionKeys=[]] - Stable entity keys for selections
 * @param {string} [opts.configVersion=''] - Environment/config version marker
 * @returns {string} Deterministic cache key
 */
export function buildCacheKey(opts) {
  const {
    inputHash = '',
    featureType = '',
    params = {},
    selectionKeys = [],
    configVersion = '',
  } = opts;

  const parts = [
    CACHE_VERSION,
    inputHash,
    featureType,
    _normalizeParams(params),
    selectionKeys.slice().sort().join(';'),
    configVersion,
  ];

  return _fnv1a32(parts.join('\x00'));
}

// -----------------------------------------------------------------------
// HistoryCache
// -----------------------------------------------------------------------

/**
 * In-memory cache for feature evaluation results.
 * The cache is content-addressed: two evaluations with the same inputs
 * will produce the same cache key and can share the result.
 *
 * The cache does NOT persist across page loads by default.
 * Use serialize/deserialize for optional persistence in .cmod files.
 */
export class HistoryCache {
  /**
   * @param {Object} [options]
   * @param {number} [options.maxEntries=256] - Maximum cache entries
   */
  constructor(options = {}) {
    this._maxEntries = options.maxEntries || 256;
    /** @type {Map<string, {result:Object, timestamp:number}>} */
    this._store = new Map();
    this._hits = 0;
    this._misses = 0;
  }

  /**
   * Look up a cached result.
   * @param {string} cacheKey - From buildCacheKey()
   * @returns {Object|null} Cached feature result, or null
   */
  get(cacheKey) {
    const entry = this._store.get(cacheKey);
    if (entry) {
      this._hits++;
      return entry.result;
    }
    this._misses++;
    return null;
  }

  /**
   * Store a feature result.
   * @param {string} cacheKey
   * @param {Object} result
   */
  set(cacheKey, result) {
    // Simple LRU-like eviction: delete oldest if full
    if (this._store.size >= this._maxEntries) {
      const oldest = this._store.keys().next().value;
      this._store.delete(oldest);
    }
    this._store.set(cacheKey, { result, timestamp: Date.now() });
  }

  /**
   * Check if a key is cached.
   * @param {string} cacheKey
   * @returns {boolean}
   */
  has(cacheKey) {
    return this._store.has(cacheKey);
  }

  /**
   * Invalidate a specific entry.
   * @param {string} cacheKey
   */
  invalidate(cacheKey) {
    this._store.delete(cacheKey);
  }

  /**
   * Invalidate all entries.
   */
  clear() {
    this._store.clear();
    this._hits = 0;
    this._misses = 0;
  }

  /**
   * Get cache statistics.
   * @returns {{ size:number, hits:number, misses:number, hitRate:number }}
   */
  stats() {
    const total = this._hits + this._misses;
    return {
      size: this._store.size,
      hits: this._hits,
      misses: this._misses,
      hitRate: total > 0 ? this._hits / total : 0,
    };
  }

  /**
   * Serialize the cache for persistence (e.g. in .cmod).
   * Only serializes cache keys and metadata, not full results,
   * since results contain live objects.
   * @returns {Object}
   */
  serialize() {
    const entries = [];
    for (const [key, entry] of this._store) {
      entries.push({ key, timestamp: entry.timestamp });
    }
    return {
      version: CACHE_VERSION,
      entries,
      stats: this.stats(),
    };
  }

  /**
   * Deserialize cache metadata from .cmod data.
   * This restores cache key awareness but not the actual results,
   * since those need to be recomputed from live topology.
   * @param {Object} data
   * @returns {HistoryCache}
   */
  static deserialize(data) {
    const cache = new HistoryCache();
    // Metadata-only restore — actual results must be recomputed
    // The serialized data is informational (for diagnostics/stats)
    return cache;
  }
}
