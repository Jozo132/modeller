// js/cache/index.js — Public re-exports for the CBREP cache layer
//
// This barrel module exposes the packages/cache/* API under the js/ tree
// so consumers can import from 'modeller/cache'.

export { CacheStore }          from '../../packages/cache/CacheStore.js';
export { NodeFsCacheStore }    from '../../packages/cache/NodeFsCacheStore.js';
export { BrowserIdbCacheStore } from '../../packages/cache/BrowserIdbCacheStore.js';
