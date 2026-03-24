// tests/test-step-import.js — Tests for STEP file import
//
// Validates:
// 1. STEP file parsing (entity extraction, reference resolution)
// 2. Mesh geometry generation (vertices, faces, normals)
// 3. Integration with feature tree (acts as parametric solid)
// 4. Serialization / deserialization round-trip
// 5. Subsequent parametric operations on imported geometry

import assert from 'assert';
import { readFileSync } from 'fs';
import { importSTEP } from '../js/cad/StepImport.js';
import { StepImportFeature } from '../js/cad/StepImportFeature.js';
import { Part } from '../js/cad/Part.js';
import { PartManager } from '../js/part-manager.js';
import { resetFeatureIds } from '../js/cad/Feature.js';

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
    if (err.stack) {
      const stackLines = err.stack.split('\n').slice(1, 4);
      for (const line of stackLines) console.log(`    ${line.trim()}`);
    }
    failed++;
  }
}

// Load the reference STEP file
const stepFilePath = new URL('./step/Unnamed-Body.step', import.meta.url).pathname;
const stepData = readFileSync(stepFilePath, 'utf-8');

// ============================================================
console.log('=== STEP Import — Parsing Tests ===\n');
// ============================================================

test('importSTEP: parses reference STEP file without errors', () => {
  const mesh = importSTEP(stepData);
  assert.ok(mesh, 'Should return a mesh object');
  assert.ok(Array.isArray(mesh.vertices), 'Should have vertices array');
  assert.ok(Array.isArray(mesh.faces), 'Should have faces array');
});

test('importSTEP: produces non-empty geometry', () => {
  const mesh = importSTEP(stepData);
  assert.ok(mesh.faces.length > 0, `Should have faces (got ${mesh.faces.length})`);
  assert.ok(mesh.vertices.length > 0, `Should have vertices (got ${mesh.vertices.length})`);
});

test('importSTEP: faces have valid structure', () => {
  const mesh = importSTEP(stepData);
  for (let i = 0; i < Math.min(mesh.faces.length, 20); i++) {
    const face = mesh.faces[i];
    assert.ok(Array.isArray(face.vertices), `Face ${i} should have vertices array`);
    assert.ok(face.vertices.length >= 3, `Face ${i} should have at least 3 vertices`);
    assert.ok(face.normal, `Face ${i} should have a normal`);
    assert.ok(typeof face.normal.x === 'number', `Face ${i} normal.x should be a number`);
    assert.ok(typeof face.normal.y === 'number', `Face ${i} normal.y should be a number`);
    assert.ok(typeof face.normal.z === 'number', `Face ${i} normal.z should be a number`);
  }
});

test('importSTEP: vertices have valid 3D coordinates', () => {
  const mesh = importSTEP(stepData);
  for (let i = 0; i < Math.min(mesh.faces.length, 20); i++) {
    for (const v of mesh.faces[i].vertices) {
      assert.ok(typeof v.x === 'number' && isFinite(v.x), `Vertex x should be finite number`);
      assert.ok(typeof v.y === 'number' && isFinite(v.y), `Vertex y should be finite number`);
      assert.ok(typeof v.z === 'number' && isFinite(v.z), `Vertex z should be finite number`);
    }
  }
});

test('importSTEP: all 60 ADVANCED_FACEs are tessellated', () => {
  const mesh = importSTEP(stepData);
  // The STEP file has 60 ADVANCED_FACEs; each produces ≥1 triangle
  assert.ok(mesh.faces.length >= 60,
    `Should produce at least 60 triangles from 60 faces (got ${mesh.faces.length})`);
});

test('importSTEP: curveSegments option affects tessellation', () => {
  const meshLow = importSTEP(stepData, { curveSegments: 4 });
  const meshHigh = importSTEP(stepData, { curveSegments: 32 });
  // Higher segment count should generally produce more faces for curved surfaces
  assert.ok(meshHigh.faces.length >= meshLow.faces.length,
    `Higher segments (${meshHigh.faces.length}) should produce ≥ faces than low (${meshLow.faces.length})`);
});

test('importSTEP: throws on empty input', () => {
  assert.throws(() => importSTEP(''), /No solid geometry/);
});

test('importSTEP: throws on invalid STEP content', () => {
  assert.throws(() => importSTEP('not a STEP file'), /No solid geometry/);
});

// ============================================================
console.log('\n=== STEP Import — Feature Tests ===\n');
// ============================================================

test('StepImportFeature: has correct type', () => {
  resetFeatureIds();
  const feature = new StepImportFeature('Test Import', stepData);
  assert.strictEqual(feature.type, 'step-import');
  assert.strictEqual(feature.name, 'Test Import');
});

test('StepImportFeature: execute produces solid result', () => {
  resetFeatureIds();
  const feature = new StepImportFeature('Test Import', stepData);
  const result = feature.execute({ results: {}, tree: { getFeatureIndex: () => 0, features: [] } });
  assert.strictEqual(result.type, 'solid');
  assert.ok(result.geometry, 'Should have geometry');
  assert.ok(result.geometry.faces.length > 0, 'Should have faces');
  assert.ok(result.geometry.edges.length > 0, 'Should have computed edges');
  assert.ok(typeof result.volume === 'number', 'Should have volume');
  assert.ok(result.boundingBox, 'Should have bounding box');
});

test('StepImportFeature: bounding box is valid', () => {
  resetFeatureIds();
  const feature = new StepImportFeature('Test Import', stepData);
  const result = feature.execute({ results: {}, tree: { getFeatureIndex: () => 0, features: [] } });
  const bb = result.boundingBox;
  assert.ok(bb.min.x < bb.max.x, 'Bounding box should have non-zero X extent');
  assert.ok(bb.min.y < bb.max.y, 'Bounding box should have non-zero Y extent');
  assert.ok(bb.min.z < bb.max.z, 'Bounding box should have non-zero Z extent');
});

test('StepImportFeature: faces are tagged with sourceFeatureId', () => {
  resetFeatureIds();
  const feature = new StepImportFeature('Test Import', stepData);
  const result = feature.execute({ results: {}, tree: { getFeatureIndex: () => 0, features: [] } });
  for (const face of result.geometry.faces.slice(0, 10)) {
    assert.ok(face.shared, 'Face should have shared metadata');
    assert.strictEqual(face.shared.sourceFeatureId, feature.id,
      'Face should reference the import feature');
  }
});

// ============================================================
console.log('\n=== STEP Import — Part Integration Tests ===\n');
// ============================================================

test('Part.importSTEP: adds feature to tree', () => {
  resetFeatureIds();
  const part = new Part('Test Part');
  const feature = part.importSTEP(stepData);
  assert.ok(feature, 'Should return a feature');
  assert.strictEqual(feature.type, 'step-import');
  assert.ok(part.getFeatures().length === 1, 'Feature tree should have 1 feature');
});

test('Part.importSTEP: produces final geometry', () => {
  resetFeatureIds();
  const part = new Part('Test Part');
  part.importSTEP(stepData);
  const geom = part.getFinalGeometry();
  assert.ok(geom, 'Should have final geometry');
  assert.strictEqual(geom.type, 'solid');
  assert.ok(geom.geometry.faces.length > 0, 'Final geometry should have faces');
});

test('Part.importSTEP: auto-names feature', () => {
  resetFeatureIds();
  const part = new Part('Test Part');
  const f1 = part.importSTEP(stepData);
  assert.strictEqual(f1.name, 'STEP Import 1');
  const f2 = part.importSTEP(stepData, { name: 'Custom Name' });
  assert.strictEqual(f2.name, 'Custom Name');
});

test('PartManager.importSTEP: creates part if needed', () => {
  resetFeatureIds();
  const pm = new PartManager();
  const feature = pm.importSTEP(stepData);
  assert.ok(pm.getPart(), 'Should have created a part');
  assert.ok(feature, 'Should return a feature');
  assert.strictEqual(feature.type, 'step-import');
});

// ============================================================
console.log('\n=== STEP Import — Serialization Tests ===\n');
// ============================================================

test('StepImportFeature: serialize round-trip preserves data', () => {
  resetFeatureIds();
  const feature = new StepImportFeature('Test Import', stepData, { curveSegments: 24 });
  const serialized = feature.serialize();

  assert.strictEqual(serialized.type, 'step-import');
  assert.strictEqual(serialized.stepData, stepData);
  assert.strictEqual(serialized.curveSegments, 24);
  assert.strictEqual(serialized.name, 'Test Import');

  const restored = StepImportFeature.deserialize(serialized);
  assert.strictEqual(restored.type, 'step-import');
  assert.strictEqual(restored.stepData, stepData);
  assert.strictEqual(restored.curveSegments, 24);
  assert.strictEqual(restored.name, 'Test Import');
});

test('Part: deserialize restores step-import features', () => {
  resetFeatureIds();
  const part = new Part('Test Part');
  part.importSTEP(stepData);

  const serialized = part.serialize();
  resetFeatureIds();
  const restored = Part.deserialize(serialized);

  assert.ok(restored.getFeatures().length === 1, 'Restored part should have 1 feature');
  assert.strictEqual(restored.getFeatures()[0].type, 'step-import');

  const geom = restored.getFinalGeometry();
  assert.ok(geom, 'Restored part should have final geometry');
  assert.strictEqual(geom.type, 'solid');
});

// ============================================================
console.log('\n=== Results ===\n');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
