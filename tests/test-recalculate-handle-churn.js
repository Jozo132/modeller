import './_watchdog.mjs';
// tests/test-recalculate-handle-churn.js
// H3/H4 full — input-fingerprint short-circuit on FeatureTree.recalculateFrom.
//
// When a feature's serialized parameters and its dependencies' irHashes are
// all unchanged since the previous successful execute, recalculateFrom must
// skip re-executing that feature, preserve its result and WASM handle, and
// leave its revision id unchanged. Only features whose inputs actually
// changed (the direct edit target and its transitive dependents whose deps'
// irHashes changed) should re-execute.

import assert from 'node:assert/strict';
import { FeatureTree } from '../js/cad/FeatureTree.js';
import { Feature } from '../js/cad/Feature.js';

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL  ${name}\n    ${e.message}\n${e.stack}`); failed++; }
}

// --- Test doubles --------------------------------------------------------
let nextHandle = 1;
class MockHandleRegistry {
  constructor() {
    this.ready = true;
    this.UNMATERIALIZED = 0; this.PENDING = 1; this.RESIDENT = 2;
    this.alive = new Set();
    this.allocCalls = 0;
    this.releaseCalls = 0;
  }
  alloc() { this.allocCalls++; const h = nextHandle++; this.alive.add(h); return h; }
  release(h) { this.releaseCalls++; this.alive.delete(h); }
  setResidency() {}
  setFeatureId() {}
  bumpRevision() {}
}

class StubSolidFeature extends Feature {
  constructor(name, param, depId = null) {
    super(name);
    this.type = 'solid_stub';
    this._param = param;
    this._execCount = 0;
    if (depId) this.dependencies.push(depId);
  }
  serialize() { return { ...super.serialize(), param: this._param }; }
  execute(context) {
    this._execCount++;
    // irHash depends on param + deps' irHashes so that when inputs are
    // identical the output is too.
    const depHashParts = this.dependencies.map(d => context.results[d]?.irHash ?? '');
    const irHash = `solid:${this._param}:${depHashParts.join(',')}`;
    return {
      type: 'solid',
      geometry: { faces: [{}], edges: [] },
      irHash,
    };
  }
  setParam(p) { this._param = p; this.modified = new Date(); }
}

// --- Tests ---------------------------------------------------------------

console.log('recalculateFrom handle-churn / input-fingerprint (H3/H4 full)\n');

check('executeAll stamps _lastInputFingerprint on each feature', () => {
  const tree = new FeatureTree();
  const a = new StubSolidFeature('A', 1);
  const b = new StubSolidFeature('B', 2, a.id);
  tree.addFeature(a); tree.addFeature(b);
  tree.executeAll();
  assert.ok(a._lastInputFingerprint, 'A has fingerprint after executeAll');
  assert.ok(b._lastInputFingerprint, 'B has fingerprint after executeAll');
});

check('no-op recalculateFrom skips re-execute when inputs unchanged', () => {
  const tree = new FeatureTree();
  const a = new StubSolidFeature('A', 1);
  const b = new StubSolidFeature('B', 2, a.id);
  const c = new StubSolidFeature('C', 3, b.id);
  tree.addFeature(a); tree.addFeature(b); tree.addFeature(c);
  tree.executeAll();
  const execA0 = a._execCount, execB0 = b._execCount, execC0 = c._execCount;
  // Recalculate without changing anything — should short-circuit all three.
  tree.recalculateFrom(a.id);
  assert.equal(a._execCount, execA0, 'A not re-executed');
  assert.equal(b._execCount, execB0, 'B not re-executed');
  assert.equal(c._execCount, execC0, 'C not re-executed');
});

check('edit to A re-executes A, B, C (irHash cascade propagates)', () => {
  const tree = new FeatureTree();
  const a = new StubSolidFeature('A', 1);
  const b = new StubSolidFeature('B', 2, a.id);
  const c = new StubSolidFeature('C', 3, b.id);
  tree.addFeature(a); tree.addFeature(b); tree.addFeature(c);
  tree.executeAll();
  const [a0, b0, c0] = [a._execCount, b._execCount, c._execCount];
  a.setParam(999); // mutates A's serialize()
  tree.recalculateFrom(a.id);
  assert.equal(a._execCount, a0 + 1, 'A re-executed once (edit)');
  assert.equal(b._execCount, b0 + 1, 'B re-executed (A irHash changed)');
  assert.equal(c._execCount, c0 + 1, 'C re-executed (B irHash changed)');
});

check('edit to B does NOT re-execute upstream A but DOES re-execute C', () => {
  const tree = new FeatureTree();
  const a = new StubSolidFeature('A', 1);
  const b = new StubSolidFeature('B', 2, a.id);
  const c = new StubSolidFeature('C', 3, b.id);
  tree.addFeature(a); tree.addFeature(b); tree.addFeature(c);
  tree.executeAll();
  const [a0, b0, c0] = [a._execCount, b._execCount, c._execCount];
  b.setParam(42);
  tree.recalculateFrom(b.id);
  assert.equal(a._execCount, a0, 'A not re-executed (upstream, untouched)');
  assert.equal(b._execCount, b0 + 1, 'B re-executed (edit target)');
  assert.equal(c._execCount, c0 + 1, 'C re-executed (B irHash changed)');
});

check('downstream skip preserves WASM handle (no handle churn)', () => {
  const tree = new FeatureTree();
  const reg = new MockHandleRegistry();
  tree.setHandleRegistry(reg);
  const a = new StubSolidFeature('A', 1);
  const b = new StubSolidFeature('B', 2, a.id);
  tree.addFeature(a); tree.addFeature(b);
  tree.executeAll();
  const handleAfterExecute = reg.allocCalls;
  const releasesAfterExecute = reg.releaseCalls;
  const bHandleBefore = tree.results[b.id].wasmHandleId;
  // No-op recalc — B's fingerprint matches, handle should not churn.
  tree.recalculateFrom(a.id);
  assert.equal(reg.allocCalls, handleAfterExecute, 'no new handles allocated on no-op recalc');
  assert.equal(reg.releaseCalls, releasesAfterExecute, 'no handles released on no-op recalc');
  assert.equal(tree.results[b.id].wasmHandleId, bHandleBefore, 'B kept its handle');
});

check('no-op recalc does NOT bump revision counter', () => {
  const tree = new FeatureTree();
  const a = new StubSolidFeature('A', 1);
  const b = new StubSolidFeature('B', 2, a.id);
  tree.addFeature(a); tree.addFeature(b);
  tree.executeAll();
  const revBefore = tree._revisionCounter;
  tree.recalculateFrom(a.id);
  assert.equal(tree._revisionCounter, revBefore, 'revision counter unchanged on no-op');
});

check('fingerprint captures serialized params (toggling param re-executes)', () => {
  const tree = new FeatureTree();
  const a = new StubSolidFeature('A', 1);
  tree.addFeature(a);
  tree.executeAll();
  const exec0 = a._execCount;
  // Set same param — fingerprint unchanged.
  a.setParam(1);
  tree.recalculateFrom(a.id);
  assert.equal(a._execCount, exec0, 'same param does not re-execute');
  // Set different param — fingerprint differs.
  a.setParam(2);
  tree.recalculateFrom(a.id);
  assert.equal(a._execCount, exec0 + 1, 'different param re-executes');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
