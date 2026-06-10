import assert from 'node:assert/strict';

import { Feature } from '../js/cad/Feature.js';
import { FilletFeature } from '../js/cad/FilletFeature.js';
import { FeatureTree } from '../js/cad/FeatureTree.js';
import { rehydrateOcctFeatureDisplayGeometry } from '../js/cad/occt/OcctSketchModeling.js';

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
      vertexNormals: [
        { x: 0, y: 0, z: 1 },
        { x: 0, y: 0, z: 1 },
        { x: 0, y: 0, z: 1 },
      ],
    }],
    edges: [{
      start: { x: 0, y: 0, z: 0 },
      end: { x: 1, y: 0, z: 0 },
      stableHash: 'E:top',
      source: 'occt',
    }],
    paths: [{ edgeIndices: [0], stableHash: 'P:top' }],
    visualEdges: [{
      start: { x: 0, y: 0, z: 0 },
      end: { x: 1, y: 0, z: 0 },
    }],
    _occtFeatureEdges: [{
      start: { x: 0, y: 0, z: 0 },
      end: { x: 1, y: 0, z: 0 },
      stableHash: 'E:top',
      source: 'occt',
    }],
    _occtFeaturePaths: [{ edgeIndices: [0], stableHash: 'P:top' }],
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

test('fast restore accepts OCCT checkpoints without CBREP deps', () => {
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

  assert.equal(restored, true, 'OCCT checkpoint should restore without any CBREP deps');
  assert.equal(hydrationAttempts, 0, 'OCCT fast restore should not rehydrate cached CBREP handles');
  assert.equal(tree.results[feature.id]?._restoredFromCheckpoint, true, 'restored result should be marked as checkpoint-restored');
  assert.equal(tree.results[feature.id]?.occtTopologyHash, checkpoint.revision.topologyHash, 'restored result should keep the OCCT topology hash');
});

test('serialize emits only OCCT checkpoints for solid results', () => {
  const { tree, feature } = createTreeWithFeature();
  const checkpoint = makeOcctCheckpoint({ revision: { revisionId: 'rev-2', topologyHash: 'topo-2' } });
  tree.results[feature.id] = {
    ...makeOcctResult(checkpoint),
    cbrepBuffer: new ArrayBuffer(8),
    cbrepCacheVersion: 'stale-version',
    irHash: 'stale-hash',
  };

  const serialized = tree.serialize();
  const entry = serialized.checkpoints?.[feature.id];

  assert.ok(entry?.occt, 'serialized checkpoints should retain the OCCT checkpoint');
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'payload'), false, 'serialized checkpoints should not emit a CBREP payload');
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'hash'), false, 'serialized checkpoints should not emit a CBREP hash field');
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'version'), false, 'serialized checkpoints should not emit a CBREP version field');
});

test('serialize preserves OCCT mesh snapshots needed for smooth shading and feature edges', () => {
  const { tree, feature } = createTreeWithFeature();
  const checkpoint = makeOcctCheckpoint({ revision: { revisionId: 'rev-3', topologyHash: 'topo-3' } });
  tree.results[feature.id] = makeOcctResult(checkpoint);

  const serialized = tree.serialize();
  const entry = serialized.checkpoints?.[feature.id];

  assert.ok(entry?.mesh, 'serialized checkpoint should include a display mesh snapshot');
  assert.equal(entry.mesh.faces?.[0]?.vertexNormals?.length, 3, 'mesh snapshot should preserve per-vertex normals');
  assert.equal(entry.mesh._occtFeatureEdges?.length, 1, 'mesh snapshot should preserve native OCCT feature edges');
  assert.equal(entry.mesh.paths?.[0]?.stableHash, 'P:top', 'mesh snapshot should preserve edge path metadata');
});

test('fast restore rebuilds solids directly from serialized mesh snapshots when available', () => {
  const { tree, feature } = createTreeWithFeature();
  const checkpoint = makeOcctCheckpoint();
  const mesh = makeOcctResult(checkpoint).geometry;
  let seenMesh = null;
  tree._buildSolidResultFromCheckpointMesh = (_featureId, occtCheckpoint, meshSnapshot) => {
    seenMesh = meshSnapshot;
    return makeOcctResult(occtCheckpoint);
  };

  const restored = tree.tryFastRestoreFromCheckpoints({
    [feature.id]: { occt: checkpoint, mesh },
  });

  assert.equal(restored, true, 'mesh-backed OCCT checkpoint should restore successfully');
  assert.deepEqual(seenMesh, mesh, 'fast restore should rebuild from the serialized mesh snapshot when one is available');
});

test('mesh-backed checkpoint restore deep-clones display snapshots before rehydrate', () => {
  const { tree, feature } = createTreeWithFeature();
  const checkpoint = makeOcctCheckpoint();
  const mesh = structuredClone(makeOcctResult(checkpoint).geometry);

  const restored = tree._buildSolidResultFromCheckpointMesh(feature.id, checkpoint, mesh);
  restored.geometry.faces[0].vertexNormals[0].z = 0.25;
  restored.geometry._occtFeatureEdges[0].stableHash = 'E:mutated';

  assert.equal(mesh.faces[0].vertexNormals[0].z, 1, 'restore should not mutate the saved smooth-shading snapshot');
  assert.equal(mesh._occtFeatureEdges[0].stableHash, 'E:top', 'restore should not mutate the saved OCCT feature-edge snapshot');
});

test('live fillet normalization keeps the executed result instead of immediately re-restoring from checkpoint', () => {
  const tree = new FeatureTree();
  const feature = new FilletFeature('Live Fillet');
  tree.features.push(feature);
  tree.featureMap.set(feature.id, feature);

  let restoreCalls = 0;
  tree._buildSolidResultFromOcctCheckpoint = () => {
    restoreCalls++;
    throw new Error('should not restore live fillet result');
  };

  const result = makeOcctResult();
  const normalized = tree._normalizeLiveSolidResultFromOcctCheckpoint(feature.id, feature, result);

  assert.equal(normalized, result, 'live fillet result should remain the active result object');
  assert.equal(restoreCalls, 0, 'live fillet normalization should not immediately rehydrate from checkpoint');
  assert.ok(normalized.occtCheckpoint, 'live fillet result should still capture an OCCT checkpoint for later restore');
});

test('stamping a live solid result does not eagerly capture an OCCT checkpoint', () => {
  const { tree, feature } = createTreeWithFeature();
  const result = makeOcctResult();
  delete result.occtCheckpoint;
  delete result.geometry.occtCheckpoint;
  delete result.solid.occtCheckpoint;

  let checkpointCaptureCalls = 0;
  tree._ensureSolidResultOcctCheckpoint = () => {
    checkpointCaptureCalls++;
    return true;
  };

  tree._stampSolidResult(feature.id, result);

  assert.equal(checkpointCaptureCalls, 0, 'interactive live stamping should not synchronously capture a checkpoint');
  assert.equal(result.exactBodyRevisionId, 1, 'live result should still receive revision metadata');
});

test('serializing checkpoints lazily captures a missing live OCCT checkpoint', () => {
  const { tree, feature } = createTreeWithFeature();
  const result = makeOcctResult();
  delete result.occtCheckpoint;
  delete result.geometry.occtCheckpoint;
  delete result.solid.occtCheckpoint;
  tree.results[feature.id] = result;

  let checkpointCaptureCalls = 0;
  tree._ensureSolidResultOcctCheckpoint = (liveResult) => {
    checkpointCaptureCalls++;
    return tree._rememberOcctCheckpoint(liveResult, makeOcctCheckpoint({ revision: { revisionId: 'rev-lazy', topologyHash: 'topo-lazy' } }));
  };

  const checkpoints = tree._serializeCheckpoints();

  assert.equal(checkpointCaptureCalls, 1, 'serialization should lazily capture a missing OCCT checkpoint');
  assert.equal(checkpoints?.[feature.id]?.occt?.revision?.topologyHash, 'topo-lazy', 'lazy-captured checkpoint should be serialized');
});

test('rehydrateOcctFeatureDisplayGeometry rebuilds fillet tags and merged edge sets from checkpoint topology', () => {
  const geometry = {
    faces: [
      {
        topoFaceId: 1,
        stableHash: 'F:base-a',
        vertices: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }],
        normal: { x: 0, y: 0, z: 1 },
        shared: { sourceFeatureId: 'op-1' },
      },
      {
        topoFaceId: 2,
        stableHash: 'F:base-b',
        vertices: [{ x: 1, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }],
        normal: { x: 0, y: 0, z: 1 },
        shared: { sourceFeatureId: 'op-1' },
      },
      {
        topoFaceId: 3,
        stableHash: 'F:fillet-a',
        vertices: [{ x: 1, y: 0, z: 0 }, { x: 1, y: 0.5, z: 0.5 }, { x: 0.5, y: 1, z: 0.5 }],
        normal: { x: 0, y: -0.7071, z: 0.7071 },
        shared: { sourceFeatureId: 'op-1' },
      },
      {
        topoFaceId: 4,
        stableHash: 'F:fillet-b',
        vertices: [{ x: 1, y: 0, z: 0 }, { x: 0.5, y: 1, z: 0.5 }, { x: 0, y: 1, z: 0 }],
        normal: { x: 0, y: -0.7071, z: 0.7071 },
        shared: { sourceFeatureId: 'op-1' },
      },
    ],
    edges: [{
      start: { x: 1, y: 0, z: 0 },
      end: { x: 0.5, y: 1, z: 0.5 },
      stableHash: 'E:native',
      source: 'occt',
    }],
    paths: [{ edgeIndices: [0], stableHash: 'P:native', topoFaceIds: [3, 4] }],
    _occtModeling: {
      topology: {
        faces: [
          { id: 1, stableHash: 'F:base-a', shared: { sourceFeatureId: 'op-1' } },
          { id: 2, stableHash: 'F:base-b', shared: { sourceFeatureId: 'op-1' } },
          { id: 3, stableHash: 'F:fillet-a', shared: { sourceFeatureId: 'op-1' } },
          { id: 4, stableHash: 'F:fillet-b', shared: { sourceFeatureId: 'op-1' } },
        ],
      },
    },
  };
  const sourceTopology = {
    faces: [
      { id: 1, stableHash: 'F:base-a', shared: { sourceFeatureId: 'op-1' } },
      { id: 2, stableHash: 'F:base-b', shared: { sourceFeatureId: 'op-1' } },
    ],
  };

  rehydrateOcctFeatureDisplayGeometry(geometry, 'fillet', sourceTopology);

  const restoredFilletFaces = geometry.faces.filter((face) => face.isFillet === true || face.shared?.isFillet === true);
  assert.deepEqual(
    restoredFilletFaces.map((face) => face.topoFaceId).sort((a, b) => a - b),
    [3, 4],
    'checkpoint display rehydrate should tag faces generated by the fillet operation',
  );
  assert.equal(geometry._occtFeatureEdges?.length, 1, 'native OCCT edges should be preserved as the base edge set');
  assert.ok(geometry.edges.length > geometry._occtFeatureEdges.length, 'computed display edges should merge with native OCCT edges');
  assert.ok(Array.isArray(geometry.paths) && geometry.paths.length >= 1, 'display edge paths should remain available after rehydrate');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);