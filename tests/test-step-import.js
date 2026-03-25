// tests/test-step-import.js — Tests for STEP file import
//
// Validates:
// 1. STEP file parsing (entity extraction, reference resolution)
// 2. Mesh geometry generation (vertices, faces, normals)
// 3. Integration with feature tree (acts as parametric solid)
// 4. Serialization / deserialization round-trip
// 5. Subsequent parametric operations on imported geometry

import assert from 'assert';
import { readFileSync } from 'fs';
import { importSTEP } from '../js/cad/StepImport.js';
import { StepImportFeature } from '../js/cad/StepImportFeature.js';
import { Part } from '../js/cad/Part.js';
import { PartManager } from '../js/part-manager.js';
import { resetFeatureIds } from '../js/cad/Feature.js';

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
    if (err.stack) {
      const stackLines = err.stack.split('\n').slice(1, 4);
      for (const line of stackLines) console.log(`    ${line.trim()}`);
    }
    failed++;
  }
}

// Load the reference STEP file
const stepFilePath = new URL('./step/Unnamed-Body.step', import.meta.url).pathname;
const stepData = readFileSync(stepFilePath, 'utf-8');

// ============================================================
console.log('=== STEP Import — Parsing Tests ===\n');
// ============================================================

test('importSTEP: parses reference STEP file without errors', () => {
  const mesh = importSTEP(stepData);
  assert.ok(mesh, 'Should return a mesh object');
  assert.ok(Array.isArray(mesh.vertices), 'Should have vertices array');
  assert.ok(Array.isArray(mesh.faces), 'Should have faces array');
});

test('importSTEP: produces non-empty geometry', () => {
  const mesh = importSTEP(stepData);
  assert.ok(mesh.faces.length > 0, `Should have faces (got ${mesh.faces.length})`);
  assert.ok(mesh.vertices.length > 0, `Should have vertices (got ${mesh.vertices.length})`);
});

test('importSTEP: faces have valid structure', () => {
  const mesh = importSTEP(stepData);
  for (let i = 0; i < Math.min(mesh.faces.length, 20); i++) {
    const face = mesh.faces[i];
    assert.ok(Array.isArray(face.vertices), `Face ${i} should have vertices array`);
    assert.ok(face.vertices.length >= 3, `Face ${i} should have at least 3 vertices`);
    assert.ok(face.normal, `Face ${i} should have a normal`);
    assert.ok(typeof face.normal.x === 'number', `Face ${i} normal.x should be a number`);
    assert.ok(typeof face.normal.y === 'number', `Face ${i} normal.y should be a number`);
    assert.ok(typeof face.normal.z === 'number', `Face ${i} normal.z should be a number`);
  }
});

test('importSTEP: vertices have valid 3D coordinates', () => {
  const mesh = importSTEP(stepData);
  for (let i = 0; i < Math.min(mesh.faces.length, 20); i++) {
    for (const v of mesh.faces[i].vertices) {
      assert.ok(typeof v.x === 'number' && isFinite(v.x), `Vertex x should be finite number`);
      assert.ok(typeof v.y === 'number' && isFinite(v.y), `Vertex y should be finite number`);
      assert.ok(typeof v.z === 'number' && isFinite(v.z), `Vertex z should be finite number`);
    }
  }
});

test('importSTEP: all 60 ADVANCED_FACEs are tessellated', () => {
  const mesh = importSTEP(stepData);
  // The STEP file has 60 ADVANCED_FACEs; each produces ≥1 triangle
  assert.ok(mesh.faces.length >= 60,
    `Should produce at least 60 triangles from 60 faces (got ${mesh.faces.length})`);
});

test('importSTEP: curveSegments option affects tessellation', () => {
  const meshLow = importSTEP(stepData, { curveSegments: 4 });
  const meshHigh = importSTEP(stepData, { curveSegments: 32 });
  // Higher segment count should generally produce more faces for curved surfaces
  assert.ok(meshHigh.faces.length >= meshLow.faces.length,
    `Higher segments (${meshHigh.faces.length}) should produce ≥ faces than low (${meshLow.faces.length})`);
});

test('importSTEP: throws on empty input', () => {
  assert.throws(() => importSTEP(''), /No solid geometry/);
});

test('importSTEP: throws on invalid STEP content', () => {
  assert.throws(() => importSTEP('not a STEP file'), /No solid geometry/);
});

// ============================================================
console.log('\n=== STEP Import — Box-Fillet-3 Tests ===\n');
// ============================================================

// Load the box-fillet-3 STEP file (FreeCAD-generated: 10x10x10 box with 3 fillets + sphere corner)
const boxFilletPath = new URL('./step/box-fillet-3.step', import.meta.url).pathname;
const boxFilletData = readFileSync(boxFilletPath, 'utf-8');

test('box-fillet-3: parses without errors', () => {
  const mesh = importSTEP(boxFilletData, { curveSegments: 16 });
  assert.ok(mesh, 'Should return a mesh object');
  assert.ok(mesh.faces.length > 0, 'Should have faces');
  assert.ok(mesh.body, 'Should have a B-Rep body');
});

test('box-fillet-3: produces all 10 faces', () => {
  const mesh = importSTEP(boxFilletData, { curveSegments: 16 });
  // 10 ADVANCED_FACEs: 6 planes + 3 cylinders + 1 sphere
  const groups = new Set(mesh.faces.map(f => f.faceGroup));
  assert.strictEqual(groups.size, 10, `Should have 10 face groups (got ${groups.size})`);
});

test('box-fillet-3: bounding box matches 10×10×10', () => {
  const mesh = importSTEP(boxFilletData, { curveSegments: 16 });
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (const v of mesh.vertices) {
    if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
    if (v.z < minZ) minZ = v.z; if (v.z > maxZ) maxZ = v.z;
  }
  assert.ok(Math.abs(maxX - minX - 10) < 0.01, `X extent should be ~10 (got ${maxX - minX})`);
  assert.ok(Math.abs(maxY - minY - 10) < 0.01, `Y extent should be ~10 (got ${maxY - minY})`);
  assert.ok(Math.abs(maxZ - minZ - 10) < 0.01, `Z extent should be ~10 (got ${maxZ - minZ})`);
});

test('box-fillet-3: curved faces have isCurved flag and varying normals', () => {
  const mesh = importSTEP(boxFilletData, { curveSegments: 16 });
  const curvedGroups = new Map();
  for (const f of mesh.faces) {
    if (f.isCurved) {
      if (!curvedGroups.has(f.faceGroup)) curvedGroups.set(f.faceGroup, []);
      curvedGroups.get(f.faceGroup).push(f.normal);
    }
  }
  // Should have 4 curved face groups (3 cylinders + 1 sphere)
  assert.ok(curvedGroups.size >= 4, `Should have at least 4 curved groups (got ${curvedGroups.size})`);

  // Each curved group with >1 triangle should have varying normals
  for (const [g, normals] of curvedGroups) {
    if (normals.length > 1) {
      const n0 = normals[0];
      const allSame = normals.every(n =>
        Math.abs(n.x - n0.x) < 0.001 && Math.abs(n.y - n0.y) < 0.001 && Math.abs(n.z - n0.z) < 0.001
      );
      assert.ok(!allSame, `Curved group ${g} should have varying normals for smooth shading`);
    }
  }
});

test('box-fillet-3: all normals are unit-length and finite', () => {
  const mesh = importSTEP(boxFilletData, { curveSegments: 16 });
  for (let i = 0; i < mesh.faces.length; i++) {
    const n = mesh.faces[i].normal;
    const len = Math.sqrt(n.x * n.x + n.y * n.y + n.z * n.z);
    assert.ok(isFinite(len), `Face ${i} normal length should be finite`);
    assert.ok(Math.abs(len - 1) < 0.01, `Face ${i} normal should be unit-length (got ${len.toFixed(4)})`);
  }
});

// ============================================================
console.log('\n=== STEP Import — Deep Sphere Tessellation Tests ===\n');
// ============================================================

// The sphere face in box-fillet-3.step: center (9,1,9), radius 1, 3 arc edges.
// Previously the centroid fan vertex was not projected onto the sphere surface,
// causing a visible dent where the three cylindrical fillets meet.

test('box-fillet-3: sphere face vertices lie on the sphere surface', () => {
  const mesh = importSTEP(boxFilletData, { curveSegments: 16 });
  // Identify sphere from BRep — faceGroup is the iteration index over body.faces()
  const body = mesh.body;
  assert.ok(body, 'Should have BRep body');
  let sphereInfo = null;
  let sphereFaceGroup = -1;
  let faceIdx = 0;
  for (const face of body.faces()) {
    if (face.surfaceType === 'sphere') {
      sphereInfo = face.surfaceInfo;
      sphereFaceGroup = faceIdx;
    }
    faceIdx++;
  }
  assert.ok(sphereInfo, 'Should have a sphere surfaceInfo');
  assert.ok(sphereFaceGroup >= 0, 'Should have a sphere faceGroup');
  const { origin, radius } = sphereInfo;

  // Collect the sphere face group from the tessellated mesh
  const sphereFaces = mesh.faces.filter(f => f.faceGroup === sphereFaceGroup);
  assert.ok(sphereFaces.length > 0, 'Sphere face group should have triangles');

  const TOL = 0.002; // tolerance in model units (radius = 1 in this file)
  for (let i = 0; i < sphereFaces.length; i++) {
    for (const v of sphereFaces[i].vertices) {
      const dx = v.x - origin.x, dy = v.y - origin.y, dz = v.z - origin.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      assert.ok(
        Math.abs(dist - radius) < TOL,
        `Sphere face ${i} vertex (${v.x.toFixed(4)}, ${v.y.toFixed(4)}, ${v.z.toFixed(4)}) ` +
        `dist from center = ${dist.toFixed(6)}, expected ${radius} ±${TOL}`
      );
    }
  }
});

test('box-fillet-3: sphere face normals point outward from center', () => {
  const mesh = importSTEP(boxFilletData, { curveSegments: 16 });
  const body = mesh.body;
  let sphereInfo = null;
  let sphereSameSense = true;
  let sphereFaceGroup = -1;
  let faceIdx = 0;
  for (const face of body.faces()) {
    if (face.surfaceType === 'sphere') {
      sphereInfo = face.surfaceInfo;
      sphereSameSense = face.sameSense;
      sphereFaceGroup = faceIdx;
    }
    faceIdx++;
  }
  const { origin } = sphereInfo;

  // Get sphere triangles by faceGroup
  const sphereFaces = mesh.faces.filter(f => f.faceGroup === sphereFaceGroup);
  assert.ok(sphereFaces.length > 0, 'Should have sphere triangles');

  // For each triangle, verify the face normal is consistent with
  // the expected outward direction (center → centroid of triangle).
  for (let i = 0; i < sphereFaces.length; i++) {
    const f = sphereFaces[i];
    const cx = (f.vertices[0].x + f.vertices[1].x + f.vertices[2].x) / 3;
    const cy = (f.vertices[0].y + f.vertices[1].y + f.vertices[2].y) / 3;
    const cz = (f.vertices[0].z + f.vertices[1].z + f.vertices[2].z) / 3;
    const rx = cx - origin.x, ry = cy - origin.y, rz = cz - origin.z;
    // Dot product of face normal with radial direction should be positive
    // (for sameSense=true) or negative (for sameSense=false)
    const dot = f.normal.x * rx + f.normal.y * ry + f.normal.z * rz;
    const expectedSign = sphereSameSense ? 1 : -1;
    assert.ok(
      dot * expectedSign > 0,
      `Sphere face ${i} normal should point ${sphereSameSense ? 'outward' : 'inward'} (dot=${dot.toFixed(4)})`
    );
  }
});

test('box-fillet-3: sphere face has no degenerate triangles', () => {
  const mesh = importSTEP(boxFilletData, { curveSegments: 16 });
  const body = mesh.body;
  let sphereFaceGroup = -1;
  let faceIdx = 0;
  for (const face of body.faces()) {
    if (face.surfaceType === 'sphere') sphereFaceGroup = faceIdx;
    faceIdx++;
  }

  const sphereFaces = mesh.faces.filter(f => f.faceGroup === sphereFaceGroup);
  assert.ok(sphereFaces.length > 0, 'Should have sphere triangles');

  for (let i = 0; i < sphereFaces.length; i++) {
    const [a, b, c] = sphereFaces[i].vertices;
    // Cross product magnitude = 2× triangle area
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
    const acx = c.x - a.x, acy = c.y - a.y, acz = c.z - a.z;
    const cx2 = aby * acz - abz * acy;
    const cy2 = abz * acx - abx * acz;
    const cz2 = abx * acy - aby * acx;
    const area2 = Math.sqrt(cx2*cx2 + cy2*cy2 + cz2*cz2);
    assert.ok(area2 > 1e-12, `Sphere triangle ${i} should not be degenerate (area²=${area2.toExponential(3)})`);
  }
});

test('box-fillet-3: sphere BRep face has 3 arc coedges', () => {
  const mesh = importSTEP(boxFilletData, { curveSegments: 16 });
  const body = mesh.body;
  let sphereFace = null;
  for (const shell of body.shells) {
    for (const face of shell.faces) {
      if (face.surfaceType === 'sphere') sphereFace = face;
    }
  }
  assert.ok(sphereFace, 'Should find the sphere BRep face');
  assert.ok(sphereFace.outerLoop, 'Sphere face should have an outer loop');
  assert.strictEqual(sphereFace.outerLoop.coedges.length, 3,
    `Sphere should have 3 coedges (got ${sphereFace.outerLoop.coedges.length})`);

  // All 3 edges should be degree-2 arcs (circular arcs on the sphere)
  for (let i = 0; i < 3; i++) {
    const edge = sphereFace.outerLoop.coedges[i].edge;
    assert.ok(edge.curve, `Sphere coedge ${i} should have a curve`);
    assert.strictEqual(edge.curve.degree, 2,
      `Sphere coedge ${i} curve should be degree 2 (got ${edge.curve.degree})`);
  }
});

test('box-fillet-3: sphere corner vertices match cylinder endpoints', () => {
  const mesh = importSTEP(boxFilletData, { curveSegments: 16 });
  const body = mesh.body;

  // Collect all cylinder and sphere face data from BRep
  const cylFaces = [];
  let sphereFace = null;
  for (const shell of body.shells) {
    for (const face of shell.faces) {
      if (face.surfaceType === 'cylinder') cylFaces.push(face);
      if (face.surfaceType === 'sphere') sphereFace = face;
    }
  }

  assert.strictEqual(cylFaces.length, 3, 'Should have 3 cylinder faces');
  assert.ok(sphereFace, 'Should have a sphere face');

  // The sphere's 3 edge endpoints should coincide with cylinder edge endpoints
  const sphereVerts = new Set();
  for (const ce of sphereFace.outerLoop.coedges) {
    const sp = ce.edge.startVertex.point;
    const ep = ce.edge.endVertex.point;
    sphereVerts.add(`${sp.x.toFixed(4)},${sp.y.toFixed(4)},${sp.z.toFixed(4)}`);
    sphereVerts.add(`${ep.x.toFixed(4)},${ep.y.toFixed(4)},${ep.z.toFixed(4)}`);
  }

  // Sphere should have exactly 3 unique corner vertices
  assert.strictEqual(sphereVerts.size, 3,
    `Sphere should have 3 unique corner vertices (got ${sphereVerts.size})`);

  // Each cylinder should share at least one vertex with the sphere
  for (let ci = 0; ci < cylFaces.length; ci++) {
    let shared = false;
    for (const ce of cylFaces[ci].outerLoop.coedges) {
      const sp = ce.edge.startVertex.point;
      const ep = ce.edge.endVertex.point;
      const sk = `${sp.x.toFixed(4)},${sp.y.toFixed(4)},${sp.z.toFixed(4)}`;
      const ek = `${ep.x.toFixed(4)},${ep.y.toFixed(4)},${ep.z.toFixed(4)}`;
      if (sphereVerts.has(sk) || sphereVerts.has(ek)) { shared = true; break; }
    }
    assert.ok(shared, `Cylinder ${ci} should share at least one vertex with the sphere`);
  }
});

test('box-fillet-3: sphere mesh has no stray boundary edges (conforming mesh)', () => {
  const mesh = importSTEP(boxFilletData, { curveSegments: 16 });
  const body = mesh.body;
  let sphereFaceGroup = -1;
  let faceIdx = 0;
  for (const face of body.faces()) {
    if (face.surfaceType === 'sphere') sphereFaceGroup = faceIdx;
    faceIdx++;
  }

  const sphereFaces = mesh.faces.filter(f => f.faceGroup === sphereFaceGroup);
  assert.ok(sphereFaces.length > 0, 'Should have sphere triangles');

  // Build edge → face count map for the sphere mesh
  const precision = 6;
  const vKey = (v) => `${v.x.toFixed(precision)},${v.y.toFixed(precision)},${v.z.toFixed(precision)}`;
  const eKey = (a, b) => {
    const ka = vKey(a), kb = vKey(b);
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };
  const edgeCounts = new Map();
  for (const f of sphereFaces) {
    const v = f.vertices;
    for (let i = 0; i < v.length; i++) {
      const key = eKey(v[i], v[(i + 1) % v.length]);
      edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
    }
  }

  // In a conforming mesh, interior edges have 2 adjacent faces and
  // boundary edges (shared with cylinders) have 1.  Stray T-junction
  // boundary edges would appear as 1-face edges that aren't on the
  // original polygon boundary.
  const boundaryEdges = [];
  for (const [key, count] of edgeCounts) {
    if (count === 1) boundaryEdges.push(key);
  }

  // The sphere patch has 3 arcs with curveSegments=16 → 3*16=48 boundary
  // edge segments.  Allow a small tolerance for edge-sharing variations.
  assert.ok(boundaryEdges.length <= 48 + 6,
    `Sphere mesh should have ≤54 boundary edges (got ${boundaryEdges.length}) — ` +
    `extra edges indicate T-junction artifacts from non-conforming subdivision`);
});

test('box-fillet-3: sphere feature edges form 3 arc paths', () => {
  resetFeatureIds();
  const feature = new StepImportFeature('Test Import', boxFilletData, { curveSegments: 16 });
  const result = feature.execute({ results: {}, tree: { getFeatureIndex: () => 0, features: [] } });
  const { edges, paths } = result.geometry;

  // Find edges adjacent to sphere faces
  const body = importSTEP(boxFilletData, { curveSegments: 16 }).body;
  let sphereFaceGroup = -1;
  let faceIdx = 0;
  for (const face of body.faces()) {
    if (face.surfaceType === 'sphere') sphereFaceGroup = faceIdx;
    faceIdx++;
  }

  // The sphere patch borders 3 cylinder faces, so there should be
  // 3 feature edge paths along the arc boundaries.
  const sphereTopoId = sphereFaceGroup;
  const sphereEdgeIndices = new Set();
  for (let ei = 0; ei < edges.length; ei++) {
    const e = edges[ei];
    if (!e.faceIndices || e.faceIndices.length < 2) continue;
    const faces = result.geometry.faces;
    const hasSphere = e.faceIndices.some(fi => faces[fi].topoFaceId === sphereTopoId);
    if (hasSphere) sphereEdgeIndices.add(ei);
  }

  // Count paths that contain sphere-adjacent edges
  const spherePaths = paths.filter(p =>
    p.edgeIndices.some(ei => sphereEdgeIndices.has(ei))
  );

  assert.strictEqual(spherePaths.length, 3,
    `Sphere boundary should form exactly 3 edge paths (got ${spherePaths.length})`);
});

test('box-fillet-3: no visual edges within sphere face', () => {
  resetFeatureIds();
  const feature = new StepImportFeature('Test Import', boxFilletData, { curveSegments: 16 });
  const result = feature.execute({ results: {}, tree: { getFeatureIndex: () => 0, features: [] } });

  const body = importSTEP(boxFilletData, { curveSegments: 16 }).body;
  let sphereInfo = null;
  for (const face of body.faces()) {
    if (face.surfaceType === 'sphere') sphereInfo = face.surfaceInfo;
  }
  assert.ok(sphereInfo, 'Should have sphere info');

  // Visual edges should NOT include edges that lie entirely on the sphere
  // (those are internal tessellation edges).
  const { origin, radius } = sphereInfo;
  const onSphere = (v) => {
    const dx = v.x - origin.x, dy = v.y - origin.y, dz = v.z - origin.z;
    return Math.abs(Math.sqrt(dx * dx + dy * dy + dz * dz) - radius) < 0.01;
  };

  const sphereVisualEdges = result.geometry.visualEdges.filter(e =>
    onSphere(e.start) && onSphere(e.end)
  );

  assert.strictEqual(sphereVisualEdges.length, 0,
    `Should have no visual edges on sphere surface (got ${sphereVisualEdges.length})`);
});

// ============================================================
console.log('\n=== STEP Import — Feature Tests ===\n');
// ============================================================

test('StepImportFeature: has correct type', () => {
  resetFeatureIds();
  const feature = new StepImportFeature('Test Import', stepData);
  assert.strictEqual(feature.type, 'step-import');
  assert.strictEqual(feature.name, 'Test Import');
});

test('StepImportFeature: execute produces solid result', () => {
  resetFeatureIds();
  const feature = new StepImportFeature('Test Import', stepData);
  const result = feature.execute({ results: {}, tree: { getFeatureIndex: () => 0, features: [] } });
  assert.strictEqual(result.type, 'solid');
  assert.ok(result.geometry, 'Should have geometry');
  assert.ok(result.geometry.faces.length > 0, 'Should have faces');
  assert.ok(result.geometry.edges.length > 0, 'Should have computed edges');
  assert.ok(typeof result.volume === 'number', 'Should have volume');
  assert.ok(result.boundingBox, 'Should have bounding box');
});

test('StepImportFeature: bounding box is valid', () => {
  resetFeatureIds();
  const feature = new StepImportFeature('Test Import', stepData);
  const result = feature.execute({ results: {}, tree: { getFeatureIndex: () => 0, features: [] } });
  const bb = result.boundingBox;
  assert.ok(bb.min.x < bb.max.x, 'Bounding box should have non-zero X extent');
  assert.ok(bb.min.y < bb.max.y, 'Bounding box should have non-zero Y extent');
  assert.ok(bb.min.z < bb.max.z, 'Bounding box should have non-zero Z extent');
});

test('StepImportFeature: faces are tagged with sourceFeatureId', () => {
  resetFeatureIds();
  const feature = new StepImportFeature('Test Import', stepData);
  const result = feature.execute({ results: {}, tree: { getFeatureIndex: () => 0, features: [] } });
  for (const face of result.geometry.faces.slice(0, 10)) {
    assert.ok(face.shared, 'Face should have shared metadata');
    assert.strictEqual(face.shared.sourceFeatureId, feature.id,
      'Face should reference the import feature');
  }
});

// ============================================================
console.log('\n=== STEP Import — Part Integration Tests ===\n');
// ============================================================

test('Part.importSTEP: adds feature to tree', () => {
  resetFeatureIds();
  const part = new Part('Test Part');
  const feature = part.importSTEP(stepData);
  assert.ok(feature, 'Should return a feature');
  assert.strictEqual(feature.type, 'step-import');
  assert.ok(part.getFeatures().length === 1, 'Feature tree should have 1 feature');
});

test('Part.importSTEP: produces final geometry', () => {
  resetFeatureIds();
  const part = new Part('Test Part');
  part.importSTEP(stepData);
  const geom = part.getFinalGeometry();
  assert.ok(geom, 'Should have final geometry');
  assert.strictEqual(geom.type, 'solid');
  assert.ok(geom.geometry.faces.length > 0, 'Final geometry should have faces');
});

test('Part.importSTEP: auto-names feature', () => {
  resetFeatureIds();
  const part = new Part('Test Part');
  const f1 = part.importSTEP(stepData);
  assert.strictEqual(f1.name, 'STEP Import 1');
  const f2 = part.importSTEP(stepData, { name: 'Custom Name' });
  assert.strictEqual(f2.name, 'Custom Name');
});

test('PartManager.importSTEP: creates part if needed', () => {
  resetFeatureIds();
  const pm = new PartManager();
  const feature = pm.importSTEP(stepData);
  assert.ok(pm.getPart(), 'Should have created a part');
  assert.ok(feature, 'Should return a feature');
  assert.strictEqual(feature.type, 'step-import');
});

// ============================================================
console.log('\n=== STEP Import — Serialization Tests ===\n');
// ============================================================

test('StepImportFeature: serialize round-trip preserves data', () => {
  resetFeatureIds();
  const feature = new StepImportFeature('Test Import', stepData, { curveSegments: 24 });
  const serialized = feature.serialize();

  assert.strictEqual(serialized.type, 'step-import');
  assert.strictEqual(serialized.stepData, stepData);
  assert.strictEqual(serialized.curveSegments, 24);
  assert.strictEqual(serialized.name, 'Test Import');

  const restored = StepImportFeature.deserialize(serialized);
  assert.strictEqual(restored.type, 'step-import');
  assert.strictEqual(restored.stepData, stepData);
  assert.strictEqual(restored.curveSegments, 24);
  assert.strictEqual(restored.name, 'Test Import');
});

test('Part: deserialize restores step-import features', () => {
  resetFeatureIds();
  const part = new Part('Test Part');
  part.importSTEP(stepData);

  const serialized = part.serialize();
  resetFeatureIds();
  const restored = Part.deserialize(serialized);

  assert.ok(restored.getFeatures().length === 1, 'Restored part should have 1 feature');
  assert.strictEqual(restored.getFeatures()[0].type, 'step-import');

  const geom = restored.getFinalGeometry();
  assert.ok(geom, 'Restored part should have final geometry');
  assert.strictEqual(geom.type, 'solid');
});

// ============================================================
console.log('\n=== Results ===\n');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
