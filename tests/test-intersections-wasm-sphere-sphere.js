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

function makeSphere(center, radius) {
  return {
    _analyticParams: { type: 'sphere', center: { ...center }, radius },
    uMin: 0, uMax: 1, vMin: 0, vMax: 1,
    controlPoints: [], weights: [], knotsU: [], knotsV: [],
    degreeU: 2, degreeV: 2,
  };
}

// ── 1. Raw kernel ──────────────────────────────────────────────────────
console.log('\n=== WASM sphere×sphere narrowphase (H8) ===\n');

await test('raw sphereSphereIntersect — two spheres cross → circle', () => {
  // Sphere A: center (0,0,0), r=2. Sphere B: center (3,0,0), r=2.
  // Intersection plane at x=1.5, circle radius = √(4-2.25) = √1.75
  const tag = wasmKernel.sphereSphereIntersect(
    0, 0, 0, 2,
    3, 0, 0, 2,
    1e-9,
  );
  assert.equal(tag, 1);
  const out = new Float64Array(wasmKernel.memory.buffer, wasmKernel.getSphereSphereIntersectPtr(), 7);
  assert.ok(Math.abs(out[0] - 1.5) < 1e-12, `cx=1.5, got ${out[0]}`);
  assert.ok(Math.abs(out[1]) < 1e-12);
  assert.ok(Math.abs(out[2]) < 1e-12);
  // Normal points from A to B (x direction).
  assert.ok(Math.abs(out[3] - 1) < 1e-12);
  assert.ok(Math.abs(out[6] - Math.sqrt(1.75)) < 1e-12);
});

await test('raw sphereSphereIntersect — too far apart → miss', () => {
  const tag = wasmKernel.sphereSphereIntersect(
    0, 0, 0, 1,
    10, 0, 0, 1,
    1e-9,
  );
  assert.equal(tag, 0);
});

await test('raw sphereSphereIntersect — one inside the other → miss', () => {
  const tag = wasmKernel.sphereSphereIntersect(
    0, 0, 0, 5,
    0.1, 0, 0, 0.5,
    1e-9,
  );
  assert.equal(tag, 0);
});

await test('raw sphereSphereIntersect — external tangent → miss (degenerate)', () => {
  const tag = wasmKernel.sphereSphereIntersect(
    0, 0, 0, 1,
    2, 0, 0, 1,
    1e-9,
  );
  assert.equal(tag, 0, 'tangent within distTol reported as no-curve');
});

await test('raw sphereSphereIntersect — concentric → tag 255 (fallback)', () => {
  const tag = wasmKernel.sphereSphereIntersect(
    1, 1, 1, 2,
    1, 1, 1, 3,
    1e-9,
  );
  assert.equal(tag, 255);
});

// ── 2. Dispatch ────────────────────────────────────────────────────────

await test('dispatch — sphere × sphere routes to wasm-sphere-sphere and returns circle on both surfaces', async () => {
  const ok = await preloadIntersectionsWasm();
  assert.equal(ok, true);

  const cA = { x: 0, y: 0, z: 0 };
  const rA = 3;
  const cB = { x: 4, y: 0, z: 0 };
  const rB = 3;
  const a = makeSphere(cA, rA);
  const b = makeSphere(cB, rB);

  _resetIntersectionsDebugStateForTests();
  const result = intersectSurfaces(a, SurfaceType.SPHERE, b, SurfaceType.SPHERE);
  const dbg = _getIntersectionsDebugStateForTests();
  assert.equal(dbg.last, 'wasm-sphere-sphere');
  assert.equal(dbg.wasmSphereSphereCalls, 1);
  assert.equal(result.length, 1);

  const curve = result[0].curve;
  // Expected: plane x=2, circle radius = √(9-4) = √5.
  for (const t of [0, 0.125, 0.25, 0.5, 0.625, 0.875, 1.0]) {
    const p = curve.evaluate(t);
    assert.ok(Math.abs(p.x - 2) < 1e-6, `on plane x=2 (t=${t}, x=${p.x})`);
    const dA = len(sub(p, cA));
    const dB = len(sub(p, cB));
    assert.ok(Math.abs(dA - rA) < 1e-6, `on sphere A (t=${t}, got ${dA})`);
    assert.ok(Math.abs(dB - rB) < 1e-6, `on sphere B (t=${t}, got ${dB})`);
  }
});

await test('dispatch — sphere × sphere miss returns [] with backend tag set', async () => {
  const a = makeSphere({ x: 0, y: 0, z: 0 }, 1);
  const b = makeSphere({ x: 10, y: 0, z: 0 }, 1);

  _resetIntersectionsDebugStateForTests();
  const result = intersectSurfaces(a, SurfaceType.SPHERE, b, SurfaceType.SPHERE);
  const dbg = _getIntersectionsDebugStateForTests();
  assert.equal(dbg.last, 'wasm-sphere-sphere');
  assert.equal(dbg.wasmSphereSphereCalls, 1);
  assert.deepEqual(result, []);
});

await test('dispatch — concentric spheres fall back (WASM counter not incremented)', async () => {
  const a = makeSphere({ x: 0, y: 0, z: 0 }, 2);
  const b = makeSphere({ x: 0, y: 0, z: 0 }, 3);

  _resetIntersectionsDebugStateForTests();
  try { intersectSurfaces(a, SurfaceType.SPHERE, b, SurfaceType.SPHERE); } catch { /* JS fallback on empty-CP mock throws */ }
  const dbg = _getIntersectionsDebugStateForTests();
  assert.equal(dbg.wasmSphereSphereCalls, 0);
  assert.notEqual(dbg.last, 'wasm-sphere-sphere');
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
