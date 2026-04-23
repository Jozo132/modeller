import './_watchdog.mjs';
// tests/test-topo-serializer.js
// H11 scaffold — reusable JS→WASM topology serializer.
// Locks in the contract that `loadBodyIntoWasm` uploads a TopoBody into
// the current active kernel body with correct entity counts and without
// relying on any FaceSplitter-local ad hoc bridge.

import assert from 'node:assert/strict';
import * as wasmKernel from '../build/release.js';
import { buildTopoBody, SurfaceType, resetTopoIds } from '../js/cad/BRepTopology.js';
import { loadBodyIntoWasm } from '../js/cad/wasm/TopoSerializer.js';

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL  ${name}\n    ${e && e.stack ? e.stack : e}`); failed++; }
}

function makeUnitCube() {
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

console.log('\n=== TopoSerializer — JS→WASM scaffold (H11) ===\n');

check('loadBodyIntoWasm uploads a unit cube with correct entity counts', () => {
  const body = makeUnitCube();
  const w = wasmKernel;

  w.bodyBegin();
  w.geomPoolReset();
  const result = loadBodyIntoWasm(body, w);
  w.bodyEnd();

  assert.equal(result.faceCount, 6, 'cube must have 6 faces');
  assert.equal(result.faceMap.size, 6);

  // A topologically clean closed cube has 8 vertices and 12 edges.
  assert.equal(result.vertexMap.size, 8, 'cube must have 8 unique vertices');
  assert.equal(result.edgeMap.size, 12, 'cube must have 12 unique edges');

  // Every coedge records its loop id; every loop records its face id.
  assert.equal(w.shellGetCount(), 1, 'cube must produce a single shell');
  assert.equal(w.faceGetCount(), 6);
  assert.equal(w.loopGetCount(), 6, 'one outer loop per face');
  assert.equal(w.coedgeGetCount(), 24, 'four coedges per loop × 6 faces');
  assert.equal(w.vertexGetCount(), 8);
  assert.equal(w.edgeGetCount(), 12);
});

check('every face is tagged GEOM_PLANE and every loop is outer', () => {
  const body = makeUnitCube();
  const w = wasmKernel;
  const GEOM_PLANE = (w.GEOM_PLANE && typeof w.GEOM_PLANE === 'object' && 'value' in w.GEOM_PLANE)
    ? w.GEOM_PLANE.value
    : w.GEOM_PLANE;

  w.bodyBegin();
  w.geomPoolReset();
  loadBodyIntoWasm(body, w);
  w.bodyEnd();

  const faceCount = w.faceGetCount();
  for (let f = 0; f < faceCount; f++) {
    assert.equal(w.faceGetGeomType(f), GEOM_PLANE, `face ${f} geomType must be PLANE`);
    assert.equal(w.faceGetLoopCount(f), 1, `face ${f} must have exactly one loop`);
  }
  const loopCount = w.loopGetCount();
  for (let l = 0; l < loopCount; l++) {
    assert.equal(w.loopIsOuterLoop(l), 1, `loop ${l} must be outer`);
  }
});

check('coedge ring of the first loop is closed and walks 4 distinct coedges', () => {
  const body = makeUnitCube();
  const w = wasmKernel;

  w.bodyBegin();
  w.geomPoolReset();
  loadBodyIntoWasm(body, w);
  w.bodyEnd();

  const first = w.loopGetFirstCoedge(0);
  const seen = new Set();
  let cur = first;
  for (let i = 0; i < 8; i++) {
    if (seen.has(cur)) break;
    seen.add(cur);
    cur = w.coedgeGetNext(cur);
  }
  assert.equal(seen.size, 4, 'loop 0 must walk 4 coedges before cycling');
  assert.equal(cur, first, 'coedge ring must close back to the starting coedge');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
