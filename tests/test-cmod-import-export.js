// tests/test-cmod-import-export.js — Tests for .cmod project file import/export
//
// Verifies the round-trip: build a Part → export to .cmod → validate format →
// import back → verify the feature tree and geometry match.

import assert from 'assert';
import fs from 'fs';
import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { buildCMOD, parseCMOD } from '../js/cmod.js';
import {
  calculateMeshVolume, calculateBoundingBox, calculateSurfaceArea,
  detectDisconnectedBodies, calculateWallThickness, countInvertedFaces, computeFeatureEdges,
} from '../js/cad/CSG.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

function assertApprox(actual, expected, tol, msg) {
  assert.ok(Math.abs(actual - expected) < tol,
    `${msg}: expected ~${expected}, got ${actual}`);
}

function quantizedVertexKey(vertex) {
  return [vertex.x, vertex.y, vertex.z].map((value) => Number(value).toFixed(6)).join(',');
}

function undirectedEdgeKey(start, end) {
  const startKey = quantizedVertexKey(start);
  const endKey = quantizedVertexKey(end);
  return startKey < endKey ? `${startKey}|${endKey}` : `${endKey}|${startKey}`;
}

function collectEdgeUsage(geometry) {
  const edgeCounts = new Map();
  const directedEdges = new Map();

  for (const face of geometry.faces || []) {
    for (let index = 0; index < face.vertices.length; index++) {
      const current = face.vertices[index];
      const next = face.vertices[(index + 1) % face.vertices.length];
      const currentKey = quantizedVertexKey(current);
      const nextKey = quantizedVertexKey(next);
      const key = undirectedEdgeKey(current, next);
      edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
      if (!directedEdges.has(key)) directedEdges.set(key, []);
      directedEdges.get(key).push({ fwd: currentKey < nextKey });
    }
  }

  let windingErrors = 0;
  for (const entries of directedEdges.values()) {
    if (entries.length === 2 && entries[0].fwd === entries[1].fwd) windingErrors++;
  }

  return {
    boundaryEdges: [...edgeCounts.values()].filter((count) => count === 1).length,
    nonManifoldEdges: [...edgeCounts.values()].filter((count) => count > 2).length,
    windingErrors,
  };
}

function assertPositiveWallThickness(geometry, context) {
  const wt = calculateWallThickness(geometry);
  assert.ok(wt.minThickness > 0, `${context}: expected min wall thickness > 0, got ${wt.minThickness}`);
  assert.ok(wt.maxThickness > 0, `${context}: expected max wall thickness > 0, got ${wt.maxThickness}`);
}

function assertSingleHorizontalCapGroup(geometry, context) {
  const faces = geometry.faces || [];
  let zMax = -Infinity;
  for (const face of faces) {
    for (const vertex of face.vertices || []) zMax = Math.max(zMax, vertex.z);
  }
  const topFaces = faces.filter((face) =>
    (face.normal?.z || 0) > 0.99999 &&
    (face.vertices || []).length >= 3 &&
    face.vertices.every((vertex) => Math.abs(vertex.z - zMax) < 1e-5)
  );
  assert.ok(topFaces.length > 0, `${context}: expected at least one top cap face`);
  const groups = new Set(topFaces.map((face) => face.faceGroup));
  assert.strictEqual(groups.size, 1, `${context}: expected a single top cap face group, got ${groups.size}`);
}

function assertNoDownwardTopExtremeFaces(geometry, context) {
  const faces = geometry.faces || [];
  let zMax = -Infinity;
  for (const face of faces) {
    for (const vertex of face.vertices || []) {
      zMax = Math.max(zMax, vertex.z);
    }
  }

  const eps = 1e-5;
  const topWrong = faces.filter((face) =>
    (face.normal?.z || 0) < -0.99999 &&
    (face.vertices || []).length >= 3 &&
    face.vertices.every((vertex) => Math.abs(vertex.z - zMax) < eps)
  );

  assert.strictEqual(topWrong.length, 0, `${context}: expected no downward-facing top-extreme faces, got ${topWrong.length}`);
}

function countUnsupportedFeatureEdges(geometry) {
  const meshSegments = new Set();
  for (const face of geometry.faces || []) {
    const vertices = face.vertices || [];
    for (let i = 0; i < vertices.length; i++) {
      meshSegments.add(undirectedEdgeKey(vertices[i], vertices[(i + 1) % vertices.length]));
    }
  }

  let unsupportedEdges = 0;
  for (const edge of geometry.edges || []) {
    const points = Array.isArray(edge.points) && edge.points.length >= 2
      ? edge.points
      : (edge.start && edge.end ? [edge.start, edge.end] : []);
    if (points.length < 2) continue;

    let supported = true;
    for (let i = 1; i < points.length; i++) {
      if (!meshSegments.has(undirectedEdgeKey(points[i - 1], points[i]))) {
        supported = false;
        break;
      }
    }
    if (!supported) unsupportedEdges++;
  }

  return unsupportedEdges;
}

function assertFeatureEdgesLieOnMeshBoundaries(geometry, context) {
  const unsupportedEdges = countUnsupportedFeatureEdges(geometry);
  assert.strictEqual(unsupportedEdges, 0, `${context}: expected no floating feature edges, got ${unsupportedEdges}`);
}

function cloneFaces(faces) {
  return (faces || []).map((face) => ({
    ...face,
    vertices: (face.vertices || []).map((vertex) => ({ ...vertex })),
    normal: face.normal ? { ...face.normal } : face.normal,
    shared: face.shared ? { ...face.shared } : face.shared,
  }));
}

function countFilletBoundaryPaths(geometry) {
  let count = 0;
  for (const path of geometry.paths || []) {
    let hasFillet = false;
    let hasNonFillet = false;
    for (const edgeIndex of path.edgeIndices || []) {
      const edge = geometry.edges && geometry.edges[edgeIndex];
      if (!edge) continue;
      for (const fi of edge.faceIndices || []) {
        const face = geometry.faces && geometry.faces[fi];
        if (!face) continue;
        if (face.isFillet) hasFillet = true;
        else hasNonFillet = true;
      }
    }
    if (hasFillet && hasNonFillet) count++;
  }
  return count;
}

function countOpposedCoplanarSameGroupFacePairs(geometry, normalDotTol = 0.999999, planeTol = 1e-5) {
  const faces = geometry && geometry.faces ? geometry.faces : [];
  let count = 0;
  for (let i = 0; i < faces.length; i++) {
    const faceA = faces[i];
    const normalA = faceA && faceA.normal;
    const verticesA = faceA && faceA.vertices;
    if (!normalA || !Array.isArray(verticesA) || verticesA.length < 3) continue;
    const planeA = normalA.x * verticesA[0].x + normalA.y * verticesA[0].y + normalA.z * verticesA[0].z;
    for (let j = i + 1; j < faces.length; j++) {
      const faceB = faces[j];
      const normalB = faceB && faceB.normal;
      const verticesB = faceB && faceB.vertices;
      if (!normalB || !Array.isArray(verticesB) || verticesB.length < 3) continue;
      if (faceA.faceGroup !== faceB.faceGroup) continue;

      const dot = normalA.x * normalB.x + normalA.y * normalB.y + normalA.z * normalB.z;
      if (dot > -normalDotTol) continue;

      const planeB = normalA.x * verticesB[0].x + normalA.y * verticesB[0].y + normalA.z * verticesB[0].z;
      if (Math.abs(planeA - planeB) > planeTol) continue;
      count++;
    }
  }
  return count;
}

// -----------------------------------------------------------------------
// Build test geometry
// -----------------------------------------------------------------------

function makeBox(w, h, d) {
  const part = new Part('TestBox');
  const sketch = new Sketch();
  sketch.addSegment(0, 0, w, 0);
  sketch.addSegment(w, 0, w, h);
  sketch.addSegment(w, h, 0, h);
  sketch.addSegment(0, h, 0, 0);
  const sf = part.addSketch(sketch);
  part.extrude(sf.id, d);
  return part;
}

function makeBoxWithChamfer(w, h, d, dist) {
  const part = makeBox(w, h, d);
  const geo = part.getFinalGeometry();
  if (geo && geo.geometry && geo.geometry.edges) {
    // Chamfer the first edge
    const edge = geo.geometry.edges[0];
    const ek = edgeKey(edge.start, edge.end);
    part.chamfer([ek], dist);
  }
  return part;
}

function edgeKey(a, b) {
  const ka = `${a.x.toFixed(5)},${a.y.toFixed(5)},${a.z.toFixed(5)}`;
  const kb = `${b.x.toFixed(5)},${b.y.toFixed(5)},${b.z.toFixed(5)}`;
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

function findFirstCrossGroupEdgeKey(geometry) {
  const edges = geometry && geometry.edges ? geometry.edges : [];
  const faces = geometry && geometry.faces ? geometry.faces : [];
  for (const edge of edges) {
    const faceIndices = edge.faceIndices || [];
    if (faceIndices.length !== 2) continue;
    const faceA = faces[faceIndices[0]];
    const faceB = faces[faceIndices[1]];
    if (!faceA || !faceB) continue;
    if (faceA.faceGroup === faceB.faceGroup) continue;
    return edgeKey(edge.start, edge.end);
  }
  return null;
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

console.log('\n=== CMOD Import/Export Tests ===\n');

// --- Test 1: Basic export format ---
console.log('--- Test 1: Export format ---');
{
  const part = makeBox(10, 10, 10);
  const cmod = buildCMOD(part);

  test('format field is correct', () => {
    assert.strictEqual(cmod.format, 'CAD Modeller Open Design');
  });

  test('version field is 2', () => {
    assert.strictEqual(cmod.version, 2);
  });

  test('has part data', () => {
    assert.ok(cmod.part);
    assert.strictEqual(cmod.part.type, 'Part');
    assert.strictEqual(cmod.part.name, 'TestBox');
  });

  test('has settings', () => {
    assert.ok(cmod.settings);
    assert.strictEqual(cmod.settings.gridSize, 10);
    assert.strictEqual(cmod.settings.snapEnabled, true);
  });

  test('has metadata', () => {
    assert.ok(cmod.metadata);
    assert.strictEqual(cmod.metadata.featureCount, 2); // sketch + extrude
    assert.deepStrictEqual(cmod.metadata.featureTypes, ['sketch', 'extrude']);
  });

  test('metadata has geometry stats', () => {
    assert.strictEqual(cmod.metadata.faceCount, 6);
    assertApprox(cmod.metadata.volume, 1000, 1, 'volume');
    assert.ok(cmod.metadata.edgeCount > 0);
    assert.ok(cmod.metadata.pathCount > 0);
    assert.strictEqual(cmod.metadata.bodyCount, 1);
    assert.strictEqual(cmod.metadata.invertedFaceCount, 0);
  });

  test('metadata has wall thickness', () => {
    assertApprox(cmod.metadata.minWallThickness, 10, 0.1, 'minWall');
    assertApprox(cmod.metadata.maxWallThickness, 10, 0.1, 'maxWall');
  });

  test('metadata has bounding box', () => {
    const bb = cmod.metadata.boundingBox;
    assert.ok(bb);
    assertApprox(bb.min.x, 0, 0.01, 'bb.min.x');
    assertApprox(bb.max.x, 10, 0.01, 'bb.max.x');
  });

  test('has layers', () => {
    assert.ok(Array.isArray(cmod.layers));
    assert.ok(cmod.layers.length >= 1);
  });
}

// --- Test 2: JSON serialization round-trip ---
console.log('--- Test 2: JSON round-trip ---');
{
  const part = makeBox(20, 30, 40);
  const cmod = buildCMOD(part, {
    orbit: { theta: 0.5, phi: 1.0, radius: 100, target: { x: 10, y: 15, z: 20 } },
    settings: { gridSize: 5, snapEnabled: false },
  });

  const json = JSON.stringify(cmod);
  const parsed = parseCMOD(json);

  test('parseCMOD from string succeeds', () => {
    assert.strictEqual(parsed.ok, true);
    assert.ok(parsed.data);
  });

  test('round-trip preserves format', () => {
    assert.strictEqual(parsed.data.format, 'CAD Modeller Open Design');
    assert.strictEqual(parsed.data.version, 2);
  });

  test('round-trip preserves part', () => {
    assert.ok(parsed.data.part);
    assert.strictEqual(parsed.data.part.name, 'TestBox');
  });

  test('round-trip preserves orbit', () => {
    const orbit = parsed.data.orbit;
    assert.ok(orbit);
    assertApprox(orbit.theta, 0.5, 0.001, 'theta');
    assertApprox(orbit.phi, 1.0, 0.001, 'phi');
    assertApprox(orbit.radius, 100, 0.001, 'radius');
  });

  test('round-trip preserves custom settings', () => {
    assert.strictEqual(parsed.data.settings.gridSize, 5);
    assert.strictEqual(parsed.data.settings.snapEnabled, false);
  });

  test('round-trip preserves metadata', () => {
    assert.strictEqual(parsed.data.metadata.featureCount, 2);
    assertApprox(parsed.data.metadata.volume, 24000, 1, 'volume');
    assert.strictEqual(parsed.data.metadata.invertedFaceCount, 0);
  });
}

// --- Test 3: Validation ---
console.log('--- Test 3: Validation ---');
{
  test('rejects null input', () => {
    const r = parseCMOD(null);
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('Invalid'));
  });

  test('rejects wrong format', () => {
    const r = parseCMOD({ format: 'SomeOtherApp', version: 1 });
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('Unknown format'));
  });

  test('rejects future version', () => {
    const r = parseCMOD({ format: 'CAD Modeller Open Design', version: 999 });
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('newer'));
  });

  test('rejects invalid JSON string', () => {
    const r = parseCMOD('not valid json{{{');
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('JSON parse'));
  });

  test('accepts valid object', () => {
    const r = parseCMOD({ format: 'CAD Modeller Open Design', version: 1 });
    assert.strictEqual(r.ok, true);
  });
}

// --- Test 4: Feature tree preservation ---
console.log('--- Test 4: Feature tree preservation ---');
{
  const part = makeBoxWithChamfer(50, 50, 50, 2);
  const cmod = buildCMOD(part);
  const json = JSON.stringify(cmod);
  const parsed = parseCMOD(json);

  test('feature tree round-trip successful', () => {
    assert.strictEqual(parsed.ok, true);
    const ft = parsed.data.part.featureTree;
    assert.ok(ft);
    assert.ok(Array.isArray(ft.features));
  });

  test('feature types preserved', () => {
    const types = parsed.data.part.featureTree.features.map(f => f.type);
    assert.ok(types.includes('sketch'));
    assert.ok(types.includes('extrude'));
    assert.ok(types.includes('chamfer'));
  });

  test('part can be deserialized back', () => {
    const restored = Part.deserialize(parsed.data.part);
    assert.ok(restored);
    assert.strictEqual(restored.name, 'TestBox');
    const features = restored.getFeatures();
    assert.strictEqual(features.length, 3); // sketch, extrude, chamfer
  });

  test('restored geometry matches original', () => {
    const restored = Part.deserialize(parsed.data.part);
    const origGeo = part.getFinalGeometry();
    const restGeo = restored.getFinalGeometry();
    assert.ok(origGeo && origGeo.geometry);
    assert.ok(restGeo && restGeo.geometry);

    const origFaces = origGeo.geometry.faces.length;
    const restFaces = restGeo.geometry.faces.length;
    assert.strictEqual(restFaces, origFaces);

    const origVol = calculateMeshVolume(origGeo.geometry);
    const restVol = calculateMeshVolume(restGeo.geometry);
    assertApprox(restVol, origVol, 0.5, 'volume');
    assertPositiveWallThickness(origGeo.geometry, 'original chamfered box');
    assertPositiveWallThickness(restGeo.geometry, 'restored chamfered box');
  });
}

// --- Test 5: Origin planes preservation ---
console.log('--- Test 5: Origin planes ---');
{
  const part = makeBox(10, 10, 10);
  const cmod = buildCMOD(part);

  test('origin planes serialized', () => {
    assert.ok(cmod.part.originPlanes);
    assert.ok(cmod.part.originPlanes.XY);
    assert.ok(cmod.part.originPlanes.XZ);
    assert.ok(cmod.part.originPlanes.YZ);
  });

  test('origin planes round-trip', () => {
    const restored = Part.deserialize(cmod.part);
    const planes = restored.getOriginPlanes();
    assert.ok(planes.XY);
    assert.ok(planes.XZ);
    assert.ok(planes.YZ);
  });
}

// --- Test 6: Empty project ---
console.log('--- Test 6: Edge cases ---');
{
  test('null part produces valid cmod', () => {
    const cmod = buildCMOD(null);
    assert.strictEqual(cmod.format, 'CAD Modeller Open Design');
    assert.strictEqual(cmod.part, null);
    assert.ok(cmod.metadata);
    assert.strictEqual(cmod.metadata.featureCount, undefined);
  });

  test('part-only (no geometry features) exports', () => {
    const part = new Part('EmptyPart');
    const cmod = buildCMOD(part);
    assert.strictEqual(cmod.part.name, 'EmptyPart');
    assert.strictEqual(cmod.metadata.featureCount, 0);
  });
}

// --- Test 7: Metadata accuracy ---
console.log('--- Test 7: Metadata accuracy ---');
{
  const part = makeBox(100, 100, 100);
  const cmod = buildCMOD(part);

  test('volume is accurate', () => {
    assertApprox(cmod.metadata.volume, 1000000, 1, 'volume');
  });

  test('dimensions are accurate', () => {
    assertApprox(cmod.metadata.width, 100, 0.01, 'width');
    assertApprox(cmod.metadata.height, 100, 0.01, 'height');
    assertApprox(cmod.metadata.depth, 100, 0.01, 'depth');
  });

  test('faces count correct', () => {
    assert.strictEqual(cmod.metadata.faceCount, 6);
  });

  test('single body', () => {
    assert.strictEqual(cmod.metadata.bodyCount, 1);
  });

  test('no inverted faces', () => {
    assert.strictEqual(cmod.metadata.invertedFaceCount, 0);
  });

  test('positive wall thickness', () => {
    const result = part.getFinalGeometry();
    assert.ok(result && result.geometry, 'Expected solid geometry');
    assertPositiveWallThickness(result.geometry, '100x100x100 box');
  });
}

// --- Test 8: Duplicate imported feature IDs are repaired ---
console.log('--- Test 8: Duplicate imported feature IDs ---');
{
  const sample = JSON.parse(
    fs.readFileSync(new URL('./samples/extrude-on-extrude-dual-failing-sketch-select.cmod', import.meta.url), 'utf8')
  );

  test('deserialized part repairs duplicate feature IDs', () => {
    const restored = Part.deserialize(sample.part);
    const ids = restored.getFeatures().map((feature) => feature.id);
    assert.strictEqual(new Set(ids).size, ids.length, `Expected unique feature IDs, got ${ids.join(', ')}`);
  });

  test('new features after import use fresh IDs', () => {
    const restored = Part.deserialize(sample.part);
    const sketch = new Sketch();
    sketch.addSegment(0, 0, 1, 0);
    sketch.addSegment(1, 0, 1, 1);
    sketch.addSegment(1, 1, 0, 1);
    sketch.addSegment(0, 1, 0, 0);
    const feature = restored.addSketch(sketch);
    const ids = restored.getFeatures().map((candidate) => candidate.id);
    assert.strictEqual(new Set(ids).size, ids.length, `Expected unique feature IDs after add, got ${ids.join(', ')}`);
    const numericId = parseInt(String(feature.id).replace('feature_', ''), 10);
    assert.ok(Number.isFinite(numericId), `Expected numeric feature ID, got ${feature.id}`);
    assert.ok(numericId > 13, `Expected imported feature IDs to advance beyond 13, got ${feature.id}`);
  });
}

// --- Test 9: Coplanar face-start extrude cuts stay closed ---
console.log('--- Test 9: Coplanar face-start extrude cuts ---');
{
  const dualExtrudeSample = JSON.parse(
    fs.readFileSync(new URL('./samples/extrude-on-extrude-dual.cmod', import.meta.url), 'utf8')
  );
  const sample = JSON.parse(
    fs.readFileSync(new URL('./samples/extrude-on-extrude-dual-with-cut.cmod', import.meta.url), 'utf8')
  );

  test('deserialized dual extrude sample compacts planar display faces', () => {
    const restored = Part.deserialize(dualExtrudeSample.part);
    const finalGeometry = restored.getFinalGeometry();
    assert.ok(finalGeometry && finalGeometry.geometry, 'Expected final dual-extrude solid geometry');

    const faces = finalGeometry.geometry.faces || [];
    let zMax = -Infinity;
    for (const face of faces) {
      for (const vertex of face.vertices || []) zMax = Math.max(zMax, vertex.z);
    }
    const topFaces = faces.filter((face) =>
      (face.normal?.z || 0) > 0.99999 &&
      (face.vertices || []).length >= 3 &&
      face.vertices.every((vertex) => Math.abs(vertex.z - zMax) < 1e-5)
    );

    assert.ok(faces.length <= 40, `Expected compact planar display mesh, got ${faces.length} faces`);
    assert.strictEqual(topFaces.length, 1, `Expected a single top face polygon, got ${topFaces.length}`);
    assertSingleHorizontalCapGroup(finalGeometry.geometry, 'dual extrude sample');
  });

  test('deserialized cut sample produces a closed manifold mesh', () => {
    const restored = Part.deserialize(sample.part);
    const finalGeometry = restored.getFinalGeometry();
    assert.ok(finalGeometry && finalGeometry.geometry, 'Expected final solid geometry');

    const edgeUsage = collectEdgeUsage(finalGeometry.geometry);
    assert.strictEqual(edgeUsage.boundaryEdges, 0, `Expected no boundary edges, got ${edgeUsage.boundaryEdges}`);
    assert.strictEqual(edgeUsage.nonManifoldEdges, 0, `Expected no non-manifold edges, got ${edgeUsage.nonManifoldEdges}`);
    assert.strictEqual(edgeUsage.windingErrors, 0, `Expected no winding errors, got ${edgeUsage.windingErrors}`);
    assert.strictEqual(countInvertedFaces(finalGeometry.geometry), 0, 'Expected no inverted faces');
    assertPositiveWallThickness(finalGeometry.geometry, 'coplanar face-start cut sample');
  });

  test('deserialized cut sample accepts an added fillet on a sharp edge', () => {
    const restored = Part.deserialize(sample.part);
    const before = restored.getFinalGeometry();
    assert.ok(before && before.geometry, 'Expected base solid geometry');

    const selectedEdgeKey = findFirstCrossGroupEdgeKey(before.geometry);
    assert.ok(selectedEdgeKey, 'Expected a selectable sharp edge on the loaded cut sample');

    const beforeVolume = calculateMeshVolume(before.geometry);
    restored.fillet([selectedEdgeKey], 0.25, { segments: 8 });

    const after = restored.getFinalGeometry();
    assert.ok(after && after.geometry, 'Expected filleted solid geometry');
    assert.notStrictEqual(after.geometry, before.geometry, 'Added fillet should not return the original geometry');
    assert.ok(
      after.geometry.faces.length !== before.geometry.faces.length ||
      after.geometry.edges.length !== before.geometry.edges.length ||
      Math.abs(calculateMeshVolume(after.geometry) - beforeVolume) > 1e-6,
      'Added fillet should modify the loaded cut geometry',
    );
  });
}

// --- Test 10: Filleted coplanar face-start cuts stay closed ---
console.log('--- Test 10: Filleted coplanar face-start extrude cuts ---');
{
  const sample = JSON.parse(
    fs.readFileSync(new URL('./samples/extrude-on-extrude-dual-with-cut-and-radius.cmod', import.meta.url), 'utf8')
  );

  test('deserialized cut+fillet sample produces a closed manifold mesh', () => {
    const restored = Part.deserialize(sample.part);
    const finalGeometry = restored.getFinalGeometry();
    assert.ok(finalGeometry && finalGeometry.geometry, 'Expected final solid geometry');

    const edgeUsage = collectEdgeUsage(finalGeometry.geometry);
    assert.strictEqual(edgeUsage.boundaryEdges, 0, `Expected no boundary edges, got ${edgeUsage.boundaryEdges}`);
    assert.strictEqual(edgeUsage.nonManifoldEdges, 0, `Expected no non-manifold edges, got ${edgeUsage.nonManifoldEdges}`);
    assert.strictEqual(edgeUsage.windingErrors, 0, `Expected no winding errors, got ${edgeUsage.windingErrors}`);
    assert.strictEqual(countInvertedFaces(finalGeometry.geometry), 0, 'Expected no inverted faces');
    assertPositiveWallThickness(finalGeometry.geometry, 'coplanar face-start cut+fillet sample');
  });
}

// --- Test 11: Chamfered concave cut edge stays closed ---
console.log('--- Test 11: Chamfered concave cut edge ---');
{
  const sample = JSON.parse(
    fs.readFileSync(new URL('./samples/extrude-on-extrude-dual-with-cut-and-chamfer.cmod', import.meta.url), 'utf8')
  );

  test('deserialized cut+chamfer sample produces a closed manifold mesh', () => {
    const restored = Part.deserialize(sample.part);
    const finalGeometry = restored.getFinalGeometry();
    assert.ok(finalGeometry && finalGeometry.geometry, 'Expected final solid geometry');

    const edgeUsage = collectEdgeUsage(finalGeometry.geometry);
    assert.strictEqual(edgeUsage.boundaryEdges, 0, `Expected no boundary edges, got ${edgeUsage.boundaryEdges}`);
    assert.strictEqual(edgeUsage.nonManifoldEdges, 0, `Expected no non-manifold edges, got ${edgeUsage.nonManifoldEdges}`);
    assert.strictEqual(edgeUsage.windingErrors, 0, `Expected no winding errors, got ${edgeUsage.windingErrors}`);
    assert.strictEqual(countInvertedFaces(finalGeometry.geometry), 0, 'Expected no inverted faces');
    assertPositiveWallThickness(finalGeometry.geometry, 'concave cut-edge chamfer sample');
    assertSingleHorizontalCapGroup(finalGeometry.geometry, 'concave cut-edge chamfer sample');
  });

  test('deserialized cut+chamfer sample accepts an additional chamfer on a sharp edge', () => {
    const restored = Part.deserialize(sample.part);
    const before = restored.getFinalGeometry();
    assert.ok(before && before.geometry, 'Expected base solid geometry');

    const selectedEdgeKey = findFirstCrossGroupEdgeKey(before.geometry);
    assert.ok(selectedEdgeKey, 'Expected a selectable sharp edge on the loaded chamfer sample');

    const beforeVolume = calculateMeshVolume(before.geometry);
    restored.chamfer([selectedEdgeKey], 0.25);

    const after = restored.getFinalGeometry();
    assert.ok(after && after.geometry, 'Expected chamfered solid geometry');
    assert.notStrictEqual(after.geometry, before.geometry, 'Added chamfer should not return the original geometry');
    assert.ok(
      after.geometry.faces.length !== before.geometry.faces.length ||
      after.geometry.edges.length !== before.geometry.edges.length ||
      Math.abs(calculateMeshVolume(after.geometry) - beforeVolume) > 1e-6,
      'Added chamfer should modify the loaded chamfer geometry',
    );
  });
}

// --- Test 12: Filleted chamfered concave cut edge keeps cap winding ---
console.log('--- Test 12: Filleted chamfered concave cut edge ---');
{
  const sample = JSON.parse(
    fs.readFileSync(new URL('./samples/extrude-on-extrude-dual-with-cut-and-chamfer-fillet.cmod', import.meta.url), 'utf8')
  );

  test('deserialized cut+chamfer+fillet sample keeps cap normals outward', () => {
    const restored = Part.deserialize(sample.part);
    const finalGeometry = restored.getFinalGeometry();
    assert.ok(finalGeometry && finalGeometry.geometry, 'Expected final solid geometry');

    const edgeUsage = collectEdgeUsage(finalGeometry.geometry);
    assert.strictEqual(edgeUsage.boundaryEdges, 0, `Expected no boundary edges, got ${edgeUsage.boundaryEdges}`);
    assert.strictEqual(edgeUsage.nonManifoldEdges, 0, `Expected no non-manifold edges, got ${edgeUsage.nonManifoldEdges}`);
    assert.strictEqual(edgeUsage.windingErrors, 0, `Expected no winding errors, got ${edgeUsage.windingErrors}`);
    assert.strictEqual(countInvertedFaces(finalGeometry.geometry), 0, 'Expected no inverted faces');
    assertPositiveWallThickness(finalGeometry.geometry, 'concave cut-edge chamfer+fillet sample');
    assertSingleHorizontalCapGroup(finalGeometry.geometry, 'concave cut-edge chamfer+fillet sample');
    assertNoDownwardTopExtremeFaces(finalGeometry.geometry, 'concave cut-edge chamfer+fillet sample');
  });

  test('deserialized cut+chamfer+fillet sample keeps displayed feature edges on the mesh', () => {
    const restored = Part.deserialize(sample.part);
    const finalGeometry = restored.getFinalGeometry();
    assert.ok(finalGeometry && finalGeometry.geometry, 'Expected final solid geometry');

    assertFeatureEdgesLieOnMeshBoundaries(finalGeometry.geometry, 'concave cut-edge chamfer+fillet sample');
  });

  test('deserialized cut+chamfer+fillet sample keeps exact displayed paths aligned to fallback-supported seams', () => {
    const restored = Part.deserialize(sample.part);
    const finalGeometry = restored.getFinalGeometry();
    assert.ok(finalGeometry && finalGeometry.geometry, 'Expected final solid geometry');

    const geometry = finalGeometry.geometry;
    const fallbackFeatureEdges = computeFeatureEdges(cloneFaces(geometry.faces));
    assert.strictEqual(
      geometry.paths.length,
      fallbackFeatureEdges.paths.length,
      `Expected displayed exact paths to follow fallback seam layout (${fallbackFeatureEdges.paths.length}), got ${geometry.paths.length}`,
    );
    assert.ok(
      countFilletBoundaryPaths(geometry) >= 3,
      `Expected at least 3 displayed fillet boundary paths, got ${countFilletBoundaryPaths(geometry)}`,
    );
  });

  test('deserialized cut+chamfer+fillet sample suppresses same-group internal seams', () => {
    const restored = Part.deserialize(sample.part);
    const finalGeometry = restored.getFinalGeometry();
    assert.ok(finalGeometry && finalGeometry.geometry, 'Expected final solid geometry');

    const singleFaceEdges = (finalGeometry.geometry.edges || []).filter((edge) => (edge.faceIndices || []).length === 1);
    assert.strictEqual(
      singleFaceEdges.length,
      0,
      `Expected no displayed single-face feature edges, got ${singleFaceEdges.length}`,
    );
  });

  test('deserialized cut+chamfer+fillet sample has no opposed coplanar faces in one face group', () => {
    const restored = Part.deserialize(sample.part);
    const finalGeometry = restored.getFinalGeometry();
    assert.ok(finalGeometry && finalGeometry.geometry, 'Expected final solid geometry');

    const opposedPairs = countOpposedCoplanarSameGroupFacePairs(finalGeometry.geometry);
    assert.strictEqual(
      opposedPairs,
      0,
      `Expected no opposed coplanar same-group face pairs, got ${opposedPairs}`,
    );
  });
}

// --- Summary ---
console.log('');
console.log(`CMOD Import/Export Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
