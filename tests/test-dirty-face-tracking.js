import './_watchdog.mjs';
// tests/test-dirty-face-tracking.js — C3 dirty-face tracking regression
//
// Validates the new DirtyFaceTracker plumbing that the kernel audit flagged
// as missing (grep for `dirtyFaces|invalidatedFaceIds` used to return 0 hits):
//
//   1. Tracker primitive semantics (mark / clear / isAllDirty / superset rule).
//   2. FeatureTree integration — every new solid result stamps
//      `allFacesDirty: true` and `invalidatedFaceIds: null`.
//   3. Features that opt in to discrete tracking keep their narrow face set.
//   4. removeFeature / clear drop tracker state.

import { strict as assert } from 'node:assert';

import { DirtyFaceTracker, stampDirtyFieldsOnResult } from '../js/cad/DirtyFaceTracker.js';
import { FeatureTree } from '../js/cad/FeatureTree.js';
import { Feature } from '../js/cad/Feature.js';

console.log('=== C3: DirtyFaceTracker primitive ===');

let passed = 0;
const failures = [];
function test(label, fn) {
  try {
    fn();
    console.log(`  \u2713 ${label}`);
    passed++;
  } catch (err) {
    console.log(`  \u2717 ${label}`);
    console.log(`    ${err && err.stack ? err.stack : err}`);
    failures.push(label);
  }
}

test('new tracker reports every feature as clean', () => {
  const t = new DirtyFaceTracker();
  assert.ok(t.isClean('f1'));
  assert.ok(!t.isAllDirty('f1'));
  assert.equal(t.getDirtyFaceIds('f1').size, 0);
});

test('markAllDirty flips the feature to allDirty', () => {
  const t = new DirtyFaceTracker();
  t.markAllDirty('f1');
  assert.ok(t.isAllDirty('f1'));
  assert.ok(!t.isClean('f1'));
  assert.equal(t.getDirtyFaceIds('f1').size, 0,
    'getDirtyFaceIds returns empty set when allDirty — callers use isAllDirty');
});

test('markFaceDirty accumulates discrete face ids', () => {
  const t = new DirtyFaceTracker();
  t.markFaceDirty('f1', 'face_a');
  t.markFaceDirty('f1', 'face_b');
  t.markFaceDirty('f1', 'face_a'); // duplicate
  const dirty = t.getDirtyFaceIds('f1');
  assert.equal(dirty.size, 2);
  assert.ok(dirty.has('face_a') && dirty.has('face_b'));
  assert.ok(!t.isAllDirty('f1'));
  assert.ok(!t.isClean('f1'));
});

test('markAllDirty subsumes any pre-existing discrete set', () => {
  const t = new DirtyFaceTracker();
  t.markFaceDirty('f1', 'face_a');
  t.markAllDirty('f1');
  assert.ok(t.isAllDirty('f1'));
  assert.equal(t.getDirtyFaceIds('f1').size, 0);
});

test('markFaceDirty after markAllDirty is a no-op', () => {
  const t = new DirtyFaceTracker();
  t.markAllDirty('f1');
  t.markFaceDirty('f1', 'face_a');
  assert.ok(t.isAllDirty('f1'), 'still allDirty');
  assert.equal(t.getDirtyFaceIds('f1').size, 0,
    'markFaceDirty does not create a phantom discrete set on an allDirty feature');
});

test('markFacesDirty is the bulk variant of markFaceDirty', () => {
  const t = new DirtyFaceTracker();
  t.markFacesDirty('f1', ['face_a', 'face_b', 'face_c']);
  assert.equal(t.getDirtyFaceIds('f1').size, 3);
});

test('clear(featureId) drops per-feature state', () => {
  const t = new DirtyFaceTracker();
  t.markAllDirty('f1');
  t.markFaceDirty('f2', 'face_a');
  t.clear('f1');
  assert.ok(t.isClean('f1'));
  assert.equal(t.getDirtyFaceIds('f2').size, 1);
});

test('clearAll drops everything', () => {
  const t = new DirtyFaceTracker();
  t.markAllDirty('f1');
  t.markFaceDirty('f2', 'face_a');
  t.clearAll();
  assert.ok(t.isClean('f1'));
  assert.ok(t.isClean('f2'));
});

test('snapshot reports allDirty distinctly from discrete sets', () => {
  const t = new DirtyFaceTracker();
  t.markAllDirty('f1');
  t.markFaceDirty('f2', 'face_a');
  const snap = t.snapshot();
  assert.ok(snap.f1.allDirty);
  assert.equal(snap.f1.faceIds, null);
  assert.equal(snap.f2.allDirty, false);
  assert.deepEqual(snap.f2.faceIds, ['face_a']);
});

test('stampDirtyFieldsOnResult — allDirty sets allFacesDirty=true, invalidatedFaceIds=null', () => {
  const t = new DirtyFaceTracker();
  t.markAllDirty('f1');
  const result = {};
  stampDirtyFieldsOnResult(result, 'f1', t);
  assert.equal(result.allFacesDirty, true);
  assert.equal(result.invalidatedFaceIds, null);
});

test('stampDirtyFieldsOnResult — discrete dirty ids land on invalidatedFaceIds', () => {
  const t = new DirtyFaceTracker();
  t.markFaceDirty('f1', 'face_a');
  t.markFaceDirty('f1', 'face_b');
  const result = {};
  stampDirtyFieldsOnResult(result, 'f1', t);
  assert.equal(result.allFacesDirty, false);
  assert.deepEqual(result.invalidatedFaceIds.sort(), ['face_a', 'face_b']);
});

test('stampDirtyFieldsOnResult — clean feature stamps empty list', () => {
  const t = new DirtyFaceTracker();
  const result = {};
  stampDirtyFieldsOnResult(result, 'f1', t);
  assert.equal(result.allFacesDirty, false);
  assert.deepEqual(result.invalidatedFaceIds, []);
});

// ---------------------------------------------------------------------------

console.log('\n=== C3: FeatureTree integration ===');

class StubSolid extends Feature {
  constructor(name) { super(name); this.type = 'stub-solid'; }
  canExecute() { return true; }
  execute() { return { type: 'solid', geometry: {}, volume: 1, boundingBox: {} }; }
}

test('fresh solid result stamps allFacesDirty=true and invalidatedFaceIds=null', () => {
  const tree = new FeatureTree();
  const f1 = new StubSolid('box');
  tree.addFeature(f1);
  const r = tree.results[f1.id];
  assert.equal(r.type, 'solid');
  assert.equal(r.allFacesDirty, true);
  assert.equal(r.invalidatedFaceIds, null);
  assert.ok(tree.isAllFacesDirty(f1.id));
});

test('markFaceDirty before stamping preserves the discrete set when _dirtyOverride is set', () => {
  // Contract: a feature.execute() impl that knows which faces it mutated
  // can call tree.markFaceDirty(id, faceId) BEFORE returning, and set
  // result._dirtyOverride = true so _stampSolidResult keeps the discrete
  // set instead of widening to allDirty.
  class SelectiveSolid extends Feature {
    constructor(tree) { super('selective'); this.type = 'selective'; this._tree = tree; }
    canExecute() { return true; }
    execute() {
      this._tree.markFaceDirty(this.id, 'face_42');
      return {
        type: 'solid', geometry: {}, volume: 1, boundingBox: {},
        _dirtyOverride: true,
      };
    }
  }
  const tree = new FeatureTree();
  const f = new SelectiveSolid(tree);
  tree.addFeature(f);
  const r = tree.results[f.id];
  assert.equal(r.allFacesDirty, false);
  assert.deepEqual(r.invalidatedFaceIds, ['face_42']);
  assert.ok(!tree.isAllFacesDirty(f.id));
  assert.equal(tree.getDirtyFaceIds(f.id).size, 1);
});

test('clearDirtyFaces drops the feature\'s dirty state', () => {
  const tree = new FeatureTree();
  const f1 = new StubSolid('box');
  tree.addFeature(f1);
  assert.ok(tree.isAllFacesDirty(f1.id));
  tree.clearDirtyFaces(f1.id);
  assert.ok(!tree.isAllFacesDirty(f1.id));
  assert.equal(tree.getDirtyFaceIds(f1.id).size, 0);
});

test('removeFeature scrubs tracker state', () => {
  const tree = new FeatureTree();
  const f1 = new StubSolid('a');
  tree.addFeature(f1);
  tree.removeFeature(f1.id);
  assert.ok(!tree.isAllFacesDirty(f1.id));
});

test('clear() scrubs all tracker state', () => {
  const tree = new FeatureTree();
  const f1 = new StubSolid('a');
  const f2 = new StubSolid('b');
  tree.addFeature(f1);
  tree.addFeature(f2);
  assert.ok(tree.isAllFacesDirty(f1.id));
  assert.ok(tree.isAllFacesDirty(f2.id));
  tree.clear();
  assert.ok(!tree.isAllFacesDirty(f1.id));
  assert.ok(!tree.isAllFacesDirty(f2.id));
});

test('markModified re-stamps allFacesDirty on recalculation', () => {
  const tree = new FeatureTree();
  const f1 = new StubSolid('box');
  tree.addFeature(f1);
  tree.clearDirtyFaces(f1.id);
  assert.ok(!tree.isAllFacesDirty(f1.id), 'cleared before markModified');
  tree.markModified(f1.id);
  assert.ok(tree.isAllFacesDirty(f1.id),
    'recalculated feature is flagged dirty again for downstream consumers');
  assert.equal(tree.results[f1.id].allFacesDirty, true);
});

// ---------------------------------------------------------------------------

if (failures.length === 0) {
  console.log(`\n\u2713 All ${passed} C3 dirty-face assertions passed.`);
  process.exit(0);
} else {
  console.log(`\n\u2717 ${failures.length} of ${passed + failures.length} assertions failed.`);
  process.exit(1);
}
