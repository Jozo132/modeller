// js/workers/kernel-worker.js — Web Worker for off-main-thread CAD kernel ops
//
// Receives kernel operation requests (boolean ops, feature execution) from
// the main thread and returns results.  Heavy CSG / boolean work runs here
// so the UI thread stays responsive.
//
// Message protocol:
//   Request:  {
//     op: 'boolean',
//     a: <body>,
//     b: <body>,
//     operation: 'union'|'subtract'|'intersect',
//     tolerance?: <Tolerance>,
//     options?: <exactBooleanOp opts>,
//     _dispatchId,
//   }
//   Response: { type: 'result', body: <resultBody>, _dispatchId }
//   Error:    { type: 'error', message, stack, _dispatchId }

import { exactBooleanOp } from '../cad/BooleanKernel.js';
import { Tolerance } from '../cad/Tolerance.js';
import { telemetry } from '../telemetry.js';

function normalizeTolerance(tolerance) {
  if (!tolerance || typeof tolerance !== 'object') return tolerance;
  if (typeof tolerance.distance === 'function') return tolerance;
  return Tolerance.deserialize(tolerance);
}

export function handleKernelWorkerMessage(data) {
  const { op, _dispatchId } = data || {};

  try {
    let result;
    switch (op) {
      case 'boolean': {
        const { a, b, operation, tolerance, options } = data;
        telemetry.startTimer('kernel:boolean');
        const body = exactBooleanOp(a, b, operation, normalizeTolerance(tolerance), options || {});
        const duration = telemetry.endTimer('kernel:boolean');
        result = { type: 'result', body, duration, _dispatchId };
        break;
      }
      default:
        result = { type: 'error', message: `Unknown kernel op: ${op}`, _dispatchId };
    }

    return result;
  } catch (err) {
    return {
      type: 'error',
      message: err.message || String(err),
      stack: err.stack || '',
      _dispatchId,
    };
  }
}

if (typeof self !== 'undefined') {
  self.onmessage = function (e) {
    self.postMessage(handleKernelWorkerMessage(e.data));
  };
}
