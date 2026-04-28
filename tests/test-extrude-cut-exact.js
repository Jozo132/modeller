import './_watchdog.mjs';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Part } from '../js/cad/Part.js';
import { calculateMeshVolume } from '../js/cad/toolkit/MeshAnalysis.js';
import { checkWatertight } from '../js/cad/MeshValidator.js';
import { validateBooleanResult } from '../js/cad/BooleanInvariantValidator.js';

function loadPart(sampleName) {
  const sample = JSON.parse(readFileSync(new URL(`./samples/${sampleName}`, import.meta.url), 'utf8'));
  return Part.deserialize(sample.part);
}

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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
