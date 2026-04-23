import './_watchdog.mjs';
// tests/test-fast-restore-opt-out.js
// Regression — features exposing `canFastRestoreFromCbrep() === false` force
// FeatureTree.tryFastRestoreFromCheckpoints to bail out and fall through to
// the full executeAll replay. This is the protection against corrupted
// restored geometry for STEP imports (the JS-side CBREP roundtrip is
// known-lossy for analytic-surface metadata; see StepImportFeature
// canFastRestoreFromCbrep() docblock).

import assert from 'node:assert/strict';
import { FeatureTree } from '../js/cad/FeatureTree.js';
import { Feature } from '../js/cad/Feature.js';

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL  ${name}\n    ${e.message}`); failed++; }
}

class StubSolid extends Feature {
  constructor(name) { super(name); this.type = 'stub-solid'; }
  canExecute() { return true; }
  execute() { return { type: 'solid', geometry: { faces: [{}] }, irHash: 'stub' }; }
}

class OptsOutSolid extends StubSolid {
  canFastRestoreFromCbrep() { return false; }
}

const fakeDeps = {
  readCbrep: () => ({}),
  tessellateBody: () => ({ faces: [{}] }),
  computeFeatureEdges: () => ({ edges: [], paths: [], visualEdges: [] }),
  calculateMeshVolume: () => 1,
  calculateBoundingBox: () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }),
};

console.log('Fast-restore opt-out (STEP import protection)\n');

check('opts-out feature forces tryFastRestoreFromCheckpoints to return false', () => {
  const tree = new FeatureTree();
  const a = new StubSolid('A');
  const b = new OptsOutSolid('B');
  tree.features.push(a); tree.features.push(b);
  tree.featureMap.set(a.id, a); tree.featureMap.set(b.id, b);
  const checkpoints = {
    [a.id]: { payload: 'dGVzdA==', hash: 'hA' },
    [b.id]: { payload: 'dGVzdA==', hash: 'hB' },
  };
  const ok = tree.tryFastRestoreFromCheckpoints(checkpoints, fakeDeps);
  assert.equal(ok, false, 'bails out when any feature opts out');
  assert.deepEqual(tree.results, {}, 'no results populated when opt-out fires');
});

check('tree without opt-out features still fast-restores', () => {
  const tree = new FeatureTree();
  const a = new StubSolid('A');
  tree.features.push(a);
  tree.featureMap.set(a.id, a);
  // Build a real CBREP so readCbrep succeeds — use a stub payload and a
  // stub readCbrep that returns a minimal TopoBody-shaped object.
  const checkpoints = {
    [a.id]: { payload: 'dGVzdA==', hash: 'hA' },
  };
  const ok = tree.tryFastRestoreFromCheckpoints(checkpoints, {
    ...fakeDeps,
    tessellateBody: () => ({ faces: [{ normal: { x: 0, y: 0, z: 1 }, vertices: [] }], edges: [] }),
  });
  assert.equal(ok, true, 'succeeds when no feature opts out');
});

check('StepImportFeature exposes canFastRestoreFromCbrep === false', async () => {
  const mod = await import('../js/cad/StepImportFeature.js');
  const f = new mod.StepImportFeature('Import', 'ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n');
  assert.equal(typeof f.canFastRestoreFromCbrep, 'function');
  assert.equal(f.canFastRestoreFromCbrep(), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
