import './_watchdog.mjs';

import assert from 'node:assert/strict';

import { computeFeatureEdges, makeEdgeKey } from '../js/cad/EdgeAnalysis.js';

function cloneVertex(vertex) {
  return { x: vertex.x, y: vertex.y, z: vertex.z };
}

function makeFace(vertices, normal, sourceFeatureId) {
  return {
    vertices: vertices.map(cloneVertex),
    normal: { ...normal },
    shared: sourceFeatureId ? { sourceFeatureId } : {},
  };
}

function edgeKeySet(edges) {
  return new Set(edges.map((edge) => makeEdgeKey(edge.start, edge.end)));
}

const seamStart = { x: 1, y: 0, z: 0 };
const seamEnd = { x: 1, y: 1, z: 0 };
const seamKey = makeEdgeKey(seamStart, seamEnd);

const coplanarSameOwner = computeFeatureEdges([
  makeFace([
    { x: 0, y: 0, z: 0 },
    seamStart,
    seamEnd,
    { x: 0, y: 1, z: 0 },
  ], { x: 0, y: 0, z: 1 }, 'base'),
  makeFace([
    seamStart,
    { x: 2, y: 0, z: 0 },
    { x: 2, y: 1, z: 0 },
    seamEnd,
  ], { x: 0, y: 0, z: 1 }, 'base'),
]);
assert.equal(edgeKeySet(coplanarSameOwner.edges).has(seamKey), false);

const coplanarDifferentOwner = computeFeatureEdges([
  makeFace([
    { x: 0, y: 0, z: 0 },
    seamStart,
    seamEnd,
    { x: 0, y: 1, z: 0 },
  ], { x: 0, y: 0, z: 1 }, 'base'),
  makeFace([
    seamStart,
    { x: 2, y: 0, z: 0 },
    { x: 2, y: 1, z: 0 },
    seamEnd,
  ], { x: 0, y: 0, z: 1 }, 'fillet-1'),
]);
assert.equal(edgeKeySet(coplanarDifferentOwner.edges).has(seamKey), true);

const tiltedNormal = { x: Math.sin(Math.PI / 36), y: 0, z: Math.cos(Math.PI / 36) };
const smoothDifferentOwner = computeFeatureEdges([
  makeFace([
    { x: 0, y: 0, z: 0 },
    seamStart,
    seamEnd,
    { x: 0, y: 1, z: 0 },
  ], { x: 0, y: 0, z: 1 }, 'base'),
  makeFace([
    seamStart,
    { x: 2, y: 0, z: 0.175 },
    { x: 2, y: 1, z: 0.175 },
    seamEnd,
  ], tiltedNormal, 'fillet-2'),
]);
assert.equal(edgeKeySet(smoothDifferentOwner.edges).has(seamKey), true);

console.log('ok');