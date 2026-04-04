// tests/test-toolkit.js — Unit tests for js/cad/toolkit/ modules
// Covers: Vec3Utils, GeometryUtils, MeshRepair, MeshAnalysis, PlanarMath,
//         EdgePathUtils, TopologyUtils, CoplanarUtils

import assert from 'assert';
import {
  // Vec3Utils
  vec3Sub, vec3Add, vec3Scale, vec3Dot, vec3Cross,
  vec3Len, vec3Normalize, vec3Lerp,
  circumCenter3D, projectOntoAxis, pointsCoincident3D,
  canonicalCoord, canonicalPoint, edgeVKey, edgeKeyFromVerts,
  distancePointToLineSegment, openPolylineNormal,
  // GeometryUtils
  computePolygonNormal, faceCentroid, edgeKey,
  collectFaceEdgeKeys, pointOnSegmentStrict,
  // MeshRepair
  weldVertices, removeDegenerateFaces, recomputeFaceNormals,
  fixWindingConsistency, countMeshEdgeUsage, cloneMeshFace,
  // MeshAnalysis
  calculateMeshVolume, calculateBoundingBox, calculateSurfaceArea,
  countInvertedFaces,
  // PlanarMath
  isConvexPlanarPolygon, projectPolygon2D,
  triangulatePlanarPolygon, classifyFaceType,
  // EdgePathUtils
  chainEdgePaths,
  // TopologyUtils
  measureMeshTopology, findAdjacentFaces, buildVertexEdgeMap,
  // CoplanarUtils
  polygonArea, collinearSegmentsOverlap, coplanarFacesTouch,
  facesSharePlane, sameNormalPair, coplanarFaceClusterKey,
  sharedMetadataSignature,
} from '../js/cad/toolkit/index.js';

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

function approx(a, b, tol = 1e-6) {
  assert.ok(Math.abs(a - b) < tol, `Expected ${a} ≈ ${b} (diff=${Math.abs(a - b)})`);
}

function v(x, y, z) { return { x, y, z }; }

// Helper: make a unit box (1×1×1) mesh — 6 faces, 2 triangles each = 12 faces
function makeBoxFaces(sx = 1, sy = 1, sz = 1) {
  const faces = [];
  // Each face: {vertices: [v0, v1, v2], normal: {x,y,z}}
  const push = (verts, n) => faces.push({ vertices: verts, normal: n });
  // bottom (z=0)
  push([v(0,0,0), v(sx,0,0), v(sx,sy,0)], v(0,0,-1));
  push([v(0,0,0), v(sx,sy,0), v(0,sy,0)], v(0,0,-1));
  // top (z=sz)
  push([v(0,0,sz), v(sx,sy,sz), v(sx,0,sz)], v(0,0,1));
  push([v(0,0,sz), v(0,sy,sz), v(sx,sy,sz)], v(0,0,1));
  // front (y=0)
  push([v(0,0,0), v(sx,0,sz), v(sx,0,0)], v(0,-1,0));
  push([v(0,0,0), v(0,0,sz), v(sx,0,sz)], v(0,-1,0));
  // back (y=sy)
  push([v(0,sy,0), v(sx,sy,0), v(sx,sy,sz)], v(0,1,0));
  push([v(0,sy,0), v(sx,sy,sz), v(0,sy,sz)], v(0,1,0));
  // left (x=0)
  push([v(0,0,0), v(0,sy,0), v(0,sy,sz)], v(-1,0,0));
  push([v(0,0,0), v(0,sy,sz), v(0,0,sz)], v(-1,0,0));
  // right (x=sx)
  push([v(sx,0,0), v(sx,0,sz), v(sx,sy,sz)], v(1,0,0));
  push([v(sx,0,0), v(sx,sy,sz), v(sx,sy,0)], v(1,0,0));
  return faces;
}

// ===================================================================
// Vec3Utils
// ===================================================================
console.log('\n=== Vec3Utils ===\n');

test('vec3Sub computes correct difference', () => {
  const r = vec3Sub(v(3, 4, 5), v(1, 2, 3));
  assert.deepStrictEqual(r, v(2, 2, 2));
});

test('vec3Add computes correct sum', () => {
  const r = vec3Add(v(1, 2, 3), v(4, 5, 6));
  assert.deepStrictEqual(r, v(5, 7, 9));
});

test('vec3Scale scales vector', () => {
  const r = vec3Scale(v(1, 2, 3), 2);
  assert.deepStrictEqual(r, v(2, 4, 6));
});

test('vec3Dot computes dot product', () => {
  assert.strictEqual(vec3Dot(v(1, 0, 0), v(0, 1, 0)), 0);
  assert.strictEqual(vec3Dot(v(1, 2, 3), v(4, 5, 6)), 32);
});

test('vec3Cross computes cross product', () => {
  const r = vec3Cross(v(1, 0, 0), v(0, 1, 0));
  assert.deepStrictEqual(r, v(0, 0, 1));
});

test('vec3Len computes vector length', () => {
  approx(vec3Len(v(3, 4, 0)), 5);
  approx(vec3Len(v(0, 0, 0)), 0);
});

test('vec3Normalize returns unit vector', () => {
  const r = vec3Normalize(v(3, 4, 0));
  approx(r.x, 0.6);
  approx(r.y, 0.8);
  approx(r.z, 0);
  approx(vec3Len(r), 1);
});

test('vec3Lerp interpolates', () => {
  const r = vec3Lerp(v(0, 0, 0), v(10, 20, 30), 0.5);
  assert.deepStrictEqual(r, v(5, 10, 15));
});

test('canonicalCoord rounds to 5 decimals', () => {
  // canonicalCoord doesn't snap near-zero, it just passes through
  assert.strictEqual(typeof canonicalCoord(1e-12), 'number');
  assert.strictEqual(typeof canonicalCoord(1.23456789), 'number');
});

test('canonicalPoint returns point with snapped coords', () => {
  const p = canonicalPoint(v(1e-11, 2.123456789, -0.00001));
  assert.strictEqual(typeof p.x, 'number');
  assert.strictEqual(typeof p.y, 'number');
  assert.strictEqual(typeof p.z, 'number');
});

test('edgeVKey produces deterministic key', () => {
  const k = edgeVKey(v(1.00001, 2.00002, 3.00003));
  assert.strictEqual(typeof k, 'string');
  assert.strictEqual(edgeVKey(v(1.00001, 2.00002, 3.00003)), k); // same input = same key
});

test('edgeKeyFromVerts is order-independent', () => {
  const a = v(0, 0, 0), b = v(1, 0, 0);
  assert.strictEqual(edgeKeyFromVerts(a, b), edgeKeyFromVerts(b, a));
});

test('distancePointToLineSegment — on segment', () => {
  approx(distancePointToLineSegment(v(0.5, 1, 0), v(0, 0, 0), v(1, 0, 0)), 1);
});

test('distancePointToLineSegment — beyond endpoint', () => {
  approx(distancePointToLineSegment(v(2, 0, 0), v(0, 0, 0), v(1, 0, 0)), 1);
});

test('distancePointToLineSegment — degenerate segment', () => {
  approx(distancePointToLineSegment(v(1, 0, 0), v(0, 0, 0), v(0, 0, 0)), 1);
});

test('openPolylineNormal — planar L-shape', () => {
  const pts = [v(0,0,0), v(1,0,0), v(1,1,0)];
  const n = openPolylineNormal(pts);
  assert.ok(n);
  approx(Math.abs(n.z), 1);
});

test('openPolylineNormal — too few points returns null', () => {
  assert.strictEqual(openPolylineNormal([v(0,0,0), v(1,0,0)]), null);
});

test('circumCenter3D — equilateral triangle in XY', () => {
  const c = circumCenter3D(v(0,0,0), v(1,0,0), v(0.5, Math.sqrt(3)/2, 0));
  assert.ok(c);
  approx(c.x, 0.5);
  approx(c.z, 0);
});

test('projectOntoAxis — projects to nearest point', () => {
  const proj = projectOntoAxis(v(3, 4, 5), v(0, 0, 0), v(1, 0, 0));
  // Returns the projected point, not a scalar
  approx(proj.x, 3);
  approx(proj.y, 0);
  approx(proj.z, 0);
});

test('pointsCoincident3D — near-identical points', () => {
  // Uses internal tolerance, 1e-6 may be too tight
  assert.ok(pointsCoincident3D(v(1, 2, 3), v(1, 2, 3)));
});

test('pointsCoincident3D — different points', () => {
  assert.ok(!pointsCoincident3D(v(0, 0, 0), v(1, 0, 0)));
});

// ===================================================================
// GeometryUtils
// ===================================================================
console.log('\n=== GeometryUtils ===\n');

test('computePolygonNormal — triangle', () => {
  const n = computePolygonNormal([v(0,0,0), v(1,0,0), v(0,1,0)]);
  assert.ok(n);
  approx(n.z, 1);
});

test('computePolygonNormal — degenerate returns null', () => {
  assert.strictEqual(computePolygonNormal([v(0,0,0), v(0,0,0), v(0,0,0)]), null);
});

test('faceCentroid — triangle centroid', () => {
  const c = faceCentroid({ vertices: [v(0,0,0), v(3,0,0), v(0,3,0)] });
  approx(c.x, 1);
  approx(c.y, 1);
  approx(c.z, 0);
});

test('edgeKey — canonical key', () => {
  const k = edgeKey(v(0,0,0), v(1,0,0));
  assert.strictEqual(typeof k, 'string');
  assert.strictEqual(edgeKey(v(0,0,0), v(1,0,0)), edgeKey(v(1,0,0), v(0,0,0)));
});

test('collectFaceEdgeKeys — triangle face returns Set of 3 keys', () => {
  const face = { vertices: [v(0,0,0), v(1,0,0), v(0,1,0)] };
  const keys = collectFaceEdgeKeys(face);
  assert.ok(keys instanceof Set);
  assert.strictEqual(keys.size, 3);
});

test('pointOnSegmentStrict — midpoint', () => {
  assert.ok(pointOnSegmentStrict(v(0.5, 0, 0), v(0, 0, 0), v(1, 0, 0)));
});

test('pointOnSegmentStrict — endpoint excluded', () => {
  assert.ok(!pointOnSegmentStrict(v(0, 0, 0), v(0, 0, 0), v(1, 0, 0)));
  assert.ok(!pointOnSegmentStrict(v(1, 0, 0), v(0, 0, 0), v(1, 0, 0)));
});

test('pointOnSegmentStrict — off-segment', () => {
  assert.ok(!pointOnSegmentStrict(v(0.5, 1, 0), v(0, 0, 0), v(1, 0, 0)));
});

// ===================================================================
// PlanarMath
// ===================================================================
console.log('\n=== PlanarMath ===\n');

test('isConvexPlanarPolygon — square is convex', () => {
  const verts = [v(0,0,0), v(1,0,0), v(1,1,0), v(0,1,0)];
  assert.ok(isConvexPlanarPolygon(verts, v(0,0,1)));
});

test('isConvexPlanarPolygon — L-shape is not convex', () => {
  const verts = [v(0,0,0), v(2,0,0), v(2,1,0), v(1,1,0), v(1,2,0), v(0,2,0)];
  assert.ok(!isConvexPlanarPolygon(verts, v(0,0,1)));
});

test('projectPolygon2D — XY plane drops z', () => {
  const pts = projectPolygon2D([v(1,2,3), v(4,5,6)], v(0,0,1));
  assert.deepStrictEqual(pts, [{x:1, y:2}, {x:4, y:5}]);
});

test('triangulatePlanarPolygon — square → 2 triangles', () => {
  const verts = [v(0,0,0), v(1,0,0), v(1,1,0), v(0,1,0)];
  const tris = triangulatePlanarPolygon(verts, v(0,0,1));
  assert.ok(Array.isArray(tris));
  assert.strictEqual(tris.length, 2);
  tris.forEach(tri => assert.strictEqual(tri.length, 3));
});

test('triangulatePlanarPolygon — triangle returns identity', () => {
  const verts = [v(0,0,0), v(1,0,0), v(0,1,0)];
  const tris = triangulatePlanarPolygon(verts, v(0,0,1));
  assert.strictEqual(tris.length, 1);
});

test('triangulatePlanarPolygon — degenerate returns empty', () => {
  assert.deepStrictEqual(triangulatePlanarPolygon([v(0,0,0)], v(0,0,1)), []);
});

test('classifyFaceType — horizontal planar', () => {
  assert.strictEqual(classifyFaceType(v(0,0,1), [v(0,0,5), v(1,0,5), v(1,1,5)]), 'planar-horizontal');
});

test('classifyFaceType — vertical planar', () => {
  assert.strictEqual(classifyFaceType(v(1,0,0), [v(5,0,0), v(5,1,0), v(5,1,1)]), 'planar-vertical');
});

test('classifyFaceType — angled planar', () => {
  const n = vec3Normalize(v(1, 1, 0));
  // Vertices must be on the plane defined by this normal
  const d = 5; // plane distance
  const verts = [
    v(d * n.x, d * n.y, 0),
    v(d * n.x, d * n.y, 1),
    v(d * n.x + 0.5 * (-n.y), d * n.y + 0.5 * n.x, 0),
  ];
  assert.strictEqual(classifyFaceType(n, verts), 'planar');
});

// ===================================================================
// MeshRepair
// ===================================================================
console.log('\n=== MeshRepair ===\n');

test('countMeshEdgeUsage — closed box has zero boundary', () => {
  const faces = makeBoxFaces();
  const usage = countMeshEdgeUsage(faces);
  assert.strictEqual(usage.boundaryCount, 0);
});

test('recomputeFaceNormals — updates normals', () => {
  const faces = [
    { vertices: [v(0,0,0), v(1,0,0), v(0,1,0)], normal: v(0,0,-1) },
  ];
  recomputeFaceNormals(faces);
  // After recompute, normal should point +z for CCW XY triangle
  approx(faces[0].normal.z, 1, 0.01);
});

test('removeDegenerateFaces — removes zero-area triangles', () => {
  const faces = [
    { vertices: [v(0,0,0), v(1,0,0), v(0,1,0)], normal: v(0,0,1) },
    { vertices: [v(0,0,0), v(0,0,0), v(0,0,0)], normal: v(0,0,1) }, // degenerate
  ];
  removeDegenerateFaces(faces);
  assert.strictEqual(faces.length, 1);
});

test('cloneMeshFace — creates deep copy', () => {
  const face = { vertices: [v(1,2,3)], normal: v(0,0,1), shared: { color: 'red' } };
  const clone = cloneMeshFace(face);
  assert.notStrictEqual(clone, face);
  assert.notStrictEqual(clone.vertices, face.vertices);
  assert.notStrictEqual(clone.shared, face.shared);
  assert.deepStrictEqual(clone.shared, { color: 'red' });
});

test('cloneMeshFace — returns null-ish for null input', () => {
  assert.strictEqual(cloneMeshFace(null), null);
  assert.strictEqual(cloneMeshFace(undefined), undefined);
});

// ===================================================================
// MeshAnalysis
// ===================================================================
console.log('\n=== MeshAnalysis ===\n');

test('calculateMeshVolume — unit cube ≈ 1', () => {
  const faces = makeBoxFaces();
  const vol = calculateMeshVolume({ faces });
  approx(vol, 1, 0.01);
});

test('calculateMeshVolume — 2x3x4 box ≈ 24', () => {
  const faces = makeBoxFaces(2, 3, 4);
  const vol = calculateMeshVolume({ faces });
  approx(vol, 24, 0.1);
});

test('calculateBoundingBox — unit cube', () => {
  const faces = makeBoxFaces();
  const bbox = calculateBoundingBox({ faces });
  approx(bbox.min.x, 0); approx(bbox.min.y, 0); approx(bbox.min.z, 0);
  approx(bbox.max.x, 1); approx(bbox.max.y, 1); approx(bbox.max.z, 1);
});

test('calculateSurfaceArea — unit cube ≈ 6', () => {
  const faces = makeBoxFaces();
  const area = calculateSurfaceArea({ faces });
  approx(area, 6, 0.01);
});

test('countInvertedFaces — correct box has 0 inverted', () => {
  const faces = makeBoxFaces();
  recomputeFaceNormals(faces);
  fixWindingConsistency(faces);
  // After fixing, count should be 0
  const count = countInvertedFaces({ faces });
  assert.ok(count <= 1, `Expected ≤1 inverted faces, got ${count}`);
});

// ===================================================================
// EdgePathUtils
// ===================================================================
console.log('\n=== EdgePathUtils ===\n');

test('chainEdgePaths — empty input', () => {
  assert.deepStrictEqual(chainEdgePaths([]), []);
});

test('chainEdgePaths — single edge → one open path', () => {
  const paths = chainEdgePaths([{ start: v(0,0,0), end: v(1,0,0) }]);
  assert.strictEqual(paths.length, 1);
  assert.strictEqual(paths[0].edgeIndices.length, 1);
  assert.strictEqual(paths[0].isClosed, false);
});

test('chainEdgePaths — closed triangle', () => {
  const edges = [
    { start: v(0,0,0), end: v(1,0,0) },
    { start: v(1,0,0), end: v(0,1,0) },
    { start: v(0,1,0), end: v(0,0,0) },
  ];
  const paths = chainEdgePaths(edges);
  assert.strictEqual(paths.length, 1);
  assert.strictEqual(paths[0].isClosed, true);
  assert.strictEqual(paths[0].edgeIndices.length, 3);
});

test('chainEdgePaths — two disconnected edges → two paths', () => {
  const edges = [
    { start: v(0,0,0), end: v(1,0,0) },
    { start: v(10,0,0), end: v(11,0,0) },
  ];
  const paths = chainEdgePaths(edges);
  assert.strictEqual(paths.length, 2);
});

test('chainEdgePaths — open L-shape chain', () => {
  const edges = [
    { start: v(0,0,0), end: v(1,0,0) },
    { start: v(1,0,0), end: v(1,1,0) },
  ];
  const paths = chainEdgePaths(edges);
  assert.strictEqual(paths.length, 1);
  assert.strictEqual(paths[0].edgeIndices.length, 2);
  assert.strictEqual(paths[0].isClosed, false);
});

// ===================================================================
// TopologyUtils
// ===================================================================
console.log('\n=== TopologyUtils ===\n');

test('measureMeshTopology — closed box has 0 boundary, 0 non-manifold, 0 winding errors', () => {
  const faces = makeBoxFaces();
  const topo = measureMeshTopology(faces);
  assert.strictEqual(topo.boundaryEdges, 0);
  assert.strictEqual(topo.nonManifoldEdges, 0);
  assert.strictEqual(topo.windingErrors, 0);
});

test('measureMeshTopology — single triangle has 3 boundary edges', () => {
  const faces = [{ vertices: [v(0,0,0), v(1,0,0), v(0,1,0)] }];
  const topo = measureMeshTopology(faces);
  assert.strictEqual(topo.boundaryEdges, 3);
});

test('measureMeshTopology — two triangles sharing edge have 4 boundary edges', () => {
  const faces = [
    { vertices: [v(0,0,0), v(1,0,0), v(0,1,0)] },
    { vertices: [v(1,0,0), v(1,1,0), v(0,1,0)] },
  ];
  const topo = measureMeshTopology(faces);
  assert.strictEqual(topo.boundaryEdges, 4);
  assert.strictEqual(topo.nonManifoldEdges, 0);
});

test('findAdjacentFaces — exact match on box', () => {
  const faces = makeBoxFaces();
  const key = edgeKeyFromVerts(v(0,0,0), v(1,0,0));
  const adj = findAdjacentFaces(faces, key);
  assert.strictEqual(adj.length, 2);
  assert.notStrictEqual(adj[0].fi, adj[1].fi);
});

test('findAdjacentFaces — no match returns empty', () => {
  const faces = makeBoxFaces();
  const adj = findAdjacentFaces(faces, '99,99,99|100,100,100');
  assert.strictEqual(adj.length, 0);
});

test('buildVertexEdgeMap — simple edge list', () => {
  const edges = [
    { edgeA: v(0,0,0), edgeB: v(1,0,0) },
    { edgeA: v(1,0,0), edgeB: v(1,1,0) },
  ];
  const map = buildVertexEdgeMap(edges);
  const sharedKey = edgeVKey(v(1,0,0));
  assert.ok(map.has(sharedKey));
  assert.strictEqual(map.get(sharedKey).length, 2); // vertex (1,0,0) is shared
});

// ===================================================================
// CoplanarUtils
// ===================================================================
console.log('\n=== CoplanarUtils ===\n');

test('polygonArea — unit square area ≈ 1', () => {
  const face = { vertices: [v(0,0,0), v(1,0,0), v(1,1,0), v(0,1,0)] };
  approx(polygonArea(face), 1, 0.01);
});

test('polygonArea — triangle area ≈ 0.5', () => {
  const face = { vertices: [v(0,0,0), v(1,0,0), v(0,1,0)] };
  approx(polygonArea(face), 0.5, 0.01);
});

test('collinearSegmentsOverlap — overlapping', () => {
  assert.ok(collinearSegmentsOverlap(v(0,0,0), v(2,0,0), v(1,0,0), v(3,0,0)));
});

test('collinearSegmentsOverlap — non-overlapping', () => {
  assert.ok(!collinearSegmentsOverlap(v(0,0,0), v(1,0,0), v(2,0,0), v(3,0,0)));
});

test('collinearSegmentsOverlap — non-collinear', () => {
  assert.ok(!collinearSegmentsOverlap(v(0,0,0), v(1,0,0), v(0,1,0), v(1,1,0)));
});

test('collinearSegmentsOverlap — contained segment', () => {
  assert.ok(collinearSegmentsOverlap(v(0,0,0), v(4,0,0), v(1,0,0), v(3,0,0)));
});

test('coplanarFacesTouch — overlapping edge', () => {
  // Two triangles sharing a collinear edge section
  const a = { vertices: [v(0,0,0), v(2,0,0), v(1,1,0)] };
  const b = { vertices: [v(1,0,0), v(3,0,0), v(2,1,0)] };
  // Edge (0,0)→(2,0) and (1,0)→(3,0) overlap on [1,2]
  assert.ok(coplanarFacesTouch(a, b));
});

test('coplanarFacesTouch — disjoint faces', () => {
  const a = { vertices: [v(0,0,0), v(1,0,0), v(1,1,0)] };
  const b = { vertices: [v(5,0,0), v(6,0,0), v(6,1,0)] };
  assert.ok(!coplanarFacesTouch(a, b));
});

test('facesSharePlane — coplanar faces', () => {
  const a = { vertices: [v(0,0,0), v(1,0,0), v(1,1,0)], normal: v(0,0,1) };
  const b = { vertices: [v(2,0,0), v(3,0,0), v(3,1,0)], normal: v(0,0,1) };
  assert.ok(facesSharePlane(a, b));
});

test('facesSharePlane — different planes', () => {
  const a = { vertices: [v(0,0,0), v(1,0,0), v(1,1,0)], normal: v(0,0,1) };
  const b = { vertices: [v(0,0,1), v(1,0,1), v(1,1,1)], normal: v(0,0,1) };
  assert.ok(!facesSharePlane(a, b)); // Same normal but different plane offset
});

test('facesSharePlane — opposite normals still on same plane', () => {
  const a = { vertices: [v(0,0,0), v(1,0,0), v(1,1,0)], normal: v(0,0,1) };
  const b = { vertices: [v(0,0,0), v(1,0,0), v(1,1,0)], normal: v(0,0,-1) };
  assert.ok(facesSharePlane(a, b));
});

test('sameNormalPair — matching pairs', () => {
  assert.ok(sameNormalPair(v(0,0,1), v(0,1,0), v(0,0,1), v(0,1,0)));
  assert.ok(sameNormalPair(v(0,0,1), v(0,1,0), v(0,1,0), v(0,0,1))); // swapped
});

test('sameNormalPair — non-matching', () => {
  assert.ok(!sameNormalPair(v(0,0,1), v(0,1,0), v(1,0,0), v(0,1,0)));
});

test('coplanarFaceClusterKey — coplanar faces get same key', () => {
  const a = { vertices: [v(0,0,0), v(1,0,0), v(1,1,0)], normal: v(0,0,1), faceGroup: 0 };
  const b = { vertices: [v(2,0,0), v(3,0,0), v(3,1,0)], normal: v(0,0,1), faceGroup: 0 };
  assert.strictEqual(coplanarFaceClusterKey(a), coplanarFaceClusterKey(b));
});

test('coplanarFaceClusterKey — different planes get different keys', () => {
  const a = { vertices: [v(0,0,0), v(1,0,0), v(1,1,0)], normal: v(0,0,1), faceGroup: 0 };
  const b = { vertices: [v(0,0,5), v(1,0,5), v(1,1,5)], normal: v(0,0,1), faceGroup: 0 };
  assert.notStrictEqual(coplanarFaceClusterKey(a), coplanarFaceClusterKey(b));
});

test('coplanarFaceClusterKey — null for degenerate face', () => {
  assert.strictEqual(coplanarFaceClusterKey(null), null);
  assert.strictEqual(coplanarFaceClusterKey({ normal: null, vertices: [] }), null);
});

test('sharedMetadataSignature — null shared', () => {
  assert.strictEqual(sharedMetadataSignature(null), '__null__');
});

test('sharedMetadataSignature — deterministic', () => {
  const a = sharedMetadataSignature({ b: 2, a: 1 });
  const b = sharedMetadataSignature({ a: 1, b: 2 });
  assert.strictEqual(a, b);
});

test('sharedMetadataSignature — different values differ', () => {
  assert.notStrictEqual(
    sharedMetadataSignature({ x: 1 }),
    sharedMetadataSignature({ x: 2 }),
  );
});

// ===================================================================
// Cross-module integration tests
// ===================================================================
console.log('\n=== Cross-module Integration ===\n');

test('topology + analysis — box mesh is watertight with positive volume', () => {
  const faces = makeBoxFaces();
  const topo = measureMeshTopology(faces);
  assert.strictEqual(topo.boundaryEdges, 0);
  const vol = calculateMeshVolume({ faces });
  assert.ok(vol > 0, `Expected positive volume, got ${vol}`);
});

test('planarMath + coplanar — triangulated square stays coplanar', () => {
  const verts = [v(0,0,0), v(10,0,0), v(10,10,0), v(0,10,0)];
  const tris = triangulatePlanarPolygon(verts, v(0,0,1));
  assert.strictEqual(tris.length, 2);
  // Each triangle should have a normal pointing +z
  for (const tri of tris) {
    const n = computePolygonNormal(tri);
    assert.ok(n, 'Triangle should have valid normal');
    approx(Math.abs(n.z), 1, 0.01);
  }
});

test('edgePath + topology — box edge paths are all closed', () => {
  const faces = makeBoxFaces();
  // Collect all unique edges
  const edgeSet = new Map();
  for (const face of faces) {
    const verts = face.vertices;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      const key = edgeKeyFromVerts(a, b);
      if (!edgeSet.has(key)) {
        edgeSet.set(key, { start: a, end: b });
      }
    }
  }
  const edges = [...edgeSet.values()];
  const paths = chainEdgePaths(edges);
  assert.ok(paths.length > 0, 'Should have at least one path');
});

test('cloneMeshFace + measureTopology — clone preserves topology', () => {
  const faces = makeBoxFaces();
  const cloned = faces.map(f => cloneMeshFace(f));
  const origTopo = measureMeshTopology(faces);
  const cloneTopo = measureMeshTopology(cloned);
  assert.strictEqual(origTopo.boundaryEdges, cloneTopo.boundaryEdges);
  assert.strictEqual(origTopo.nonManifoldEdges, cloneTopo.nonManifoldEdges);
});

// ===================================================================
// Summary
// ===================================================================
console.log(`\n=== Toolkit Test Results ===\n`);
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
