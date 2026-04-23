// js/cache/index.js — Public re-exports for the CBREP cache layer
//
// This barrel module exposes the packages/cache/* API under the js/ tree
// so consumers can import from 'modeller/cache'.
//
// Browser safety: `NodeFsCacheStore` pulls in `node:fs`/`node:path`, which
// browsers cannot resolve and will reject with a CORS error when this
// barrel is loaded via `await import('./cache/index.js')`. Expose the
// Node-only store behind an async factory so the static import graph stays
// browser-safe; callers that need it can `await getNodeFsCacheStore()`.

export { CacheStore }           from '../../packages/cache/CacheStore.js';
export { BrowserIdbCacheStore } from '../../packages/cache/BrowserIdbCacheStore.js';

/**
 * Dynamically load `NodeFsCacheStore`. Only safe to call under Node.js.
 * Returns the class constructor, not an instance.
 * @returns {Promise<typeof import('../../packages/cache/NodeFsCacheStore.js').NodeFsCacheStore>}
 */
export async function getNodeFsCacheStore() {
  const mod = await import('../../packages/cache/NodeFsCacheStore.js');
  return mod.NodeFsCacheStore;
}
