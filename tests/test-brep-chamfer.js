import './_watchdog.mjs';
import assert from 'assert';
import { readFileSync } from 'node:fs';
import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { parseCMOD } from '../js/cmod.js';
import { applyBRepChamfer } from '../js/cad/BRepChamfer.js';
import { resetFeatureIds } from '../js/cad/Feature.js';
import { resetTopoIds } from '../js/cad/BRepTopology.js';
import { tessellateBody } from '../js/cad/Tessellation.js';
import { detectBoundaryEdges, detectDegenerateFaces } from '../js/cad/MeshValidator.js';
import { EdgeSampler } from '../js/cad/Tessellator2/EdgeSampler.js';
import { ensureWasmReady, tessellateBodyWasm } from '../js/cad/StepImportWasm.js';
import { formatTimingSuffix, startTiming } from './test-timing.js';

await ensureWasmReady().catch(() => null);

let passed = 0;
let failed = 0;

function test(name, fn) {
  const startedAt = startTiming();
  try {
    fn();
    console.log(`  ✓ ${name}${formatTimingSuffix(startedAt)}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}${formatTimingSuffix(startedAt)}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

function edgeKey(a, b) {
  return [a, b]
    .map((point) => `${point.x.toFixed(5)},${point.y.toFixed(5)},${point.z.toFixed(5)}`)
    .sort()
    .join('|');
}

function countBoundaryEdges(body) {
  const edgeRefs = new Map();
  for (const face of body.shells[0].faces) {
    for (const coedge of face.outerLoop.coedges) {
      edgeRefs.set(coedge.edge.id, (edgeRefs.get(coedge.edge.id) || 0) + 1);
    }
  }
  let boundaryEdges = 0;
  for (const count of edgeRefs.values()) {
    if (count < 2) boundaryEdges++;
  }
  return boundaryEdges;
}

function makePlane() {
  return {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
  };
}

function makeBoxPart() {
  const part = new Part('Box');
  const sketch = new Sketch();
  sketch.addSegment(0, 0, 20, 0);
  sketch.addSegment(20, 0, 20, 10);
  sketch.addSegment(20, 10, 0, 10);
  sketch.addSegment(0, 10, 0, 0);
  part.addSketch(sketch, makePlane());
  part.extrude(part.getSketches()[0].id, 10);
  return part;
}

function makeArcPart() {
  const part = new Part('ArcTest');
  const sketch = new Sketch();
  sketch.addSegment(-10, -10, -10, 10);
  sketch.addSegment(-10, 10, 10, 10);
  sketch.addArc(10, 0, 10, Math.PI / 2, -Math.PI / 2);
  sketch.addSegment(10, -10, -10, -10);
  part.addSketch(sketch, makePlane());
  part.extrude(part.getSketches()[0].id, 10);
  return part;
}

function validateExactChamfer(part, edgeSelector, distance) {
  const extrude = part.featureTree.features.find((feature) => feature.type === 'extrude');
  const geometry = extrude.result.geometry;
  const selectedEdge = edgeSelector(geometry.edges || []);
  assert.ok(selectedEdge, 'Expected an edge selection for chamfer');

  const result = applyBRepChamfer(geometry, [edgeKey(selectedEdge.start, selectedEdge.end)], distance);
  assert.ok(result, 'Exact chamfer should return a geometry');
  assert.ok(result.topoBody, 'Exact chamfer should produce a topoBody');
  assert.ok(result.topoBody.shells[0].faces.length >= 7, 'Chamfered body should add a face');
  assert.strictEqual(countBoundaryEdges(result.topoBody), 0, 'Chamfered topoBody should be closed');

  const tess = tessellateBody(result.topoBody, { validate: true });
  assert.strictEqual(tess.boundaryEdges ?? 0, 0, 'Tessellation should have no boundary edges');
  assert.strictEqual(tess.nonManifoldEdges ?? 0, 0, 'Tessellation should have no non-manifold edges');
}

function loadSamplePart(filename) {
  const parsed = parseCMOD(readFileSync(`tests/samples/${filename}`, 'utf8'));
  assert.ok(parsed.ok, `Expected ${filename} to parse`);
  return Part.deserialize(parsed.data.part);
}

function dotProduct(first, second) {
  return first.x * second.x + first.y * second.y + first.z * second.z;
}

function normalizeVector(vector) {
  const length = Math.sqrt(vector.x * vector.x + vector.y * vector.y + vector.z * vector.z);
  assert.ok(length > 1e-12, 'Expected a non-zero normal vector');
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function surfaceNormalAtPoint(face, point) {
  if (!face.surface || typeof face.surface.closestPointUV !== 'function' || typeof face.surface.normal !== 'function') {
    return null;
  }
  const uv = face.surface.closestPointUV(point);
  const surfaceNormal = face.surface.normal(uv.u, uv.v);
  if (!surfaceNormal) return null;
  const outward = face.sameSense === false
    ? { x: -surfaceNormal.x, y: -surfaceNormal.y, z: -surfaceNormal.z }
    : surfaceNormal;
  return normalizeVector(outward);
}

function triangleCentroid(face) {
  const vertices = face.vertices || [];
  return {
    x: (vertices[0].x + vertices[1].x + vertices[2].x) / 3,
    y: (vertices[0].y + vertices[1].y + vertices[2].y) / 3,
    z: (vertices[0].z + vertices[1].z + vertices[2].z) / 3,
  };
}

function assertCurvedNormalsFollowSurface(topoBody, mesh) {
  for (const topoFace of topoBody.faces()) {
    if (topoFace.surfaceType === 'plane' || !topoFace.surface) continue;
    const meshFaces = mesh.faces.filter((meshFace) => meshFace.topoFaceId === topoFace.id);
    assert.ok(meshFaces.length > 0, `Expected tessellation for curved face ${topoFace.id}`);
    for (const meshFace of meshFaces) {
      const expectedFaceNormal = surfaceNormalAtPoint(topoFace, triangleCentroid(meshFace));
      if (!expectedFaceNormal) continue;
      assert.ok(
        dotProduct(meshFace.normal, expectedFaceNormal) > 0,
        `Curved face ${topoFace.id} mesh normal should follow its surface normal`,
      );
      const vertexNormals = meshFace.vertexNormals || [];
      assert.strictEqual(vertexNormals.length, meshFace.vertices.length, `Curved face ${topoFace.id} should carry vertex normals`);
      for (let vertexIndex = 0; vertexIndex < meshFace.vertices.length; vertexIndex++) {
        const expectedVertexNormal = surfaceNormalAtPoint(topoFace, meshFace.vertices[vertexIndex]);
        if (!expectedVertexNormal) continue;
        assert.ok(
          dotProduct(vertexNormals[vertexIndex], expectedVertexNormal) > 0,
          `Curved face ${topoFace.id} vertex normal should follow its surface normal`,
        );
      }
    }
  }
}

function countRoundedBoundaryEdges(meshFaces) {
  const edgeCounts = new Map();
  const vertexKey = (vertex) => `${vertex.x.toFixed(5)},${vertex.y.toFixed(5)},${vertex.z.toFixed(5)}`;
  for (const face of meshFaces || []) {
    const vertices = face.vertices || [];
    for (let index = 0; index < vertices.length; index++) {
      const currentKey = vertexKey(vertices[index]);
      const nextKey = vertexKey(vertices[(index + 1) % vertices.length]);
      const edgeKey = currentKey < nextKey ? `${currentKey}|${nextKey}` : `${nextKey}|${currentKey}`;
      edgeCounts.set(edgeKey, (edgeCounts.get(edgeKey) || 0) + 1);
    }
  }
  let boundaryEdges = 0;
  for (const count of edgeCounts.values()) {
    if (count === 1) boundaryEdges++;
  }
  return boundaryEdges;
}

function assertNativeWasmFeatureNormalsFollowSurface(topoBody, mesh) {
  assert.ok(mesh && mesh.faces && mesh.faces.length > 0, 'Expected native WASM tessellation output');
  assert.strictEqual(detectBoundaryEdges(mesh.faces).count, 0, 'Native WASM cc3 mesh should not expose boundary holes');
  assert.strictEqual(countRoundedBoundaryEdges(mesh.faces), 0, 'Native WASM cc3 mesh should not trip app rounded-edge hole detection');

  let checkedCurvedFaces = 0;
  let checkedChamferFaces = 0;
  for (const topoFace of topoBody.faces()) {
    const isChamferPlane = topoFace.surfaceType === 'plane' && topoFace.shared?.isChamfer;
    const isCurved = topoFace.surfaceType !== 'plane';
    if (!topoFace.surface || (!isCurved && !isChamferPlane)) continue;

    const meshFaces = mesh.faces.filter((meshFace) => meshFace.topoFaceId === topoFace.id);
    assert.ok(meshFaces.length > 0, `Expected native WASM tessellation for feature face ${topoFace.id}`);
    if (isCurved) checkedCurvedFaces++;
    if (isChamferPlane) checkedChamferFaces++;

    for (const meshFace of meshFaces) {
      const expectedFaceNormal = surfaceNormalAtPoint(topoFace, triangleCentroid(meshFace));
      if (!expectedFaceNormal) continue;
      assert.ok(
        dotProduct(normalizeVector(meshFace.normal), expectedFaceNormal) > 0.25,
        `Native WASM feature face ${topoFace.id} should wind toward its surface normal`,
      );
      const vertexNormals = meshFace.vertexNormals || [];
      for (let vertexIndex = 0; vertexIndex < vertexNormals.length; vertexIndex++) {
        const expectedVertexNormal = surfaceNormalAtPoint(topoFace, meshFace.vertices[vertexIndex]);
        if (!expectedVertexNormal) continue;
        assert.ok(
          dotProduct(normalizeVector(vertexNormals[vertexIndex]), expectedVertexNormal) > 0.25,
          `Native WASM feature face ${topoFace.id} vertex normal should follow its surface normal`,
        );
      }
    }
  }

  assert.ok(checkedCurvedFaces >= 1, 'Expected cc3 native WASM check to cover curved feature faces');
  assert.ok(checkedChamferFaces >= 1, 'Expected cc3 native WASM check to cover the straight chamfer face');
}

function assertNativeWasmChamferSurfaceTessellated(topoBody, mesh, surfaceType) {
  assert.ok(mesh && mesh.faces && mesh.faces.length > 0, 'Expected native WASM tessellation output');
  assert.strictEqual(detectBoundaryEdges(mesh.faces).count, 0, `${surfaceType} chamfer mesh should match neighboring boundary samples`);
  const chamferFace = topoBody.faces().find((face) =>
    face.surfaceType === surfaceType &&
    face.shared?.isChamfer &&
    face.surface &&
    typeof face.surface.closestPointUV === 'function' &&
    typeof face.surface.normal === 'function'
  );
  assert.ok(chamferFace, `Expected ${surfaceType} chamfer face in topoBody`);
  assert.ok(!chamferFace.surfaceInfo, `Expected ${surfaceType} chamfer to exercise NURBS-backed WASM serialization`);

  const meshFaces = mesh.faces.filter((meshFace) => meshFace.topoFaceId === chamferFace.id);
  assert.ok(meshFaces.length >= 32, `Expected native WASM tessellation for ${surfaceType} chamfer face ${chamferFace.id}`);
  assert.ok(meshFaces.length <= 128, `Expected ${surfaceType} chamfer face ${chamferFace.id} to use a boundary-matched strip, got ${meshFaces.length} triangles`);
  assert.strictEqual(detectDegenerateFaces(meshFaces).count, 0, `${surfaceType} chamfer face should not emit degenerate triangles`);

  for (const meshFace of meshFaces) {
    const expectedFaceNormal = surfaceNormalAtPoint(chamferFace, triangleCentroid(meshFace));
    if (!expectedFaceNormal) continue;
    assert.ok(
      dotProduct(normalizeVector(meshFace.normal), expectedFaceNormal) > 0.25,
      `${surfaceType} chamfer face ${chamferFace.id} should wind toward its surface normal`,
    );
    const vertexNormals = meshFace.vertexNormals || [];
    assert.strictEqual(vertexNormals.length, meshFace.vertices.length, `${surfaceType} chamfer face should carry vertex normals`);
    for (let vertexIndex = 0; vertexIndex < vertexNormals.length; vertexIndex++) {
      const expectedVertexNormal = surfaceNormalAtPoint(chamferFace, meshFace.vertices[vertexIndex]);
      if (!expectedVertexNormal) continue;
      assert.ok(
        dotProduct(normalizeVector(vertexNormals[vertexIndex]), expectedVertexNormal) > 0.25,
        `${surfaceType} chamfer face ${chamferFace.id} vertex normal should follow its surface normal`,
      );
    }
  }
}

function collectLoopSamples(loop, edgeSampler, segments = 64) {
  const points = [];
  for (const coedge of loop.coedges || []) {
    let samples = edgeSampler.sampleCoEdge(coedge, segments);
    if (points.length > 0 && samples.length > 0) samples = samples.slice(1);
    points.push(...samples);
  }
  if (points.length > 1) {
    const first = points[0];
    const last = points[points.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y, first.z - last.z) < 1e-8) points.pop();
  }
  return points;
}

function pointInPolygonXY(point, polygon) {
  let inside = false;
  for (let currentIndex = 0, previousIndex = polygon.length - 1; currentIndex < polygon.length; previousIndex = currentIndex++) {
    const current = polygon[currentIndex];
    const previous = polygon[previousIndex];
    const crosses = (current.y > point.y) !== (previous.y > point.y);
    if (!crosses) continue;
    const xAtY = (previous.x - current.x) * (point.y - current.y) / ((previous.y - current.y) || 1e-30) + current.x;
    if (point.x < xAtY) inside = !inside;
  }
  return inside;
}

function polygonAreaXY(polygon) {
  let area = 0;
  for (let currentIndex = 0, previousIndex = polygon.length - 1; currentIndex < polygon.length; previousIndex = currentIndex++) {
    area += polygon[previousIndex].x * polygon[currentIndex].y - polygon[currentIndex].x * polygon[previousIndex].y;
  }
  return area / 2;
}

function assertTopFaceTrianglesStayInTrimRegion(topoBody, mesh) {
  const topFace = topoBody.faces().find((face) =>
    face.surfaceType === 'plane' &&
    face.outerLoop?.points().every((point) => Math.abs(point.z - 10) < 1e-6) &&
    (face.innerLoops?.length || 0) >= 2
  );
  assert.ok(topFace, 'Expected the advanced planar top face with inner loops');
  assert.strictEqual(mesh._tessellator, 'wasm', 'Expected holed feature top face to tessellate in WASM without JS fallback');

  const edgeSampler = new EdgeSampler();
  for (const shell of topoBody.shells || []) {
    for (const edge of shell.edges()) edgeSampler.sampleEdge(edge, 64);
  }
  const outerLoop = collectLoopSamples(topFace.outerLoop, edgeSampler);
  const innerLoops = (topFace.innerLoops || [])
    .map((loop) => collectLoopSamples(loop, edgeSampler))
    .filter((loop) => loop.length >= 3);
  assert.ok(outerLoop.length >= 3, 'Expected top face outer loop samples');
  assert.ok(innerLoops.length >= 2, 'Expected top face hole loop samples');

  const topTriangles = mesh.faces.filter((meshFace) => meshFace.topoFaceId === topFace.id);
  assert.ok(topTriangles.length >= 40, 'Expected detailed top face triangulation instead of a coarse fan');
  assert.strictEqual(detectBoundaryEdges(mesh.faces).count, 0, 'WASM cc3 mesh should not contain boundary seams from planar hole bridging');
  assert.strictEqual(detectDegenerateFaces(mesh.faces).count, 0, 'WASM cc3 mesh should not emit degenerate planar bridge triangles');

  let maxArea = 0;
  let totalArea = 0;
  for (const meshFace of topTriangles) {
    const vertices = meshFace.vertices;
    const area = Math.abs(
      ((vertices[1].x - vertices[0].x) * (vertices[2].y - vertices[0].y) -
        (vertices[1].y - vertices[0].y) * (vertices[2].x - vertices[0].x)) / 2,
    );
    maxArea = Math.max(maxArea, area);
    totalArea += area;

    const centroid = triangleCentroid(meshFace);
    assert.ok(
      !innerLoops.some((innerLoop) => pointInPolygonXY(centroid, innerLoop)),
      'Top face triangle centroid should not fill an inner loop',
    );
  }
  const expectedArea = Math.abs(polygonAreaXY(outerLoop)) - innerLoops.reduce(
    (sum, innerLoop) => sum + Math.abs(polygonAreaXY(innerLoop)),
    0,
  );
  assert.ok(
    Math.abs(totalArea - expectedArea) <= Math.max(0.1, expectedArea * 1e-4),
    `Expected top face triangles to cover trim area ${expectedArea.toFixed(3)}, got ${totalArea.toFixed(3)}`,
  );
  assert.ok(maxArea <= 200, `Expected no giant fan triangle on top face, got area ${maxArea}`);
}

console.log('=== Exact B-Rep Chamfer Tests ===\n');

test('Planar box edge chamfer builds a closed topoBody', () => {
  resetFeatureIds();
  resetTopoIds();
  const part = makeBoxPart();
  validateExactChamfer(
    part,
    (edges) => edges.find((edge) => Math.abs(edge.start.z - 10) < 1e-6 && Math.abs(edge.end.z - 10) < 1e-6),
    1,
  );
});

test('Curved extrusion edge chamfer builds a closed topoBody', () => {
  resetFeatureIds();
  resetTopoIds();
  const part = makeArcPart();
  validateExactChamfer(
    part,
    (edges) => edges.find((edge) =>
      Math.abs(edge.start.z - 10) < 1e-6 &&
      Math.abs(edge.end.z - 10) < 1e-6 &&
      Math.abs(edge.start.x - edge.end.x) > 0.5 &&
      Math.abs(edge.start.y - edge.end.y) > 0.01
    ),
    1,
  );
});

test('ChamferFeature uses exact path for curved extrusion edge', () => {
  resetFeatureIds();
  resetTopoIds();
  const part = makeArcPart();
  const extrude = part.featureTree.features.find((feature) => feature.type === 'extrude');
  const geometry = extrude.result.geometry;
  const selectedEdge = (geometry.edges || []).find((edge) =>
    Math.abs(edge.start.z - 10) < 1e-6 &&
    Math.abs(edge.end.z - 10) < 1e-6 &&
    Math.abs(edge.start.x - edge.end.x) > 0.5 &&
    Math.abs(edge.start.y - edge.end.y) > 0.01
  );
  assert.ok(selectedEdge, 'Expected a curved top edge selection');

  const chamfer = part.chamfer([edgeKey(selectedEdge.start, selectedEdge.end)], 1);
  const result = chamfer.result.geometry;
  assert.ok(result.topoBody, 'Chamfer feature should keep exact topology');
  assert.strictEqual(countBoundaryEdges(result.topoBody), 0, 'Chamfer feature topoBody should be closed');
});

test('Concave top-face chamfer offsets toward local material side', () => {
  resetFeatureIds();
  resetTopoIds();
  const part = new Part('ConcaveChamfer');
  const sketch = new Sketch();
  const points = [[0, 0], [10, 0], [10, 10], [7, 10], [7, 4], [3, 4], [3, 10], [0, 10]];
  for (let index = 0; index < points.length; index++) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    sketch.addSegment(start[0], start[1], end[0], end[1]);
  }
  part.addSketch(sketch, makePlane());
  part.extrude(part.getSketches()[0].id, 10);

  const geometry = part.getFinalGeometry().geometry;
  const selectedEdge = (geometry.edges || []).find((edge) =>
    Math.abs(edge.start.z - 10) < 1e-6 &&
    Math.abs(edge.end.z - 10) < 1e-6 &&
    Math.abs(edge.start.y - 4) < 1e-6 &&
    Math.abs(edge.end.y - 4) < 1e-6
  );
  assert.ok(selectedEdge, 'Expected concave notch edge on the top face');

  const chamfer = part.chamfer([edgeKey(selectedEdge.start, selectedEdge.end)], 1);
  const topFace = chamfer.result.geometry.topoBody.faces().find((face) =>
    face.outerLoop?.points().every((point) => Math.abs(point.z - 10) < 1e-6)
  );
  assert.ok(topFace, 'Expected the top planar face to survive chamfer');

  const notchVertices = topFace.outerLoop.points().filter((point) =>
    point.x >= 3 - 1e-6 && point.x <= 7 + 1e-6 && Math.abs(point.z - 10) < 1e-6
  );
  assert.ok(notchVertices.some((point) => Math.abs(point.y - 3) < 1e-6), 'Top face should trim into the local material side');
  assert.ok(!notchVertices.some((point) => Math.abs(point.y - 5) < 1e-6), 'Top face should not offset into the concave void');
});

test('puzzle-extrude-cc2 concave arc chamfer surface tessellates in native WASM', () => {
  const part = loadSamplePart('puzzle-extrude-cc2.cmod');
  const geometry = part.getFinalGeometry().geometry;
  assert.ok(geometry.topoBody, 'Expected cc2 sample to rebuild exact topology');

  const rawWasmMesh = tessellateBodyWasm(geometry.topoBody, { edgeSegments: 16, surfaceSegments: 16 });
  assertNativeWasmChamferSurfaceTessellated(geometry.topoBody, rawWasmMesh, 'cone');

  const mesh = tessellateBody(geometry.topoBody, { validate: false });
  assert.strictEqual(mesh._tessellator, 'wasm', 'Expected cc2 concave arc chamfer to stay on the WASM route');
  assertNativeWasmChamferSurfaceTessellated(geometry.topoBody, mesh, 'cone');
});

test('puzzle-extrude-cc3 chamfer keeps top trims and curved normals outward', () => {
  const part = loadSamplePart('puzzle-extrude-cc3.cmod');
  const geometry = part.getFinalGeometry().geometry;
  assert.ok(geometry.topoBody, 'Expected cc3 sample to rebuild exact topology');

  const rawWasmMesh = tessellateBodyWasm(geometry.topoBody, { edgeSegments: 16, surfaceSegments: 16 });
  assertNativeWasmFeatureNormalsFollowSurface(geometry.topoBody, rawWasmMesh);

  const mesh = tessellateBody(geometry.topoBody, { validate: false });
  assertCurvedNormalsFollowSurface(geometry.topoBody, mesh);
  assertTopFaceTrianglesStayInTrimRegion(geometry.topoBody, mesh);
});

console.log('\n=== Results ===\n');
console.log(`${passed} passed, ${failed} failed`);

if (failed > 0) process.exit(1);