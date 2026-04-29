import './_watchdog.mjs';

import assert from 'node:assert/strict';

import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { WasmBrepHandleRegistry } from '../js/cad/WasmBrepHandleRegistry.js';
import { ensureNativeExtrudeReady, tryBuildNativeExtrude } from '../js/cad/wasm/NativeExtrude.js';
import { checkWatertight } from '../js/cad/MeshValidator.js';

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

function makeRectSketch(x1, y1, x2, y2) {
  const sketch = new Sketch();
  sketch.addSegment(x1, y1, x2, y1);
  sketch.addSegment(x2, y1, x2, y2);
  sketch.addSegment(x2, y2, x1, y2);
  sketch.addSegment(x1, y2, x1, y1);
  return sketch;
}

const plane = {
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  xAxis: { x: 1, y: 0, z: 0 },
  yAxis: { x: 0, y: 1, z: 0 },
};

console.log('Native WASM extrude regression\n');

const ready = await ensureNativeExtrudeReady();
assert.equal(ready, true, 'native extrude WASM exports should load');

check('direct wrapper builds a resident watertight box', () => {
  const geometry = tryBuildNativeExtrude({
    loops: [{
      isOuter: true,
      points: [
        { x: -5, y: -5, z: 0 },
        { x: 5, y: -5, z: 0 },
        { x: 5, y: 5, z: 0 },
        { x: -5, y: 5, z: 0 },
      ],
      edges: [],
    }],
    plane,
    extrusionVector: { x: 0, y: 0, z: 10 },
    refDir: plane.xAxis,
    sourceFeatureId: 'native-test',
  });

  assert.ok(geometry, 'native extrude should return geometry');
  assert.equal(geometry.nativeExtrude, true, 'geometry should be marked native');
  assert.ok(geometry.wasmHandleId > 0, 'geometry should keep a resident handle id');
  assert.ok(geometry.faces.length > 0, 'native tessellation should produce faces');

  const watertight = checkWatertight(geometry.faces || []);
  assert.equal(watertight.boundaryCount, 0, `expected watertight mesh, got ${watertight.boundaryCount}`);
});

check('ExtrudeFeature uses the native resident path when WASM is ready', () => {
  const part = new Part('NativeExtrudePart');
  part.addSketch(makeRectSketch(-5, -5, 5, 5), plane);
  const feature = part.extrude(part.getSketches()[0].id, 10);
  assert.equal(feature.error, null, `feature should execute cleanly: ${feature.error}`);

  const geometry = feature.result?.geometry;
  assert.ok(geometry, 'feature should return geometry');
  assert.equal(geometry.nativeExtrude, true, 'feature geometry should come from native extrude');
  assert.ok(geometry.wasmHandleId > 0, 'feature geometry should keep the native handle');
  assert.ok(geometry.topoBody, 'JS exact topology should remain available for current API callers');
});

const registry = new WasmBrepHandleRegistry();
await registry.init();

check('FeatureTree adopts the native handle instead of allocating a placeholder', () => {
  const part = new Part('NativeExtrudeRegistryPart');
  part.setWasmHandleSubsystem(registry);
  part.addSketch(makeRectSketch(-5, -5, 5, 5), plane);
  const feature = part.extrude(part.getSketches()[0].id, 10);
  assert.equal(feature.error, null, `feature should execute cleanly: ${feature.error}`);

  const result = feature.result;
  const geometry = result?.geometry;
  assert.ok(geometry?.wasmHandleId > 0, 'geometry should expose the native handle');
  assert.equal(result.wasmHandleId, geometry.wasmHandleId, 'result should adopt the geometry handle');
  assert.equal(result.wasmHandleResident, true, 'adopted handle should remain resident');
  assert.equal(registry.getResidency(result.wasmHandleId), registry.RESIDENT, 'registry should mark the adopted handle resident');
});

registry.releaseAll();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);