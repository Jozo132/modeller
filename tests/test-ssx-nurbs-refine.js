import './_watchdog.mjs';

import assert from 'node:assert/strict';

import * as wasmKernel from '../build/release.js';
import { NurbsSurface } from '../js/cad/NurbsSurface.js';

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

// ── NURBS-pair Newton refiner & seed finder ───────────────────────────

console.log('\n=== WASM ssxRefinePair / ssxFindSeeds (H8, generic NURBS) ===\n');

/**
 * Pack a NurbsSurface into kernel-ready Float64Array buffers and call
 * ssxSetSurfaceA/B. Supports rational surfaces (weights preserved).
 */
function loadSurface(surf, which /* 'A' | 'B' */) {
  const nRowsU = surf.numRowsU;
  const nColsV = surf.numColsV;
  const total = nRowsU * nColsV;
  const ctrlPts = new Float64Array(total * 3);
  const weights = new Float64Array(total);
  for (let k = 0; k < total; k++) {
    const p = surf.controlPoints[k];
    ctrlPts[k * 3 + 0] = p.x;
    ctrlPts[k * 3 + 1] = p.y;
    ctrlPts[k * 3 + 2] = p.z;
    weights[k] = surf.weights[k] != null ? surf.weights[k] : 1;
  }
  const knotsU = Float64Array.from(surf.knotsU);
  const knotsV = Float64Array.from(surf.knotsV);
  const setter = which === 'A' ? wasmKernel.ssxSetSurfaceA : wasmKernel.ssxSetSurfaceB;
  setter(surf.degreeU, surf.degreeV, nRowsU, nColsV, knotsU, knotsV, ctrlPts, weights);
  return { knotsU, knotsV, ctrlPts, weights }; // keep references alive for GC
}

function evalSurfacePoint(surf, u, v) {
  const nRowsU = surf.numRowsU;
  const nColsV = surf.numColsV;
  const total = nRowsU * nColsV;
  const ctrlPts = new Float64Array(total * 3);
  const weights = new Float64Array(total);
  for (let k = 0; k < total; k++) {
    const p = surf.controlPoints[k];
    ctrlPts[k * 3 + 0] = p.x;
    ctrlPts[k * 3 + 1] = p.y;
    ctrlPts[k * 3 + 2] = p.z;
    weights[k] = surf.weights[k] != null ? surf.weights[k] : 1;
  }
  const knotsU = Float64Array.from(surf.knotsU);
  const knotsV = Float64Array.from(surf.knotsV);
  wasmKernel.nurbsSurfaceDerivEval(
    surf.degreeU, surf.degreeV, nRowsU, nColsV,
    ctrlPts, knotsU, knotsV, weights, u, v,
  );
  const buf = new Float64Array(wasmKernel.memory.buffer, wasmKernel.getDerivBufPtr(), 21);
  return { x: buf[0], y: buf[1], z: buf[2] };
}

await test('ssxRefinePair — two planes (x=0 and y=0): converges to the line y=0,x=0', () => {
  // Plane A: passes through origin, normal = +x (so x=0). Span z=[-1..1], y=[-1..1].
  // Representation as a NURBS plane: corners at (0,-1,-1), (0,1,-1), (0,-1,1), (0,1,1).
  const planeA = NurbsSurface.createPlane(
    { x: 0, y: 0, z: 0 },    // origin
    { x: 0, y: 2, z: 0 },    // uDir
    { x: 0, y: 0, z: 2 },    // vDir
  );
  // Plane B: y=0 plane. Corners at (-1,0,-1), (1,0,-1), (-1,0,1), (1,0,1).
  const planeB = NurbsSurface.createPlane(
    { x: 0, y: 0, z: 0 },
    { x: 2, y: 0, z: 0 },
    { x: 0, y: 0, z: 2 },
  );

  const refsA = loadSurface(planeA, 'A');
  const refsB = loadSurface(planeB, 'B');

  // Seed point where surfaces are close but not identical. Plane A param
  // (0.6, 0.4) maps to (0, 0.2, -0.2); closest point on plane B is (0, 0, -0.2).
  // Expected convergence: a point (0,0,z*) with z ≈ -0.2 (mean of the two).
  const conv = wasmKernel.ssxRefinePair(0.6, 0.4, 0.5, 0.4, 32, 1e-9);
  assert.equal(conv, 1, 'should converge within 1e-9');
  const out = new Float64Array(wasmKernel.memory.buffer, wasmKernel.getSsxRefineOutPtr(), 5);
  const pA = evalSurfacePoint(planeA, out[0], out[1]);
  const pB = evalSurfacePoint(planeB, out[2], out[3]);
  const dx = pA.x - pB.x, dy = pA.y - pB.y, dz = pA.z - pB.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  assert.ok(dist < 1e-9, `SA-SB should vanish, got ${dist}`);
  // Both on line x=y=0
  assert.ok(Math.abs(pA.x) < 1e-9);
  assert.ok(Math.abs(pA.y) < 1e-9);
  // refine residual should match
  assert.ok(out[4] < 1e-9);

  // Prevent GC (silence unused var lint)
  void refsA; void refsB;
});

await test('ssxRefinePair — plane × cylinder: converges onto the intersection circle', () => {
  // Cylinder: axis +z, radius 2, height 4, centered at origin bottom.
  const cyl = NurbsSurface.createCylinder(
    { x: 0, y: 0, z: -2 },
    { x: 0, y: 0, z: 1 },
    2, 4,
    { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 },
  );
  // Plane z=0. Expected intersection: circle radius 2 in plane z=0.
  const plane = NurbsSurface.createPlane(
    { x: -3, y: -3, z: 0 },
    { x: 6, y: 0, z: 0 },
    { x: 0, y: 6, z: 0 },
  );

  const refsA = loadSurface(plane, 'A');
  const refsB = loadSurface(cyl, 'B');

  // Seed the refiner near the intersection circle.
  // Plane param (0.8, 0.5) ≈ xy (1.8, 0). Cylinder at (u=0, v=0.5) ≈ angle 0, mid height.
  const conv = wasmKernel.ssxRefinePair(0.8, 0.5, 0.0, 0.5, 60, 1e-9);
  assert.equal(conv, 1, 'should converge onto intersection circle');
  const out = new Float64Array(wasmKernel.memory.buffer, wasmKernel.getSsxRefineOutPtr(), 5);
  const pA = evalSurfacePoint(plane, out[0], out[1]);
  const pB = evalSurfacePoint(cyl, out[2], out[3]);
  const dd = Math.hypot(pA.x - pB.x, pA.y - pB.y, pA.z - pB.z);
  assert.ok(dd < 1e-7, `surfaces coincident, got ${dd}`);
  assert.ok(Math.abs(pA.z) < 1e-7, `on plane z=0, got z=${pA.z}`);
  const circR = Math.sqrt(pA.x * pA.x + pA.y * pA.y);
  assert.ok(Math.abs(circR - 2) < 1e-6, `circle radius 2, got ${circR}`);

  void refsA; void refsB;
});

await test('ssxRefinePair — non-intersecting surfaces: returns 0 and leaves residual > eps', () => {
  // Plane z=0 and plane z=5. No intersection — both planes parallel.
  const planeA = NurbsSurface.createPlane(
    { x: 0, y: 0, z: 0 },
    { x: 2, y: 0, z: 0 },
    { x: 0, y: 2, z: 0 },
  );
  const planeB = NurbsSurface.createPlane(
    { x: 0, y: 0, z: 5 },
    { x: 2, y: 0, z: 0 },
    { x: 0, y: 2, z: 0 },
  );

  const refsA = loadSurface(planeA, 'A');
  const refsB = loadSurface(planeB, 'B');

  const conv = wasmKernel.ssxRefinePair(0.5, 0.5, 0.5, 0.5, 20, 1e-9);
  assert.equal(conv, 0, 'parallel planes 5 apart should NOT converge');
  const out = new Float64Array(wasmKernel.memory.buffer, wasmKernel.getSsxRefineOutPtr(), 5);
  assert.ok(out[4] >= 4.99, `residual should be ≈ 5, got ${out[4]}`);

  void refsA; void refsB;
});

await test('ssxFindSeeds — grid discovers seeds where plane × cylinder intersect', () => {
  const cyl = NurbsSurface.createCylinder(
    { x: 0, y: 0, z: -2 },
    { x: 0, y: 0, z: 1 },
    2, 4,
    { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 },
  );
  const plane = NurbsSurface.createPlane(
    { x: -3, y: -3, z: 0 },
    { x: 6, y: 0, z: 0 },
    { x: 0, y: 6, z: 0 },
  );

  const refsA = loadSurface(plane, 'A');
  const refsB = loadSurface(cyl, 'B');

  const n = wasmKernel.ssxFindSeeds(16, 16, 0.3, 64);
  assert.ok(n > 0, `should find at least one seed, got ${n}`);
  const seeds = new Float64Array(wasmKernel.memory.buffer, wasmKernel.getSsxSeedsOutPtr(), n * 5);
  assert.ok(seeds[4] >= 0, 'dist is non-negative');
  assert.ok(seeds[4] < 0.3, 'below threshold');
  for (let i = 1; i < n; i++) {
    assert.ok(seeds[i * 5 + 4] >= seeds[(i - 1) * 5 + 4] - 1e-15, `seed[${i}].dist >= seed[${i - 1}].dist`);
  }

  void refsA; void refsB;
});

await test('ssxRefinePair after ssxFindSeeds: top seed refines onto the intersection', () => {
  const cyl = NurbsSurface.createCylinder(
    { x: 0, y: 0, z: -2 },
    { x: 0, y: 0, z: 1 },
    2, 4,
    { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 },
  );
  const plane = NurbsSurface.createPlane(
    { x: -3, y: -3, z: 0 },
    { x: 6, y: 0, z: 0 },
    { x: 0, y: 6, z: 0 },
  );

  const refsA = loadSurface(plane, 'A');
  const refsB = loadSurface(cyl, 'B');

  const n = wasmKernel.ssxFindSeeds(16, 16, 0.4, 64);
  assert.ok(n > 0);
  const seeds = new Float64Array(wasmKernel.memory.buffer, wasmKernel.getSsxSeedsOutPtr(), n * 5);
  const conv = wasmKernel.ssxRefinePair(seeds[0], seeds[1], seeds[2], seeds[3], 60, 1e-9);
  assert.equal(conv, 1);
  const out = new Float64Array(wasmKernel.memory.buffer, wasmKernel.getSsxRefineOutPtr(), 5);
  const pA = evalSurfacePoint(plane, out[0], out[1]);
  assert.ok(Math.abs(pA.z) < 1e-7, `on plane z=0, got z=${pA.z}`);
  const circR = Math.sqrt(pA.x * pA.x + pA.y * pA.y);
  assert.ok(Math.abs(circR - 2) < 1e-5, `circle radius ≈ 2, got ${circR}`);

  void refsA; void refsB;
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
