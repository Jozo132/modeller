import './_watchdog.mjs';

import assert from 'node:assert/strict';

import * as wasmKernel from '../build/release.js';
import { NurbsSurface } from '../js/cad/NurbsSurface.js';
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
function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function makePlane(origin, uDir, vDir) {
  // NurbsSurface.createPlane takes (origin, uDir, vDir) as direction vectors.
  return NurbsSurface.createPlane(origin, uDir, vDir);
}

/**
 * Mock cylinder surface — Intersections.js only reads `_analyticParams`
 * for its WASM dispatch; no evalSurface path is needed.
 */
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

/** Distance from a point to the infinite cylinder axis. */
function distToAxis(pt, origin, axis) {
  const d = sub(pt, origin);
  const t = dot(d, axis);
  const proj = { x: origin.x + t * axis.x, y: origin.y + t * axis.y, z: origin.z + t * axis.z };
  return len(sub(pt, proj));
}

// ── 1. Raw kernel helper ───────────────────────────────────────────────
console.log('\n=== WASM plane×cylinder narrowphase (H8) ===\n');

await test('raw planeCylinderIntersect — plane perpendicular to axis yields circle', () => {
  // Cylinder along z-axis, r=2. Plane z=5.
  const tag = wasmKernel.planeCylinderIntersect(
    0, 0, 5,   // plane point
    0, 0, 1,   // plane normal (unit)
    0, 0, 0,   // cyl origin
    0, 0, 1,   // cyl axis (unit)
    2,         // cyl radius
    1e-9,      // angular tol
    1e-9,      // dist tol
  );
  assert.equal(tag, 1, 'perpendicular plane → circle');
  const out = new Float64Array(wasmKernel.memory.buffer, wasmKernel.getPlaneCylinderIntersectPtr(), 7);
  assert.ok(Math.abs(out[0]) < 1e-12);
  assert.ok(Math.abs(out[1]) < 1e-12);
  assert.ok(Math.abs(out[2] - 5) < 1e-12);
  assert.ok(Math.abs(out[6] - 2) < 1e-12);
});

await test('raw planeCylinderIntersect — plane parallel, cuts cylinder → 2 lines', () => {
  // Cylinder along z-axis, r=5, origin at (0,0,0). Plane with normal
  // along +x, passing through x=3 → cuts cylinder in two lines at
  // x=3, y=±4 (since √(5²−3²)=4), both parallel to z axis.
  const tag = wasmKernel.planeCylinderIntersect(
    3, 0, 0,
    1, 0, 0,
    0, 0, 0,
    0, 0, 1,
    5,
    1e-9, 1e-9,
  );
  assert.equal(tag, 3, 'parallel, secant plane → 2 lines');
  const out = new Float64Array(wasmKernel.memory.buffer, wasmKernel.getPlaneCylinderIntersectPtr(), 12);
  // Both lines must be at x=3; y should be ±4; direction must be ±(0,0,1)
  for (const lineIdx of [0, 1]) {
    const base = lineIdx * 6;
    const pt = { x: out[base + 0], y: out[base + 1], z: out[base + 2] };
    const dir = { x: out[base + 3], y: out[base + 4], z: out[base + 5] };
    assert.ok(Math.abs(pt.x - 3) < 1e-12, `line ${lineIdx} x=3`);
    assert.ok(Math.abs(Math.abs(pt.y) - 4) < 1e-12, `line ${lineIdx} |y|=4 (got ${pt.y})`);
    assert.ok(Math.abs(Math.abs(dir.z) - 1) < 1e-12, `line ${lineIdx} dir along z`);
  }
  // Ensure the two lines are distinct in y.
  assert.ok(Math.sign(out[1]) !== Math.sign(out[7]), 'one line on each side of the axis');
});

await test('raw planeCylinderIntersect — plane parallel, tangent → 1 line', () => {
  // Cylinder along z, r=5. Plane x=5 is tangent.
  const tag = wasmKernel.planeCylinderIntersect(
    5, 0, 0,
    1, 0, 0,
    0, 0, 0,
    0, 0, 1,
    5,
    1e-9, 1e-9,
  );
  assert.equal(tag, 2);
  const out = new Float64Array(wasmKernel.memory.buffer, wasmKernel.getPlaneCylinderIntersectPtr(), 6);
  assert.ok(Math.abs(out[0] - 5) < 1e-12);
  assert.ok(Math.abs(out[1]) < 1e-12);
  assert.ok(Math.abs(Math.abs(out[5]) - 1) < 1e-12, 'dir along z');
});

await test('raw planeCylinderIntersect — plane parallel, miss → tag 0', () => {
  const tag = wasmKernel.planeCylinderIntersect(
    10, 0, 0,
    1, 0, 0,
    0, 0, 0,
    0, 0, 1,
    5,
    1e-9, 1e-9,
  );
  assert.equal(tag, 0);
});

await test('raw planeCylinderIntersect — oblique plane returns 255 (fallback signal)', () => {
  // Plane normal tilted 45° off the cylinder axis → ellipse regime.
  const nLen = Math.sqrt(2);
  const tag = wasmKernel.planeCylinderIntersect(
    0, 0, 0,
    1 / nLen, 0, 1 / nLen,  // 45° off z-axis
    0, 0, 0,
    0, 0, 1,
    2,
    1e-9, 1e-9,
  );
  assert.equal(tag, 255, 'oblique case must signal fallback');
});

// ── 2. High-level intersectSurfaces dispatch ──────────────────────────

await test('dispatch — perpendicular plane × cylinder routes to wasm-plane-cylinder and returns circle', async () => {
  const ok = await preloadIntersectionsWasm();
  assert.equal(ok, true);

  const cylOrigin = { x: 1, y: 2, z: -3 };
  const cylAxis = { x: 0, y: 0, z: 1 };
  const cylR = 4;
  const cyl = makeCylinder(cylOrigin, cylAxis, cylR);
  // Plane perpendicular to axis at z = 7
  const plane = makePlane({ x: 0, y: 0, z: 7 }, { x: 10, y: 0, z: 0 }, { x: 0, y: 10, z: 0 });

  _resetIntersectionsDebugStateForTests();
  const result = intersectSurfaces(plane, SurfaceType.PLANE, cyl, SurfaceType.CYLINDER);
  const dbg = _getIntersectionsDebugStateForTests();
  assert.equal(dbg.last, 'wasm-plane-cylinder');
  assert.equal(dbg.wasmPlaneCylinderCalls, 1);
  assert.equal(result.length, 1);

  // Sample the circle and verify each sample is on the cylinder (distance
  // to axis == r) and on the plane (z == 7).
  const curve = result[0].curve;
  const samples = [0, 0.125, 0.25, 0.5, 0.625, 0.875, 1.0];
  for (const t of samples) {
    const pt = curve.evaluate(t);
    assert.ok(Math.abs(pt.z - 7) < 1e-9, `t=${t} lies on plane z=7`);
    const r = distToAxis(pt, cylOrigin, cylAxis);
    assert.ok(Math.abs(r - cylR) < 1e-9, `t=${t} on cyl surface (r=${r})`);
  }
});

await test('dispatch — parallel plane × cylinder yields two z-aligned lines', async () => {
  await preloadIntersectionsWasm();
  const cyl = makeCylinder({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 5);
  // Plane normal = +x, passing through x=3 → cuts cylinder in two lines
  const plane = makePlane({ x: 3, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }, { x: 0, y: 0, z: 10 });

  _resetIntersectionsDebugStateForTests();
  const result = intersectSurfaces(plane, SurfaceType.PLANE, cyl, SurfaceType.CYLINDER);
  const dbg = _getIntersectionsDebugStateForTests();
  assert.equal(dbg.last, 'wasm-plane-cylinder');
  assert.equal(result.length, 2);

  const ys = new Set();
  for (const hit of result) {
    const p0 = hit.curve.evaluate(0);
    const p1 = hit.curve.evaluate(1);
    // Line sits on the plane x=3
    assert.ok(Math.abs(p0.x - 3) < 1e-9, `endpoint x=3 (got ${p0.x})`);
    assert.ok(Math.abs(p1.x - 3) < 1e-9);
    // Line sits on cylinder (distance to z-axis = 5)
    assert.ok(Math.abs(distToAxis(p0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }) - 5) < 1e-9);
    ys.add(Math.sign(p0.y));
  }
  assert.ok(ys.has(1) && ys.has(-1), 'one line on each side of axis');
});

await test('dispatch — parallel plane missing cylinder returns empty (backend still logged)', async () => {
  await preloadIntersectionsWasm();
  const cyl = makeCylinder({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 2);
  const plane = makePlane({ x: 10, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }, { x: 0, y: 0, z: 10 });
  _resetIntersectionsDebugStateForTests();
  const result = intersectSurfaces(plane, SurfaceType.PLANE, cyl, SurfaceType.CYLINDER);
  const dbg = _getIntersectionsDebugStateForTests();
  assert.equal(dbg.last, 'wasm-plane-cylinder');
  assert.equal(result.length, 0);
});

await test('dispatch — cylinder × plane (reversed arg order) also dispatches and matches', async () => {
  await preloadIntersectionsWasm();
  const cyl = makeCylinder({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 3);
  const plane = makePlane({ x: 0, y: 0, z: 2 }, { x: 10, y: 0, z: 0 }, { x: 0, y: 10, z: 0 });

  _resetIntersectionsDebugStateForTests();
  const ab = intersectSurfaces(plane, SurfaceType.PLANE, cyl, SurfaceType.CYLINDER);
  const ba = intersectSurfaces(cyl, SurfaceType.CYLINDER, plane, SurfaceType.PLANE);
  const dbg = _getIntersectionsDebugStateForTests();
  assert.equal(dbg.last, 'wasm-plane-cylinder');
  assert.equal(ab.length, 1);
  assert.equal(ba.length, 1);
  const ptA = ab[0].curve.evaluate(0);
  const ptB = ba[0].curve.evaluate(0);
  // Both land on the cylinder (r=3) and the plane (z=2).
  assert.ok(Math.abs(distToAxis(ptA, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }) - 3) < 1e-9);
  assert.ok(Math.abs(distToAxis(ptB, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }) - 3) < 1e-9);
  assert.ok(Math.abs(ptA.z - 2) < 1e-9);
  assert.ok(Math.abs(ptB.z - 2) < 1e-9);
});

await test('dispatch — oblique plane × cylinder falls back to JS (backend stays off wasm)', async () => {
  await preloadIntersectionsWasm();
  const cyl = makeCylinder({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 2);
  // Plane normal 45° off z axis → oblique ellipse.
  const nLen = Math.sqrt(2);
  const pOrigin = { x: 0, y: 0, z: 0 };
  // Pick in-plane u,v vectors orthogonal to n=(1,0,1)/√2
  const n = { x: 1 / nLen, y: 0, z: 1 / nLen };
  const u = { x: 1 / nLen, y: 0, z: -1 / nLen }; // orthogonal to n
  const v = cross(n, u);                        // orthogonal to both
  const plane = makePlane(pOrigin, { x: u.x * 10, y: u.y * 10, z: u.z * 10 }, { x: v.x * 10, y: v.y * 10, z: v.z * 10 });

  _resetIntersectionsDebugStateForTests();
  // The oblique regime intentionally delegates to the JS numeric marcher.
  // Our mock cylinder lacks real evaluator control points, so the JS
  // marcher may itself throw — that is still valid evidence the WASM
  // path stepped aside. What we actually want to prove is: the WASM call
  // counter stayed at zero and the backend tag did NOT stick on
  // wasm-plane-cylinder.
  try {
    intersectSurfaces(plane, SurfaceType.PLANE, cyl, SurfaceType.CYLINDER);
  } catch { /* expected for mock-only cylinder in the JS marcher */ }
  const dbg = _getIntersectionsDebugStateForTests();
  assert.notEqual(dbg.last, 'wasm-plane-cylinder', 'oblique must fall through to JS');
  assert.equal(dbg.wasmPlaneCylinderCalls, 0, 'oblique must not increment WASM call counter');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
