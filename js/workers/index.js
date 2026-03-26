// js/workers/index.js — Public barrel for worker modules
//
// Re-exports the available Web Worker entry points so consumers can
// discover them from 'modeller/workers'.
//
// Note: Workers are typically loaded via `new Worker(url, { type: 'module' })`
// rather than direct import, but this barrel lets bundlers tree-shake and
// provides a single discovery point for the public worker surface.

// We export the module path constants so callers can reference them:
export const STEP_IMPORT_WORKER_PATH = new URL('./step-import-worker.js', import.meta.url).href;
export const KERNEL_WORKER_PATH = new URL('./kernel-worker.js', import.meta.url).href;
export const TESSELLATION_WORKER_PATH = new URL('./tessellation-worker.js', import.meta.url).href;

// Dispatcher utility for structured clone / transfer discipline
export { WorkerDispatcher, collectTransferables } from './WorkerDispatcher.js';
