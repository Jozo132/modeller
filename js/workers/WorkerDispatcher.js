// js/workers/WorkerDispatcher.js — Structured clone / transfer discipline
//
// Provides a uniform interface for dispatching work to Web Workers with
// automatic Transferable detection.  Large ArrayBuffer and typed-array
// payloads are transferred (zero-copy) instead of cloned to keep memory
// usage and latency low.
//
// Usage:
//   const dispatcher = new WorkerDispatcher(workerUrl);
//   const result = await dispatcher.dispatch({ stepData, curveSegments: 16 });
//   dispatcher.terminate();

/**
 * Collect Transferable objects (ArrayBuffer instances) from a value.
 * Walks plain objects and arrays recursively; ignores functions, Maps,
 * Sets, DOM nodes, etc.
 *
 * @param {*} value
 * @param {Set<ArrayBuffer>} [seen]
 * @returns {ArrayBuffer[]}
 */
export function collectTransferables(value, seen = new Set()) {
  const result = [];

  if (value == null || typeof value === 'string' || typeof value === 'number' ||
      typeof value === 'boolean' || typeof value === 'function') {
    return result;
  }

  // ArrayBuffer itself
  if (value instanceof ArrayBuffer) {
    if (!seen.has(value) && value.byteLength > 0) {
      seen.add(value);
      result.push(value);
    }
    return result;
  }

  // Typed arrays (Float32Array, Uint8Array, etc.)
  if (ArrayBuffer.isView(value)) {
    const buf = value.buffer;
    if (!seen.has(buf) && buf.byteLength > 0) {
      seen.add(buf);
      result.push(buf);
    }
    return result;
  }

  // Plain arrays
  if (Array.isArray(value)) {
    for (const item of value) {
      const sub = collectTransferables(item, seen);
      for (const t of sub) result.push(t);
    }
    return result;
  }

  // Plain objects
  if (typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const sub = collectTransferables(value[key], seen);
      for (const t of sub) result.push(t);
    }
  }

  return result;
}

/**
 * Dispatch messages to a Web Worker with automatic Transferable detection.
 *
 * Each `dispatch()` call posts a message and returns a Promise that
 * resolves when the worker replies.  If the worker response includes a
 * `type: 'error'` field the promise rejects.
 *
 * Transferables (ArrayBuffer instances found in the payload) are moved
 * instead of copied for large-buffer performance.
 */
export class WorkerDispatcher {
  /**
   * @param {string|URL} workerUrl  URL to the worker module
   * @param {Object} [options]
   * @param {boolean} [options.autoTransfer=true] Automatically detect and transfer ArrayBuffers
   */
  constructor(workerUrl, options = {}) {
    /** @type {Worker} */
    this._worker = new Worker(workerUrl, { type: 'module' });
    /** @type {boolean} */
    this._autoTransfer = options.autoTransfer !== false;
    /** @type {number} */
    this._nextId = 1;
    /** @type {Map<number, {resolve: Function, reject: Function}>} */
    this._pending = new Map();

    this._worker.onmessage = (e) => {
      const data = e.data;
      const id = data._dispatchId;
      const entry = id != null ? this._pending.get(id) : undefined;
      if (!entry) return;
      this._pending.delete(id);

      if (data.type === 'error') {
        const err = new Error(data.message || 'Worker error');
        err.stack = data.stack || err.stack;
        entry.reject(err);
      } else {
        entry.resolve(data);
      }
    };

    this._worker.onerror = (event) => {
      // Reject all pending dispatches
      const err = new Error(event.message || 'Worker error');
      for (const [, entry] of this._pending) {
        entry.reject(err);
      }
      this._pending.clear();
    };
  }

  /**
   * Post a message to the worker and await the reply.
   *
   * @param {Object} message
   * @param {ArrayBuffer[]} [transferables]  Explicit transferables; if omitted, auto-detected.
   * @returns {Promise<Object>}
   */
  dispatch(message, transferables) {
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      this._pending.set(id, { resolve, reject });

      const payload = { ...message, _dispatchId: id };
      const xfer = transferables ??
        (this._autoTransfer ? collectTransferables(payload) : []);

      try {
        this._worker.postMessage(payload, xfer);
      } catch (err) {
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  /** Terminate the underlying Worker. */
  terminate() {
    this._worker.terminate();
    // Reject anything still pending
    for (const [, entry] of this._pending) {
      entry.reject(new Error('Worker terminated'));
    }
    this._pending.clear();
  }
}
