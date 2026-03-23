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
console.log('\n=== Results ===\n');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
