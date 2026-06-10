import './_watchdog.mjs';

import assert from 'node:assert/strict';

import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { ensureWasmReady } from '../js/cad/StepImportWasm.js';
import { loadOcctKernelModule } from '../js/cad/occt/index.js';
import { edgeEntityToLegacyKey } from '../js/cad/history/StableEntityKey.js';
import { formatTimingSuffix, startTiming } from './test-timing.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  const startedAt = startTiming();
  try {
    await fn();
    console.log(`  ✓ ${name}${formatTimingSuffix(startedAt)}`);
    passed += 1;
  } catch (error) {
    console.log(`  ✗ ${name}${formatTimingSuffix(startedAt)}`);
    console.log(`    ${error?.message || String(error)}`);
    failed += 1;
  }
}

function makeRectSketch(x1, y1, x2, y2) {
  const sketch = new Sketch();
  sketch.addSegment(x1, y1, x2, y1);
  sketch.addSegment(x2, y1, x2, y2);
  sketch.addSegment(x2, y2, x1, y2);
  sketch.addSegment(x1, y2, x1, y1);
  return sketch;
}

function buildReplayFixture() {
  const part = new Part('OcctReplayFixture');
  const baseSketch = part.addSketch(makeRectSketch(0, 0, 20, 20));
  part.extrude(baseSketch.id, 20);
  const cutSketch = part.addSketch(makeRectSketch(6, 6, 14, 14));
  part.extrudeCut(cutSketch.id, 12);
  return part.serialize();
}

console.log('=== OCCT History Replay Tests ===\n');

await test('checkpoint-free replay keeps a base-extrude plus extrude-cut history on the OCCT fillet path with flag disabled', async () => {
  await ensureWasmReady();
  await loadOcctKernelModule({ fresh: true });

  const serialized = buildReplayFixture();
  delete serialized.featureTree.checkpoints;

  const part = Part.deserialize(serialized);
  const base = part.getFinalGeometry();
  const geometry = base?.geometry;
  assert.ok(geometry, 'expected replayed solid geometry');
  assert.ok(geometry.occtShapeHandle > 0, 'expected replayed solid to keep a resident OCCT handle');

  const targetPath = (geometry._occtFeaturePaths || geometry.paths || []).find(
    (path) => Array.isArray(path?.edgeIndices) && path.edgeIndices.length > 0,
  );
  assert.ok(targetPath, 'expected an executable feature path on replayed geometry');

  const edgeKeys = (targetPath.edgeIndices || [])
    .map((index) => edgeEntityToLegacyKey((geometry._occtFeatureEdges || geometry.edges || [])[index]))
    .filter(Boolean);
  assert.ok(edgeKeys.length > 0, 'expected executable edge keys from OCCT feature path');

  const fillet = part.fillet(edgeKeys.slice(0, 1), 1, { segments: 8 });
  assert.ok(!fillet?.error, `expected fillet feature to succeed, got: ${fillet?.error || 'unknown error'}`);

  const result = part.getFinalGeometry();
  assert.ok(result?.geometry?.occtShapeHandle > 0, 'expected fillet result to keep a resident OCCT handle');
  assert.ok(result?.geometry?.occtCheckpoint, 'expected fillet result to retain an OCCT checkpoint');
});

console.log(`\n=== Results ===\n\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}