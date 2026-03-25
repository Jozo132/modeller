// js/workers/step-import-worker.js — Web Worker for off-main-thread STEP import
//
// Receives STEP file data + tessellation options from the main thread,
// runs the full import pipeline (parse → topology → tessellate), and
// returns the result as transferable typed arrays.
//
// This keeps the main thread responsive during large STEP imports.
//
// Usage from main thread:
//   const worker = new Worker(new URL('./workers/step-import-worker.js', import.meta.url), { type: 'module' });
//   worker.postMessage({ stepData, curveSegments: 16 });
//   worker.onmessage = (e) => { /* e.data = { vertices, faces, body, ... } */ };

import { importSTEP } from '../cad/StepImport.js';

self.onmessage = function (e) {
  const { stepData, curveSegments = 16 } = e.data;

  try {
    // Run the full STEP import pipeline (parse + tessellate)
    const result = importSTEP(stepData, { curveSegments });

    // Post result back — the body (TopoBody) contains complex objects
    // that cannot be transferred, so we send it as a structured clone.
    self.postMessage({
      type: 'result',
      vertices: result.vertices,
      faces: result.faces,
      body: result.body,
    });
  } catch (err) {
    self.postMessage({
      type: 'error',
      message: err.message || String(err),
      stack: err.stack || '',
    });
  }
};
