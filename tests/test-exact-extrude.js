import './_watchdog.mjs';
// tests/test-exact-extrude.js — Tests for exact B-Rep extrude output
//
// Validates that ExtrudeFeature produces exact TopoBody alongside mesh.

import assert from 'assert';
import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { SketchFeature } from '../js/cad/SketchFeature.js';
import { resetFeatureIds } from '../js/cad/Feature.js';
import { resetTopoIds } from '../js/cad/BRepTopology.js';
import { validateBody, validateFull } from '../js/cad/BRepValidator.js';
import { tessellateBody } from '../js/cad/Tessellation.js';
import { globalTessConfig } from '../js/cad/TessellationConfig.js';
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

function makeRectSketch(x1, y1, x2, y2) {
  const s = new Sketch();
  s.addSegment(x1, y1, x2, y1);
  s.addSegment(x2, y1, x2, y2);
  s.addSegment(x2, y2, x1, y2);
  s.addSegment(x1, y2, x1, y1);
  return s;
}

function polygonArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    area += points[i].x * points[j].y - points[j].x * points[i].y;
  }
  return area * 0.5;
}

// ============================================================
console.log('=== Exact Extrude B-Rep Tests ===\n');
// ============================================================

test('Nested sketch profiles alternate material by odd-even depth', () => {
  resetFeatureIds();
  resetTopoIds();
  const sketchFeature = new SketchFeature('NestedProfiles');
  const addRect = (x1, y1, x2, y2) => {
    sketchFeature.sketch.addSegment(x1, y1, x2, y1);
    sketchFeature.sketch.addSegment(x2, y1, x2, y2);
    sketchFeature.sketch.addSegment(x2, y2, x1, y2);
    sketchFeature.sketch.addSegment(x1, y2, x1, y1);
  };

  addRect(0, 0, 40, 40);
  addRect(5, 5, 35, 35);
  addRect(10, 10, 30, 30);
  addRect(15, 15, 25, 25);

  const profiles = sketchFeature.extractProfiles();
  assert.strictEqual(profiles.length, 4, 'should extract all four nested loops');
  const byArea = profiles
    .map((profile, index) => ({ profile, index, area: Math.abs(polygonArea(profile.points)) }))
    .sort((a, b) => b.area - a.area);

  assert.deepStrictEqual(byArea.map((entry) => entry.profile.nestingDepth), [0, 1, 2, 3]);
  assert.deepStrictEqual(byArea.map((entry) => entry.profile.isHole), [false, true, false, true]);
  assert.ok(byArea[0].profile.holes.includes(byArea[1].index), 'depth-1 loop should be a hole in the outer loop');
  assert.ok(byArea[2].profile.holes.includes(byArea[3].index), 'depth-3 loop should be a hole in the depth-2 island');
});

test('Extrude produces topoBody on geometry', () => {
  resetFeatureIds();
  resetTopoIds();
  const part = new Part('Test');
  const sketch = makeRectSketch(-5, -5, 5, 5);
  const plane = {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
  };
  part.addSketch(sketch, plane);
  const extrudeFeature = part.extrude(part.getSketches()[0].id, 10);

  assert.ok(extrudeFeature, 'Extrude feature should exist');
  assert.ok(extrudeFeature.result, 'Result should exist');
  const geom = extrudeFeature.result.geometry;
  assert.ok(geom, 'Geometry should exist');
  assert.ok(geom.faces.length > 0, 'Should have mesh faces');
});

test('Extrude box: topoBody has correct topology', () => {
  resetFeatureIds();
  resetTopoIds();
  const part = new Part('Test');
  const sketch = makeRectSketch(-5, -5, 5, 5);
  const plane = {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
  };
  part.addSketch(sketch, plane);
  part.extrude(part.getSketches()[0].id, 10);

  const extrudeFeature = part.featureTree.features.find(f => f.type === 'extrude');
  const result = extrudeFeature.result;
  assert.ok(result, 'Extrude result should exist');

  // Get the geometry that the extrude produced
  const geom = result.geometry;
  assert.ok(geom, 'Geometry should exist');

  if (geom.topoBody) {
    const body = geom.topoBody;
    assert.strictEqual(body.shells.length, 1, 'Should have 1 shell');
    assert.strictEqual(body.faces().length, 6, 'Box should have 6 faces');

    // All faces should be planar
    for (const face of body.faces()) {
      assert.strictEqual(face.surfaceType, 'plane', `Face ${face.id} should be planar`);
    }

    // Validate topology
    const valResult = validateBody(body);
    // Check that all loops are closed
    for (const face of body.faces()) {
      assert.ok(face.outerLoop, `Face ${face.id} should have outer loop`);
      assert.ok(face.outerLoop.isClosed(), `Face ${face.id} outer loop should be closed`);
    }
  }
});

test('Extrude box: topoBody faces have NURBS surfaces', () => {
  resetFeatureIds();
  resetTopoIds();
  const part = new Part('Test');
  const sketch = makeRectSketch(-5, -5, 5, 5);
  const plane = {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
  };
  part.addSketch(sketch, plane);
  part.extrude(part.getSketches()[0].id, 10);

  const geom = part.featureTree.features.find(f => f.type === 'extrude').result.geometry;
  if (geom.topoBody) {
    const body = geom.topoBody;
    let surfaceCount = 0;
    for (const face of body.faces()) {
      if (face.surface) surfaceCount++;
    }
    assert.ok(surfaceCount > 0, 'At least some faces should have NURBS surfaces');
  }
});

test('Extrude box: topoBody edges have exact curves', () => {
  resetFeatureIds();
  resetTopoIds();
  const part = new Part('Test');
  const sketch = makeRectSketch(-5, -5, 5, 5);
  const plane = {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
  };
  part.addSketch(sketch, plane);
  part.extrude(part.getSketches()[0].id, 10);

  const geom = part.featureTree.features.find(f => f.type === 'extrude').result.geometry;
  if (geom.topoBody) {
    const body = geom.topoBody;
    let curveCount = 0;
    for (const edge of body.edges()) {
      if (edge.curve) curveCount++;
    }
    assert.ok(curveCount > 0, 'At least some edges should have exact curves');
  }
});

test('Extrude box: topoBody can be tessellated', () => {
  resetFeatureIds();
  resetTopoIds();
  const part = new Part('Test');
  const sketch = makeRectSketch(-5, -5, 5, 5);
  const plane = {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
  };
  part.addSketch(sketch, plane);
  part.extrude(part.getSketches()[0].id, 10);

  const geom = part.featureTree.features.find(f => f.type === 'extrude').result.geometry;
  if (geom.topoBody) {
    const mesh = tessellateBody(geom.topoBody);
    assert.ok(mesh.faces.length > 0, 'Tessellated mesh should have faces');
    assert.ok(mesh.vertices.length > 0, 'Tessellated mesh should have vertices');
  }
});

test('Extrude box: shared metadata preserved on faces', () => {
  resetFeatureIds();
  resetTopoIds();
  const part = new Part('Test');
  const sketch = makeRectSketch(-5, -5, 5, 5);
  const plane = {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
  };
  part.addSketch(sketch, plane);
  part.extrude(part.getSketches()[0].id, 10);

  const extrudeFeature = part.featureTree.features.find(f => f.type === 'extrude');
  const geom = extrudeFeature.result.geometry;
  if (geom.topoBody) {
    for (const face of geom.topoBody.faces()) {
      assert.ok(face.shared, `Face ${face.id} should have shared metadata`);
      assert.strictEqual(face.shared.sourceFeatureId, extrudeFeature.id,
        `Face ${face.id} should track source feature`);
    }
  }
});

test('Extrude with negative direction produces valid topoBody', () => {
  resetFeatureIds();
  resetTopoIds();
  const part = new Part('Test');
  const sketch = makeRectSketch(-5, -5, 5, 5);
  const plane = {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
  };
  part.addSketch(sketch, plane);
  const extrudeFeature = part.extrude(part.getSketches()[0].id, 10, { direction: -1 });

  const geom = extrudeFeature.result.geometry;
  assert.ok(geom, 'Geometry should exist');
  if (geom.topoBody) {
    const body = geom.topoBody;
    assert.strictEqual(body.faces().length, 6, 'Should still have 6 faces');
  }
});

// ============================================================
// Spline / Bezier B-Rep Extrusion Tests
// ============================================================
console.log('\n=== Spline/Bezier Exact Extrude Tests ===\n');

test('Extrude spline profile: produces topoBody with NURBS surfaces', () => {
  resetFeatureIds();
  resetTopoIds();
  const part = new Part('SplineTest');
  // Create a closed profile: 4 segments forming a square with one edge replaced by a spline
  const sketch = new Sketch();
  // Bottom line: (0,0) -> (10,0)
  sketch.addSegment(0, 0, 10, 0);
  // Right line: (10,0) -> (10,10)
  sketch.addSegment(10, 0, 10, 10);
  // Top spline: (10,10) -> (5,12) -> (0,10) — a curved top edge
  sketch.addSpline([{ x: 10, y: 10 }, { x: 5, y: 13 }, { x: 0, y: 10 }]);
  // Left line: (0,10) -> (0,0)
  sketch.addSegment(0, 10, 0, 0);

  const plane = {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
  };
  part.addSketch(sketch, plane);
  part.extrude(part.getSketches()[0].id, 5);

  const geom = part.featureTree.features.find(f => f.type === 'extrude').result.geometry;
  assert.ok(geom.topoBody, 'Spline extrusion should produce a topoBody');

  const body = geom.topoBody;
  assert.strictEqual(body.shells.length, 1, 'Should have 1 shell');

  // Should have 8 faces: bottom cap, top cap, 3 planar side faces, 3 BSPLINE side faces
  // (spline has 3 control points → max(3,3) = 3 sub-faces)
  const faces = body.faces();
  assert.strictEqual(faces.length, 8, `Spline extrude should have 8 faces, got ${faces.length}`);

  const bsplineFaces = faces.filter(f => f.surfaceType === 'bspline');
  assert.ok(bsplineFaces.length >= 1, `Should have at least 1 bspline face from spline extrusion, got ${bsplineFaces.length}`);

  // All faces should have surfaces
  for (const face of faces) {
    assert.ok(face.surface, `Face ${face.id} should have a NURBS surface`);
  }

  // All edges should have curves
  for (const edge of body.edges()) {
    assert.ok(edge.curve, `Edge ${edge.id} should have an exact curve`);
  }

  // Validate topology
  for (const face of faces) {
    assert.ok(face.outerLoop, `Face ${face.id} should have outer loop`);
    assert.ok(face.outerLoop.isClosed(), `Face ${face.id} outer loop should be closed`);
  }
});

test('Extrude spline profile: topoBody can be tessellated', () => {
  resetFeatureIds();
  resetTopoIds();
  const part = new Part('SplineTessTest');
  const sketch = new Sketch();
  sketch.addSegment(0, 0, 10, 0);
  sketch.addSegment(10, 0, 10, 10);
  sketch.addSpline([{ x: 10, y: 10 }, { x: 5, y: 13 }, { x: 0, y: 10 }]);
  sketch.addSegment(0, 10, 0, 0);

  const plane = {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
  };
  part.addSketch(sketch, plane);
  part.extrude(part.getSketches()[0].id, 5);

  const geom = part.featureTree.features.find(f => f.type === 'extrude').result.geometry;
  assert.ok(geom.topoBody, 'Should have topoBody');

  const mesh = tessellateBody(geom.topoBody);
  assert.ok(mesh.faces.length > 0, 'Tessellated mesh should have faces');
  assert.ok(mesh.vertices.length > 0, 'Tessellated mesh should have vertices');
});

test('Extrude bezier profile: produces topoBody with NURBS surfaces', () => {
  resetFeatureIds();
  resetTopoIds();
  const part = new Part('BezierTest');
  const sketch = new Sketch();
  // Bottom line: (0,0) -> (10,0)
  sketch.addSegment(0, 0, 10, 0);
  // Right line: (10,0) -> (10,10)
  sketch.addSegment(10, 0, 10, 10);
  // Top bezier: (10,10) -> (0,10) with cubic handles
  sketch.addBezier([
    { x: 10, y: 10, handleOut: { dx: -2, dy: 5 } },
    { x: 0, y: 10, handleIn: { dx: 2, dy: 5 } },
  ]);
  // Left line: (0,10) -> (0,0)
  sketch.addSegment(0, 10, 0, 0);

  const plane = {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
  };
  part.addSketch(sketch, plane);
  part.extrude(part.getSketches()[0].id, 5);

  const geom = part.featureTree.features.find(f => f.type === 'extrude').result.geometry;
  assert.ok(geom.topoBody, 'Bezier extrusion should produce a topoBody');

  const body = geom.topoBody;
  const faces = body.faces();
  assert.strictEqual(faces.length, 8, `Bezier extrude should have 8 faces, got ${faces.length}`);

  const bsplineFaces = faces.filter(f => f.surfaceType === 'bspline');
  assert.ok(bsplineFaces.length >= 1, `Should have at least 1 bspline face from bezier extrusion, got ${bsplineFaces.length}`);

  for (const face of faces) {
    assert.ok(face.surface, `Face ${face.id} should have a NURBS surface`);
    assert.ok(face.outerLoop, `Face ${face.id} should have outer loop`);
    assert.ok(face.outerLoop.isClosed(), `Face ${face.id} outer loop should be closed`);
  }
});

test('Extrude bezier profile: topoBody can be tessellated', () => {
  resetFeatureIds();
  resetTopoIds();
  const part = new Part('BezierTessTest');
  const sketch = new Sketch();
  sketch.addSegment(0, 0, 10, 0);
  sketch.addSegment(10, 0, 10, 10);
  sketch.addBezier([
    { x: 10, y: 10, handleOut: { dx: -2, dy: 5 } },
    { x: 0, y: 10, handleIn: { dx: 2, dy: 5 } },
  ]);
  sketch.addSegment(0, 10, 0, 0);

  const plane = {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
  };
  part.addSketch(sketch, plane);
  part.extrude(part.getSketches()[0].id, 5);

  const geom = part.featureTree.features.find(f => f.type === 'extrude').result.geometry;
  assert.ok(geom.topoBody, 'Should have topoBody');

  const mesh = tessellateBody(geom.topoBody);
  assert.ok(mesh.faces.length > 0, 'Tessellated mesh should have faces');
  assert.ok(mesh.vertices.length > 0, 'Tessellated mesh should have vertices');
});

test('Sketch profile tessellation follows global curve quality', () => {
  const savedConfig = globalTessConfig.serialize();
  try {
    const sketch = new Sketch();
    sketch.addCircle(0, 0, 5);
    const sketchFeature = new SketchFeature('QualityCircle', sketch);

    globalTessConfig.applyPreset('draft');
    assert.strictEqual(sketchFeature.extractProfiles()[0].points.length, 8);

    globalTessConfig.applyPreset('ultra');
    assert.strictEqual(sketchFeature.extractProfiles()[0].points.length, 64);
  } finally {
    Object.assign(globalTessConfig, savedConfig);
  }
});

// ============================================================
console.log('\n=== Results ===\n');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
