import './_watchdog.mjs';

import assert from 'node:assert/strict';

import { exactBooleanOp } from '../js/cad/BooleanKernel.js';
import { handleKernelWorkerMessage } from '../js/workers/kernel-worker.js';
import { buildTopoBody, SurfaceType, resetTopoIds } from '../js/cad/BRepTopology.js';
import { Tolerance } from '../js/cad/Tolerance.js';

function makeBox(x, y, z, w, h, d) {
  const c = [
    { x: x, y: y, z: z },
    { x: x + w, y: y, z: z },
    { x: x + w, y: y + h, z: z },
    { x: x, y: y + h, z: z },
    { x: x, y: y, z: z + d },
    { x: x + w, y: y, z: z + d },
    { x: x + w, y: y + h, z: z + d },
    { x: x, y: y + h, z: z + d },
  ];
  return buildTopoBody([
    { surfaceType: SurfaceType.PLANE, vertices: [c[3], c[2], c[1], c[0]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [c[4], c[5], c[6], c[7]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [c[0], c[1], c[5], c[4]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [c[2], c[3], c[7], c[6]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [c[3], c[0], c[4], c[7]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [c[1], c[2], c[6], c[5]], surface: null, edgeCurves: null, shared: null },
  ]);
}

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (error) {
    console.error(`  FAIL  ${name}\n    ${error?.message || error}`);
    failed++;
  }
}

console.log('kernel worker integration\n');

await check('boolean message routes policy through exactBooleanOp opts', async () => {
  resetTopoIds();
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(20, 0, 0, 10, 10, 10);
  const result = handleKernelWorkerMessage({
    op: 'boolean',
    _dispatchId: 7,
    a: boxA,
    b: boxB,
    operation: 'union',
    options: { policy: 'force-fallback' },
  });
  const expected = exactBooleanOp(boxA, boxB, 'union', undefined, { policy: 'force-fallback' });

  assert.equal(result.type, 'result');
  assert.equal(result._dispatchId, 7);
  assert.equal(result.body?.resultGrade, expected.resultGrade);
  assert.equal(result.body?._isFallback, expected._isFallback);
  assert.equal(result.body?.fallbackDiagnostics?.grade, expected.fallbackDiagnostics?.grade ?? null);
});

await check('boolean message keeps tolerance and opts as separate slots', async () => {
  resetTopoIds();
  const tolerancePayload = { pointCoincidence: 1e-7 };
  const tolerance = Tolerance.deserialize(tolerancePayload);
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(20, 0, 0, 10, 10, 10);
  const result = handleKernelWorkerMessage({
    op: 'boolean',
    _dispatchId: 8,
    a: boxA,
    b: boxB,
    operation: 'union',
    tolerance: tolerancePayload,
    options: { policy: 'force-fallback' },
  });
  const expected = exactBooleanOp(boxA, boxB, 'union', tolerance, { policy: 'force-fallback' });

  assert.equal(result.type, 'result');
  assert.equal(result._dispatchId, 8);
  assert.equal(result.body?.resultGrade, expected.resultGrade);
  assert.equal(result.body?._isFallback, expected._isFallback);
  assert.equal(result.body?.fallbackDiagnostics?.grade, expected.fallbackDiagnostics?.grade ?? null);
});

console.log(`\nkernel worker: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);