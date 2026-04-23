import './_watchdog.mjs';

import assert from 'node:assert/strict';

import * as wasmKernel from '../build/release.js';
import { NurbsSurface } from '../js/cad/NurbsSurface.js';
import { SurfaceType } from '../js/cad/BRepTopology.js';
import { GeometryEvaluator } from '../js/cad/GeometryEvaluator.js';
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

function makePlane(origin, uDir, vDir) {
  // NurbsSurface.createPlane takes (origin, uDir, vDir) as direction vectors.
  return NurbsSurface.createPlane(origin, uDir, vDir);
}

/**
 * Mock sphere surface — Intersections.js only reads `_analyticParams`
 * for its WASM dispatch. No evalSurface/bounds needed for this path.
 */
function makeSphere(center, radius) {
  return {
    _analyticParams: {
      type: 'sphere',
      center: { ...center },
      origin: { ...center },
      radius,
    },
    // Placeholder fields so any accidental access at least doesn't throw.
    uMin: 0, uMax: 1, vMin: 0, vMax: 1,
    controlPoints: [], weights: [], knotsU: [], knotsV: [],
    degreeU: 2, degreeV: 2,
  };
}

// ── 1. Raw kernel helper ───────────────────────────────────────────────
console.log('\n=== WASM plane×sphere narrowphase (H8) ===\n');

await test('raw planeSphereIntersect — plane through equator gives full great circle', () => {
  const hit = wasmKernel.planeSphereIntersect(
    0, 0, 0,    // plane point
    0, 0, 1,    // plane normal (xy plane)
    0, 0, 0,    // sphere center (on plane)
    5,          // sphere radius
    1e-9,
  );
  assert.equal(hit, 1, 'equatorial plane must intersect');
  const out = new Float64Array(wasmKernel.memory.buffer, wasmKernel.getPlaneSphereIntersectPtr(), 7);
  assert.equal(out[0], 0);
  assert.equal(out[1], 0);
  assert.equal(out[2], 0);
  assert.equal(out[3], 0);
  assert.equal(out[4], 0);
  assert.equal(out[5], 1);
  assert.ok(Math.abs(out[6] - 5) < 1e-12, 'great-circle radius = sphere radius');
});

await test('raw planeSphereIntersect — offset plane gives smaller circle on axis', () => {
  const dist = 3;
  const r = 5;
  const hit = wasmKernel.planeSphereIntersect(
    0, 0, dist,  // plane point at z=3
    0, 0, 1,
    0, 0, 0,     // sphere center
    r,
    1e-9,
  );
  assert.equal(hit, 1);
  const out = new Float64Array(wasmKernel.memory.buffer, wasmKernel.getPlaneSphereIntersectPtr(), 7);
  // Circle center projects sphere center onto plane: (0,0,3)
  assert.ok(Math.abs(out[0]) < 1e-12);
  assert.ok(Math.abs(out[1]) < 1e-12);
  assert.ok(Math.abs(out[2] - dist) < 1e-12);
  const expectedR = Math.sqrt(r * r - dist * dist);
  assert.ok(Math.abs(out[6] - expectedR) < 1e-12, `circle radius = √(r²-d²) = ${expectedR}`);
});

await test('raw planeSphereIntersect — plane beyond sphere returns 0 (no hit)', () => {
  const hit = wasmKernel.planeSphereIntersect(
    0, 0, 10,   // plane far outside
    0, 0, 1,
    0, 0, 0,    // radius-5 sphere
    5,
    1e-9,
  );
  assert.equal(hit, 0);
});

await test('raw planeSphereIntersect — tangent plane returns 0 (grazing, degenerate circle)', () => {
  const hit = wasmKernel.planeSphereIntersect(
    0, 0, 5,    // plane exactly tangent at north pole
    0, 0, 1,
    0, 0, 0,
    5,
    1e-9,
  );
  // Tangent yields a degenerate (r=0) circle; our kernel rejects it to
  // match the JS fallback's `circleR < distTol` guard.
  assert.equal(hit, 0);
});

// ── 2. High-level intersectSurfaces dispatch ──────────────────────────
await test('after preload, plane×sphere dispatches to wasm-plane-sphere', async () => {
  const ok = await preloadIntersectionsWasm();
  assert.equal(ok, true, 'WASM build must be available');

  const plane = makePlane({ x: 0, y: 0, z: 2 }, { x: 10, y: 0, z: 0 }, { x: 0, y: 10, z: 0 });
  const sphere = makeSphere({ x: 0, y: 0, z: 0 }, 5);

  _resetIntersectionsDebugStateForTests();
  const result = intersectSurfaces(plane, SurfaceType.PLANE, sphere, SurfaceType.SPHERE);
  const dbg = _getIntersectionsDebugStateForTests();
  assert.equal(dbg.last, 'wasm-plane-sphere');
  assert.equal(dbg.wasmPlaneSphereCalls, 1);
  assert.equal(result.length, 1);
});

await test('plane×sphere dispatch — resulting circle lies on both surfaces', async () => {
  await preloadIntersectionsWasm();
  const sphereCenter = { x: 1, y: 2, z: -1 };
  const sphereR = 3;
  const planeZ = 0.5; // plane z = 0.5 (plane normal = +z, passes through (1,2,0.5))
  const plane = makePlane({ x: 1, y: 2, z: planeZ }, { x: 10, y: 0, z: 0 }, { x: 0, y: 10, z: 0 });
  const sphere = makeSphere(sphereCenter, sphereR);

  _resetIntersectionsDebugStateForTests();
  const result = intersectSurfaces(plane, SurfaceType.PLANE, sphere, SurfaceType.SPHERE);
  assert.equal(result.length, 1);

  // Sample the rational NURBS circle curve at a handful of parameters and
  // check each sample lies on both the plane and the sphere.
  const curve = result[0].curve;
  const planeEval = GeometryEvaluator.evalSurface(plane, 0.5, 0.5);
  const planeN = planeEval.n;
  const planeP = planeEval.p;

  const samples = [0, 0.125, 0.25, 0.5, 0.625, 0.875, 1.0];
  for (const t of samples) {
    const pt = curve.evaluate(t);
    // On plane: (pt - planeP) . planeN ≈ 0
    const toPt = sub(pt, planeP);
    assert.ok(Math.abs(dot(toPt, planeN)) < 1e-9, `sample t=${t} must lie on plane`);
    // On sphere: |pt - sphereCenter| ≈ sphereR
    const radial = sub(pt, sphereCenter);
    assert.ok(Math.abs(len(radial) - sphereR) < 1e-9,
      `sample t=${t} must lie on sphere surface (got |r|=${len(radial).toFixed(12)}, want ${sphereR})`);
  }
});

await test('plane×sphere dispatch — missed plane returns empty', async () => {
  await preloadIntersectionsWasm();
  const plane = makePlane({ x: 0, y: 0, z: 100 }, { x: 10, y: 0, z: 0 }, { x: 0, y: 10, z: 0 });
  const sphere = makeSphere({ x: 0, y: 0, z: 0 }, 5);

  _resetIntersectionsDebugStateForTests();
  const result = intersectSurfaces(plane, SurfaceType.PLANE, sphere, SurfaceType.SPHERE);
  const dbg = _getIntersectionsDebugStateForTests();
  assert.equal(dbg.last, 'wasm-plane-sphere');
  assert.equal(result.length, 0);
});

await test('sphere×plane (reversed argument order) also dispatches and yields the same circle', async () => {
  await preloadIntersectionsWasm();
  const plane = makePlane({ x: 0, y: 0, z: 1 }, { x: 10, y: 0, z: 0 }, { x: 0, y: 10, z: 0 });
  const sphere = makeSphere({ x: 0, y: 0, z: 0 }, 3);

  _resetIntersectionsDebugStateForTests();
  const ab = intersectSurfaces(plane, SurfaceType.PLANE, sphere, SurfaceType.SPHERE);
  const ba = intersectSurfaces(sphere, SurfaceType.SPHERE, plane, SurfaceType.PLANE);
  assert.equal(ab.length, 1);
  assert.equal(ba.length, 1);
  const dbg = _getIntersectionsDebugStateForTests();
  assert.equal(dbg.last, 'wasm-plane-sphere');
  // Samples lie on the sphere (|pt - sphereCenter| = sphereRadius = 3).
  const sphereR = 3;
  const sphereCenter = { x: 0, y: 0, z: 0 };
  const ptA = ab[0].curve.evaluate(0);
  const ptB = ba[0].curve.evaluate(0);
  const rA = len(sub(ptA, sphereCenter));
  const rB = len(sub(ptB, sphereCenter));
  assert.ok(Math.abs(rA - sphereR) < 1e-9, `ab sample must lie on sphere (got ${rA})`);
  assert.ok(Math.abs(rB - sphereR) < 1e-9, `ba sample must lie on sphere (got ${rB})`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
