import './_watchdog.mjs';
// tests/test-history-cbrep-checkpoints.js — C2 regression
//
// Locks in that undo/redo in js/history.js uses the same CBREP-checkpoint
// fast-restore path as .cmod load (C1):
//
//   1. PartManager.serialize() emits the H5 `checkpoints` map on the part.
//   2. takeSnapshot() stores that part snapshot verbatim in the history node.
//   3. undo() / redo() call PartManager.deserialize(snapshot.part), which
//      forwards { fastRestoreDeps: FAST_RESTORE_DEPS } to Part.deserialize,
//      which in turn drives FeatureTree.tryFastRestoreFromCheckpoints so
//      solid features skip full feature replay.
//
// This test verifies the wiring through history.js end-to-end with a mock
// PartManager so a regression in setPartManager / _restoreSnapshot / the
// PartManager.deserialize bridge surfaces here.

import { strict as assert } from 'node:assert';

import { state } from '../js/state.js';
import {
  setPartManager, takeSnapshot, undo, redo, getHistoryInfo,
} from '../js/history.js';
import { Scene } from '../js/cad/Scene.js';

function makePartSnapshot(featureId, payload, hash) {
  return {
    name: 'HistoryC2Part',
    featureTree: {
      features: [{ id: featureId, type: 'extrude', name: 'e' }],
      checkpoints: { [featureId]: { payload, hash } },
    },
    material: null,
    mass: 0,
    volume: 0,
    centerOfMass: { x: 0, y: 0, z: 0 },
  };
}

class MockPartManager {
  constructor() {
    this.part = null;
    this._snapshots = [];
    this._restored = [];
  }
  getPart() { return this.part; }
  serialize() {
    if (!this.part) return null;
    const out = JSON.parse(JSON.stringify(this.part));
    this._snapshots.push(out);
    return out;
  }
  deserialize(data, options = {}) {
    this._restored.push({ data, options });
    this.part = data;
  }
}

console.log('=== C2: history.js undo/redo forwards CBREP checkpoints ===');

let passed = 0;
const failures = [];
function step(label, fn) {
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

const pm = new MockPartManager();
state.scene = new Scene();
state._stableSelectionKeys = [];
state._undoStack = [];
state._redoStack = [];
state._maxHistory = 50;
setPartManager(pm);

const base = getHistoryInfo();
const baseLen = base.length;

pm.part = makePartSnapshot('feature_1', 'AQID', 'hash-v1');
takeSnapshot();

step('takeSnapshot captures the part produced by PartManager.serialize', () => {
  const info = getHistoryInfo();
  assert.equal(info.length - baseLen, 1, 'one new snapshot recorded');
  assert.equal(pm._snapshots.length, 1, 'serialize called exactly once for first takeSnapshot');
  const snap = pm._snapshots[0];
  assert.ok(snap.featureTree.checkpoints,
    'emitted snapshot carries featureTree.checkpoints (H5 payload)');
  assert.equal(snap.featureTree.checkpoints.feature_1.hash, 'hash-v1',
    'checkpoint hash round-trips through serialize');
});

pm.part = makePartSnapshot('feature_1', 'BAUG', 'hash-v2');
takeSnapshot();

step('second takeSnapshot advances pointer to the tip', () => {
  const info = getHistoryInfo();
  assert.equal(info.length - baseLen, 2, 'two new snapshots recorded');
  assert.equal(info.pointer, info.length - 1, 'pointer at tip of history');
});

const restoredBeforeUndo = pm._restored.length;
undo();

step('undo invokes PartManager.deserialize with the v1 checkpoint payload', () => {
  assert.ok(pm._restored.length > restoredBeforeUndo, 'deserialize invoked during undo');
  const last = pm._restored[pm._restored.length - 1];
  assert.ok(last.data && last.data.featureTree && last.data.featureTree.checkpoints,
    'restored payload carries featureTree.checkpoints');
  assert.equal(last.data.featureTree.checkpoints.feature_1.hash, 'hash-v1',
    'deserialize receives the v1 (older) checkpoint payload on undo');
});

step('history.js calls deserialize with empty options so PartManager injects FAST_RESTORE_DEPS', () => {
  const last = pm._restored[pm._restored.length - 1];
  assert.deepEqual(last.options, {},
    'history.js calls PartManager.deserialize with no options');
});

const restoredBeforeRedo = pm._restored.length;
redo();

step('redo invokes PartManager.deserialize with the v2 checkpoint payload', () => {
  assert.equal(pm._restored.length, restoredBeforeRedo + 1,
    'redo triggers exactly one deserialize');
  const seen = pm._restored[pm._restored.length - 1];
  assert.equal(seen.data.featureTree.checkpoints.feature_1.hash, 'hash-v2',
    'deserialize receives the v2 (newer) checkpoint payload on redo');
});

if (failures.length === 0) {
  console.log(`\n\u2713 All ${passed} C2 history-checkpoint assertions passed.`);
  process.exit(0);
} else {
  console.log(`\n\u2717 ${failures.length} of ${passed + failures.length} assertions failed.`);
  process.exit(1);
}
