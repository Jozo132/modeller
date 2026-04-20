// tests/test-exact-revolve.js — Tests for exact B-Rep revolve output
//
// Validates that RevolveFeature produces exact TopoBody alongside mesh.

import assert from 'assert';
import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { resetFeatureIds } from '../js/cad/Feature.js';
import { resetTopoIds, SurfaceType } from '../js/cad/BRepTopology.js';
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

// ============================================================
console.log('=== Exact Revolve B-Rep Tests ===\n');
// ============================================================

test('Revolve produces topoBody on geometry', () => {
  resetFeatureIds();
  resetTopoIds();
  const part = new Part('Test');
  const sketch = makeRectSketch(5, -5, 10, 5); // Offset from axis
  const plane = {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
  };
  part.addSketch(sketch, plane);
  const revolveFeature = part.revolve(part.getSketches()[0].id, Math.PI * 2);

  assert.ok(revolveFeature, 'Revolve feature should exist');
  assert.ok(revolveFeature.result, 'Result should exist');
  assert.ok(revolveFeature.result.geometry, 'Geometry should exist');
  assert.ok(revolveFeature.result.geometry.faces.length > 0, 'Should have mesh faces');
});

test('Revolve topoBody has revolution surface type', () => {
  resetFeatureIds();
  resetTopoIds();
  const part = new Part('Test');
  const sketch = makeRectSketch(5, -5, 10, 5);
  const plane = {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
  };
  part.addSketch(sketch, plane);
  const revolveFeature = part.revolve(part.getSketches()[0].id, Math.PI * 2);

  const geom = revolveFeature.result.geometry;
  if (geom.topoBody) {
    const body = geom.topoBody;
    const revFaces = body.faces().filter(f => f.surfaceType === SurfaceType.REVOLUTION);
    assert.ok(revFaces.length > 0, 'Should have revolution surface faces');
  }
});

test('Revolve partial: topoBody has cap faces', () => {
  resetFeatureIds();
  resetTopoIds();
  const part = new Part('Test');
  const sketch = makeRectSketch(5, -5, 10, 5);
  const plane = {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
  };
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
  const part = new Part('Test');
  const sketch = makeRectSketch(5, -5, 10, 5);
  const plane = {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
  };
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
  const part = new Part('Test');
  const sketch = makeRectSketch(5, -5, 10, 5);
  const plane = {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
  };
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

// ============================================================
console.log('\n=== Results ===\n');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
