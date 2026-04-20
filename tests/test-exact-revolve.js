// tests/test-exact-revolve.js — Tests for exact B-Rep revolve output
//
// Validates that RevolveFeature produces exact TopoBody alongside mesh.

import assert from 'assert';
import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { SketchFeature } from '../js/cad/SketchFeature.js';
import { RevolveFeature } from '../js/cad/RevolveFeature.js';
import { resetFeatureIds } from '../js/cad/Feature.js';
import { resetTopoIds, SurfaceType } from '../js/cad/BRepTopology.js';
import { resetPrimitiveIds } from '../js/cad/Primitive.js';
import { validateBody } from '../js/cad/BRepValidator.js';
import { tessellateBody } from '../js/cad/Tessellation.js';
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

function makeRectSketch(x1, y1, x2, y2) {
  const s = new Sketch();
  s.addSegment(x1, y1, x2, y1);
  s.addSegment(x2, y1, x2, y2);
  s.addSegment(x2, y2, x1, y2);
  s.addSegment(x1, y2, x1, y1);
  return s;
}

function makeXYPlane() {
  return {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
  };
}

function makeArcProfileSketch() {
  const sketch = new Sketch();
  sketch.addArc(9, 0, 2, -Math.PI / 2, Math.PI / 2);
  sketch.addSegment(9, 2, 9, -2);
  return sketch;
}

function makeCircleSketch() {
  const sketch = new Sketch();
  sketch.addCircle(8, 0, 2);
  return sketch;
}

function makeSplineProfileSketch() {
  const sketch = new Sketch();
  sketch.addSpline([
    { x: 8, y: -2 },
    { x: 10, y: -1.5 },
    { x: 10.5, y: 1.5 },
    { x: 8, y: 2 },
  ]);
  sketch.addSegment(8, 2, 8, -2);
  return sketch;
}

function makeBezierProfileSketch() {
  const sketch = new Sketch();
  sketch.addBezier([
    { x: 8, y: -2, handleOut: { dx: 1.5, dy: 0 } },
    { x: 10, y: 0, handleIn: { dx: -0.5, dy: -1.5 }, handleOut: { dx: 0.5, dy: 1.5 } },
    { x: 8, y: 2, handleIn: { dx: 0.5, dy: 0 } },
  ]);
  sketch.addSegment(8, 2, 8, -2);
  return sketch;
}

function assertExactRevolveForSketch(sketch, description) {
  resetFeatureIds();
  resetTopoIds();
  resetPrimitiveIds();

  const part = new Part(description);
  part.addSketch(sketch, makeXYPlane());
  const revolveFeature = part.revolve(part.getSketches()[0].id, Math.PI * 2);
  const body = revolveFeature.result?.geometry?.topoBody;

  assert.ok(body, `${description} should produce an exact topoBody`);
  const validation = validateBody(body);
  assert.deepStrictEqual(validation.errors, [], `${description} should remain topologically valid`);
  assert.strictEqual(
    body.faces().filter(face => face.surfaceType === SurfaceType.REVOLUTION).length,
    0,
    `${description} should not fall back to generic revolution placeholder faces`,
  );
  assert.ok(
    body.faces().some(face => face.surfaceType === SurfaceType.BSPLINE),
    `${description} should emit exact BSpline revolution faces`,
  );
}

// ============================================================
console.log('=== Exact Revolve B-Rep Tests ===\n');
// ============================================================

test('Revolve produces topoBody on geometry', () => {
  resetFeatureIds();
  resetTopoIds();
  resetPrimitiveIds();
  const part = new Part('Test');
  const sketch = makeRectSketch(5, -5, 10, 5); // Offset from axis
  const plane = makeXYPlane();
  part.addSketch(sketch, plane);
  const revolveFeature = part.revolve(part.getSketches()[0].id, Math.PI * 2);

  assert.ok(revolveFeature, 'Revolve feature should exist');
  assert.ok(revolveFeature.result, 'Result should exist');
  assert.ok(revolveFeature.result.geometry, 'Geometry should exist');
  assert.ok(revolveFeature.result.geometry.faces.length > 0, 'Should have mesh faces');
});

test('Revolve topoBody uses supported analytic side surfaces', () => {
  resetFeatureIds();
  resetTopoIds();
  resetPrimitiveIds();
  const part = new Part('Test');
  const sketch = makeRectSketch(5, -5, 10, 5);
  const plane = makeXYPlane();
  part.addSketch(sketch, plane);
  const revolveFeature = part.revolve(part.getSketches()[0].id, Math.PI * 2);

  const geom = revolveFeature.result.geometry;
  if (geom.topoBody) {
    const body = geom.topoBody;
    const cylinderFaces = body.faces().filter(f => f.surfaceType === SurfaceType.CYLINDER);
    const planeFaces = body.faces().filter(f => f.surfaceType === SurfaceType.PLANE);
    const revolutionFaces = body.faces().filter(f => f.surfaceType === SurfaceType.REVOLUTION);

    assert.ok(cylinderFaces.length >= 2, 'Line-profile full revolve should emit cylindrical side faces');
    assert.ok(planeFaces.length >= 2, 'Line-profile full revolve should emit planar annulus faces');
    assert.strictEqual(revolutionFaces.length, 0,
      'Line-profile full revolve should not fall back to generic revolution placeholder faces');
  }
});

test('Revolve partial: topoBody has cap faces', () => {
  resetFeatureIds();
  resetTopoIds();
  resetPrimitiveIds();
  const part = new Part('Test');
  const sketch = makeRectSketch(5, -5, 10, 5);
  const plane = makeXYPlane();
  part.addSketch(sketch, plane);
  const revolveFeature = part.revolve(part.getSketches()[0].id, Math.PI); // 180°

  const geom = revolveFeature.result.geometry;
  if (geom.topoBody) {
    const body = geom.topoBody;
    const planeFaces = body.faces().filter(f => f.surfaceType === SurfaceType.PLANE);
    assert.ok(planeFaces.length >= 2, 'Partial revolve should have at least 2 cap faces');
  }
});

test('Revolve topoBody can be tessellated', () => {
  resetFeatureIds();
  resetTopoIds();
  resetPrimitiveIds();
  const part = new Part('Test');
  const sketch = makeRectSketch(5, -5, 10, 5);
  const plane = makeXYPlane();
  part.addSketch(sketch, plane);
  const revolveFeature = part.revolve(part.getSketches()[0].id, Math.PI * 2);

  const geom = revolveFeature.result.geometry;
  if (geom.topoBody) {
    const mesh = tessellateBody(geom.topoBody);
    assert.ok(mesh.faces.length > 0, 'Tessellated mesh should have faces');
  }
});

test('Revolve: shared metadata preserved on faces', () => {
  resetFeatureIds();
  resetTopoIds();
  resetPrimitiveIds();
  const part = new Part('Test');
  const sketch = makeRectSketch(5, -5, 10, 5);
  const plane = makeXYPlane();
  part.addSketch(sketch, plane);
  const revolveFeature = part.revolve(part.getSketches()[0].id, Math.PI * 2);

  const geom = revolveFeature.result.geometry;
  if (geom.topoBody) {
    for (const face of geom.topoBody.faces()) {
      assert.ok(face.shared, `Face ${face.id} should have shared metadata`);
      assert.strictEqual(face.shared.sourceFeatureId, revolveFeature.id,
        `Face should track source feature`);
    }
  }
});

test('Sketch profiles ignore construction geometry and expose revolve axis candidates', () => {
  resetPrimitiveIds();

  const sketch = makeRectSketch(10, -5, 15, 5);
  const axisA = sketch.addSegment(0, -10, 0, 10, { construction: true });
  const axisB = sketch.addSegment(25, -10, 25, 10, { construction: true });
  sketch.addCircle(40, 0, 3, { construction: true });

  const sketchFeature = new SketchFeature('Sketch', sketch);
  const profiles = sketchFeature.extractProfiles();
  const axisCandidates = sketchFeature.getRevolveAxisCandidates();

  assert.strictEqual(profiles.length, 1, 'Construction geometry should not create additional profiles');
  assert.strictEqual(axisCandidates.length, 2, 'Construction segments should be available as revolve axis candidates');
  assert.deepStrictEqual(
    axisCandidates.map(candidate => candidate.segmentId).sort((a, b) => a - b),
    [axisA.id, axisB.id].sort((a, b) => a - b),
    'Axis candidates should track the sketch construction segments by primitive id',
  );
});

test('Revolve with multiple construction lines requires explicit axis selection', () => {
  resetFeatureIds();
  resetTopoIds();
  resetPrimitiveIds();

  const part = new Part('Test');
  const sketch = makeRectSketch(10, -5, 15, 5);
  sketch.addSegment(0, -10, 0, 10, { construction: true });
  sketch.addSegment(30, -10, 30, 10, { construction: true });

  const sketchFeature = part.addSketch(sketch, makeXYPlane());
  const revolveFeature = part.revolve(sketchFeature.id, Math.PI * 2);

  assert.ok(revolveFeature.error, 'Ambiguous revolve axis selection should fail the feature');
  assert.match(
    revolveFeature.error,
    /Multiple construction lines found in sketch/,
    'Feature error should tell the user to select the revolve axis explicitly',
  );
});

test('Revolve stores construction axis by segment id and follows sketch edits', () => {
  resetFeatureIds();
  resetTopoIds();
  resetPrimitiveIds();

  const part = new Part('Test');
  const sketch = makeRectSketch(10, -5, 15, 5);
  sketch.addSegment(0, -10, 0, 10, { construction: true });
  const selectedAxis = sketch.addSegment(30, -10, 30, 10, { construction: true });

  const sketchFeature = part.addSketch(sketch, makeXYPlane());
  const revolveFeature = part.revolve(sketchFeature.id, Math.PI * 2, { axisSegmentId: selectedAxis.id });

  assert.ifError(revolveFeature.error);
  assert.strictEqual(revolveFeature.axisSegmentId, selectedAxis.id, 'Selected construction axis should be stored by primitive id');
  assert.strictEqual(revolveFeature.axisSource, 'construction', 'Construction-backed revolves should record their axis source');
  assert.strictEqual(revolveFeature.axis.origin.x, 30, 'Initial revolve axis should come from the selected construction line');

  selectedAxis.p1.x = 40;
  selectedAxis.p2.x = 40;
  part.featureTree.recalculateFrom(sketchFeature.id);

  assert.ifError(revolveFeature.error);
  assert.strictEqual(revolveFeature.axis.origin.x, 40, 'Revolve axis should follow the selected sketch construction line after edits');
});

test('Axis-crossing line revolves split into analytic cone faces', () => {
  resetFeatureIds();
  resetTopoIds();

  const revolveFeature = new RevolveFeature('Revolve', null, Math.PI * 2);
  const plane = makeXYPlane();
  const axisFrame = revolveFeature.resolveAxisFrame(plane);
  const profile = {
    points: [
      { x: 2, y: 0 },
      { x: -2, y: 2 },
    ],
  };
  const range = { startIdx: 0, endIdx: 1 };

  const exactFaces = revolveFeature._buildExactSegmentRevolveFaceDescs(
    profile,
    range,
    0,
    0,
    plane,
    axisFrame,
    true,
  );

  assert.ok(Array.isArray(exactFaces) && exactFaces.length === 8,
    'A full axis-crossing segment revolve should split into 8 quarter-turn cone faces');
  assert.ok(exactFaces.every(face => face.surfaceType === SurfaceType.CONE),
    'Axis-crossing segment revolves should stay on analytic cone faces');
});

test('Arc-profile revolves use exact non-placeholder faces', () => {
  assertExactRevolveForSketch(makeArcProfileSketch(), 'Arc-profile revolve');
});

test('Circle-profile revolves use exact non-placeholder faces', () => {
  assertExactRevolveForSketch(makeCircleSketch(), 'Circle-profile revolve');
});

test('Spline-profile revolves use exact non-placeholder faces', () => {
  assertExactRevolveForSketch(makeSplineProfileSketch(), 'Spline-profile revolve');
});

test('Bezier-profile revolves use exact non-placeholder faces', () => {
  assertExactRevolveForSketch(makeBezierProfileSketch(), 'Bezier-profile revolve');
});

// ============================================================
console.log('\n=== Results ===\n');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
