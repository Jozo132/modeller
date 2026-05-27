import './_watchdog.mjs';

import assert from 'node:assert/strict';

import { mergeOcctFeatureEdgeSets } from '../js/cad/occt/OcctSketchModeling.js';

const nativeEdge = {
  start: { x: 1, y: 0, z: 0 },
  end: { x: 1, y: 1, z: 0 },
  faceIndices: [0, 1],
  stableHash: 'E:fillet-boundary-1',
};

const merged = mergeOcctFeatureEdgeSets(
  [nativeEdge],
  [{ edgeIndices: [0], isClosed: false, stableHash: 'E:fillet-boundary-1' }],
  [],
  [],
);

assert.equal(merged.edges.length, 1);
assert.equal(merged.edges[0].stableHash, 'E:fillet-boundary-1');
assert.deepEqual(merged.edges[0].faceIndices, [0, 1]);
assert.equal(merged.paths.length, 1);
assert.deepEqual(merged.paths[0].edgeIndices, [0]);

const computedDuplicate = mergeOcctFeatureEdgeSets(
  [nativeEdge],
  [{ edgeIndices: [0], isClosed: false, stableHash: 'E:fillet-boundary-1' }],
  [{ start: { x: 1, y: 1, z: 0 }, end: { x: 1, y: 0, z: 0 }, faceIndices: [0, 1] }],
  [{ edgeIndices: [0], isClosed: false }],
);

assert.equal(computedDuplicate.edges.length, 1);
assert.equal(computedDuplicate.paths.length, 1);
assert.deepEqual(computedDuplicate.paths[0].edgeIndices, [0]);

console.log('ok');