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

function makePlane(origin, uDir, vDir) {
  return NurbsSurface.createPlane(origin, uDir, vDir);
}

/**
 * Mock cone surface — Intersections.js only reads `_analyticParams` for
 * its WASM dispatch. The JS fallback is never expected to run in these
 * tests (oblique case asserts via try/catch like the cylinder test).
 */
function makeCone(origin, axis, radius, semiAngle) {
  return {
    _analyticParams: {
      type: 'cone',
      origin: { ...origin },
      axis: { ...axis },
      radius,
      semiAngle,
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

// ── 1. Raw kernel ──────────────────────────────────────────────────────
console.log('\n=== WASM plane×cone narrowphase (H8) ===\n');

await test('raw planeConeIntersect — perpendicular plane above apex → circle', () => {
  // Cone with apex at origin (radius 1 at height 1 along +z, semiAngle=π/4).
  // origin param = (0,0,1), radius=1, axis=+z, semiAngle=π/4.
  // At plane z=2 → cone radius = 2.
  const tag = wasmKernel.planeConeIntersect(
    0, 0, 2,            // plane point
    0, 0, 1,            // plane normal
    0, 0, 1,            // cone origin (at height 1)
    0, 0, 1,            // cone axis
    1, Math.PI / 4,     // radius @ origin, semi-angle
    1e-9, 1e-9,
  );
  assert.equal(tag, 1);
  const out = new Float64Array(wasmKernel.memory.buffer, wasmKernel.getPlaneConeIntersectPtr(), 7);
  assert.ok(Math.abs(out[0]) < 1e-12, 'cx ≈ 0');
  assert.ok(Math.abs(out[1]) < 1e-12, 'cy ≈ 0');
  assert.ok(Math.abs(out[2] - 2) < 1e-12, 'cz ≈ 2');
  assert.ok(Math.abs(out[6] - 2) < 1e-12, `radius ≈ 2 (got ${out[6]})`);
});

await test('raw planeConeIntersect — plane through apex → tag 0 (degenerate)', () => {
  const tag = wasmKernel.planeConeIntersect(
    0, 0, 0,
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
    1, Math.PI / 4,
    1e-9, 1e-9,
  );
  assert.equal(tag, 0, 'plane at apex → zero-radius circle → reported as miss');
});

await test('raw planeConeIntersect — oblique plane returns 255', () => {
  const nLen = Math.sqrt(2);
  const tag = wasmKernel.planeConeIntersect(
    0, 0, 2,
    1 / nLen, 0, 1 / nLen,   // tilted 45°
    0, 0, 1,
    0, 0, 1,
    1, Math.PI / 6,
    1e-9, 1e-9,
  );
  assert.equal(tag, 255);
});

// ── 2. Dispatch ────────────────────────────────────────────────────────

await test('dispatch — perpendicular plane × cone routes to wasm-plane-cone', async () => {
  const ok = await preloadIntersectionsWasm();
  assert.equal(ok, true);

  const coneOrigin = { x: 0, y: 0, z: 1 };
  const coneAxis = { x: 0, y: 0, z: 1 };
  const coneR = 1;
  const semiAngle = Math.PI / 4; // 45° → radius grows 1:1 with z
  const cone = makeCone(coneOrigin, coneAxis, coneR, semiAngle);
  // Plane z=3 → cone radius at that height = 3.
  const plane = makePlane({ x: 0, y: 0, z: 3 }, { x: 10, y: 0, z: 0 }, { x: 0, y: 10, z: 0 });

  _resetIntersectionsDebugStateForTests();
  const result = intersectSurfaces(plane, SurfaceType.PLANE, cone, SurfaceType.CONE);
  const dbg = _getIntersectionsDebugStateForTests();
  assert.equal(dbg.last, 'wasm-plane-cone');
  assert.equal(dbg.wasmPlaneConeCalls, 1);
  assert.equal(result.length, 1);

  const curve = result[0].curve;
  // Sample a handful of params; each sampled 3D point must lie on plane z=3
  // and on the cone (distance to axis == 3).
  for (const t of [0, 0.125, 0.25, 0.5, 0.625, 0.875, 1.0]) {
    const p = curve.evaluate(t);
    assert.ok(Math.abs(p.z - 3) < 1e-6, `on plane z=3 (t=${t}, z=${p.z})`);
    const da = distToAxis(p, coneOrigin, coneAxis);
    assert.ok(Math.abs(da - 3) < 1e-6, `on cone radius=3 (t=${t}, got ${da})`);
  }
});

await test('dispatch — reversed (CONE, PLANE) order also routes to WASM', async () => {
  const coneOrigin = { x: 0, y: 0, z: 0 };
  const coneAxis = { x: 0, y: 0, z: 1 };
  const cone = makeCone(coneOrigin, coneAxis, 0.5, Math.atan2(1, 2)); // gentle cone
  const plane = makePlane({ x: 0, y: 0, z: 4 }, { x: 10, y: 0, z: 0 }, { x: 0, y: 10, z: 0 });

  _resetIntersectionsDebugStateForTests();
  const result = intersectSurfaces(cone, SurfaceType.CONE, plane, SurfaceType.PLANE);
  const dbg = _getIntersectionsDebugStateForTests();
  assert.equal(dbg.last, 'wasm-plane-cone');
  assert.equal(dbg.wasmPlaneConeCalls, 1);
  assert.equal(result.length, 1);
});

await test('dispatch — oblique plane × cone falls back (WASM counter not incremented)', async () => {
  const coneOrigin = { x: 0, y: 0, z: 1 };
  const cone = makeCone(coneOrigin, { x: 0, y: 0, z: 1 }, 1, Math.PI / 6);
  const nLen = Math.sqrt(2);
  const plane = makePlane(
    { x: 0, y: 0, z: 3 },
    { x: 10, y: 0, z: 0 },
    { x: 0, y: 10, z: 10 }, // tilted so normal is off-axis
  );

  _resetIntersectionsDebugStateForTests();
  // JS fallback's numeric marcher throws on the empty-CP mock surface; we
  // only care that the WASM slice did not claim the result.
  try { intersectSurfaces(plane, SurfaceType.PLANE, cone, SurfaceType.CONE); } catch { /* ok */ }
  const dbg = _getIntersectionsDebugStateForTests();
  assert.equal(dbg.wasmPlaneConeCalls, 0, 'oblique must not count as WASM hit');
  assert.notEqual(dbg.last, 'wasm-plane-cone');
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
