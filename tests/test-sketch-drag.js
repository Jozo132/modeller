import './_watchdog.mjs';
// tests/test-sketch-drag.js — Tests for sketch vertex drag correctness
// Validates: union degenerate cleanup, snap candidate freshness, neighbor preservation

import { Scene } from '../js/cad/Scene.js';
import { union } from '../js/cad/Operations.js';
import { Horizontal, Length } from '../js/cad/Constraint.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL: ${msg}`); }
}

function assertApprox(a, b, msg, tol = 1e-4) {
  assert(Math.abs(a - b) < tol, `${msg}: expected ${b}, got ${a}`);
}

// ---- Test 1: union removes degenerate segments ----
{
  console.log('Test 1: union() cleans up degenerate segments');
  const scene = new Scene();
  // Triangle: A(0,0) - B(10,0) - C(5,10)
  const segAB = scene.addSegment(0, 0, 10, 0);
  const segBC = scene.addSegment(10, 0, 5, 10);
  const segCA = scene.addSegment(5, 10, 0, 0);
  const A = segAB.p1;
  const B = segAB.p2;
  const C = segBC.p2;

  assert(scene.points.length === 3, `Initial 3 points, got ${scene.points.length}`);
  assert(scene.segments.length === 3, `Initial 3 segments, got ${scene.segments.length}`);

  // Force union of direct neighbors (B into A) — creates degenerate segAB
  union(scene, B, A);

  // segAB had (A, B) → after rewire becomes (B, B) → should be removed
  assert(scene.segments.length === 2, `After union: 2 segments (degenerate removed), got ${scene.segments.length}`);
  assert(!scene.segments.includes(segAB), 'Degenerate segAB removed from scene');
  assert(scene.points.length === 2, `After union: 2 points, got ${scene.points.length}`);
  assert(scene.points.includes(B), 'B still in scene');
  assert(scene.points.includes(C), 'C still in scene');
  assert(!scene.points.includes(A), 'A removed (merged into B)');
}

// ---- Test 2: union removes constraints on degenerate segments ----
{
  console.log('Test 2: union() cleans constraints referencing degenerate segments');
  const scene = new Scene();
  const seg = scene.addSegment(0, 0, 10, 0);
  const A = seg.p1;
  const B = seg.p2;

  // Add a Horizontal constraint on the segment
  const hc = new Horizontal(seg);
  scene.constraints.push(hc);
  assert(scene.constraints.length === 1, 'Has horizontal constraint');

  // Merge B into A → seg becomes (A, A) → degenerate → removed
  union(scene, A, B);

  assert(scene.segments.length === 0, `Degenerate segment removed, got ${scene.segments.length}`);
  assert(scene.constraints.length === 0, `Constraint on degenerate removed, got ${scene.constraints.length}`);
  assert(scene.points.length === 1, `One point remains, got ${scene.points.length}`);
}

// ---- Test 3: union preserves non-degenerate segments and their neighbors ----
{
  console.log('Test 3: union() preserves neighbor vertices');
  const scene = new Scene();
  // A(0,0) - B(10,0) - C(20,0) and D(15,5) standalone
  const seg1 = scene.addSegment(0, 0, 10, 0);
  const seg2 = scene.addSegment(10, 0, 20, 0);
  const D = scene.addPoint(15, 5);

  const A = seg1.p1;
  const B = seg1.p2;
  const C = seg2.p2;

  // Simulate: drag B near D, merge D into B
  B.x = 15; B.y = 5;
  union(scene, B, D);

  assert(scene.points.length === 3, `3 points remain, got ${scene.points.length}`);
  assert(scene.points.includes(A), 'A preserved');
  assert(scene.points.includes(B), 'B preserved');
  assert(scene.points.includes(C), 'C preserved');
  assert(!scene.points.includes(D), 'D removed (merged)');
  assert(scene.segments.length === 2, `2 segments remain, got ${scene.segments.length}`);
  assertApprox(A.x, 0, 'A.x unchanged');
  assertApprox(A.y, 0, 'A.y unchanged');
  assertApprox(C.x, 20, 'C.x unchanged');
  assertApprox(C.y, 0, 'C.y unchanged');
}

// ---- Test 4: Simple drag without snap preserves all neighbors ----
{
  console.log('Test 4: Simple vertex drag without snap preserves neighbors');
  const scene = new Scene();
  // Rectangle: A(0,0) - B(10,0) - C(10,5) - D(0,5)
  scene.addSegment(0, 0, 10, 0);
  scene.addSegment(10, 0, 10, 5);
  scene.addSegment(10, 5, 0, 5);
  scene.addSegment(0, 5, 0, 0);

  assert(scene.points.length === 4, `4 points, got ${scene.points.length}`);
  assert(scene.segments.length === 4, `4 segments, got ${scene.segments.length}`);

  // Pick B = second point
  const B = scene.points[1];
  const others = scene.points.filter(p => p !== B);
  const originalPositions = others.map(p => ({ x: p.x, y: p.y }));

  // Simulate drag B to (12, 3)
  B.x = 12;
  B.y = 3;
  scene.solve();

  // All 4 points should still exist
  assert(scene.points.length === 4, `Still 4 points, got ${scene.points.length}`);
  assert(scene.segments.length === 4, `Still 4 segments, got ${scene.segments.length}`);

  // Simulate mouseUp: solve again
  scene.solve();

  assert(scene.points.length === 4, `After release: 4 points, got ${scene.points.length}`);
  assert(scene.segments.length === 4, `After release: 4 segments, got ${scene.segments.length}`);

  // Neighbors (no constraints) should NOT have moved
  for (let i = 0; i < others.length; i++) {
    assertApprox(others[i].x, originalPositions[i].x, `Neighbor ${i} x unchanged`);
    assertApprox(others[i].y, originalPositions[i].y, `Neighbor ${i} y unchanged`);
  }
}

// ---- Test 5: Drag with constraints preserves all points ----
{
  console.log('Test 5: Drag with constraints preserves all points');
  const scene = new Scene();
  const seg = scene.addSegment(0, 0, 10, 0);
  const A = seg.p1;
  const B = seg.p2;

  // Add length constraint
  const lc = new Length(seg, 10);
  scene.addConstraint(lc);

  // Drag B to (15, 0)
  B.x = 15; B.y = 0;
  scene.solve();

  assert(scene.points.length === 2, `2 points, got ${scene.points.length}`);
  assert(scene.segments.length === 1, `1 segment, got ${scene.segments.length}`);
  assertApprox(seg.length, 10, 'Length constraint satisfied');

  // Release: solve again
  scene.solve();

  assert(scene.points.length === 2, `After release: 2 points, got ${scene.points.length}`);
  assertApprox(seg.length, 10, 'Length still satisfied after release');
}

// ---- Test 6: Multiple degenerate segments from complex union ----
{
  console.log('Test 6: Complex union with multiple potential degenerates');
  const scene = new Scene();
  // Square: A-B, B-C, C-D, D-A
  scene.addSegment(0, 0, 10, 0);
  scene.addSegment(10, 0, 10, 10);
  scene.addSegment(10, 10, 0, 10);
  scene.addSegment(0, 10, 0, 0);

  const A = scene.points[0];
  const B = scene.points[1];
  const C = scene.points[2];
  const D = scene.points[3];

  // Merge B with A (neighbors via segment AB) — creates degenerate
  union(scene, B, A);

  // AB was (A,B) → (B,B) → degenerate → removed
  // DA was (D,A) → (D,B) → not degenerate
  assert(scene.segments.length === 3, `3 segments after union (1 degenerate removed), got ${scene.segments.length}`);
  assert(scene.points.length === 3, `3 points, got ${scene.points.length}`);
  assert(scene.points.includes(B), 'B exists');
  assert(scene.points.includes(C), 'C exists');
  assert(scene.points.includes(D), 'D exists');
}

// ---- Summary ----
console.log(`\nSketch Drag Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
