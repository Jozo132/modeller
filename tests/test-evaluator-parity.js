import './_watchdog.mjs';
// tests/test-evaluator-parity.js — JS vs WASM evaluator parity tests
//
// Forces both JS and WASM backends and compares results within tolerance.
// Exercises a range of geometry fixtures: lines, arcs, circles, planes,
// cylinders, spherical patches, and multi-span curves/surfaces.
//
// Also verifies:
//   - No crashes if WASM init fails (graceful JS fallback)
//   - Repeated evaluations are deterministic (bit-exact)

import { NurbsCurve, NurbsSurface, GeometryEvaluator } from '../js/cad/index.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ ${msg}`); }
}

function assertApprox(actual, expected, tol, msg) {
  const ok = Math.abs(actual - expected) <= tol;
  if (ok) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ ${msg} — got ${actual}, expected ${expected} (tol ${tol})`); }
}

function dist3(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function vecLen(v) {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

// ─── Setup ────────────────────────────────────────────────────────────

console.log('=== Evaluator Parity Tests ===\n');

const wasmReady = await GeometryEvaluator.initWasm();
console.log(`WASM available: ${wasmReady}\n`);

// ─── Fixtures ─────────────────────────────────────────────────────────

const fixtures = {
  line: NurbsCurve.createLine({ x: 1, y: 2, z: 3 }, { x: 4, y: 6, z: 8 }),
  arc90: NurbsCurve.createArc(
    { x: 0, y: 0, z: 0 }, 5,
    { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 },
    0, Math.PI / 2
  ),
  arc270: NurbsCurve.createArc(
    { x: 0, y: 0, z: 0 }, 3,
    { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 },
    0, Math.PI * 1.5
  ),
  circle: NurbsCurve.createCircle(
    { x: 0, y: 0, z: 0 }, 5,
    { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }
  ),
  plane: NurbsSurface.createPlane(
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 0, y: 10, z: 0 }
  ),
  cylinder: NurbsSurface.createCylinder(
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 1 }, 5, 10,
    { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }
  ),
  sphere: NurbsSurface.createSphericalPatch(
    { x: 0, y: 0, z: 0 }, 5,
    { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }
  ),
};

// ─── 1) JS vs WASM Curve Parity ─────────────────────────────────────

console.log('--- JS vs WASM Curve Parity ---');

if (wasmReady) {
  const CURVE_PARITY_TOL = 1e-10;
  const D1_PARITY_TOL = 1e-8;
  const D2_PARITY_TOL = 1e-6;

  for (const [name, curve] of Object.entries(fixtures)) {
    if (!(curve instanceof NurbsCurve)) continue;
    const nSamples = 50;
    let maxPosDist = 0;
    let maxD1Dist = 0;
    let maxD2Dist = 0;

    for (let i = 0; i <= nSamples; i++) {
      const t = curve.uMin + (i / nSamples) * (curve.uMax - curve.uMin);
      const jsResult = GeometryEvaluator._jsEvalCurve(curve, t);
      const wasmResult = GeometryEvaluator._wasmEvalCurve(curve, t);
      if (!wasmResult) continue;

      maxPosDist = Math.max(maxPosDist, dist3(jsResult.p, wasmResult.p));
      maxD1Dist = Math.max(maxD1Dist, dist3(jsResult.d1, wasmResult.d1));
      maxD2Dist = Math.max(maxD2Dist, dist3(jsResult.d2, wasmResult.d2));
    }

    assertApprox(maxPosDist, 0, CURVE_PARITY_TOL,
      `${name}: position parity (max δ=${maxPosDist.toExponential(2)})`);
    assertApprox(maxD1Dist, 0, D1_PARITY_TOL,
      `${name}: d1 parity (max δ=${maxD1Dist.toExponential(2)})`);
    assertApprox(maxD2Dist, 0, D2_PARITY_TOL,
      `${name}: d2 parity (max δ=${maxD2Dist.toExponential(2)})`);
  }
} else {
  console.log('  (WASM not available — skipping curve parity)');
}

// ─── 2) JS vs WASM Surface Parity ───────────────────────────────────

console.log('\n--- JS vs WASM Surface Parity ---');

if (wasmReady) {
  const POS_TOL = 1e-10;
  const DERIV_TOL = 1e-8;
  const NORMAL_TOL = 1e-8;

  for (const [name, surface] of Object.entries(fixtures)) {
    if (!(surface instanceof NurbsSurface)) continue;
    const nSamples = 10;
    let maxPosDist = 0;
    let maxDuDist = 0;
    let maxDvDist = 0;
    let maxNDist = 0;

    for (let i = 0; i <= nSamples; i++) {
      const u = surface.uMin + (i / nSamples) * (surface.uMax - surface.uMin);
      for (let j = 0; j <= nSamples; j++) {
        const v = surface.vMin + (j / nSamples) * (surface.vMax - surface.vMin);
        const jsResult = GeometryEvaluator._jsEvalSurface(surface, u, v);
        const wasmResult = GeometryEvaluator._wasmEvalSurface(surface, u, v);
        if (!wasmResult) continue;

        maxPosDist = Math.max(maxPosDist, dist3(jsResult.p, wasmResult.p));
        maxDuDist = Math.max(maxDuDist, dist3(jsResult.du, wasmResult.du));
        maxDvDist = Math.max(maxDvDist, dist3(jsResult.dv, wasmResult.dv));
        maxNDist = Math.max(maxNDist, dist3(jsResult.n, wasmResult.n));
      }
    }

    assertApprox(maxPosDist, 0, POS_TOL,
      `${name}: position parity (max δ=${maxPosDist.toExponential(2)})`);
    assertApprox(maxDuDist, 0, DERIV_TOL,
      `${name}: du parity (max δ=${maxDuDist.toExponential(2)})`);
    assertApprox(maxDvDist, 0, DERIV_TOL,
      `${name}: dv parity (max δ=${maxDvDist.toExponential(2)})`);
    assertApprox(maxNDist, 0, NORMAL_TOL,
      `${name}: normal parity (max δ=${maxNDist.toExponential(2)})`);
  }
} else {
  console.log('  (WASM not available — skipping surface parity)');
}

// ─── 3) Deterministic Repeated Evaluation ────────────────────────────

console.log('\n--- Deterministic repeated evaluation ---');

{
  // Curve determinism: same input → bit-identical output
  const arc = fixtures.arc270;
  const params = [arc.uMin, (arc.uMin + arc.uMax) / 2, arc.uMax, 0.37];
  let allIdentical = true;
  for (const t of params) {
    const r1 = GeometryEvaluator.evalCurve(arc, t);
    const r2 = GeometryEvaluator.evalCurve(arc, t);
    if (r1.p.x !== r2.p.x || r1.p.y !== r2.p.y || r1.p.z !== r2.p.z ||
        r1.d1.x !== r2.d1.x || r1.d1.y !== r2.d1.y || r1.d1.z !== r2.d1.z ||
        r1.d2.x !== r2.d2.x || r1.d2.y !== r2.d2.y || r1.d2.z !== r2.d2.z) {
      allIdentical = false;
      break;
    }
  }
  assert(allIdentical, 'Curve eval: repeated calls produce bit-identical results');
}

{
  // Surface determinism
  const cyl = fixtures.cylinder;
  const uvPairs = [
    [cyl.uMin, cyl.vMin],
    [(cyl.uMin + cyl.uMax) / 2, (cyl.vMin + cyl.vMax) / 2],
    [cyl.uMax, cyl.vMax],
    [0.37, 0.73],
  ];
  let allIdentical = true;
  for (const [u, v] of uvPairs) {
    const r1 = GeometryEvaluator.evalSurface(cyl, u, v);
    const r2 = GeometryEvaluator.evalSurface(cyl, u, v);
    if (r1.p.x !== r2.p.x || r1.p.y !== r2.p.y || r1.p.z !== r2.p.z ||
        r1.n.x !== r2.n.x || r1.n.y !== r2.n.y || r1.n.z !== r2.n.z ||
        r1.du.x !== r2.du.x || r1.dv.y !== r2.dv.y) {
      allIdentical = false;
      break;
    }
  }
  assert(allIdentical, 'Surface eval: repeated calls produce bit-identical results');
}

// ─── 4) Batch vs Single Consistency ─────────────────────────────────

console.log('\n--- Batch vs single evaluation consistency ---');

{
  const circle = fixtures.circle;
  const params = [];
  const N = 20;
  for (let i = 0; i <= N; i++) {
    params.push(circle.uMin + (i / N) * (circle.uMax - circle.uMin));
  }
  const batch = GeometryEvaluator.evalCurveBatch(circle, params);
  let maxDist = 0;
  for (let i = 0; i <= N; i++) {
    const single = GeometryEvaluator.evalCurve(circle, params[i]);
    const off = i * 9;
    const bp = { x: batch[off], y: batch[off + 1], z: batch[off + 2] };
    maxDist = Math.max(maxDist, dist3(single.p, bp));
  }
  assertApprox(maxDist, 0, 1e-14, `Curve batch=single parity (max δ=${maxDist.toExponential(2)})`);
}

{
  const cyl = fixtures.cylinder;
  const params = [];
  const N = 5;
  for (let i = 0; i <= N; i++) {
    const u = cyl.uMin + (i / N) * (cyl.uMax - cyl.uMin);
    for (let j = 0; j <= N; j++) {
      const v = cyl.vMin + (j / N) * (cyl.vMax - cyl.vMin);
      params.push(u, v);
    }
  }
  const batch = GeometryEvaluator.evalSurfaceBatch(cyl, params);
  let maxDist = 0;
  const count = params.length / 2;
  for (let i = 0; i < count; i++) {
    const single = GeometryEvaluator.evalSurface(cyl, params[i * 2], params[i * 2 + 1]);
    const off = i * 21;
    const bp = { x: batch[off], y: batch[off + 1], z: batch[off + 2] };
    maxDist = Math.max(maxDist, dist3(single.p, bp));
  }
  assertApprox(maxDist, 0, 1e-14, `Surface batch=single parity (max δ=${maxDist.toExponential(2)})`);
}

// ─── 5) WASM Init Failure Safety ────────────────────────────────────

console.log('\n--- WASM init failure safety ---');

{
  // Even if WASM were unavailable, the JS fallback must work correctly.
  // Force JS path by calling internal method directly.
  const line = fixtures.line;
  const r = GeometryEvaluator._jsEvalCurve(line, 0.5);
  assertApprox(r.p.x, 2.5, 1e-10, 'JS fallback curve eval correct when WASM absent');

  const plane = fixtures.plane;
  const rs = GeometryEvaluator._jsEvalSurface(plane, 0.5, 0.5);
  assertApprox(rs.p.x, 5, 1e-10, 'JS fallback surface eval correct when WASM absent');
  assertApprox(Math.abs(rs.n.z), 1, 1e-10, 'JS fallback normal correct when WASM absent');
}

{
  // initWasm is safe to call multiple times
  const ok1 = await GeometryEvaluator.initWasm();
  const ok2 = await GeometryEvaluator.initWasm();
  assert(ok1 === ok2, 'initWasm idempotent (repeated calls return same result)');
}

// ─── 6) Edge Cases ──────────────────────────────────────────────────

console.log('\n--- Edge cases ---');

{
  // Evaluate at domain boundaries
  const arc = fixtures.arc90;
  const r0 = GeometryEvaluator.evalCurve(arc, arc.uMin);
  const r1 = GeometryEvaluator.evalCurve(arc, arc.uMax);
  assert(isFinite(r0.p.x) && isFinite(r0.p.y) && isFinite(r0.p.z),
    'Curve eval at uMin produces finite values');
  assert(isFinite(r1.p.x) && isFinite(r1.p.y) && isFinite(r1.p.z),
    'Curve eval at uMax produces finite values');
}

{
  // Surface eval at all four domain corners
  const cyl = fixtures.cylinder;
  const corners = [
    [cyl.uMin, cyl.vMin], [cyl.uMax, cyl.vMin],
    [cyl.uMin, cyl.vMax], [cyl.uMax, cyl.vMax],
  ];
  let allFinite = true;
  for (const [u, v] of corners) {
    const r = GeometryEvaluator.evalSurface(cyl, u, v);
    if (!isFinite(r.p.x) || !isFinite(r.p.y) || !isFinite(r.p.z) ||
        !isFinite(r.n.x) || !isFinite(r.n.y) || !isFinite(r.n.z)) {
      allFinite = false;
    }
  }
  assert(allFinite, 'Surface eval at all domain corners produces finite values');
}

{
  // Parameter clamping: values outside domain should be clamped
  const line = fixtures.line;
  const rBelow = GeometryEvaluator.evalCurve(line, -1);
  const rAbove = GeometryEvaluator.evalCurve(line, 2);
  const rMin = GeometryEvaluator.evalCurve(line, line.uMin);
  const rMax = GeometryEvaluator.evalCurve(line, line.uMax);
  assertApprox(dist3(rBelow.p, rMin.p), 0, 1e-10, 'Curve clamps below-domain params');
  assertApprox(dist3(rAbove.p, rMax.p), 0, 1e-10, 'Curve clamps above-domain params');
}

// ─── Results ────────────────────────────────────────────────────────

console.log(`\n=== Results ===\n\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
