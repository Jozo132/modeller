// js/workers/kernel-worker.js — Web Worker for off-main-thread CAD kernel ops
//
// Receives kernel operation requests (boolean ops, feature execution) from
// the main thread and returns results.  Heavy CSG / boolean work runs here
// so the UI thread stays responsive.
//
// Message protocol:
//   Request:  { op: 'boolean', a: <body>, b: <body>, operation: 'union'|'subtract'|'intersect', _dispatchId }
//   Response: { type: 'result', body: <resultBody>, _dispatchId }
//   Error:    { type: 'error', message, stack, _dispatchId }

import { exactBooleanOp } from '../cad/BooleanKernel.js';
import { telemetry } from '../telemetry.js';

self.onmessage = function (e) {
  const { op, _dispatchId } = e.data;

  try {
    let result;
    switch (op) {
      case 'boolean': {
        const { a, b, operation, options } = e.data;
        telemetry.startTimer('kernel:boolean');
        const body = exactBooleanOp(a, b, operation, options);
        const duration = telemetry.endTimer('kernel:boolean');
        result = { type: 'result', body, duration, _dispatchId };
        break;
      }
      default:
        result = { type: 'error', message: `Unknown kernel op: ${op}`, _dispatchId };
    }

    self.postMessage(result);
  } catch (err) {
    self.postMessage({
      type: 'error',
      message: err.message || String(err),
      stack: err.stack || '',
      _dispatchId,
    });
  }
};
