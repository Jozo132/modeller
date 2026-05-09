import './_watchdog.mjs';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Part } from '../js/cad/Part.js';
import { calculateMeshVolume } from '../js/cad/toolkit/MeshAnalysis.js';
import { checkWatertight } from '../js/cad/MeshValidator.js';
import { validateBooleanResult } from '../js/cad/BooleanInvariantValidator.js';
import { ensureWasmReady } from '../js/cad/StepImportWasm.js';
import { resetFlags, setFlag } from '../js/featureFlags.js';

function loadPart(sampleName) {
  const sample = JSON.parse(readFileSync(new URL(`./samples/${sampleName}`, import.meta.url), 'utf8'));
  return Part.deserialize(sample.part);
}

await ensureWasmReady();

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (error) {
    console.error(`  FAIL  ${name}\n    ${error.message}`);
    failed++;
  }
}

console.log('Exact extrude cut regression\n');

check('extrude-on-extrude-dual-with-cut applies the subtract exactly', () => {
  const basePart = loadPart('extrude-on-extrude-dual.cmod');
  const cutPart = loadPart('extrude-on-extrude-dual-with-cut.cmod');

  const cutFeature = cutPart.featureTree.features.find((feature) => feature.operation === 'subtract');
  assert.ok(cutFeature, 'expected sample to contain a subtract extrude feature');
  assert.equal(cutFeature.error, null, `subtract feature should execute without an error: ${cutFeature.error}`);

  const baseGeometry = basePart.getFinalGeometry()?.geometry;
  const cutGeometry = cutPart.getFinalGeometry()?.geometry;
  assert.ok(baseGeometry?.topoBody, 'expected base sample to produce exact topology');
  assert.ok(cutGeometry?.topoBody, 'expected cut sample to produce exact topology');

  const baseVolume = calculateMeshVolume(baseGeometry);
  const cutVolume = calculateMeshVolume(cutGeometry);
  assert.ok(cutVolume < baseVolume - 1e-3, `subtract should reduce volume (${baseVolume} -> ${cutVolume})`);

  const validation = validateBooleanResult(cutGeometry.topoBody, { operation: 'subtract' }).toJSON();
  assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics, null, 2));

  const watertight = checkWatertight(cutGeometry.faces || []);
  assert.equal(watertight.boundaryCount, 0, `expected watertight display mesh, got ${watertight.boundaryCount} boundary edges`);
});

check('puzzle-extrude-cc4 cuts multiple sketch faces exactly', () => {
  const part = loadPart('puzzle-extrude-cc4.cmod');
  const cutFeature = part.featureTree.features.find((feature) => feature.type === 'extrude-cut');
  assert.ok(cutFeature, 'expected sample to contain an extrude-cut feature');
  assert.equal(cutFeature.error, null, `extrude cut should execute without an error: ${cutFeature.error}`);

  const geometry = part.getFinalGeometry()?.geometry;
  assert.ok(geometry?.topoBody, 'expected exact topology after multi-profile cut');

  const validation = validateBooleanResult(geometry.topoBody, { operation: 'subtract' }).toJSON();
  assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics, null, 2));

  const watertight = checkWatertight(geometry.faces || []);
  assert.equal(watertight.boundaryCount, 0, `expected watertight display mesh, got ${watertight.boundaryCount} boundary edges`);
});

check('machinning-sample extrude cut survives strict WASM tessellation mode', () => {
  setFlag('CAD_REQUIRE_WASM_TESSELLATION', true);
  setFlag('CAD_ALLOW_DISCRETE_FALLBACK', false);
  try {
    const part = loadPart('machinning-sample.cmod');
    const cutFeature = part.featureTree.features.find((feature) => feature.type === 'extrude-cut');
    assert.ok(cutFeature, 'expected sample to contain an extrude-cut feature');
    assert.equal(cutFeature.error, null, `strict WASM reload should not fail the cut: ${cutFeature.error}`);

    const geometry = part.getFinalGeometry()?.geometry;
    assert.ok(geometry?.topoBody, 'expected exact topology after strict WASM reload');
    assert.ok((geometry.faces || []).length > 0, 'expected non-empty display mesh after strict WASM reload');
    assert.equal(geometry._tessellator, 'wasm', 'strict reload should use native WASM tessellation');
    assert.notEqual(geometry.resultGrade, 'fallback', 'strict reload must not use boolean fallback');
    assert.notEqual(geometry._isFallback, true, 'strict reload must not be marked as fallback');
    assert.equal(countOutOfBlockFaces(geometry.faces || []), 0, 'cut display mesh should not leave tool faces outside the source block');
    assert.equal(countLargeUncutTopTriangles(geometry.faces || []), 0, 'top face should not be emitted as an uncut rectangular fan');
    const sideSurfaceCounts = countCutSideSurfaceTypes(geometry.topoBody, cutFeature.id);
    assert.ok(sideSurfaceCounts.bspline >= 200, `clipped spline cut profiles should retain B-spline side faces: ${JSON.stringify(sideSurfaceCounts)}`);
    assert.ok((sideSurfaceCounts.plane || 0) <= 32, `clipped spline cut profiles should not be flattened into planar side strips: ${JSON.stringify(sideSurfaceCounts)}`);

    const validation = validateBooleanResult(geometry.topoBody, { operation: 'subtract' }).toJSON();
    assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics, null, 2));
  } finally {
    resetFlags();
  }
});

function countOutOfBlockFaces(faces) {
  return faces.filter((face) => (face.vertices || []).some((vertex) =>
    vertex.x < -1e-6 || vertex.x > 60 + 1e-6
      || vertex.y < -1e-6 || vertex.y > 60 + 1e-6
      || vertex.z < -1e-6 || vertex.z > 21.8 + 1e-5
  )).length;
}

function countLargeUncutTopTriangles(faces) {
  return faces.filter((face) => {
    const vertices = face.vertices || [];
    if (vertices.length !== 3 || !vertices.every((vertex) => Math.abs(vertex.z - 21.8) < 1e-5)) return false;
    const [a, b, c] = vertices;
    const area = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) * 0.5;
    return area > 1000;
  }).length;
}

function countCutSideSurfaceTypes(body, featureId) {
  const counts = {};
  const sideHashMarker = `${featureId}_Cut_${featureId}_Face_Side`;
  for (const face of body?.faces?.() || []) {
    const stableHash = face.stableHash || '';
    if (!stableHash.includes(sideHashMarker)) continue;
    counts[face.surfaceType] = (counts[face.surfaceType] || 0) + 1;
  }
  return counts;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
