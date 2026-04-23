import './_watchdog.mjs';
// tests/test-incremental-tess-dirty.js
// H21 regression — dirtyFaceIds option on robustTessellateBody forces
// re-triangulation for flagged face ids while keeping cache reuse for
// everything else. This is the C3 dirty-set → incremental tessellation
// wire-up that makes H14/H15 LoD dispatch meaningful once a consumer
// subscribes to onLodChange.

import assert from 'node:assert/strict';
import { robustTessellateBody } from '../js/cad/Tessellator2/index.js';
import { buildTopoBody, SurfaceType, resetTopoIds } from '../js/cad/BRepTopology.js';

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL  ${name}\n    ${e.message}`); failed++; }
}

// Build a unit-cube TopoBody by delegating to buildTopoBody. Face ids come
// from resetTopoIds, which makes them deterministic across makeCube() calls.
function makeCube() {
  resetTopoIds();
  const c = [
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
    { x: 1, y: 1, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 0, y: 0, z: 1 },
    { x: 1, y: 0, z: 1 },
    { x: 1, y: 1, z: 1 },
    { x: 0, y: 1, z: 1 },
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

function faceIds(body) {
  return body.shells[0].faces.map((f) => f.id);
}

console.log('Incremental tessellation — dirtyFaceIds (H21)');

check('first tess with no cache produces all-dirty incremental report', () => {
  const body = makeCube();
  const r = robustTessellateBody(body, { surfaceSegments: 8, edgeSegments: 8 });
  assert.ok(r.incrementalTessellation);
  assert.equal(r.incrementalTessellation.reusedFaceKeys.length, 0);
  assert.equal(r.incrementalTessellation.dirtyFaceKeys.length, 6);
  assert.ok(r._incrementalTessellationCache);
});

check('second tess with cache reuses all six faces', () => {
  const body = makeCube();
  const first = robustTessellateBody(body, { surfaceSegments: 8, edgeSegments: 8 });
  const body2 = makeCube();
  const second = robustTessellateBody(body2, {
    surfaceSegments: 8,
    edgeSegments: 8,
    incrementalCache: first._incrementalTessellationCache,
  });
  assert.equal(second.incrementalTessellation.reusedFaceKeys.length, 6);
  assert.equal(second.incrementalTessellation.dirtyFaceKeys.length, 0);
});

check('dirtyFaceIds as Set forces re-triangulation of flagged faces only', () => {
  const body = makeCube();
  const first = robustTessellateBody(body, { surfaceSegments: 8, edgeSegments: 8 });
  const body2 = makeCube();
  const ids = faceIds(body2);
  const second = robustTessellateBody(body2, {
    surfaceSegments: 8,
    edgeSegments: 8,
    incrementalCache: first._incrementalTessellationCache,
    dirtyFaceIds: new Set([ids[0], ids[1]]),
  });
  assert.equal(second.incrementalTessellation.dirtyFaceKeys.length, 2);
  assert.equal(second.incrementalTessellation.reusedFaceKeys.length, 4);
});

check('dirtyFaceIds as Array is normalised to a Set', () => {
  const body = makeCube();
  const first = robustTessellateBody(body, { surfaceSegments: 8, edgeSegments: 8 });
  const body2 = makeCube();
  const ids = faceIds(body2);
  const second = robustTessellateBody(body2, {
    surfaceSegments: 8,
    edgeSegments: 8,
    incrementalCache: first._incrementalTessellationCache,
    dirtyFaceIds: [ids[3]],
  });
  assert.equal(second.incrementalTessellation.dirtyFaceKeys.length, 1);
  assert.equal(second.incrementalTessellation.reusedFaceKeys.length, 5);
});

check('dirtyFaceIds with ids not present in body is a harmless no-op', () => {
  const body = makeCube();
  const first = robustTessellateBody(body, { surfaceSegments: 8, edgeSegments: 8 });
  const body2 = makeCube();
  const second = robustTessellateBody(body2, {
    surfaceSegments: 8,
    edgeSegments: 8,
    incrementalCache: first._incrementalTessellationCache,
    dirtyFaceIds: new Set([999999, 'does-not-exist']),
  });
  assert.equal(second.incrementalTessellation.dirtyFaceKeys.length, 0);
  assert.equal(second.incrementalTessellation.reusedFaceKeys.length, 6);
});

check('dirtyFaceIds without incrementalCache is harmless (first-tess scenario)', () => {
  const body = makeCube();
  const ids = faceIds(body);
  const r = robustTessellateBody(body, {
    surfaceSegments: 8,
    edgeSegments: 8,
    dirtyFaceIds: new Set([ids[0]]),
  });
  assert.equal(r.incrementalTessellation.dirtyFaceKeys.length, 6);
  assert.equal(r.incrementalTessellation.reusedFaceKeys.length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
