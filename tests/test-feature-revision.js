// tests/test-feature-revision.js — Tests for exactBodyRevisionId + irHash in feature results
//
// Validates that FeatureTree stamps solid results with:
//   - exactBodyRevisionId (monotonic counter)
//   - irHash (propagated from feature instance when available)
//   - wasmHandleId (when a registry is attached)

import { FeatureTree } from '../js/cad/FeatureTree.js';
import { Feature } from '../js/cad/Feature.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`  \u2713 ${msg}`);
    passed++;
  } else {
    console.error(`  \u2717 ${msg}`);
    failed++;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Minimal solid-producing feature for testing. */
class StubSolid extends Feature {
  constructor(name) {
    super(name);
    this.type = 'stub-solid';
  }
  execute(_ctx) {
    return { type: 'solid', geometry: {}, solid: {}, volume: 1, boundingBox: {} };
  }
}

/** Solid feature that exposes _irHash (simulating StepImportFeature). */
class StubSolidWithHash extends Feature {
  constructor(name, hash) {
    super(name);
    this.type = 'stub-solid-hash';
    this._irHash = hash;
  }
  execute(_ctx) {
    return { type: 'solid', geometry: {}, solid: {}, volume: 1, boundingBox: {} };
  }
}

/** Sketch-like feature that produces a non-solid result. */
class StubSketch extends Feature {
  constructor(name) {
    super(name);
    this.type = 'stub-sketch';
  }
  execute(_ctx) {
    return { type: 'sketch', geometry: {}, curves: [] };
  }
}

/** Minimal mock of WasmBrepHandleRegistry for testing. */
class MockHandleRegistry {
  constructor() {
    this.ready = true;
    this.UNMATERIALIZED = 0;
    this._nextHandle = 1;
    this._handles = new Map();
    this._residencies = new Map();
    this._featureIds = new Map();
    this._revisions = new Map();
    this._released = [];
  }
  alloc() {
    const h = this._nextHandle++;
    this._handles.set(h, true);
    return h;
  }
  release(h) {
    this._handles.delete(h);
    this._released.push(h);
  }
  isValid(h) {
    return this._handles.has(h);
  }
  setResidency(h, s) { this._residencies.set(h, s); }
  getResidency(h) { return this._residencies.get(h) ?? -1; }
  setFeatureId(h, fid) { this._featureIds.set(h, fid); }
  bumpRevision(h) { this._revisions.set(h, (this._revisions.get(h) || 0) + 1); }
}

// ── Tests ────────────────────────────────────────────────────────────────

console.log('=== exactBodyRevisionId ===');

{
  const tree = new FeatureTree();
  const f1 = new StubSolid('box');
  tree.addFeature(f1);
  const r1 = tree.results[f1.id];
  assert(r1.type === 'solid', 'result is solid');
  assert(typeof r1.exactBodyRevisionId === 'number', 'revisionId is a number');
  assert(r1.exactBodyRevisionId > 0, 'revisionId is positive');
}

{
  const tree = new FeatureTree();
  const f1 = new StubSolid('a');
  const f2 = new StubSolid('b');
  tree.addFeature(f1);
  tree.addFeature(f2);
  const r1 = tree.results[f1.id];
  const r2 = tree.results[f2.id];
  assert(r2.exactBodyRevisionId > r1.exactBodyRevisionId,
    'revisionId is monotonically increasing across features');
}

{
  const tree = new FeatureTree();
  const f1 = new StubSolid('a');
  tree.addFeature(f1);
  const rev1 = tree.results[f1.id].exactBodyRevisionId;
  tree.markModified(f1.id);
  const rev2 = tree.results[f1.id].exactBodyRevisionId;
  assert(rev2 > rev1, 'revisionId bumps on recalculation');
}

{
  const tree = new FeatureTree();
  const sk = new StubSketch('sketch1');
  tree.addFeature(sk);
  const r = tree.results[sk.id];
  assert(r.exactBodyRevisionId === undefined, 'sketch results have no revisionId');
}

console.log('\n=== irHash propagation ===');

{
  const tree = new FeatureTree();
  const f = new StubSolidWithHash('import', 'abcdef0123456789');
  tree.addFeature(f);
  const r = tree.results[f.id];
  assert(r.irHash === 'abcdef0123456789', 'irHash propagated from feature to result');
}

{
  const tree = new FeatureTree();
  const f = new StubSolid('box');
  tree.addFeature(f);
  const r = tree.results[f.id];
  assert(r.irHash === undefined, 'result without _irHash has no irHash field');
}

console.log('\n=== WASM handle lifecycle ===');

{
  const tree = new FeatureTree();
  const reg = new MockHandleRegistry();
  tree.setHandleRegistry(reg);

  const f1 = new StubSolid('box');
  tree.addFeature(f1);
  const r1 = tree.results[f1.id];
  assert(typeof r1.wasmHandleId === 'number' && r1.wasmHandleId > 0,
    'solid result gets wasmHandleId when registry attached');
  assert(reg.isValid(r1.wasmHandleId), 'handle is valid in registry');
}

{
  const tree = new FeatureTree();
  const reg = new MockHandleRegistry();
  tree.setHandleRegistry(reg);

  const f1 = new StubSolid('box');
  tree.addFeature(f1);
  const oldHandle = tree.results[f1.id].wasmHandleId;

  // Recalculation replaces the result — old handle should be released
  tree.markModified(f1.id);
  const newHandle = tree.results[f1.id].wasmHandleId;
  assert(!reg.isValid(oldHandle), 'old handle released on recalculation');
  assert(reg.isValid(newHandle), 'new handle allocated after recalculation');
  assert(newHandle !== oldHandle, 'new handle is different from old handle');
}

{
  const tree = new FeatureTree();
  const reg = new MockHandleRegistry();
  tree.setHandleRegistry(reg);

  const f1 = new StubSolid('box');
  tree.addFeature(f1);
  const handle = tree.results[f1.id].wasmHandleId;

  tree.removeFeature(f1.id);
  assert(!reg.isValid(handle), 'handle released on feature removal');
}

{
  const tree = new FeatureTree();
  const reg = new MockHandleRegistry();
  tree.setHandleRegistry(reg);

  const f1 = new StubSolid('a');
  const f2 = new StubSolid('b');
  tree.addFeature(f1);
  tree.addFeature(f2);
  const h1 = tree.results[f1.id].wasmHandleId;
  const h2 = tree.results[f2.id].wasmHandleId;

  tree.clear();
  assert(!reg.isValid(h1) && !reg.isValid(h2), 'clear() releases all handles');
}

{
  const tree = new FeatureTree();
  const reg = new MockHandleRegistry();
  tree.setHandleRegistry(reg);

  const sk = new StubSketch('sketch1');
  tree.addFeature(sk);
  const r = tree.results[sk.id];
  assert(r.wasmHandleId === undefined, 'sketch results do not get wasmHandleId');
}

{
  // No registry — should still work without errors
  const tree = new FeatureTree();
  const f1 = new StubSolid('box');
  tree.addFeature(f1);
  const r = tree.results[f1.id];
  assert(r.wasmHandleId === undefined, 'no wasmHandleId without registry');
  assert(r.exactBodyRevisionId > 0, 'revisionId still assigned without registry');
}

console.log('\n=== executeAll handle release ===');

{
  const tree = new FeatureTree();
  const reg = new MockHandleRegistry();
  tree.setHandleRegistry(reg);

  const f1 = new StubSolid('box');
  tree.addFeature(f1);
  const oldHandle = tree.results[f1.id].wasmHandleId;

  tree.executeAll();
  assert(!reg.isValid(oldHandle), 'executeAll releases old handles');
  const newHandle = tree.results[f1.id].wasmHandleId;
  assert(reg.isValid(newHandle), 'executeAll allocates new handles');
}

// ── Summary ──────────────────────────────────────────────────────────────

console.log(`\n=== Results ===\n\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
