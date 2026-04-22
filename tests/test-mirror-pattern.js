import './_watchdog.mjs';
// tests/test-mirror-pattern.js — Unit tests for Mirror, LinearPattern, RadialPattern constraints
import { Scene } from '../js/cad/Scene.js';
import { Mirror, LinearPattern, RadialPattern, Midpoint } from '../js/cad/Constraint.js';
import { solve } from '../js/cad/Solver.js';

let pass = 0, fail = 0;

function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

function approx(a, b, tol = 1e-4) {
  return Math.abs(a - b) < tol;
}

// ---------------------------------------------------------------------------
// Mirror constraint tests
// ---------------------------------------------------------------------------
console.log('\n=== Mirror Constraint ===');

{
  const scene = new Scene();
  const ptA = scene.addPoint(3, 4);
  // Mirror line: Y axis (segment along Y)
  const seg = scene.addSegment(0, -10, 0, 10);
  const ptB = scene.addPoint(0, 0); // will be moved by constraint

  const c = new Mirror(ptA, ptB, seg);
  scene.addConstraint(c);

  assert(approx(ptB.x, -3), `Mirror across Y axis: x = ${ptB.x} ≈ -3`);
  assert(approx(ptB.y, 4), `Mirror across Y axis: y = ${ptB.y} ≈ 4`);
}

{
  const scene = new Scene();
  const ptA = scene.addPoint(2, 5);
  // Mirror line: X axis (segment along X)
  const seg = scene.addSegment(-10, 0, 10, 0);
  const ptB = scene.addPoint(0, 0);

  scene.addConstraint(new Mirror(ptA, ptB, seg));

  assert(approx(ptB.x, 2), `Mirror across X axis: x = ${ptB.x} ≈ 2`);
  assert(approx(ptB.y, -5), `Mirror across X axis: y = ${ptB.y} ≈ -5`);
}

{
  const scene = new Scene();
  const ptA = scene.addPoint(0, 5);
  // Mirror line: diagonal y=x (from origin to (10,10))
  const seg = scene.addSegment(0, 0, 10, 10);
  const ptB = scene.addPoint(0, 0);

  scene.addConstraint(new Mirror(ptA, ptB, seg));

  assert(approx(ptB.x, 5), `Mirror across y=x: x = ${ptB.x} ≈ 5`);
  assert(approx(ptB.y, 0), `Mirror across y=x: y = ${ptB.y} ≈ 0`);
}

// ---------------------------------------------------------------------------
// Mirror serialization/deserialization
// ---------------------------------------------------------------------------
console.log('\n=== Mirror Serialization ===');

{
  const scene = new Scene();
  const ptA = scene.addPoint(3, 4);
  const seg = scene.addSegment(0, -5, 0, 5);
  const ptB = scene.addPoint(-3, 4);
  scene.addConstraint(new Mirror(ptA, ptB, seg));

  const data = scene.serialize();
  const scene2 = Scene.deserialize(data);

  assert(scene2.constraints.length === 1, `Deserialized 1 constraint (got ${scene2.constraints.length})`);
  assert(scene2.constraints[0].type === 'mirror', `Constraint type is mirror`);

  // Verify the mirrored point is correct after deserialization
  const c = scene2.constraints[0];
  const err = c.error();
  assert(err < 1e-4, `Mirror constraint satisfied after deserialization (error: ${err})`);
}

// ---------------------------------------------------------------------------
// LinearPattern constraint tests
// ---------------------------------------------------------------------------
console.log('\n=== LinearPattern Constraint ===');

{
  const scene = new Scene();
  const srcPt = scene.addPoint(0, 0);
  const seg = scene.addSegment(0, 0, 10, 0); // direction: +X

  const dst1 = scene.addPoint(0, 0);
  const dst2 = scene.addPoint(0, 0);

  scene.addConstraint(new LinearPattern([{ src: srcPt, dst: dst1 }], seg, 1, 5));
  scene.addConstraint(new LinearPattern([{ src: srcPt, dst: dst2 }], seg, 2, 5));

  assert(approx(dst1.x, 5), `LinearPattern copy 1: x = ${dst1.x} ≈ 5`);
  assert(approx(dst1.y, 0), `LinearPattern copy 1: y = ${dst1.y} ≈ 0`);
  assert(approx(dst2.x, 10), `LinearPattern copy 2: x = ${dst2.x} ≈ 10`);
  assert(approx(dst2.y, 0), `LinearPattern copy 2: y = ${dst2.y} ≈ 0`);
}

{
  const scene = new Scene();
  const srcPt = scene.addPoint(1, 1);
  // Direction: 45 degrees
  const seg = scene.addSegment(0, 0, 10, 10);
  const dst = scene.addPoint(0, 0);

  scene.addConstraint(new LinearPattern([{ src: srcPt, dst }], seg, 1, 5));

  const dx = 10 / Math.hypot(10, 10);
  const expected_x = 1 + dx * 5;
  const expected_y = 1 + dx * 5;
  assert(approx(dst.x, expected_x), `LinearPattern 45°: x = ${dst.x.toFixed(4)} ≈ ${expected_x.toFixed(4)}`);
  assert(approx(dst.y, expected_y), `LinearPattern 45°: y = ${dst.y.toFixed(4)} ≈ ${expected_y.toFixed(4)}`);
}

// LinearPattern serialization
console.log('\n=== LinearPattern Serialization ===');

{
  const scene = new Scene();
  const srcPt = scene.addPoint(0, 0);
  const seg = scene.addSegment(0, 0, 10, 0);
  const dst = scene.addPoint(5, 0);

  scene.addConstraint(new LinearPattern([{ src: srcPt, dst }], seg, 1, 5));

  const data = scene.serialize();
  const scene2 = Scene.deserialize(data);

  assert(scene2.constraints.length === 1, `Deserialized 1 LP constraint (got ${scene2.constraints.length})`);
  assert(scene2.constraints[0].type === 'linear_pattern', `Constraint type is linear_pattern`);
  assert(scene2.constraints[0].count === 1, `LP count is 1`);
  assert(scene2.constraints[0].spacing === 5, `LP spacing is 5`);

  const err = scene2.constraints[0].error();
  assert(err < 1e-4, `LP constraint satisfied after deserialization (error: ${err})`);
}

// ---------------------------------------------------------------------------
// RadialPattern constraint tests
// ---------------------------------------------------------------------------
console.log('\n=== RadialPattern Constraint ===');

{
  const scene = new Scene();
  const center = scene.addPoint(0, 0);
  const srcPt = scene.addPoint(5, 0);
  const dst = scene.addPoint(0, 0);

  // 90 degree rotation
  const angle = Math.PI / 2;
  scene.addConstraint(new RadialPattern([{ src: srcPt, dst }], center, 1, angle));

  assert(approx(dst.x, 0, 1e-3), `RadialPattern 90°: x = ${dst.x.toFixed(4)} ≈ 0`);
  assert(approx(dst.y, 5, 1e-3), `RadialPattern 90°: y = ${dst.y.toFixed(4)} ≈ 5`);
}

{
  const scene = new Scene();
  const center = scene.addPoint(0, 0);
  const srcPt = scene.addPoint(5, 0);
  const dst1 = scene.addPoint(0, 0);
  const dst2 = scene.addPoint(0, 0);
  const dst3 = scene.addPoint(0, 0);

  // 4 copies at 90° intervals (full circle)
  const angle = Math.PI / 2;
  scene.addConstraint(new RadialPattern([{ src: srcPt, dst: dst1 }], center, 1, angle));
  scene.addConstraint(new RadialPattern([{ src: srcPt, dst: dst2 }], center, 2, angle));
  scene.addConstraint(new RadialPattern([{ src: srcPt, dst: dst3 }], center, 3, angle));

  assert(approx(dst1.x, 0, 1e-3) && approx(dst1.y, 5, 1e-3), `RadialPattern 4-way: copy 1 at (0,5)`);
  assert(approx(dst2.x, -5, 1e-3) && approx(dst2.y, 0, 1e-3), `RadialPattern 4-way: copy 2 at (-5,0)`);
  assert(approx(dst3.x, 0, 1e-3) && approx(dst3.y, -5, 1e-3), `RadialPattern 4-way: copy 3 at (0,-5)`);
}

// RadialPattern serialization
console.log('\n=== RadialPattern Serialization ===');

{
  const scene = new Scene();
  const center = scene.addPoint(0, 0);
  const srcPt = scene.addPoint(5, 0);
  const dst = scene.addPoint(0, 5);

  const angle = Math.PI / 2;
  scene.addConstraint(new RadialPattern([{ src: srcPt, dst }], center, 1, angle));

  const data = scene.serialize();
  const scene2 = Scene.deserialize(data);

  assert(scene2.constraints.length === 1, `Deserialized 1 RP constraint (got ${scene2.constraints.length})`);
  assert(scene2.constraints[0].type === 'radial_pattern', `Constraint type is radial_pattern`);
  assert(scene2.constraints[0].count === 1, `RP count is 1`);
  assert(approx(scene2.constraints[0].angle, Math.PI / 2), `RP angle is π/2`);

  const err = scene2.constraints[0].error();
  assert(err < 1e-3, `RP constraint satisfied after deserialization (error: ${err})`);
}

// ---------------------------------------------------------------------------
// Midpoint constraint (already exists, just verify)
// ---------------------------------------------------------------------------
console.log('\n=== Midpoint Constraint (existing) ===');

{
  const scene = new Scene();
  const seg = scene.addSegment(0, 0, 10, 0);
  const pt = scene.addPoint(0, 0);

  scene.addConstraint(new Midpoint(pt, seg));

  assert(approx(pt.x, 5), `Midpoint: x = ${pt.x} ≈ 5`);
  assert(approx(pt.y, 0), `Midpoint: y = ${pt.y} ≈ 0`);
}

// ---------------------------------------------------------------------------
// Edge case: Mirror constraint with point on the mirror line
// ---------------------------------------------------------------------------
console.log('\n=== Mirror Edge Cases ===');

{
  const scene = new Scene();
  const ptA = scene.addPoint(0, 5); // on the Y axis (mirror line)
  const seg = scene.addSegment(0, -10, 0, 10);
  const ptB = scene.addPoint(0, 0);

  scene.addConstraint(new Mirror(ptA, ptB, seg));

  // Point on mirror line should mirror to itself
  assert(approx(ptB.x, 0), `Mirror of point on line: x = ${ptB.x} ≈ 0`);
  assert(approx(ptB.y, 5), `Mirror of point on line: y = ${ptB.y} ≈ 5`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n--- Mirror/Pattern tests: ${pass} passed, ${fail} failed ---`);
if (fail > 0) process.exit(1);
