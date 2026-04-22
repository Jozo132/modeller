import './_watchdog.mjs';
// tests/test-boolean-nurbs.js — Tests for NURBS boolean support
//
// Validates:
// 1. Surface/surface intersection for NURBS surfaces
// 2. Mixed analytic and NURBS surface classification
// 3. Tolerance-focused numerical tests

import assert from 'assert';
import { NurbsCurve } from '../js/cad/NurbsCurve.js';
import { NurbsSurface } from '../js/cad/NurbsSurface.js';
import { surfaceSurfaceIntersect } from '../js/cad/SurfaceSurfaceIntersect.js';
import { curveSurfaceIntersect } from '../js/cad/CurveSurfaceIntersect.js';
import { SurfaceType, resetTopoIds } from '../js/cad/BRepTopology.js';
import { Tolerance } from '../js/cad/Tolerance.js';
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

// ============================================================
console.log('=== Surface/Surface Intersection Tests ===\n');
// ============================================================

test('Plane/plane intersection: perpendicular planes', () => {
  const planeXY = NurbsSurface.createPlane(
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 0, y: 10, z: 0 },
  );
  const planeXZ = NurbsSurface.createPlane(
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 0, y: 0, z: 10 },
  );

  const results = surfaceSurfaceIntersect(planeXY, SurfaceType.PLANE, planeXZ, SurfaceType.PLANE);
  assert.ok(results.length >= 1, 'Should find at least 1 intersection curve');
  assert.ok(results[0].curve, 'Result should have a curve');
});

test('Plane/plane intersection: parallel planes have no intersection', () => {
  const plane1 = NurbsSurface.createPlane(
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 0, y: 10, z: 0 },
  );
  const plane2 = NurbsSurface.createPlane(
    { x: 0, y: 0, z: 5 },
    { x: 10, y: 0, z: 0 },
    { x: 0, y: 10, z: 0 },
  );

  const results = surfaceSurfaceIntersect(plane1, SurfaceType.PLANE, plane2, SurfaceType.PLANE);
  assert.strictEqual(results.length, 0, 'Parallel planes should not intersect');
});

// ============================================================
console.log('\n=== Curve/Surface Intersection Tests ===\n');
// ============================================================

test('Line through plane: single intersection', () => {
  const line = NurbsCurve.createLine({ x: 5, y: 5, z: -10 }, { x: 5, y: 5, z: 10 });
  const plane = NurbsSurface.createPlane(
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 0, y: 10, z: 0 },
  );

  const results = curveSurfaceIntersect(line, plane);
  assert.ok(results.length >= 1, 'Should find intersection');
  assertApprox(results[0].point.z, 0, 0.5, 'Intersection Z should be near 0');
});

test('Line parallel to plane: no intersection', () => {
  const line = NurbsCurve.createLine({ x: 0, y: 0, z: 5 }, { x: 10, y: 0, z: 5 });
  const plane = NurbsSurface.createPlane(
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 0, y: 10, z: 0 },
  );

  const results = curveSurfaceIntersect(line, plane);
  assert.strictEqual(results.length, 0, 'Line parallel to plane should not intersect');
});

// ============================================================
console.log('\n=== Tolerance-Focused Tests ===\n');
// ============================================================

test('Nearly coincident planes: no false intersection', () => {
  const plane1 = NurbsSurface.createPlane(
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 0, y: 10, z: 0 },
  );
  const plane2 = NurbsSurface.createPlane(
    { x: 0, y: 0, z: 1e-8 },
    { x: 10, y: 0, z: 0 },
    { x: 0, y: 10, z: 0 },
  );

  // Nearly coincident (offset < tolerance) should detect as parallel
  const results = surfaceSurfaceIntersect(plane1, SurfaceType.PLANE, plane2, SurfaceType.PLANE);
  // These are effectively parallel; the analytic plane/plane check should catch this
  // Either no results or a coincident detection
  assert.ok(results.length <= 1, 'Nearly coincident planes should not produce spurious intersections');
});

test('Cylinder surface creation and evaluation', () => {
  const cyl = NurbsSurface.createCylinder(
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 1 },
    5, 10,
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
  );

  // Point on cylinder at u=0, v=0 should be at radius 5
  const p = cyl.evaluate(0, 0);
  const r = Math.sqrt(p.x * p.x + p.y * p.y);
  assertApprox(r, 5, 0.1, 'Point should be at radius 5');
});

test('Custom tolerance overrides', () => {
  const tol = new Tolerance({ intersection: 1e-3 });
  assert.strictEqual(tol.intersection, 1e-3);
  assert.ok(tol.pointCoincidence !== 1e-3, 'Other tolerances should use defaults');
});

// ============================================================
console.log('\n=== Invariant Validation Tests ===\n');
// ============================================================

import { validateBooleanResult } from '../js/cad/BooleanInvariantValidator.js';
import {
  TopoBody, TopoShell, TopoFace, TopoLoop, TopoCoEdge, TopoEdge, TopoVertex,
  buildTopoBody,
} from '../js/cad/BRepTopology.js';

function makeBox(x, y, z, w, h, d) {
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

test('validateBooleanResult: null body produces body-present diagnostic', () => {
  const result = validateBooleanResult(null, { operation: 'union' });
  assert.strictEqual(result.isValid, false);
  assert.ok(result.diagnostics.some(d => d.invariant === 'body-present'));
});

test('validateBooleanResult: empty body produces body-has-shells diagnostic', () => {
  const result = validateBooleanResult(new TopoBody(), { operation: 'union' });
  assert.strictEqual(result.isValid, false);
  assert.ok(result.diagnostics.some(d => d.invariant === 'body-has-shells'));
});

test('validateBooleanResult: valid box body', () => {
  resetTopoIds();
  const box = makeBox(0, 0, 0, 10, 10, 10);
  const result = validateBooleanResult(box, { operation: 'union' });
  // A valid box should have some topology counts
  assert.ok(result.shellCount >= 1, 'Should have at least 1 shell');
  assert.ok(result.faceCount >= 6, 'Should have at least 6 faces');
  assert.ok(result.edgeCount > 0, 'Should have edges');
  assert.ok(result.vertexCount > 0, 'Should have vertices');
});

test('validateBooleanResult: toJSON produces valid JSON', () => {
  resetTopoIds();
  const box = makeBox(0, 0, 0, 10, 10, 10);
  const result = validateBooleanResult(box, { operation: 'intersect' });
  const json = result.toJSON();
  assert.strictEqual(json.operation, 'intersect');
  assert.ok(typeof json.valid === 'boolean');
  assert.ok(typeof json.diagnosticCount === 'number');
  assert.ok(Array.isArray(json.diagnostics));
  // Round-trip through JSON.stringify/parse
  const roundTrip = JSON.parse(JSON.stringify(json));
  assert.strictEqual(roundTrip.operation, 'intersect');
});

// ============================================================
console.log('\n=== Results ===\n');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
