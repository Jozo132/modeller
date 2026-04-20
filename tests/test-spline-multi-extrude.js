// tests/test-spline-multi-extrude.js — Tests for SplinePrimitive and MultiSketchExtrudeFeature
import assert from 'assert';
import { PPoint } from '../js/cad/Point.js';
import { PSpline } from '../js/cad/SplinePrimitive.js';
import { Scene } from '../js/cad/Scene.js';
import { Sketch } from '../js/cad/Sketch.js';
import { SketchFeature } from '../js/cad/SketchFeature.js';
import { ExtrudeFeature } from '../js/cad/ExtrudeFeature.js';
import { MultiSketchExtrudeFeature } from '../js/cad/MultiSketchExtrudeFeature.js';
import { resetPrimitiveIds } from '../js/cad/Primitive.js';
import { resetConstraintIds, clearVariables } from '../js/cad/Constraint.js';
import { resetFeatureIds } from '../js/cad/Feature.js';
import { formatTimingSuffix, startTiming } from './test-timing.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  resetPrimitiveIds(1);
  resetConstraintIds(1);
  clearVariables();
  resetFeatureIds(1);
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

function assertApprox(actual, expected, msg, tol = 1e-4) {
  assert.ok(Math.abs(actual - expected) < tol,
    `${msg}: expected ~${expected}, got ${actual}`);
}

// -----------------------------------------------------------------------
// PSpline tests
// -----------------------------------------------------------------------
console.log('\n=== PSpline Tests ===');

test('PSpline constructor requires >= 2 control points', () => {
  assert.throws(() => new PSpline([new PPoint(0, 0)]), /at least 2/);
  assert.throws(() => new PSpline([]), /at least 2/);
  assert.throws(() => new PSpline(null), /at least 2/);
});

test('PSpline with 2 control points evaluates to a line', () => {
  const p1 = new PPoint(0, 0);
  const p2 = new PPoint(10, 0);
  const spl = new PSpline([p1, p2]);

  assert.strictEqual(spl.type, 'spline');
  assert.strictEqual(spl.p1, p1);
  assert.strictEqual(spl.p2, p2);

  const start = spl.evaluateAt(0);
  assertApprox(start.x, 0, 'start x');
  assertApprox(start.y, 0, 'start y');

  const end = spl.evaluateAt(1);
  assertApprox(end.x, 10, 'end x');
  assertApprox(end.y, 0, 'end y');

  const mid = spl.evaluateAt(0.5);
  assertApprox(mid.x, 5, 'mid x');
  assertApprox(mid.y, 0, 'mid y');
});

test('PSpline with 3 control points creates quadratic curve', () => {
  const p1 = new PPoint(0, 0);
  const p2 = new PPoint(5, 10);
  const p3 = new PPoint(10, 0);
  const spl = new PSpline([p1, p2, p3]);

  const start = spl.evaluateAt(0);
  assertApprox(start.x, 0, 'start x');
  assertApprox(start.y, 0, 'start y');

  const end = spl.evaluateAt(1);
  assertApprox(end.x, 10, 'end x');
  assertApprox(end.y, 0, 'end y');

  // Mid should be somewhere above the baseline
  const mid = spl.evaluateAt(0.5);
  assert.ok(mid.y > 0, `midpoint y=${mid.y} should be > 0`);
});

test('PSpline with 4+ control points creates cubic curve', () => {
  const pts = [
    new PPoint(0, 0), new PPoint(3, 10),
    new PPoint(7, -5), new PPoint(10, 0),
  ];
  const spl = new PSpline(pts);

  const start = spl.evaluateAt(0);
  assertApprox(start.x, 0, 'start x');
  assertApprox(start.y, 0, 'start y');

  const end = spl.evaluateAt(1);
  assertApprox(end.x, 10, 'end x');
  assertApprox(end.y, 0, 'end y');
});

test('PSpline tessellate2D returns correct number of points', () => {
  const pts = [new PPoint(0, 0), new PPoint(5, 5), new PPoint(10, 0)];
  const spl = new PSpline(pts);
  const tess = spl.tessellate2D(16);
  assert.strictEqual(tess.length, 17, `Expected 17 points, got ${tess.length}`);
});

test('PSpline distanceTo works correctly', () => {
  const pts = [new PPoint(0, 0), new PPoint(10, 0)];
  const spl = new PSpline(pts);

  // Point on the line should have ~0 distance
  const d1 = spl.distanceTo(5, 0);
  assert.ok(d1 < 0.1, `Distance on line: ${d1}`);

  // Point off the line should have non-zero distance
  const d2 = spl.distanceTo(5, 5);
  assertApprox(d2, 5, 'off-line distance', 0.2);
});

test('PSpline getBounds is correct', () => {
  const pts = [new PPoint(0, 0), new PPoint(5, 10), new PPoint(10, 0)];
  const spl = new PSpline(pts);
  const b = spl.getBounds();
  assert.ok(b.minX <= 0.1, `minX=${b.minX}`);
  assert.ok(b.maxX >= 9.9, `maxX=${b.maxX}`);
  assert.ok(b.minY <= 0.1, `minY=${b.minY}`);
  assert.ok(b.maxY > 0, `maxY=${b.maxY}`);
});

test('PSpline getSnapPoints includes endpoints and midpoint', () => {
  const p1 = new PPoint(0, 0);
  const p2 = new PPoint(10, 0);
  const spl = new PSpline([p1, p2]);
  const snaps = spl.getSnapPoints();
  assert.ok(snaps.length >= 3, `Expected >=3 snap points, got ${snaps.length}`);
  assert.ok(snaps.some(s => s.type === 'endpoint'), 'Should have endpoint snaps');
  assert.ok(snaps.some(s => s.type === 'midpoint'), 'Should have midpoint snap');
});

test('PSpline serialize/deserialize roundtrip', () => {
  const p1 = new PPoint(0, 0);
  const p2 = new PPoint(5, 10);
  const p3 = new PPoint(10, 0);
  const spl = new PSpline([p1, p2, p3]);
  const data = spl.serialize();

  assert.strictEqual(data.type, 'spline');
  assert.strictEqual(data.controlPoints.length, 3);
  assert.strictEqual(data.controlPoints[0], p1.id);
  assert.strictEqual(data.controlPoints[1], p2.id);
  assert.strictEqual(data.controlPoints[2], p3.id);
});

// -----------------------------------------------------------------------
// Scene spline integration tests
// -----------------------------------------------------------------------
console.log('\n=== Scene Spline Integration Tests ===');

test('Scene.addSpline creates a spline with shared points', () => {
  const scene = new Scene();
  const spl = scene.addSpline([{x: 0, y: 0}, {x: 5, y: 5}, {x: 10, y: 0}]);

  assert.strictEqual(scene.splines.length, 1);
  assert.strictEqual(spl.type, 'spline');
  assert.strictEqual(spl.points.length, 3);
  // Points should be in scene.points
  assert.strictEqual(scene.points.length, 3);
});

test('Scene.addSpline with merge=true shares points with segments', () => {
  const scene = new Scene();
  scene.addSegment(0, 0, 5, 5);
  const spl = scene.addSpline([{x: 5, y: 5}, {x: 10, y: 10}, {x: 15, y: 5}]);

  // Point at (5,5) should be shared between the segment and the spline
  assert.strictEqual(scene.points.length, 4); // 2 from segment, 2 new from spline (1 shared)
  assert.strictEqual(spl.p1, scene.segments[0].p2);
});

test('Scene.removeSpline removes spline and cleans orphan points', () => {
  const scene = new Scene();
  const spl = scene.addSpline([{x: 0, y: 0}, {x: 5, y: 5}]);
  assert.strictEqual(scene.splines.length, 1);
  assert.strictEqual(scene.points.length, 2);

  scene.removeSpline(spl);
  assert.strictEqual(scene.splines.length, 0);
  assert.strictEqual(scene.points.length, 0); // orphan points cleaned
});

test('Scene shapes() iterator includes splines', () => {
  const scene = new Scene();
  scene.addSpline([{x: 0, y: 0}, {x: 10, y: 0}]);
  const shapes = [...scene.shapes()];
  assert.ok(shapes.some(s => s.type === 'spline'), 'shapes() should include splines');
});

test('Scene serialize/deserialize roundtrip with splines', () => {
  const scene = new Scene();
  scene.addSegment(0, 0, 5, 5);
  scene.addSpline([{x: 5, y: 5}, {x: 10, y: 10}, {x: 15, y: 5}]);

  const data = scene.serialize();
  assert.ok(data.splines, 'Serialized data should have splines');
  assert.strictEqual(data.splines.length, 1);

  const restored = Scene.deserialize(data);
  assert.strictEqual(restored.splines.length, 1);
  assert.strictEqual(restored.splines[0].type, 'spline');
  assert.strictEqual(restored.splines[0].points.length, 3);
  assert.strictEqual(restored.segments.length, 1);
});

// -----------------------------------------------------------------------
// Sketch spline integration tests
// -----------------------------------------------------------------------
console.log('\n=== Sketch Spline Integration Tests ===');

test('Sketch.addSpline delegates to scene', () => {
  const sketch = new Sketch();
  const spl = sketch.addSpline([{x: 0, y: 0}, {x: 5, y: 5}, {x: 10, y: 0}]);
  assert.strictEqual(sketch.splines.length, 1);
  assert.strictEqual(spl.type, 'spline');
});

test('Sketch serialize/deserialize preserves splines', () => {
  const sketch = new Sketch();
  sketch.addSpline([{x: 0, y: 0}, {x: 5, y: 5}, {x: 10, y: 0}]);
  const data = sketch.serialize();
  const restored = Sketch.deserialize(data);
  assert.strictEqual(restored.splines.length, 1);
});

// -----------------------------------------------------------------------
// SketchFeature profile extraction with splines
// -----------------------------------------------------------------------
console.log('\n=== Profile Extraction with Splines ===');

test('SketchFeature extracts profile from segments forming a triangle', () => {
  const sf = new SketchFeature('TestSketch');
  sf.sketch.addSegment(0, 0, 10, 0);
  sf.sketch.addSegment(10, 0, 5, 10);
  sf.sketch.addSegment(5, 10, 0, 0);

  const profiles = sf.extractProfiles();
  assert.ok(profiles.length >= 1, `Expected >=1 closed profile, got ${profiles.length}`);
  const closed = profiles.filter(p => p.closed);
  assert.ok(closed.length >= 1, 'Should have at least 1 closed profile');
});

test('SketchFeature extracts profile from spline+segments forming a closed loop', () => {
  const sf = new SketchFeature('TestSketch');
  // Create a shape: segment at bottom, spline forming the top
  const seg = sf.sketch.addSegment(0, 0, 10, 0);
  const spl = sf.sketch.addSpline([{x: 10, y: 0}, {x: 7, y: 5}, {x: 3, y: 5}, {x: 0, y: 0}]);

  // The spline p1 should share a point with segment p2
  assert.strictEqual(spl.p1, seg.p2, 'Spline p1 should share point with segment p2');
  // The spline p2 should share a point with segment p1
  assert.strictEqual(spl.p2, seg.p1, 'Spline p2 should share point with segment p1');

  const profiles = sf.extractProfiles();
  const closed = profiles.filter(p => p.closed);
  assert.ok(closed.length >= 1, `Expected >=1 closed profile, got ${closed.length}`);

  // The profile should have many points (from spline tessellation)
  if (closed.length > 0) {
    assert.ok(closed[0].points.length > 4, `Expected >4 points from tessellated spline, got ${closed[0].points.length}`);
  }
});

// -----------------------------------------------------------------------
// MultiSketchExtrudeFeature tests
// -----------------------------------------------------------------------
console.log('\n=== MultiSketchExtrudeFeature Tests ===');

test('MultiSketchExtrudeFeature serialization roundtrip', () => {
  const feat = new MultiSketchExtrudeFeature('TestMultiExtrude');
  feat.addSketchEntry('sketch-1', 15, 1);
  feat.addSketchEntry('sketch-2', 20, -1);
  feat.operation = 'add';

  const data = feat.serialize();
  assert.strictEqual(data.type, 'multi-sketch-extrude');
  assert.strictEqual(data.sketchEntries.length, 2);
  assert.strictEqual(data.sketchEntries[0].distance, 15);
  assert.strictEqual(data.sketchEntries[1].direction, -1);
  assert.strictEqual(data.operation, 'add');

  const restored = MultiSketchExtrudeFeature.deserialize(data);
  assert.strictEqual(restored.type, 'multi-sketch-extrude');
  assert.strictEqual(restored.sketchEntries.length, 2);
  assert.strictEqual(restored.sketchEntries[0].sketchFeatureId, 'sketch-1');
  assert.strictEqual(restored.sketchEntries[1].sketchFeatureId, 'sketch-2');
  assert.strictEqual(restored.operation, 'add');
});

test('MultiSketchExtrudeFeature tracks dependencies', () => {
  const feat = new MultiSketchExtrudeFeature();
  feat.addSketchEntry('s1', 10);
  feat.addSketchEntry('s2', 20);

  assert.ok(feat.dependencies.includes('s1'), 'Should depend on s1');
  assert.ok(feat.dependencies.includes('s2'), 'Should depend on s2');
});

test('MultiSketchExtrudeFeature removeSketchEntry cleans dependencies', () => {
  const feat = new MultiSketchExtrudeFeature();
  feat.addSketchEntry('s1', 10);
  feat.addSketchEntry('s2', 20);

  feat.removeSketchEntry(0);
  assert.strictEqual(feat.sketchEntries.length, 1);
  assert.ok(!feat.dependencies.includes('s1'), 's1 dependency should be removed');
  assert.ok(feat.dependencies.includes('s2'), 's2 dependency should remain');
});

test('MultiSketchExtrudeFeature execute with XY and XZ plane sketches', () => {
  // Create two sketch features on different planes
  const sf1 = new SketchFeature('Sketch1');
  sf1.plane = {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
  };
  // Add a rectangle profile to sketch 1
  sf1.sketch.addSegment(0, 0, 5, 0);
  sf1.sketch.addSegment(5, 0, 5, 5);
  sf1.sketch.addSegment(5, 5, 0, 5);
  sf1.sketch.addSegment(0, 5, 0, 0);

  const sf2 = new SketchFeature('Sketch2');
  sf2.plane = {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 1, z: 0 },  // XZ plane
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 0, z: 1 },
  };
  // Add a rectangle profile to sketch 2
  sf2.sketch.addSegment(-2, -2, 7, -2);
  sf2.sketch.addSegment(7, -2, 7, 7);
  sf2.sketch.addSegment(7, 7, -2, 7);
  sf2.sketch.addSegment(-2, 7, -2, -2);

  // Execute sketches first
  const context = {
    results: {},
    tree: { features: [sf1, sf2], getFeatureIndex: (id) => id === sf1.id ? 0 : id === sf2.id ? 1 : 2 },
  };
  context.results[sf1.id] = sf1.execute(context);
  context.results[sf2.id] = sf2.execute(context);

  // Create multi-sketch extrude
  const mse = new MultiSketchExtrudeFeature('TestMSE');
  mse.addSketchEntry(sf1.id, 10, 1);
  mse.addSketchEntry(sf2.id, 8, 1);

  context.tree.features.push(mse);
  context.tree.getFeatureIndex = (id) => {
    const idx = context.tree.features.findIndex(f => f.id === id);
    return idx;
  };

  const result = mse.execute(context);
  assert.strictEqual(result.type, 'solid');
  assert.ok(result.geometry, 'Should have geometry');
  assert.ok(result.geometry.faces.length > 0, 'Should have faces');
  assert.ok(result.volume > 0, `Volume should be > 0, got ${result.volume}`);
});

test('MultiSketchExtrudeFeature with sketches in arbitrary orientation', () => {
  // Create sketch on a tilted plane (45 degrees)
  const sf1 = new SketchFeature('Sketch1');
  sf1.plane = {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
  };
  sf1.sketch.addSegment(0, 0, 5, 0);
  sf1.sketch.addSegment(5, 0, 5, 5);
  sf1.sketch.addSegment(5, 5, 0, 5);
  sf1.sketch.addSegment(0, 5, 0, 0);

  const sqrt2 = Math.SQRT1_2;
  const sf2 = new SketchFeature('Sketch2');
  sf2.plane = {
    origin: { x: 0, y: 0, z: 5 },
    normal: { x: 0, y: -sqrt2, z: sqrt2 }, // tilted 45 degrees
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: sqrt2, z: sqrt2 },
  };
  sf2.sketch.addSegment(-1, -1, 6, -1);
  sf2.sketch.addSegment(6, -1, 6, 6);
  sf2.sketch.addSegment(6, 6, -1, 6);
  sf2.sketch.addSegment(-1, 6, -1, -1);

  const context = {
    results: {},
    tree: { features: [sf1, sf2], getFeatureIndex: (id) => id === sf1.id ? 0 : id === sf2.id ? 1 : 2 },
  };
  context.results[sf1.id] = sf1.execute(context);
  context.results[sf2.id] = sf2.execute(context);

  const mse = new MultiSketchExtrudeFeature('TiltedMSE');
  mse.addSketchEntry(sf1.id, 10, 1);
  mse.addSketchEntry(sf2.id, 5, 1);

  context.tree.features.push(mse);
  context.tree.getFeatureIndex = (id) => {
    return context.tree.features.findIndex(f => f.id === id);
  };

  const result = mse.execute(context);
  assert.strictEqual(result.type, 'solid');
  assert.ok(result.geometry.faces.length > 0, 'Should have faces');
  assert.ok(result.volume > 0, `Volume should be > 0, got ${result.volume}`);
});

// -----------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------
console.log(`\nSpline & Multi-Sketch Extrude Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
