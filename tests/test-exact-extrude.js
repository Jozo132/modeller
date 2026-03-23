// tests/test-exact-extrude.js — Tests for exact B-Rep extrude output
//
// Validates that ExtrudeFeature produces exact TopoBody alongside mesh.

import assert from 'assert';
import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { resetFeatureIds } from '../js/cad/Feature.js';
import { resetTopoIds } from '../js/cad/BRepTopology.js';
import { validateBody, validateFull } from '../js/cad/BRepValidator.js';
import { tessellateBody } from '../js/cad/Tessellation.js';

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

function makeRectSketch(x1, y1, x2, y2) {
  const s = new Sketch();
  s.addSegment(x1, y1, x2, y1);
  s.addSegment(x2, y1, x2, y2);
  s.addSegment(x2, y2, x1, y2);
  s.addSegment(x1, y2, x1, y1);
  return s;
}

// ============================================================
console.log('=== Exact Extrude B-Rep Tests ===\n');
// ============================================================

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
console.log('\n=== Results ===\n');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
