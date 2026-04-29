import './_watchdog.mjs';

import assert from 'node:assert/strict';

import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { Feature } from '../js/cad/Feature.js';
import { FeatureTree } from '../js/cad/FeatureTree.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}\n    ${err.message}`);
    failed++;
  }
}

function makeRectSketch() {
  const sketch = new Sketch();
  sketch.addSegment(0, 0, 10, 0);
  sketch.addSegment(10, 0, 10, 10);
  sketch.addSegment(10, 10, 0, 10);
  sketch.addSegment(0, 10, 0, 0);
  return sketch;
}

class DummySolidFeature extends Feature {
  constructor(name) {
    super(name);
    this.type = 'dummy-solid';
    this.executeCount = 0;
  }

  canExecute() {
    return true;
  }

  execute() {
    this.executeCount++;
    return {
      type: 'solid',
      geometry: { faces: [] },
      solid: { geometry: { faces: [] } },
      volume: 0,
      boundingBox: null,
    };
  }
}

console.log('FeatureTree checkpoints and rollback\n');

test('generic solid feature results capture CBREP checkpoints', () => {
  const part = new Part('CheckpointCapture');
  part.addSketch(makeRectSketch(), {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
  });
  const extrude = part.extrude(part.getSketches()[0].id, 5);
  const result = part.featureTree.results[extrude.id];
  const serialized = part.serialize();

  assert.ok(result?.cbrepBuffer, 'extrude result should carry a CBREP buffer');
  assert.ok(result?.irHash, 'extrude result should carry an IR hash');
  assert.ok(serialized.featureTree?.checkpoints?.[extrude.id]?.payload, 'serialized tree should include the extrude checkpoint');
  assert.equal(serialized.featureTree.checkpoints[extrude.id].hash, result.irHash);
});

test('rollback suppression reuses cached results without replaying', () => {
  const tree = new FeatureTree();
  const first = new DummySolidFeature('First');
  const second = new DummySolidFeature('Second');
  const third = new DummySolidFeature('Third');

  tree.addFeature(first);
  tree.addFeature(second);
  tree.addFeature(third);
  tree.executeAll();

  const counts = [first.executeCount, second.executeCount, third.executeCount];
  const rollback = tree.applyRollbackSuppression(1);
  assert.equal(rollback.replayed, false);
  assert.deepEqual([first.executeCount, second.executeCount, third.executeCount], counts);
  assert.equal(first.suppressed, false);
  assert.equal(second.suppressed, true);
  assert.equal(third.suppressed, true);

  const rollForward = tree.applyRollbackSuppression(3);
  assert.equal(rollForward.replayed, false);
  assert.deepEqual([first.executeCount, second.executeCount, third.executeCount], counts);
  assert.equal(first.suppressed, false);
  assert.equal(second.suppressed, false);
  assert.equal(third.suppressed, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
