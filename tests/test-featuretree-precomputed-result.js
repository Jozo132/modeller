import assert from 'node:assert/strict';

import { Feature } from '../js/cad/Feature.js';
import { FeatureTree } from '../js/cad/FeatureTree.js';

class PreparedSolidFeature extends Feature {
  constructor() {
    super('Prepared Solid');
    this.type = 'prepared-solid';
  }

  canExecute() {
    return true;
  }

  execute() {
    throw new Error('precomputed feature should not execute');
  }
}

function makeOcctCheckpoint() {
  return {
    brep: 'occt-checkpoint',
    revision: {
      revisionId: 'rev-precomputed',
      topologyHash: 'topo-precomputed',
    },
  };
}

function makeOcctResult(checkpoint = makeOcctCheckpoint()) {
  const topology = {
    revisionId: checkpoint.revision.revisionId,
    topologyHash: checkpoint.revision.topologyHash,
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
      source: 'worker-precomputed',
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
    occtShapeHandle: 0,
    occtShapeResident: false,
    _occtModeling: geometry._occtModeling,
    occtCheckpoint: checkpoint,
    _restoredFromCheckpoint: true,
  };
}

const tree = new FeatureTree();
const feature = new PreparedSolidFeature();
const result = makeOcctResult();

tree.addFeature(feature, -1, result);

assert.equal(tree.results[feature.id], result, 'precomputed appended feature should adopt the provided result');
assert.equal(feature.result, result, 'feature should keep the provided result');
assert.ok(Number.isInteger(result.exactBodyRevisionId) && result.exactBodyRevisionId > 0, 'precomputed appended result should still be stamped');

console.log('ok');