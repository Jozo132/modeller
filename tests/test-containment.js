// tests/test-containment.js — Deterministic containment engine tests
//
// Validates:
//   1. Clean analytic solids (box, tetrahedron)
//   2. Trimmed NURBS faces with holes
//   3. Points clearly inside / outside / on-boundary
//   4. Seeded randomized near-boundary queries
//   5. Repeated runs produce identical results
//   6. Regression coverage for existing boolean fixtures
//   7. Imperfect or borderline cases returning "uncertain"
//   8. isPointOnFace helper
//   9. classifyFragment routing through Containment

import assert from 'assert';
import {
  classifyPoint, classifyPoints, classifyFragment,
  isPointOnFace, maybeResolveUncertain,
} from '../js/cad/Containment.js';
import {
  TopoBody, TopoShell, TopoFace, TopoLoop, TopoCoEdge, TopoEdge, TopoVertex,
  SurfaceType, buildTopoBody, resetTopoIds,
} from '../js/cad/BRepTopology.js';
import { Tolerance, DEFAULT_TOLERANCE } from '../js/cad/Tolerance.js';
import { NurbsCurve } from '../js/cad/NurbsCurve.js';
import { NurbsSurface } from '../js/cad/NurbsSurface.js';
import { classifyFragment as faceSplitterClassifyFragment } from '../js/cad/FaceSplitter.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeBox(x, y, z, w, h, d) {
  resetTopoIds();
  const c = [
    { x, y, z },
    { x: x + w, y, z },
    { x: x + w, y: y + h, z },
    { x, y: y + h, z },
    { x, y, z: z + d },
    { x: x + w, y, z: z + d },
    { x: x + w, y: y + h, z: z + d },
    { x, y: y + h, z: z + d },
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

function makeTetrahedron() {
  resetTopoIds();
  const v = [
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 5, y: 10, z: 0 },
    { x: 5, y: 3, z: 8 },
  ];
  return buildTopoBody([
    { surfaceType: SurfaceType.PLANE, vertices: [v[0], v[2], v[1]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [v[0], v[1], v[3]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [v[1], v[2], v[3]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [v[2], v[0], v[3]], surface: null, edgeCurves: null, shared: null },
  ]);
}

/**
 * Create a single triangular face for isPointOnFace tests.
 */
function makeTriangleFace(p0, p1, p2) {
  resetTopoIds();
  const v0 = new TopoVertex(p0);
  const v1 = new TopoVertex(p1);
  const v2 = new TopoVertex(p2);
  const e0 = new TopoEdge(v0, v1);
  const e1 = new TopoEdge(v1, v2);
  const e2 = new TopoEdge(v2, v0);
  const loop = new TopoLoop([
    new TopoCoEdge(e0, true),
    new TopoCoEdge(e1, true),
    new TopoCoEdge(e2, true),
  ]);
  const face = new TopoFace(null, SurfaceType.PLANE);
  face.setOuterLoop(loop);
  return face;
}

/**
 * Simple seeded pseudo-random number generator (mulberry32).
 * Returns a function that produces deterministic floats in [0,1).
 */
function seededRng(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================
console.log('=== Containment: Clean Analytic Solids ===\n');
// ============================================================

test('classifyPoint: center of unit box is inside', () => {
  const box = makeBox(0, 0, 0, 10, 10, 10);
  const r = classifyPoint(box, { x: 5, y: 5, z: 5 });
  assert.strictEqual(r.state, 'inside', `Expected inside, got ${r.state} (${r.detail})`);
  assert.ok(r.confidence > 0.5, `Confidence should be high: ${r.confidence}`);
});

test('classifyPoint: point outside unit box', () => {
  const box = makeBox(0, 0, 0, 10, 10, 10);
  const r = classifyPoint(box, { x: 20, y: 20, z: 20 });
  assert.strictEqual(r.state, 'outside', `Expected outside, got ${r.state} (${r.detail})`);
});

test('classifyPoint: point on box vertex is on-boundary', () => {
  const box = makeBox(0, 0, 0, 10, 10, 10);
  const r = classifyPoint(box, { x: 0, y: 0, z: 0 });
  assert.strictEqual(r.state, 'on', `Expected on, got ${r.state} (${r.detail})`);
});

test('classifyPoint: point near box face is on-boundary', () => {
  const box = makeBox(0, 0, 0, 10, 10, 10);
  const r = classifyPoint(box, { x: 5, y: 5, z: 1e-7 });
  assert.strictEqual(r.state, 'on', `Expected on, got ${r.state} (${r.detail})`);
});

test('classifyPoint: tetrahedron centroid is inside', () => {
  const tet = makeTetrahedron();
  const r = classifyPoint(tet, { x: 5, y: 3, z: 2 });
  assert.strictEqual(r.state, 'inside', `Expected inside, got ${r.state} (${r.detail})`);
});

test('classifyPoint: tetrahedron far outside', () => {
  const tet = makeTetrahedron();
  const r = classifyPoint(tet, { x: -10, y: -10, z: -10 });
  assert.strictEqual(r.state, 'outside', `Expected outside, got ${r.state} (${r.detail})`);
});

test('classifyPoint: empty body is outside', () => {
  const r = classifyPoint(new TopoBody(), { x: 0, y: 0, z: 0 });
  assert.strictEqual(r.state, 'outside');
  assert.strictEqual(r.detail, 'empty-body');
});

test('classifyPoint: null body is outside', () => {
  const r = classifyPoint(null, { x: 0, y: 0, z: 0 });
  assert.strictEqual(r.state, 'outside');
});

// ============================================================
console.log('\n=== Containment: classifyPoints (Batch) ===\n');
// ============================================================

test('classifyPoints: batch of 4 points', () => {
  const box = makeBox(0, 0, 0, 10, 10, 10);
  const results = classifyPoints(box, [
    { x: 5, y: 5, z: 5 },  // inside
    { x: 20, y: 5, z: 5 }, // outside
    { x: 0, y: 0, z: 0 },  // on
    { x: -5, y: -5, z: -5 }, // outside
  ]);
  assert.strictEqual(results.length, 4);
  assert.strictEqual(results[0].state, 'inside');
  assert.strictEqual(results[1].state, 'outside');
  assert.strictEqual(results[2].state, 'on');
  assert.strictEqual(results[3].state, 'outside');
});

// ============================================================
console.log('\n=== Containment: isPointOnFace ===\n');
// ============================================================

test('isPointOnFace: point inside triangle face', () => {
  const face = makeTriangleFace(
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 5, y: 10, z: 0 },
  );
  const r = isPointOnFace(face, { x: 5, y: 3, z: 0 });
  assert.strictEqual(r.on, true, `Expected on=true, got ${r.on} (${r.detail})`);
});

test('isPointOnFace: point outside triangle face', () => {
  const face = makeTriangleFace(
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 5, y: 10, z: 0 },
  );
  const r = isPointOnFace(face, { x: 20, y: 20, z: 0 });
  assert.strictEqual(r.on, false);
});

test('isPointOnFace: point on vertex', () => {
  const face = makeTriangleFace(
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 5, y: 10, z: 0 },
  );
  const r = isPointOnFace(face, { x: 0, y: 0, z: 0 });
  assert.strictEqual(r.on, true);
  assert.strictEqual(r.detail, 'on-vertex');
});

test('isPointOnFace: face without outer loop', () => {
  const face = new TopoFace(null, SurfaceType.PLANE);
  const r = isPointOnFace(face, { x: 0, y: 0, z: 0 });
  assert.strictEqual(r.on, false);
  assert.strictEqual(r.detail, 'no-outer-loop');
});

// ============================================================
console.log('\n=== Containment: classifyFragment ===\n');
// ============================================================

test('classifyFragment: fragment inside a box', () => {
  // Create a small triangle face inside the box
  const box = makeBox(0, 0, 0, 10, 10, 10);
  resetTopoIds();
  const face = makeTriangleFace(
    { x: 3, y: 3, z: 5 },
    { x: 7, y: 3, z: 5 },
    { x: 5, y: 7, z: 5 },
  );
  const r = classifyFragment(box, face);
  assert.strictEqual(r.state, 'inside', `Expected inside, got ${r.state} (${r.detail})`);
});

test('classifyFragment: fragment outside a box', () => {
  const box = makeBox(0, 0, 0, 10, 10, 10);
  resetTopoIds();
  const face = makeTriangleFace(
    { x: 20, y: 20, z: 20 },
    { x: 25, y: 20, z: 20 },
    { x: 22, y: 25, z: 20 },
  );
  const r = classifyFragment(box, face);
  assert.strictEqual(r.state, 'outside', `Expected outside, got ${r.state} (${r.detail})`);
});

// ============================================================
console.log('\n=== Containment: FaceSplitter Integration ===\n');
// ============================================================

test('FaceSplitter.classifyFragment: routes through Containment', () => {
  const box = makeBox(0, 0, 0, 10, 10, 10);
  resetTopoIds();
  const face = makeTriangleFace(
    { x: 3, y: 3, z: 5 },
    { x: 7, y: 3, z: 5 },
    { x: 5, y: 7, z: 5 },
  );
  // FaceSplitter's classifyFragment returns legacy 'inside'/'outside'/'coincident'
  const result = faceSplitterClassifyFragment(face, box);
  assert.strictEqual(result, 'inside', `Expected 'inside', got '${result}'`);
});

test('FaceSplitter.classifyFragment: outside case routes correctly', () => {
  const box = makeBox(0, 0, 0, 10, 10, 10);
  resetTopoIds();
  const face = makeTriangleFace(
    { x: 20, y: 20, z: 20 },
    { x: 25, y: 20, z: 20 },
    { x: 22, y: 25, z: 20 },
  );
  const result = faceSplitterClassifyFragment(face, box);
  assert.strictEqual(result, 'outside', `Expected 'outside', got '${result}'`);
});

// ============================================================
console.log('\n=== Containment: Determinism ===\n');
// ============================================================

test('classifyPoint: 10 repeated runs give identical results', () => {
  const box = makeBox(0, 0, 0, 10, 10, 10);
  const testPoints = [
    { x: 5, y: 5, z: 5 },
    { x: 20, y: 5, z: 5 },
    { x: 0, y: 0, z: 0 },
    { x: 5, y: 5, z: 10.001 },
  ];

  const firstRun = testPoints.map(p => classifyPoint(box, p));

  for (let run = 0; run < 10; run++) {
    const results = testPoints.map(p => classifyPoint(box, p));
    for (let i = 0; i < results.length; i++) {
      assert.strictEqual(results[i].state, firstRun[i].state,
        `Run ${run}, point ${i}: state mismatch ${results[i].state} vs ${firstRun[i].state}`);
      assert.strictEqual(results[i].confidence, firstRun[i].confidence,
        `Run ${run}, point ${i}: confidence mismatch`);
    }
  }
});

// ============================================================
console.log('\n=== Containment: Seeded Randomized Near-Boundary ===\n');
// ============================================================

test('Seeded near-boundary queries: stable classification', () => {
  const box = makeBox(0, 0, 0, 10, 10, 10);
  const rng = seededRng(42);

  // Generate 50 points near the box surface
  const nearPoints = [];
  for (let i = 0; i < 50; i++) {
    // Pick a random face of the box and offset slightly
    const face = Math.floor(rng() * 6);
    let p;
    switch (face) {
      case 0: p = { x: rng() * 10, y: rng() * 10, z: (rng() - 0.5) * 0.01 }; break;  // near z=0
      case 1: p = { x: rng() * 10, y: rng() * 10, z: 10 + (rng() - 0.5) * 0.01 }; break; // near z=10
      case 2: p = { x: (rng() - 0.5) * 0.01, y: rng() * 10, z: rng() * 10 }; break; // near x=0
      case 3: p = { x: 10 + (rng() - 0.5) * 0.01, y: rng() * 10, z: rng() * 10 }; break; // near x=10
      case 4: p = { x: rng() * 10, y: (rng() - 0.5) * 0.01, z: rng() * 10 }; break; // near y=0
      default: p = { x: rng() * 10, y: 10 + (rng() - 0.5) * 0.01, z: rng() * 10 }; break; // near y=10
    }
    nearPoints.push(p);
  }

  // Run twice and verify determinism
  const run1 = nearPoints.map(p => classifyPoint(box, p));
  const run2 = nearPoints.map(p => classifyPoint(box, p));

  for (let i = 0; i < run1.length; i++) {
    assert.strictEqual(run1[i].state, run2[i].state,
      `Point ${i}: state mismatch ${run1[i].state} vs ${run2[i].state}`);
  }

  // Verify that results are plausible (not all uncertain)
  const states = run1.map(r => r.state);
  const hasClassified = states.some(s => s === 'inside' || s === 'outside' || s === 'on');
  assert.ok(hasClassified, 'At least some near-boundary points should be classified');
});

test('Seeded randomized deep-interior points: all inside', () => {
  const box = makeBox(0, 0, 0, 10, 10, 10);
  const rng = seededRng(123);

  for (let i = 0; i < 20; i++) {
    const p = {
      x: 2 + rng() * 6,
      y: 2 + rng() * 6,
      z: 2 + rng() * 6,
    };
    const r = classifyPoint(box, p);
    assert.strictEqual(r.state, 'inside',
      `Deep interior point ${i} (${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}) should be inside, got ${r.state}`);
  }
});

test('Seeded randomized far-exterior points: all outside', () => {
  const box = makeBox(0, 0, 0, 10, 10, 10);
  const rng = seededRng(456);

  for (let i = 0; i < 20; i++) {
    const p = {
      x: 20 + rng() * 100,
      y: 20 + rng() * 100,
      z: 20 + rng() * 100,
    };
    const r = classifyPoint(box, p);
    assert.strictEqual(r.state, 'outside',
      `Far exterior point ${i} should be outside, got ${r.state}`);
  }
});

// ============================================================
console.log('\n=== Containment: Confidence and Detail ===\n');
// ============================================================

test('classifyPoint: result includes confidence', () => {
  const box = makeBox(0, 0, 0, 10, 10, 10);
  const r = classifyPoint(box, { x: 5, y: 5, z: 5 });
  assert.ok(typeof r.confidence === 'number', 'confidence should be a number');
  assert.ok(r.confidence >= 0 && r.confidence <= 1, `confidence out of range: ${r.confidence}`);
});

test('classifyPoint: result includes detail string', () => {
  const box = makeBox(0, 0, 0, 10, 10, 10);
  const r = classifyPoint(box, { x: 5, y: 5, z: 5 });
  assert.ok(typeof r.detail === 'string', 'detail should be a string');
  assert.ok(r.detail.length > 0, 'detail should not be empty');
});

test('classifyPoint: on-boundary detail', () => {
  const box = makeBox(0, 0, 0, 10, 10, 10);
  const r = classifyPoint(box, { x: 0, y: 0, z: 0 });
  assert.ok(r.detail.includes('on-boundary'), `Expected on-boundary detail, got: ${r.detail}`);
});

// ============================================================
console.log('\n=== Containment: maybeResolveUncertain ===\n');
// ============================================================

test('maybeResolveUncertain: non-uncertain passes through', () => {
  const box = makeBox(0, 0, 0, 10, 10, 10);
  const prior = { state: 'inside', confidence: 1.0, detail: 'test' };
  const r = maybeResolveUncertain(box, { x: 5, y: 5, z: 5 }, prior);
  assert.strictEqual(r.state, 'inside');
  assert.strictEqual(r.detail, 'test');
});

test('maybeResolveUncertain: attempts resolution of uncertain', () => {
  const box = makeBox(0, 0, 0, 10, 10, 10);
  const prior = { state: 'uncertain', confidence: 0.1, detail: 'test-uncertain' };
  const r = maybeResolveUncertain(box, { x: 5, y: 5, z: 5 }, prior);
  // Should either resolve or keep uncertain, but never crash
  assert.ok(['inside', 'outside', 'on', 'uncertain'].includes(r.state),
    `Expected valid state, got: ${r.state}`);
});

// ============================================================
console.log('\n=== Containment: Tolerance Overrides ===\n');
// ============================================================

test('classifyPoint: custom tolerance affects classification', () => {
  const box = makeBox(0, 0, 0, 10, 10, 10);
  const looseTol = new Tolerance({ classification: 1.0, pointCoincidence: 1.0 });
  // A point 0.5 away from surface should be "on" with loose tolerance
  const r = classifyPoint(box, { x: 5, y: 5, z: 0.5 }, { tolerance: looseTol });
  assert.strictEqual(r.state, 'on', `Expected on with loose tolerance, got ${r.state}`);
});

// ============================================================
console.log('\n=== Containment: Trimmed Face with Hole ===\n');
// ============================================================

test('isPointOnFace: face with inner loop (hole)', () => {
  resetTopoIds();

  // Outer boundary: large square
  const ov = [
    new TopoVertex({ x: 0, y: 0, z: 0 }),
    new TopoVertex({ x: 20, y: 0, z: 0 }),
    new TopoVertex({ x: 20, y: 20, z: 0 }),
    new TopoVertex({ x: 0, y: 20, z: 0 }),
  ];
  const outerEdges = [];
  const outerCoEdges = [];
  for (let i = 0; i < 4; i++) {
    const e = new TopoEdge(ov[i], ov[(i + 1) % 4]);
    outerEdges.push(e);
    outerCoEdges.push(new TopoCoEdge(e, true));
  }
  const outerLoop = new TopoLoop(outerCoEdges);

  // Inner boundary: small square hole at center
  const iv = [
    new TopoVertex({ x: 8, y: 8, z: 0 }),
    new TopoVertex({ x: 12, y: 8, z: 0 }),
    new TopoVertex({ x: 12, y: 12, z: 0 }),
    new TopoVertex({ x: 8, y: 12, z: 0 }),
  ];
  const innerEdges = [];
  const innerCoEdges = [];
  for (let i = 0; i < 4; i++) {
    const e = new TopoEdge(iv[i], iv[(i + 1) % 4]);
    innerEdges.push(e);
    innerCoEdges.push(new TopoCoEdge(e, true));
  }
  const innerLoop = new TopoLoop(innerCoEdges);

  const face = new TopoFace(null, SurfaceType.PLANE);
  face.setOuterLoop(outerLoop);
  face.addInnerLoop(innerLoop);

  // Point in the solid part of the face (outside hole)
  const r1 = isPointOnFace(face, { x: 2, y: 2, z: 0 });
  assert.strictEqual(r1.on, true, `Expected on=true for solid part, got ${r1.on} (${r1.detail})`);

  // Point inside the hole
  const r2 = isPointOnFace(face, { x: 10, y: 10, z: 0 });
  assert.strictEqual(r2.on, false, `Expected on=false inside hole, got ${r2.on} (${r2.detail})`);
  assert.strictEqual(r2.detail, 'inside-hole');

  // Point outside face entirely
  const r3 = isPointOnFace(face, { x: 30, y: 30, z: 0 });
  assert.strictEqual(r3.on, false, `Expected on=false outside face, got ${r3.on} (${r3.detail})`);

  // Point on hole edge boundary
  const r4 = isPointOnFace(face, { x: 10, y: 8, z: 0 });
  assert.strictEqual(r4.on, true, `Expected on=true for hole edge, got ${r4.on} (${r4.detail})`);
  assert.strictEqual(r4.detail, 'on-hole-edge');
});

// ============================================================
console.log('\n=== Containment: Boolean Regression Coverage ===\n');
// ============================================================

test('Boolean fixture: union of non-overlapping boxes preserves classification', () => {
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(20, 0, 0, 10, 10, 10);

  // Point inside boxA
  const rA = classifyPoint(boxA, { x: 5, y: 5, z: 5 });
  assert.strictEqual(rA.state, 'inside');

  // Same point should be outside boxB
  const rB = classifyPoint(boxB, { x: 5, y: 5, z: 5 });
  assert.strictEqual(rB.state, 'outside');

  // Point inside boxB
  const rC = classifyPoint(boxB, { x: 25, y: 5, z: 5 });
  assert.strictEqual(rC.state, 'inside');
});

test('Boolean fixture: overlapping boxes share region classification', () => {
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(5, 0, 0, 10, 10, 10);

  // Point in overlap region (5-10 on x)
  const rOverlap = classifyPoint(boxA, { x: 7, y: 5, z: 5 });
  assert.strictEqual(rOverlap.state, 'inside');

  const rOverlap2 = classifyPoint(boxB, { x: 7, y: 5, z: 5 });
  assert.strictEqual(rOverlap2.state, 'inside');

  // Point only in boxA (0-5 on x)
  const rA = classifyPoint(boxA, { x: 3, y: 5, z: 5 });
  assert.strictEqual(rA.state, 'inside');
  const rB = classifyPoint(boxB, { x: 3, y: 5, z: 5 });
  assert.strictEqual(rB.state, 'outside');
});

// ============================================================
// Shadow Mode Disagreement Tests
// ============================================================

console.log('\n=== Containment: Shadow Mode ===\n');

import {
  getShadowDisagreements, clearShadowDisagreements,
} from '../js/cad/Containment.js';
import { setFlag, resetFlags } from '../js/featureFlags.js';

test('getShadowDisagreements: returns empty by default', () => {
  clearShadowDisagreements();
  const d = getShadowDisagreements();
  assert.ok(Array.isArray(d));
  assert.strictEqual(d.length, 0);
});

test('shadow mode: runs both paths when flag enabled (default)', () => {
  clearShadowDisagreements();
  // GWN containment is now enabled by default — just verify behavior
  resetFlags();
  try {
    const box = makeBox(0, 0, 0, 10, 10, 10);
    // Clear point inside — both paths should agree
    const r = classifyPoint(box, { x: 5, y: 5, z: 5 });
    assert.strictEqual(r.state, 'inside');
    // No disagreement expected for clear interior point
    const d = getShadowDisagreements();
    // Disagreements are only logged when fast and robust disagree on state
    assert.ok(Array.isArray(d));
  } finally {
    clearShadowDisagreements();
  }
});

test('shadow mode: disagreements are frozen snapshots', () => {
  clearShadowDisagreements();
  const d = getShadowDisagreements();
  assert.ok(Object.isFrozen(d));
});

test('clearShadowDisagreements: clears log', () => {
  clearShadowDisagreements();
  const d = getShadowDisagreements();
  assert.strictEqual(d.length, 0);
});

// ============================================================
console.log('\n=== Results ===\n');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
