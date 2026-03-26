// js/workers/index.js — Public barrel for worker modules
//
// Re-exports the available Web Worker entry points so consumers can
// discover them from 'modeller/workers'.
//
// Note: Workers are typically loaded via `new Worker(url, { type: 'module' })`
// rather than direct import, but this barrel lets bundlers tree-shake and
// provides a single discovery point for the public worker surface.

// We export the module path constant so callers can reference it:
export const STEP_IMPORT_WORKER_PATH = new URL('./step-import-worker.js', import.meta.url).href;
