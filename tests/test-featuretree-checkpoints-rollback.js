import './_watchdog.mjs';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseCMOD } from '../js/cmod.js';
import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { Feature } from '../js/cad/Feature.js';
import { FeatureTree } from '../js/cad/FeatureTree.js';
import { tessellateBody } from '../js/cad/Tessellation.js';
import { computeFeatureEdges } from '../js/cad/EdgeAnalysis.js';
import { calculateMeshVolume, calculateBoundingBox, countInvertedFaces } from '../js/cad/toolkit/MeshAnalysis.js';
import { detectBoundaryEdges, detectDegenerateFaces } from '../js/cad/MeshValidator.js';
import {
  TopoVertex, TopoEdge, TopoCoEdge, TopoLoop, TopoFace, TopoShell, TopoBody,
  SurfaceType,
} from '../js/cad/BRepTopology.js';
import { NurbsCurve } from '../js/cad/NurbsCurve.js';
import { NurbsSurface } from '../js/cad/NurbsSurface.js';
import { readCbrep, setTopoDeps } from '../packages/ir/reader.js';

setTopoDeps({
  TopoVertex, TopoEdge, TopoCoEdge, TopoLoop, TopoFace, TopoShell, TopoBody,
  NurbsCurve, NurbsSurface, SurfaceType,
});

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

function fastRestoreDeps() {
  return {
    readCbrep,
    tessellateBody,
    computeFeatureEdges,
    calculateMeshVolume,
    calculateBoundingBox,
  };
}

function loadSamplePart(fileName) {
  const raw = readFileSync(new URL(`./samples/${fileName}`, import.meta.url), 'utf8');
  return Part.deserialize(parseCMOD(raw).data.part, { fastRestoreDeps: fastRestoreDeps() });
}

function assertValidMesh(geometry, label) {
  assert.ok(geometry?.faces?.length > 0, `${label} should have display faces`);
  assert.equal(detectBoundaryEdges(geometry.faces).count, 0, `${label} should not have boundary edges`);
  assert.equal(detectDegenerateFaces(geometry.faces).count, 0, `${label} should not have degenerate faces`);
  assert.equal(countInvertedFaces(geometry), 0, `${label} should not have inverted faces`);
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

test('puzzle rollback restores historic extrude body from CBREP after forward drag', () => {
  const part = loadSamplePart('puzzle-extrude-cc.cmod');
  const tree = part.featureTree;
  const extrude = tree.features.find((feature) => feature.type === 'extrude');
  assert.ok(extrude, 'sample should contain an extrude feature');
  assert.ok(tree.results[extrude.id]?.cbrepBuffer, 'extrude should have a rollback CBREP checkpoint');

  const firstRollback = tree.applyRollbackSuppression(2);
  assert.equal(firstRollback.replayed, false, 'initial rollback should not replay the feature tree');
  assert.ok(firstRollback.restored >= 1, 'initial rollback should restore at least one solid checkpoint');

  const firstResult = tree.results[extrude.id];
  assert.equal(firstResult?._restoredFromCheckpoint, true, 'rolled-back extrude should be rebuilt from CBREP');
  assertValidMesh(firstResult.geometry, 'first rolled-back extrude');
  const firstFaceCount = firstResult.geometry.faces.length;
  const firstTopoFaceCount = firstResult.geometry.topoBody.faces().length;

  const rollForward = tree.applyRollbackSuppression(3);
  assert.equal(rollForward.replayed, false, 'rolling forward should reuse available results');

  const secondRollback = tree.applyRollbackSuppression(2);
  assert.equal(secondRollback.replayed, false, 'second rollback should not replay the feature tree');
  assert.ok(secondRollback.restored >= 1, 'second rollback should restore from checkpoint again');

  const secondResult = tree.results[extrude.id];
  assert.equal(secondResult?._restoredFromCheckpoint, true, 'second rolled-back extrude should be rebuilt from CBREP');
  assert.notEqual(secondResult.geometry, firstResult.geometry, 'second rollback should rebuild a clean mesh object');
  assert.equal(secondResult.geometry.faces.length, firstFaceCount, 'restored rollback mesh face count should be stable');
  assert.equal(secondResult.geometry.topoBody.faces().length, firstTopoFaceCount, 'restored rollback topology face count should be stable');
  assertValidMesh(secondResult.geometry, 'second rolled-back extrude');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
