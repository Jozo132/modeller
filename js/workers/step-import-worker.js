// js/workers/step-import-worker.js — Web Worker for off-main-thread STEP import
//
// Receives STEP file data + tessellation options from the main thread,
// runs the full import pipeline (parse → topology → tessellate), and
// returns the result as transferable typed arrays.
//
// This keeps the main thread responsive during large STEP imports.
//
// When cacheMode is 'idb', the worker writes/reads CBREP IR to/from
// IndexedDB automatically, keeping the cache path off the main thread.
//
// Usage from main thread:
//   const worker = new Worker(new URL('./workers/step-import-worker.js', import.meta.url), { type: 'module' });
//   worker.postMessage({ stepData, curveSegments: 16, cacheMode: 'idb' });
//   worker.onmessage = (e) => { /* e.data = { vertices, faces, body, ... } */ };

import { importSTEP } from '../cad/StepImport.js';
import { telemetry } from '../telemetry.js';
import { getFlag } from '../featureFlags.js';
import { warnOnceForFallback } from '../cad/fallback/warnOnce.js';

/**
 * Pack vertex data from faces into a flat Float32Array for GPU upload.
 * The resulting buffer is transferred (zero-copy) to the main thread.
 *
 * @param {Array<{vertices: Array<{x:number,y:number,z:number}>}>} faces
 * @returns {Float32Array}
 */
function packVertices(faces) {
  let triCount = 0;
  for (const f of faces) {
    const v = f.vertices;
    if (v.length >= 3) triCount += v.length - 2;
  }

  const buf = new Float32Array(triCount * 9);
  let offset = 0;

  for (const f of faces) {
    const verts = f.vertices;
    for (let i = 1; i < verts.length - 1; i++) {
      const a = verts[0], b = verts[i], c = verts[i + 1];
      buf[offset]     = a.x; buf[offset + 1] = a.y; buf[offset + 2] = a.z;
      buf[offset + 3] = b.x; buf[offset + 4] = b.y; buf[offset + 5] = b.z;
      buf[offset + 6] = c.x; buf[offset + 7] = c.y; buf[offset + 8] = c.z;
      offset += 9;
    }
  }
  return buf;
}

/**
 * Attempt to write CBREP IR to IndexedDB cache (fire-and-forget).
 * @param {Object} body
 */
async function cacheToIdb(body) {
  try {
    const { canonicalize } = await import('../../packages/ir/canonicalize.js');
    const { writeCbrep } = await import('../../packages/ir/writer.js');
    const { hashCbrep } = await import('../../packages/ir/hash.js');
    const { BrowserIdbCacheStore } = await import('../../packages/cache/BrowserIdbCacheStore.js');

    const canon = canonicalize(body);
    const buf = writeCbrep(canon);
    const hash = hashCbrep(buf);

    const store = new BrowserIdbCacheStore();
    const exists = await store.has(hash);
    if (!exists) {
      await store.put(hash, buf);
      telemetry.recordCacheMiss();
    } else {
      telemetry.recordCacheHit();
    }
  } catch {
    // Cache write must never break the import path
    warnOnceForFallback({
      id: 'cache:ir-recompute',
      policy: 'allow-fallback',
      reason: 'IR cache write to IndexedDB failed; import proceeds without caching',
      kind: 'degraded-result',
    });
  }
}

self.onmessage = function (e) {
  const { stepData, curveSegments = 16, cacheMode, _dispatchId } = e.data;

  try {
    telemetry.startTimer('import');

    // Run the full STEP import pipeline (parse + tessellate)
    const result = importSTEP(stepData, { curveSegments });

    const duration = telemetry.endTimer('import');

    // Fire-and-forget: cache the IR to IndexedDB when requested or when
    // the IR cache flag is enabled.  Explicit cacheMode takes precedence;
    // if omitted, the flag decides the default storage mode.
    const effectiveCacheMode = cacheMode ?? (getFlag('CAD_USE_IR_CACHE') ? 'idb' : undefined);
    if (effectiveCacheMode === 'idb' && result.body) {
      cacheToIdb(result.body);
    }

    // Pack vertex data into a flat buffer for zero-copy transfer
    const packedVertices = packVertices(result.faces || []);

    // Post result back — the body (TopoBody) contains complex objects
    // that cannot be transferred, so we send it as a structured clone.
    // The packed vertex buffer IS transferred (zero-copy).
    self.postMessage(
      {
        type: 'result',
        packedVertices,
        faces: result.faces,
        body: result.body,
        duration,
        _dispatchId,
      },
      [packedVertices.buffer],
    );
  } catch (err) {
    self.postMessage({
      type: 'error',
      message: err.message || String(err),
      stack: err.stack || '',
      _dispatchId,
    });
  }
};
