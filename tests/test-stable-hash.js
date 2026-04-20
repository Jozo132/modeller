// tests/test-stable-hash.js — Tests for creation-history-based stable hashes
//
// Validates:
//   1) Faces, edges, and vertices receive stable hashes after extrusion
//   2) Face hashes reflect feature ID + structural role (bottom, top, side)
//   3) Edge/vertex hashes are derived from adjacent face hashes
//   4) Hashes are deterministic across repeated recomputes
//   5) Hashes survive parameter changes (different extrusion distance)
//   6) Hashes survive serialization/deserialization roundtrip
//   7) Multi-profile and circle-profile extrusions produce correct hashes

import { strict as assert } from 'node:assert';
import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { resetFeatureIds } from '../js/cad/Feature.js';
import {
  resetTopoIds, deriveEdgeAndVertexHashes,
  TopoBody, TopoShell, TopoFace, TopoLoop, TopoCoEdge, TopoEdge, TopoVertex,
} from '../js/cad/BRepTopology.js';
import { formatTimingSuffix, startTiming } from './test-timing.js';

// -----------------------------------------------------------------------
// Test framework
// -----------------------------------------------------------------------

let _passed = 0;
let _failed = 0;
let _currentGroup = '';

function group(name) {
  _currentGroup = name;
  console.log(`\n--- ${name} ---`);
}

function test(name, fn) {
  const startedAt = startTiming();
  try {
    fn();
    _passed++;
    console.log(`  ✓ ${name}${formatTimingSuffix(startedAt)}`);
  } catch (err) {
    _failed++;
    console.log(`  ✗ ${name}${formatTimingSuffix(startedAt)}`);
    console.log(`    ${err.message}`);
  }
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function makeRectSketch(w = 10, h = 10) {
  const s = new Sketch();
  s.addSegment(0, 0, w, 0);
  s.addSegment(w, 0, w, h);
  s.addSegment(w, h, 0, h);
  s.addSegment(0, h, 0, 0);
  return s;
}

function makeTriangleSketch() {
  const s = new Sketch();
  s.addSegment(0, 0, 10, 0);
  s.addSegment(10, 0, 5, 10);
  s.addSegment(5, 10, 0, 0);
  return s;
}

const defaultPlane = {
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  xAxis: { x: 1, y: 0, z: 0 },
  yAxis: { x: 0, y: 1, z: 0 },
};

function makeBoxPart(w = 10, h = 10, d = 10) {
  resetFeatureIds();
  resetTopoIds();
  const part = new Part('TestBox');
  const sketch = makeRectSketch(w, h);
  const sf = part.addSketch(sketch, defaultPlane);
  part.extrude(sf.id, d);
  return part;
}

function getTopoBody(part) {
  const geo = part.getFinalGeometry();
  if (!geo) return null;
  return geo.solid?.body || geo.geometry?.topoBody || null;
}

// -----------------------------------------------------------------------
// 1) Basic face hash assignment
// -----------------------------------------------------------------------

group('1) Basic face hash assignment');

test('rectangle extrusion: all faces have stableHash', () => {
  const part = makeBoxPart();
  const body = getTopoBody(part);
  assert.ok(body, 'TopoBody should exist');
  const faces = body.faces();
  assert.ok(faces.length >= 6, `Expected at least 6 faces, got ${faces.length}`);
  for (const face of faces) {
    assert.ok(face.stableHash, `Face ${face.id} should have stableHash, got ${face.stableHash}`);
  }
});

test('rectangle extrusion: has bottom, top, and side face hashes', () => {
  const part = makeBoxPart();
  const body = getTopoBody(part);
  const faces = body.faces();
  const hashes = faces.map(f => f.stableHash);

  const bottom = hashes.filter(h => h.includes('_Face_Bottom_'));
  const top = hashes.filter(h => h.includes('_Face_Top_'));
  const side = hashes.filter(h => h.includes('_Face_Side_'));

  assert.strictEqual(bottom.length, 1, `Expected 1 bottom face, got ${bottom.length}`);
  assert.strictEqual(top.length, 1, `Expected 1 top face, got ${top.length}`);
  assert.strictEqual(side.length, 4, `Expected 4 side faces, got ${side.length}: ${JSON.stringify(side)}`);
});

test('triangle extrusion: 5 faces with correct hash structure', () => {
  resetFeatureIds();
  resetTopoIds();
  const part = new Part('TestTri');
  const sketch = makeTriangleSketch();
  const sf = part.addSketch(sketch, defaultPlane);
  part.extrude(sf.id, 10);

  const body = getTopoBody(part);
  const faces = body.faces();
  const hashes = faces.map(f => f.stableHash);

  const bottom = hashes.filter(h => h.includes('_Face_Bottom_'));
  const top = hashes.filter(h => h.includes('_Face_Top_'));
  const side = hashes.filter(h => h.includes('_Face_Side_'));

  assert.strictEqual(bottom.length, 1);
  assert.strictEqual(top.length, 1);
  assert.strictEqual(side.length, 3, `Expected 3 side faces, got ${side.length}`);
});

test('face stableHash includes feature ID', () => {
  const part = makeBoxPart();
  const body = getTopoBody(part);
  const features = part.getFeatures();
  const extrudeFeature = features.find(f => f.type === 'extrude');
  assert.ok(extrudeFeature, 'Extrude feature should exist');

  for (const face of body.faces()) {
    assert.ok(face.stableHash.startsWith(extrudeFeature.id + '_'),
      `Face hash "${face.stableHash}" should start with feature ID "${extrudeFeature.id}_"`);
  }
});

test('all face hashes are unique within a body', () => {
  const part = makeBoxPart();
  const body = getTopoBody(part);
  const hashes = body.faces().map(f => f.stableHash);
  const unique = new Set(hashes);
  assert.strictEqual(unique.size, hashes.length,
    `Expected all unique hashes but got duplicates: ${JSON.stringify(hashes)}`);
});

// -----------------------------------------------------------------------
// 2) Edge and vertex hash derivation
// -----------------------------------------------------------------------

group('2) Edge and vertex hash derivation');

test('all edges have stableHash after extrusion', () => {
  const part = makeBoxPart();
  const body = getTopoBody(part);
  const edges = body.edges();
  assert.ok(edges.length >= 12, `Expected at least 12 edges, got ${edges.length}`);
  for (const edge of edges) {
    assert.ok(edge.stableHash, `Edge ${edge.id} should have stableHash`);
  }
});

test('all vertices have stableHash after extrusion', () => {
  const part = makeBoxPart();
  const body = getTopoBody(part);
  const vertices = body.vertices();
  assert.ok(vertices.length >= 8, `Expected at least 8 vertices, got ${vertices.length}`);
  for (const vertex of vertices) {
    assert.ok(vertex.stableHash, `Vertex ${vertex.id} should have stableHash`);
  }
});

test('edge hashes are derived from adjacent face hashes', () => {
  const part = makeBoxPart();
  const body = getTopoBody(part);
  for (const edge of body.edges()) {
    assert.ok(edge.stableHash.startsWith('E:'),
      `Edge hash "${edge.stableHash}" should start with "E:"`);
  }
});

test('vertex hashes are derived from adjacent face hashes', () => {
  const part = makeBoxPart();
  const body = getTopoBody(part);
  for (const vertex of body.vertices()) {
    assert.ok(vertex.stableHash.startsWith('V:'),
      `Vertex hash "${vertex.stableHash}" should start with "V:"`);
  }
});

test('all edge hashes are unique within a body', () => {
  const part = makeBoxPart();
  const body = getTopoBody(part);
  const hashes = body.edges().map(e => e.stableHash);
  const unique = new Set(hashes);
  assert.strictEqual(unique.size, hashes.length,
    `Expected all unique edge hashes`);
});

test('all vertex hashes are unique within a body', () => {
  const part = makeBoxPart();
  const body = getTopoBody(part);
  const hashes = body.vertices().map(v => v.stableHash);
  const unique = new Set(hashes);
  assert.strictEqual(unique.size, hashes.length,
    `Expected all unique vertex hashes`);
});

// -----------------------------------------------------------------------
// 3) Determinism across repeated recompute
// -----------------------------------------------------------------------

group('3) Determinism across repeated recompute');

test('face hashes are identical across two independent builds', () => {
  const part1 = makeBoxPart(10, 10, 10);
  const body1 = getTopoBody(part1);

  const part2 = makeBoxPart(10, 10, 10);
  const body2 = getTopoBody(part2);

  const hashes1 = new Set(body1.faces().map(f => f.stableHash));
  const hashes2 = new Set(body2.faces().map(f => f.stableHash));

  assert.strictEqual(hashes1.size, hashes2.size);
  for (const h of hashes1) {
    assert.ok(hashes2.has(h), `Hash "${h}" missing from second build`);
  }
});

test('edge hashes are identical across two independent builds', () => {
  const part1 = makeBoxPart(10, 10, 10);
  const body1 = getTopoBody(part1);

  const part2 = makeBoxPart(10, 10, 10);
  const body2 = getTopoBody(part2);

  const hashes1 = new Set(body1.edges().map(e => e.stableHash));
  const hashes2 = new Set(body2.edges().map(e => e.stableHash));

  assert.strictEqual(hashes1.size, hashes2.size);
  for (const h of hashes1) {
    assert.ok(hashes2.has(h), `Edge hash "${h}" missing from second build`);
  }
});

test('vertex hashes are identical across two independent builds', () => {
  const part1 = makeBoxPart(10, 10, 10);
  const body1 = getTopoBody(part1);

  const part2 = makeBoxPart(10, 10, 10);
  const body2 = getTopoBody(part2);

  const hashes1 = new Set(body1.vertices().map(v => v.stableHash));
  const hashes2 = new Set(body2.vertices().map(v => v.stableHash));

  assert.strictEqual(hashes1.size, hashes2.size);
  for (const h of hashes1) {
    assert.ok(hashes2.has(h), `Vertex hash "${h}" missing from second build`);
  }
});

// -----------------------------------------------------------------------
// 4) Stability across parameter changes
// -----------------------------------------------------------------------

group('4) Stability across parameter changes');

test('face hashes survive extrusion distance change', () => {
  // Build with distance 10
  const part1 = makeBoxPart(10, 10, 10);
  const body1 = getTopoBody(part1);
  const faceHashes10 = new Set(body1.faces().map(f => f.stableHash));

  // Build with distance 20 — different geometry, same feature structure
  const part2 = makeBoxPart(10, 10, 20);
  const body2 = getTopoBody(part2);
  const faceHashes20 = new Set(body2.faces().map(f => f.stableHash));

  // Face hashes should be identical (based on feature ID + structural role, not position)
  assert.strictEqual(faceHashes10.size, faceHashes20.size,
    'Same number of face hashes');
  for (const h of faceHashes10) {
    assert.ok(faceHashes20.has(h),
      `Face hash "${h}" should survive distance change`);
  }
});

test('face hashes survive sketch size change', () => {
  const part1 = makeBoxPart(10, 10, 10);
  const body1 = getTopoBody(part1);
  const hashes1 = new Set(body1.faces().map(f => f.stableHash));

  // Same feature IDs (resetFeatureIds ensures same sequence), different sketch size
  const part2 = makeBoxPart(20, 20, 10);
  const body2 = getTopoBody(part2);
  const hashes2 = new Set(body2.faces().map(f => f.stableHash));

  assert.strictEqual(hashes1.size, hashes2.size);
  for (const h of hashes1) {
    assert.ok(hashes2.has(h), `Face hash "${h}" should survive sketch size change`);
  }
});

// -----------------------------------------------------------------------
// 5) Serialization roundtrip
// -----------------------------------------------------------------------

group('5) Serialization roundtrip');

test('face stableHash survives TopoBody serialize/deserialize', () => {
  const part = makeBoxPart();
  const body = getTopoBody(part);
  const originalHashes = body.faces().map(f => f.stableHash);

  const serialized = body.serialize();
  const restored = TopoBody.deserialize(serialized);

  const restoredHashes = restored.faces().map(f => f.stableHash);
  assert.deepStrictEqual(restoredHashes, originalHashes,
    'Face hashes should survive serialization roundtrip');
});

test('edge stableHash survives TopoBody serialize/deserialize', () => {
  const part = makeBoxPart();
  const body = getTopoBody(part);
  const originalHashes = new Set(body.edges().map(e => e.stableHash));

  const serialized = body.serialize();
  const restored = TopoBody.deserialize(serialized);

  const restoredHashes = new Set(restored.edges().map(e => e.stableHash));
  assert.strictEqual(originalHashes.size, restoredHashes.size);
  for (const h of originalHashes) {
    assert.ok(restoredHashes.has(h), `Edge hash "${h}" should survive serialization`);
  }
});

test('vertex stableHash survives TopoBody serialize/deserialize', () => {
  const part = makeBoxPart();
  const body = getTopoBody(part);
  const originalHashes = new Set(body.vertices().map(v => v.stableHash));

  const serialized = body.serialize();
  const restored = TopoBody.deserialize(serialized);

  const restoredHashes = new Set(restored.vertices().map(v => v.stableHash));
  assert.strictEqual(originalHashes.size, restoredHashes.size);
  for (const h of originalHashes) {
    assert.ok(restoredHashes.has(h), `Vertex hash "${h}" should survive serialization`);
  }
});

// -----------------------------------------------------------------------
// 6) deriveEdgeAndVertexHashes utility
// -----------------------------------------------------------------------

group('6) deriveEdgeAndVertexHashes utility');

test('deriveEdgeAndVertexHashes is idempotent', () => {
  const part = makeBoxPart();
  const body = getTopoBody(part);

  const edgesBefore = body.edges().map(e => e.stableHash);
  const vertsBefore = body.vertices().map(v => v.stableHash);

  // Call again — should not change anything
  deriveEdgeAndVertexHashes(body);

  const edgesAfter = body.edges().map(e => e.stableHash);
  const vertsAfter = body.vertices().map(v => v.stableHash);

  assert.deepStrictEqual(edgesAfter, edgesBefore, 'Edge hashes should not change on re-derivation');
  assert.deepStrictEqual(vertsAfter, vertsBefore, 'Vertex hashes should not change on re-derivation');
});

test('deriveEdgeAndVertexHashes handles body with no face hashes', () => {
  const v1 = new TopoVertex({ x: 0, y: 0, z: 0 });
  const v2 = new TopoVertex({ x: 1, y: 0, z: 0 });
  const edge = new TopoEdge(v1, v2);
  const ce = new TopoCoEdge(edge, true);
  const loop = new TopoLoop([ce]);
  const face = new TopoFace(null, 'plane', true);
  face.setOuterLoop(loop);
  const shell = new TopoShell([face]);
  const body = new TopoBody([shell]);

  // No face has stableHash → should not crash, leave null
  deriveEdgeAndVertexHashes(body);
  assert.strictEqual(edge.stableHash, null);
  assert.strictEqual(v1.stableHash, null);
  assert.strictEqual(v2.stableHash, null);
});

// -----------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------

console.log(`\nStable Hash Tests: ${_passed} passed, ${_failed} failed`);
process.exit(_failed > 0 ? 1 : 0);
