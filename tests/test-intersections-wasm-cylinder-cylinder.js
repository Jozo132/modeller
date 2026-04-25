import './_watchdog.mjs';

import assert from 'node:assert/strict';

import * as wasmKernel from '../build/release.js';
import { SurfaceType } from '../js/cad/BRepTopology.js';
import {
  _getIntersectionsDebugStateForTests,
  _resetIntersectionsDebugStateForTests,
  intersectSurfaces,
  preloadIntersectionsWasm,
} from '../js/cad/Intersections.js';

let passed = 0;
let failed = 0;

async function test(label, fn) {
  try {
    await fn();
    console.log(`  ok  ${label}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${label}`);
    console.log(`    ${err && err.stack ? err.stack : err}`);
    failed++;
  }
}

function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
function len(v) { return Math.sqrt(dot(v, v)); }

function makeCylinder(origin, axis, radius) {
  return {
    _analyticParams: {
      type: 'cylinder',
      origin: { ...origin },
      axis: { ...axis },
      radius,
    },
    uMin: 0, uMax: 1, vMin: 0, vMax: 1,
    controlPoints: [], weights: [], knotsU: [], knotsV: [],
    degreeU: 2, degreeV: 1,
  };
}

function distToAxis(pt, origin, axis) {
  const d = sub(pt, origin);
  const t = dot(d, axis);
  const proj = { x: origin.x + t * axis.x, y: origin.y + t * axis.y, z: origin.z + t * axis.z };
  return len(sub(pt, proj));
}

console.log('\n=== WASM cylinder×cylinder narrowphase (H8) ===\n');

await test('raw cylinderCylinderIntersect — parallel secant cylinders yield two lines', () => {
  const tag = wasmKernel.cylinderCylinderIntersect(
    0, 0, 0,
    0, 0, 1,
    5,
    6, 0, 0,
    0, 0, 1,
    5,
    1e-9, 1e-9,
  );
  assert.equal(tag, 3);
  const out = new Float64Array(wasmKernel.memory.buffer, wasmKernel.getCylinderCylinderIntersectPtr(), 12);
  for (const lineIdx of [0, 1]) {
    const base = lineIdx * 6;
    assert.ok(Math.abs(out[base + 0] - 3) < 1e-12, `line ${lineIdx} x=3`);
    assert.ok(Math.abs(Math.abs(out[base + 1]) - 4) < 1e-12, `line ${lineIdx} |y|=4`);
    assert.ok(Math.abs(out[base + 2]) < 1e-12, `line ${lineIdx} z=0 base`);
    assert.ok(Math.abs(Math.abs(out[base + 5]) - 1) < 1e-12, `line ${lineIdx} direction along z`);
  }
  assert.ok(Math.sign(out[1]) !== Math.sign(out[7]), 'one line on each side of the axis plane');
});

await test('raw cylinderCylinderIntersect — parallel tangent cylinders yield one line', () => {
  const tag = wasmKernel.cylinderCylinderIntersect(
    0, 0, 0,
    0, 0, 1,
    5,
    10, 0, 0,
    0, 0, 1,
    5,
    1e-9, 1e-9,
  );
  assert.equal(tag, 2);
  const out = new Float64Array(wasmKernel.memory.buffer, wasmKernel.getCylinderCylinderIntersectPtr(), 6);
  assert.ok(Math.abs(out[0] - 5) < 1e-12, `x=5, got ${out[0]}`);
  assert.ok(Math.abs(out[1]) < 1e-12, `y=0, got ${out[1]}`);
  assert.ok(Math.abs(Math.abs(out[5]) - 1) < 1e-12, 'direction along z');
});

await test('raw cylinderCylinderIntersect — parallel separated cylinders miss', () => {
  const tag = wasmKernel.cylinderCylinderIntersect(
    0, 0, 0,
    0, 0, 1,
    5,
    20, 0, 0,
    0, 0, 1,
    5,
    1e-9, 1e-9,
  );
  assert.equal(tag, 0);
});

await test('raw cylinderCylinderIntersect — nested cross-section circles miss', () => {
  const tag = wasmKernel.cylinderCylinderIntersect(
    0, 0, 0,
    0, 0, 1,
    5,
    1, 0, 0,
    0, 0, 1,
    1,
    1e-9, 1e-9,
  );
  assert.equal(tag, 0);
});

await test('raw cylinderCylinderIntersect — non-parallel axes return fallback tag', () => {
  const tag = wasmKernel.cylinderCylinderIntersect(
    0, 0, 0,
    0, 0, 1,
    5,
    0, 0, 0,
    1, 0, 0,
    5,
    1e-9, 1e-9,
  );
  assert.equal(tag, 255);
});

await test('raw cylinderCylinderIntersect — coincident same-radius cylinders fall back', () => {
  const tag = wasmKernel.cylinderCylinderIntersect(
    0, 0, 0,
    0, 0, 1,
    5,
    0, 0, 10,
    0, 0, -1,
    5,
    1e-9, 1e-9,
  );
  assert.equal(tag, 255);
});

await test('dispatch — parallel cylinder × cylinder routes to WASM and returns two lines', async () => {
  const ok = await preloadIntersectionsWasm();
  assert.equal(ok, true);

  const cylA = makeCylinder({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 5);
  const cylB = makeCylinder({ x: 6, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 5);

  _resetIntersectionsDebugStateForTests();
  const result = intersectSurfaces(cylA, SurfaceType.CYLINDER, cylB, SurfaceType.CYLINDER);
  const dbg = _getIntersectionsDebugStateForTests();
  assert.equal(dbg.last, 'wasm-cylinder-cylinder');
  assert.equal(dbg.wasmCylinderCylinderCalls, 1);
  assert.equal(result.length, 2);

  const signs = new Set();
  for (const hit of result) {
    const p0 = hit.curve.evaluate(0);
    const p1 = hit.curve.evaluate(1);
    assert.ok(Math.abs(distToAxis(p0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }) - 5) < 1e-9);
    assert.ok(Math.abs(distToAxis(p0, { x: 6, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }) - 5) < 1e-9);
    assert.ok(Math.abs(distToAxis(p1, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }) - 5) < 1e-9);
    assert.ok(Math.abs(distToAxis(p1, { x: 6, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }) - 5) < 1e-9);
    signs.add(Math.sign(p0.y));
  }
  assert.ok(signs.has(1) && signs.has(-1), 'one line above and one below the center-center plane');
});

await test('dispatch — parallel tangent cylinders return one line', async () => {
  await preloadIntersectionsWasm();
  const cylA = makeCylinder({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 5);
  const cylB = makeCylinder({ x: 10, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 5);

  _resetIntersectionsDebugStateForTests();
  const result = intersectSurfaces(cylA, SurfaceType.CYLINDER, cylB, SurfaceType.CYLINDER);
  const dbg = _getIntersectionsDebugStateForTests();
  assert.equal(dbg.last, 'wasm-cylinder-cylinder');
  assert.equal(dbg.wasmCylinderCylinderCalls, 1);
  assert.equal(result.length, 1);

  const p = result[0].curve.evaluate(0.5);
  assert.ok(Math.abs(distToAxis(p, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }) - 5) < 1e-9);
  assert.ok(Math.abs(distToAxis(p, { x: 10, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }) - 5) < 1e-9);
});

await test('dispatch — parallel miss returns [] with backend tag set', async () => {
  await preloadIntersectionsWasm();
  const cylA = makeCylinder({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 2);
  const cylB = makeCylinder({ x: 10, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 2);

  _resetIntersectionsDebugStateForTests();
  const result = intersectSurfaces(cylA, SurfaceType.CYLINDER, cylB, SurfaceType.CYLINDER);
  const dbg = _getIntersectionsDebugStateForTests();
  assert.equal(dbg.last, 'wasm-cylinder-cylinder');
  assert.equal(dbg.wasmCylinderCylinderCalls, 1);
  assert.deepEqual(result, []);
});

await test('dispatch — non-parallel axes fall back without counting WASM hit', async () => {
  await preloadIntersectionsWasm();
  const cylA = makeCylinder({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 5);
  const cylB = makeCylinder({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 5);

  _resetIntersectionsDebugStateForTests();
  try { intersectSurfaces(cylA, SurfaceType.CYLINDER, cylB, SurfaceType.CYLINDER); } catch { /* mock surfaces are allowed to fail in JS fallback */ }
  const dbg = _getIntersectionsDebugStateForTests();
  assert.equal(dbg.wasmCylinderCylinderCalls, 0);
  assert.notEqual(dbg.last, 'wasm-cylinder-cylinder');
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
