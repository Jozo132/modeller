// tests/test-lod-manager.js
// Regression for H14/H15 — LodManager band dispatch and GpuTessPipeline shape.
//
// WasmRenderer itself cannot be imported under plain node (DOM-only class),
// so this suite validates the two collaborators that the renderer wires in
// during its constructor: the LodManager (which fires onRetessellate when the
// camera distance crosses a band) and the static GpuTessPipeline.isAvailable
// probe that WasmRenderer uses to decide whether to construct the pipeline.

import assert from 'node:assert/strict';
import { LodManager } from '../js/render/lod-manager.js';
import { GpuTessPipeline } from '../js/render/gpu-tess-pipeline.js';
import { SceneRenderer } from '../js/render/scene-renderer.js';
import { globalTessConfig } from '../js/cad/TessellationConfig.js';

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL  ${name}\n    ${e.message}`); failed++; }
}

console.log('LodManager — default-band behaviour');

check('default bands map short distance to dense tessellation', () => {
  const lod = new LodManager();
  const { segsU, segsV } = lod.segmentsForDistance(10);
  assert.equal(segsU, 32);
  assert.equal(segsV, 32);
});

check('default bands map very long distance to coarsest tessellation', () => {
  const lod = new LodManager();
  const { segsU, segsV } = lod.segmentsForDistance(1e6);
  assert.equal(segsU, 2);
  assert.equal(segsV, 2);
});

check('update() fires onRetessellate on first call and reports the band', () => {
  const lod = new LodManager();
  const events = [];
  lod.onRetessellate = (u, v) => events.push([u, v]);
  const changed = lod.update(10);
  assert.equal(changed, true);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], [32, 32]);
  assert.equal(lod.currentBandIndex, 0);
});

check('update() does not refire when distance stays inside the same band', () => {
  const lod = new LodManager();
  const events = [];
  lod.onRetessellate = (u, v) => events.push([u, v]);
  lod.update(10);
  lod.update(15);
  lod.update(18);
  assert.equal(events.length, 1);
});

check('update() fires again when distance crosses a band boundary', () => {
  const lod = new LodManager();
  const events = [];
  lod.onRetessellate = (u, v) => events.push([u, v]);
  lod.update(10);          // band 0 (≤20)  → 32/32
  lod.update(200);         // past hysteresis → a coarser band
  assert.equal(events.length, 2);
  assert.ok(events[1][0] < 32, 'density must drop when zooming out past band 0');
  assert.ok(events[1][1] < 32);
});

check('hysteresis suppresses switch near a boundary', () => {
  const lod = new LodManager();
  lod.update(10);                    // band 0
  const changedNear = lod.update(21); // just 1 past 20 → within 10% margin
  assert.equal(changedNear, false);
  assert.equal(lod.currentBandIndex, 0);
});

check('forceSegments overrides bands and resets currentBandIndex', () => {
  const lod = new LodManager();
  lod.update(10);
  const events = [];
  lod.onRetessellate = (u, v) => events.push([u, v]);
  lod.forceSegments(48, 48);
  assert.deepEqual(lod.segments, { segsU: 48, segsV: 48 });
  assert.equal(lod.currentBandIndex, -1);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], [48, 48]);
});

check('reset() causes the next update to re-fire even at same distance', () => {
  const lod = new LodManager();
  const events = [];
  lod.onRetessellate = (u, v) => events.push([u, v]);
  lod.update(10);
  lod.reset();
  lod.update(10);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], events[1]);
});

check('custom bands override defaults', () => {
  const lod = new LodManager({
    bands: [
      { maxDistance: 5,        segsU: 64, segsV: 64 },
      { maxDistance: Infinity, segsU: 1,  segsV: 1  },
    ],
    hysteresis: 0,
  });
  assert.deepEqual(lod.segmentsForDistance(3),   { segsU: 64, segsV: 64 });
  assert.deepEqual(lod.segmentsForDistance(100), { segsU: 1,  segsV: 1  });
});

console.log('GpuTessPipeline — availability probe');

check('isAvailable() returns boolean', () => {
  const av = GpuTessPipeline.isAvailable();
  assert.equal(typeof av, 'boolean');
  // In node: no navigator.gpu → must be false. Keeps WasmRenderer on the
  // legacy CPU path when running the test suite.
  assert.equal(av, false);
});

check('constructor is callable without init', () => {
  const pipe = new GpuTessPipeline();
  assert.ok(pipe);
  // Pipeline starts un-ready; init(null) must not throw.
});

console.log('SceneRenderer — static tessellation density');

check('camera movement does not emit LoD retessellation or change selected quality', () => {
  const cfgBefore = globalTessConfig.serialize();
  const fakeWasm = {
    init() {},
    setCameraMode() {},
    setCameraUp() {},
    setGridVisible() {},
    setGridSize() {},
    setAxesVisible() {},
    setAxesSize() {},
    clearEntities() {},
    resetEntityModelMatrix() {},
    setCameraPosition() {},
    setCameraTarget() {},
    render() {},
    getCommandBufferPtr: () => 0,
    getCommandBufferLen: () => 0,
  };
  const renderer = new SceneRenderer({
    canvas: { width: 800, height: 600 },
    executor: { resize() {}, execute() {}, setViewDir() {} },
    wasmModule: fakeWasm,
  });
  renderer.init();
  const events = [];
  renderer.lodManager.onRetessellate = (u, v) => events.push([u, v]);
  renderer.setOrbitState({ radius: 10 });
  renderer.renderFrame();
  renderer.setOrbitState({ radius: 1000 });
  renderer.renderFrame();
  assert.deepEqual(events, [], 'camera movement must not retessellate dynamically');
  assert.deepEqual(globalTessConfig.serialize(), cfgBefore, 'selected tessellation preset should stay static');
});

check('init() is idempotent for an injected wasm module', async () => {
  let initCalls = 0;
  const fakeWasm = {
    init() { initCalls++; },
    setCameraMode() {},
    setCameraUp() {},
    setGridVisible() {},
    setGridSize() {},
    setAxesVisible() {},
    setAxesSize() {},
    clearEntities() {},
    resetEntityModelMatrix() {},
  };
  const renderer = new SceneRenderer({
    canvas: { width: 800, height: 600 },
    executor: { resize() {}, execute() {}, setViewDir() {} },
    wasmModule: fakeWasm,
  });
  await renderer.init();
  await renderer.init();
  assert.equal(initCalls, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
