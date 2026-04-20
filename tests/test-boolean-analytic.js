// tests/test-boolean-analytic.js — Tests for the exact boolean kernel on analytic surfaces
//
// Validates:
// 1. BooleanKernel dispatch
// 2. Intersection module (curve/curve, surface/surface)
// 3. FaceSplitter classification
// 4. ShellBuilder stitching
// 5. Analytic boolean operations (plane/plane, plane/cylinder)

import assert from 'assert';
import { NurbsCurve } from '../js/cad/NurbsCurve.js';
import { NurbsSurface } from '../js/cad/NurbsSurface.js';
import { curveCurveIntersect } from '../js/cad/CurveCurveIntersect.js';
import { surfaceSurfaceIntersect } from '../js/cad/SurfaceSurfaceIntersect.js';
import { intersectCurves, intersectSurfaces } from '../js/cad/Intersections.js';
import { classifyPointOnFace } from '../js/cad/FaceSplitter.js';
import { stitchFaces, buildBody } from '../js/cad/ShellBuilder.js';
import { exactBooleanOp, hasExactTopology } from '../js/cad/BooleanKernel.js';
import {
  TopoBody, TopoShell, TopoFace, TopoLoop, TopoCoEdge, TopoEdge, TopoVertex,
  SurfaceType, buildTopoBody, resetTopoIds,
} from '../js/cad/BRepTopology.js';
import { Tolerance, DEFAULT_TOLERANCE } from '../js/cad/Tolerance.js';
import { formatTimingSuffix, startTiming } from './test-timing.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  const startedAt = startTiming();
  try {
    fn();
    console.log(`  ✓ ${name}${formatTimingSuffix(startedAt)}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}${formatTimingSuffix(startedAt)}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

function assertApprox(actual, expected, tolerance, msg) {
  assert.ok(Math.abs(actual - expected) < tolerance,
    `${msg}: expected ~${expected}, got ${actual}`);
}

function makeBox(x, y, z, w, h, d) {
  const c = [
    { x: x, y: y, z: z },
    { x: x + w, y: y, z: z },
    { x: x + w, y: y + h, z: z },
    { x: x, y: y + h, z: z },
    { x: x, y: y, z: z + d },
    { x: x + w, y: y, z: z + d },
    { x: x + w, y: y + h, z: z + d },
    { x: x, y: y + h, z: z + d },
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

// ============================================================
console.log('=== Curve/Curve Intersection Tests ===\n');
// ============================================================

test('Two intersecting lines in 3D', () => {
  const lineA = NurbsCurve.createLine({ x: -10, y: 0, z: 0 }, { x: 10, y: 0, z: 0 });
  const lineB = NurbsCurve.createLine({ x: 0, y: -10, z: 0 }, { x: 0, y: 10, z: 0 });
  const results = curveCurveIntersect(lineA, lineB);
  assert.ok(results.length >= 1, 'Should find at least 1 intersection');
  assertApprox(results[0].point.x, 0, 0.1, 'Intersection X');
  assertApprox(results[0].point.y, 0, 0.1, 'Intersection Y');
});

test('Two parallel lines: no intersection', () => {
  const lineA = NurbsCurve.createLine({ x: -10, y: 0, z: 0 }, { x: 10, y: 0, z: 0 });
  const lineB = NurbsCurve.createLine({ x: -10, y: 5, z: 0 }, { x: 10, y: 5, z: 0 });
  const results = curveCurveIntersect(lineA, lineB);
  assert.strictEqual(results.length, 0, 'Should find no intersections');
});

test('Line and arc intersection', () => {
  const line = NurbsCurve.createLine({ x: -10, y: 5, z: 0 }, { x: 10, y: 5, z: 0 });
  const arc = NurbsCurve.createArc(
    { x: 0, y: 0, z: 0 }, 10,
    { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 },
    0, Math.PI,
  );
  const results = curveCurveIntersect(line, arc);
  // Line y=5 intersects circle r=10 at x=±√(100-25)=±√75≈±8.66
  assert.ok(results.length >= 1, 'Should find at least 1 intersection');
});

// ============================================================
console.log('\n=== Intersection Dispatch Tests ===\n');
// ============================================================

test('intersectCurves dispatches correctly', () => {
  const lineA = NurbsCurve.createLine({ x: -10, y: 0, z: 0 }, { x: 10, y: 0, z: 0 });
  const lineB = NurbsCurve.createLine({ x: 0, y: -10, z: 0 }, { x: 0, y: 10, z: 0 });
  const results = intersectCurves(lineA, lineB);
  assert.ok(results.length >= 1, 'Should find intersections via dispatch');
});

// ============================================================
console.log('\n=== Face Classification Tests ===\n');
// ============================================================

test('classifyPointOnFace: point inside triangle', () => {
  resetTopoIds();
  const v1 = new TopoVertex({ x: 0, y: 0, z: 0 });
  const v2 = new TopoVertex({ x: 10, y: 0, z: 0 });
  const v3 = new TopoVertex({ x: 5, y: 10, z: 0 });
  const e1 = new TopoEdge(v1, v2);
  const e2 = new TopoEdge(v2, v3);
  const e3 = new TopoEdge(v3, v1);
  const loop = new TopoLoop([
    new TopoCoEdge(e1, true),
    new TopoCoEdge(e2, true),
    new TopoCoEdge(e3, true),
  ]);
  const face = new TopoFace(null, SurfaceType.PLANE);
  face.setOuterLoop(loop);

  const result = classifyPointOnFace({ x: 5, y: 3, z: 0 }, face);
  assert.strictEqual(result, 'inside', 'Centroid-ish point should be inside');
});

test('classifyPointOnFace: point outside triangle', () => {
  resetTopoIds();
  const v1 = new TopoVertex({ x: 0, y: 0, z: 0 });
  const v2 = new TopoVertex({ x: 10, y: 0, z: 0 });
  const v3 = new TopoVertex({ x: 5, y: 10, z: 0 });
  const e1 = new TopoEdge(v1, v2);
  const e2 = new TopoEdge(v2, v3);
  const e3 = new TopoEdge(v3, v1);
  const loop = new TopoLoop([
    new TopoCoEdge(e1, true),
    new TopoCoEdge(e2, true),
    new TopoCoEdge(e3, true),
  ]);
  const face = new TopoFace(null, SurfaceType.PLANE);
  face.setOuterLoop(loop);

  const result = classifyPointOnFace({ x: 20, y: 20, z: 0 }, face);
  assert.strictEqual(result, 'outside', 'Far point should be outside');
});

// ============================================================
console.log('\n=== ShellBuilder Tests ===\n');
// ============================================================

test('stitchFaces: single face produces one shell', () => {
  resetTopoIds();
  const v1 = new TopoVertex({ x: 0, y: 0, z: 0 });
  const v2 = new TopoVertex({ x: 10, y: 0, z: 0 });
  const v3 = new TopoVertex({ x: 5, y: 10, z: 0 });
  const e1 = new TopoEdge(v1, v2);
  const e2 = new TopoEdge(v2, v3);
  const e3 = new TopoEdge(v3, v1);
  const loop = new TopoLoop([
    new TopoCoEdge(e1, true),
    new TopoCoEdge(e2, true),
    new TopoCoEdge(e3, true),
  ]);
  const face = new TopoFace(null, SurfaceType.PLANE);
  face.setOuterLoop(loop);

  const shells = stitchFaces([face]);
  assert.strictEqual(shells.length, 1, 'Should produce 1 shell');
  assert.strictEqual(shells[0].faces.length, 1, 'Shell should have 1 face');
});

test('buildBody: builds body from face list', () => {
  resetTopoIds();
  const faceDescs = [
    { surfaceType: SurfaceType.PLANE,
      vertices: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 5, y: 10, z: 0 }],
      surface: null, edgeCurves: null, shared: null },
  ];
  const body = buildTopoBody(faceDescs);
  assert.ok(body.shells.length >= 1);
  assert.ok(body.faces().length >= 1);
});

// ============================================================
console.log('\n=== Boolean Kernel Tests ===\n');
// ============================================================

test('hasExactTopology: true for valid body', () => {
  resetTopoIds();
  const body = makeBox(0, 0, 0, 10, 10, 10);
  assert.ok(hasExactTopology(body), 'Box should have exact topology');
});

test('hasExactTopology: false for null', () => {
  assert.ok(!hasExactTopology(null));
});

test('hasExactTopology: false for empty body', () => {
  assert.ok(!hasExactTopology(new TopoBody()));
});

test('exactBooleanOp: union of two non-overlapping boxes', () => {
  resetTopoIds();
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(20, 0, 0, 10, 10, 10);

  const result = exactBooleanOp(boxA, boxB, 'union');
  assert.ok(result.body, 'Result should have a body');
  assert.ok(result.mesh, 'Result should have a mesh');
  // Non-overlapping boxes: both should be kept entirely
  assert.ok(result.body.faces().length >= 12, 'Union should have at least 12 faces (two boxes)');
});

test('exactBooleanOp: returns mesh data', () => {
  resetTopoIds();
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(20, 0, 0, 10, 10, 10);

  const result = exactBooleanOp(boxA, boxB, 'union');
  assert.ok(result.mesh.faces.length > 0, 'Mesh should have faces');
});

// ============================================================
console.log('\n=== Invariant Validation Tests ===\n');
// ============================================================

test('exactBooleanOp: union diagnostics include invariantValidation', () => {
  resetTopoIds();
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(20, 0, 0, 10, 10, 10);

  const result = exactBooleanOp(boxA, boxB, 'union');
  assert.ok(result.diagnostics, 'Result should have diagnostics');
  assert.ok(result.diagnostics.invariantValidation, 'Diagnostics should include invariantValidation');
  assert.strictEqual(result.diagnostics.invariantValidation.operation, 'union',
    'invariantValidation should record operation');
});

test('exactBooleanOp: subtract diagnostics include invariantValidation', () => {
  resetTopoIds();
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(20, 0, 0, 10, 10, 10);

  const result = exactBooleanOp(boxA, boxB, 'subtract');
  assert.ok(result.diagnostics.invariantValidation, 'Diagnostics should include invariantValidation');
  assert.strictEqual(result.diagnostics.invariantValidation.operation, 'subtract',
    'invariantValidation should record operation');
});

test('exactBooleanOp: intersect diagnostics include invariantValidation', () => {
  resetTopoIds();
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(20, 0, 0, 10, 10, 10);

  const result = exactBooleanOp(boxA, boxB, 'intersect');
  assert.ok(result.diagnostics.invariantValidation, 'Diagnostics should include invariantValidation');
});

test('exactBooleanOp: invariantValidation has topology counts', () => {
  resetTopoIds();
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(20, 0, 0, 10, 10, 10);

  const result = exactBooleanOp(boxA, boxB, 'union');
  const iv = result.diagnostics.invariantValidation;
  assert.ok(iv.counts, 'invariantValidation should have counts');
  assert.ok(typeof iv.counts.shells === 'number', 'counts.shells should be a number');
  assert.ok(typeof iv.counts.faces === 'number', 'counts.faces should be a number');
  assert.ok(typeof iv.counts.edges === 'number', 'counts.edges should be a number');
  assert.ok(typeof iv.counts.vertices === 'number', 'counts.vertices should be a number');
});

test('exactBooleanOp: resultGrade is exact for clean operands', () => {
  resetTopoIds();
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(20, 0, 0, 10, 10, 10);

  const result = exactBooleanOp(boxA, boxB, 'union');
  assert.strictEqual(result.resultGrade, 'exact', 'Clean union should be exact');
  assert.strictEqual(result._isFallback, false, 'Clean union should not be fallback');
});

test('exactBooleanOp: deterministic results for identical operands', () => {
  resetTopoIds();
  const boxA1 = makeBox(0, 0, 0, 10, 10, 10);
  const boxB1 = makeBox(20, 0, 0, 10, 10, 10);
  const r1 = exactBooleanOp(boxA1, boxB1, 'union');

  resetTopoIds();
  const boxA2 = makeBox(0, 0, 0, 10, 10, 10);
  const boxB2 = makeBox(20, 0, 0, 10, 10, 10);
  const r2 = exactBooleanOp(boxA2, boxB2, 'union');

  assert.strictEqual(r1.resultGrade, r2.resultGrade, 'Repeated runs should produce same grade');
  assert.strictEqual(r1.body.faces().length, r2.body.faces().length, 'Repeated runs should produce same face count');
  assert.strictEqual(r1.mesh.faces.length, r2.mesh.faces.length, 'Repeated runs should produce same mesh face count');
  assert.strictEqual(
    r1.diagnostics.invariantValidation.diagnosticCount,
    r2.diagnostics.invariantValidation.diagnosticCount,
    'Repeated runs should produce same diagnostic count',
  );
});

// ============================================================
console.log('\n=== Results ===\n');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
