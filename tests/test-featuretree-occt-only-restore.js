import assert from 'node:assert/strict';

import { Feature } from '../js/cad/Feature.js';
import { FeatureTree } from '../js/cad/FeatureTree.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (error) {
    console.error(`  FAIL  ${name}\n    ${error.message}`);
    failed++;
  }
}

class DummySolidFeature extends Feature {
  constructor(name = 'Dummy Solid') {
    super(name);
    this.type = 'dummy-solid';
  }

  canExecute() {
    return true;
  }

  execute() {
    return {
      type: 'solid',
      geometry: { faces: [{ normal: { x: 0, y: 0, z: 1 }, vertices: [] }], edges: [], paths: [], visualEdges: [] },
      solid: { geometry: { faces: [{ normal: { x: 0, y: 0, z: 1 }, vertices: [] }], edges: [], paths: [], visualEdges: [] }, body: null },
      body: null,
    };
  }
}

function makeOcctCheckpoint(overrides = {}) {
  return {
    brep: 'occt-checkpoint',
    revision: {
      revisionId: 'rev-1',
      topologyHash: 'topo-1',
      ...(overrides.revision || {}),
    },
    ...overrides,
  };
}

function makeOcctResult(checkpoint = makeOcctCheckpoint()) {
  const topology = {
    revisionId: checkpoint.revision?.revisionId || 'rev-1',
    topologyHash: checkpoint.revision?.topologyHash || 'topo-1',
    boundingBox: { xMin: 0, yMin: 0, zMin: 0, xMax: 1, yMax: 1, zMax: 1 },
    volume: 1,
  };
  const geometry = {
    faces: [{
      vertices: [
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
        { x: 0, y: 1, z: 0 },
      ],
      normal: { x: 0, y: 0, z: 1 },
    }],
    edges: [],
    paths: [],
    visualEdges: [],
    _occtModeling: {
      authoritative: true,
      source: 'checkpoint-restore',
      topology,
    },
  };
  return {
    type: 'solid',
    geometry,
    solid: { geometry, body: null },
    body: null,
    volume: topology.volume,
    boundingBox: topology.boundingBox,
    occtShapeHandle: 1,
    occtShapeResident: true,
    _occtModeling: geometry._occtModeling,
    occtCheckpoint: checkpoint,
    _restoredFromCheckpoint: true,
  };
}

function createTreeWithFeature() {
  const tree = new FeatureTree();
  const feature = new DummySolidFeature();
  tree.features.push(feature);
  tree.featureMap.set(feature.id, feature);
  return { tree, feature };
}

console.log('FeatureTree OCCT-only restore policy\n');

test('fast restore accepts OCCT checkpoints without legacy deps', () => {
  const { tree, feature } = createTreeWithFeature();
  const checkpoint = makeOcctCheckpoint();
  let hydrationAttempts = 0;
  tree.hydrateExistingResultsFromCbrep = () => {
    hydrationAttempts++;
    return true;
  };
  tree._buildSolidResultFromOcctCheckpoint = (_featureId, occtCheckpoint) => makeOcctResult(occtCheckpoint);

  const restored = tree.tryFastRestoreFromCheckpoints({
    [feature.id]: { occt: checkpoint },
  });

  assert.equal(restored, true, 'OCCT checkpoint should restore without any legacy deps');
  assert.equal(hydrationAttempts, 0, 'OCCT fast restore should not rehydrate legacy CBREP handles');
  assert.equal(tree.results[feature.id]?._restoredFromCheckpoint, true, 'restored result should be marked as checkpoint-restored');
  assert.equal(tree.results[feature.id]?.occtTopologyHash, checkpoint.revision.topologyHash, 'restored result should keep the OCCT topology hash');
});

test('fast restore rejects payload-only checkpoints even when legacy deps are supplied', () => {
  const { tree, feature } = createTreeWithFeature();

  const restored = tree.tryFastRestoreFromCheckpoints({
    [feature.id]: {
      payload: 'legacy-payload',
      hash: 'legacy-hash',
      version: 'legacy-version',
    },
  }, {
    readCbrep() { throw new Error('legacy restore should not run'); },
    tessellateBody() { throw new Error('legacy restore should not run'); },
    computeFeatureEdges() { throw new Error('legacy restore should not run'); },
    calculateMeshVolume() { throw new Error('legacy restore should not run'); },
    calculateBoundingBox() { throw new Error('legacy restore should not run'); },
  });

  assert.equal(restored, false, 'payload-only checkpoints should no longer be accepted');
});

test('serialize emits only OCCT checkpoints for solid results', () => {
  const { tree, feature } = createTreeWithFeature();
  const checkpoint = makeOcctCheckpoint({ revision: { revisionId: 'rev-2', topologyHash: 'topo-2' } });
  tree.results[feature.id] = {
    ...makeOcctResult(checkpoint),
    cbrepBuffer: new ArrayBuffer(8),
    cbrepCacheVersion: 'legacy-version',
    irHash: 'legacy-hash',
  };

  const serialized = tree.serialize();
  const entry = serialized.checkpoints?.[feature.id];

  assert.ok(entry?.occt, 'serialized checkpoints should retain the OCCT checkpoint');
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'payload'), false, 'serialized checkpoints should not emit a CBREP payload');
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'hash'), false, 'serialized checkpoints should not emit a legacy CBREP hash');
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'version'), false, 'serialized checkpoints should not emit a legacy CBREP version');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);