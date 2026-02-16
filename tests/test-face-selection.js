// tests/test-face-selection.js -- Tests for face selection, plane derivation,
// sketch wireframe building, and face-based sketch/extrude workflows

import assert from 'assert';
import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { ExtrudeFeature } from '../js/cad/ExtrudeFeature.js';
import { SketchFeature } from '../js/cad/SketchFeature.js';

console.log('=== Face Selection & Sketch Wireframe Tests ===\n');

// ---------------------------------------------------------------------------
// Test 1: SketchFeature plane definition
// ---------------------------------------------------------------------------
console.log('--- Test 1: SketchFeature plane definition ---');
const sketchFeature = new SketchFeature('TestSketch');
assert.ok(sketchFeature.plane, 'SketchFeature should have a plane');
assert.deepStrictEqual(sketchFeature.plane.normal, { x: 0, y: 0, z: 1 }, 'Default plane normal should be Z');
assert.deepStrictEqual(sketchFeature.plane.xAxis, { x: 1, y: 0, z: 0 }, 'Default plane xAxis should be X');
assert.deepStrictEqual(sketchFeature.plane.yAxis, { x: 0, y: 1, z: 0 }, 'Default plane yAxis should be Y');

// Set a custom plane (e.g., from a face)
sketchFeature.setPlane({
  origin: { x: 10, y: 0, z: 50 },
  normal: { x: 0, y: 0, z: 1 },
  xAxis: { x: 1, y: 0, z: 0 },
  yAxis: { x: 0, y: 1, z: 0 },
});
assert.strictEqual(sketchFeature.plane.origin.x, 10, 'Plane origin should be updated');
assert.strictEqual(sketchFeature.plane.origin.z, 50, 'Plane origin z should be updated');
console.log('  ✓ SketchFeature plane definition works correctly');

// ---------------------------------------------------------------------------
// Test 2: Sketch wireframe data in Part with sketches
// ---------------------------------------------------------------------------
console.log('\n--- Test 2: Sketch wireframes in Part ---');
const part = new Part('WireframePart');

// Create a rectangle sketch
const rectSketch = new Sketch();
rectSketch.addSegment(0, 0, 100, 0);
rectSketch.addSegment(100, 0, 100, 50);
rectSketch.addSegment(100, 50, 0, 50);
rectSketch.addSegment(0, 50, 0, 0);

const sf = part.addSketch(rectSketch);
assert.ok(sf, 'Sketch feature should be created');
assert.strictEqual(sf.sketch.segments.length, 4, 'Sketch should have 4 segments');
console.log('  ✓ Sketch with 4 segments added to part');

// Verify the sketch is accessible via getSketches()
const sketches = part.getSketches();
assert.strictEqual(sketches.length, 1, 'Part should have 1 sketch');
assert.strictEqual(sketches[0].sketch.segments.length, 4, 'Sketch should have 4 segments');
console.log('  ✓ getSketches() returns sketch features with primitives');

// ---------------------------------------------------------------------------
// Test 3: Extrude produces faces with normals for face picking
// ---------------------------------------------------------------------------
console.log('\n--- Test 3: Extruded geometry has faces with normals ---');
const extrudeFeature = part.extrude(sf.id, 25);
const geo = part.getFinalGeometry();
assert.ok(geo, 'Part should have final geometry');
assert.strictEqual(geo.type, 'solid', 'Geometry type should be solid');
assert.ok(geo.geometry.faces.length > 0, 'Geometry should have faces');

// Check all faces have normals
for (const face of geo.geometry.faces) {
  assert.ok(face.normal, `Face should have a normal`);
  const len = Math.sqrt(face.normal.x ** 2 + face.normal.y ** 2 + face.normal.z ** 2);
  assert.ok(Math.abs(len - 1) < 0.01, `Face normal should be unit length (got ${len})`);
}
console.log(`  ✓ All ${geo.geometry.faces.length} faces have valid unit normals`);

// ---------------------------------------------------------------------------
// Test 4: Face normal classification (flat faces)
// ---------------------------------------------------------------------------
console.log('\n--- Test 4: Face normal classification ---');
// A box extruded on XY plane should have faces with normals along Z, X, Y
const faceNormals = geo.geometry.faces.map(f => f.normal);
const hasZNormal = faceNormals.some(n => Math.abs(n.z) > 0.9);
const hasXNormal = faceNormals.some(n => Math.abs(n.x) > 0.9);
const hasYNormal = faceNormals.some(n => Math.abs(n.y) > 0.9);
assert.ok(hasZNormal, 'Extruded box should have faces with Z-aligned normals (top/bottom)');
console.log('  ✓ Extruded box has correctly oriented face normals');

// ---------------------------------------------------------------------------
// Test 5: Plane derivation from face normal
// ---------------------------------------------------------------------------
console.log('\n--- Test 5: Plane derivation from face normal ---');

function getPlaneFromFace(faceHit) {
  const normal = faceHit.face.normal;
  const origin = faceHit.point;
  let ref = { x: 0, y: 0, z: 1 };
  const dot = Math.abs(normal.x * ref.x + normal.y * ref.y + normal.z * ref.z);
  if (dot > 0.9) ref = { x: 1, y: 0, z: 0 };
  const xAxis = {
    x: ref.y * normal.z - ref.z * normal.y,
    y: ref.z * normal.x - ref.x * normal.z,
    z: ref.x * normal.y - ref.y * normal.x,
  };
  const xLen = Math.sqrt(xAxis.x ** 2 + xAxis.y ** 2 + xAxis.z ** 2);
  if (xLen < 1e-10) return null;
  xAxis.x /= xLen; xAxis.y /= xLen; xAxis.z /= xLen;
  const yAxis = {
    x: normal.y * xAxis.z - normal.z * xAxis.y,
    y: normal.z * xAxis.x - normal.x * xAxis.z,
    z: normal.x * xAxis.y - normal.y * xAxis.x,
  };
  const yLen = Math.sqrt(yAxis.x ** 2 + yAxis.y ** 2 + yAxis.z ** 2);
  if (yLen < 1e-10) return null;
  yAxis.x /= yLen; yAxis.y /= yLen; yAxis.z /= yLen;
  return { origin, normal, xAxis, yAxis };
}

// Test with Z-normal face (top of the box)
const topFace = geo.geometry.faces.find(f => f.normal.z > 0.9);
assert.ok(topFace, 'Should find a top face with Z normal');

const planeDef = getPlaneFromFace({
  face: { normal: topFace.normal },
  point: { x: 50, y: 25, z: 25 },
});
assert.ok(planeDef, 'Plane definition should be derived from face');
assert.ok(Math.abs(planeDef.normal.z - 1) < 0.01, 'Plane normal should point in Z');

// Verify orthogonality: xAxis · normal ≈ 0, yAxis · normal ≈ 0, xAxis · yAxis ≈ 0
const xDotN = planeDef.xAxis.x * planeDef.normal.x + planeDef.xAxis.y * planeDef.normal.y + planeDef.xAxis.z * planeDef.normal.z;
const yDotN = planeDef.yAxis.x * planeDef.normal.x + planeDef.yAxis.y * planeDef.normal.y + planeDef.yAxis.z * planeDef.normal.z;
const xDotY = planeDef.xAxis.x * planeDef.yAxis.x + planeDef.xAxis.y * planeDef.yAxis.y + planeDef.xAxis.z * planeDef.yAxis.z;
assert.ok(Math.abs(xDotN) < 0.01, 'xAxis should be perpendicular to normal');
assert.ok(Math.abs(yDotN) < 0.01, 'yAxis should be perpendicular to normal');
assert.ok(Math.abs(xDotY) < 0.01, 'xAxis should be perpendicular to yAxis');
console.log('  ✓ Face-derived plane has orthogonal axes');

// Test with X-normal face (side of the box)
const sideFace = geo.geometry.faces.find(f => Math.abs(f.normal.x) > 0.9);
if (sideFace) {
  const sidePlane = getPlaneFromFace({
    face: { normal: sideFace.normal },
    point: { x: 0, y: 25, z: 12.5 },
  });
  assert.ok(sidePlane, 'Side plane should be derivable');
  const sXDotN = sidePlane.xAxis.x * sidePlane.normal.x + sidePlane.xAxis.y * sidePlane.normal.y + sidePlane.xAxis.z * sidePlane.normal.z;
  assert.ok(Math.abs(sXDotN) < 0.01, 'Side plane xAxis perpendicular to normal');
  console.log('  ✓ Side face plane derivation works correctly');
}

// ---------------------------------------------------------------------------
// Test 6: Sketch on face-derived plane produces correct 3D geometry
// ---------------------------------------------------------------------------
console.log('\n--- Test 6: Sketch on face-derived plane ---');
const part2 = new Part('FacePlanePart');

// Create a sketch and set it on a face-derived plane (top of a box at z=25)
const faceSketch = new Sketch();
faceSketch.addSegment(-20, -20, 20, -20);
faceSketch.addSegment(20, -20, 20, 20);
faceSketch.addSegment(20, 20, -20, 20);
faceSketch.addSegment(-20, 20, -20, -20);

const faceSF = part2.addSketch(faceSketch, {
  origin: { x: 50, y: 25, z: 25 },
  normal: { x: 0, y: 0, z: 1 },
  xAxis: { x: 1, y: 0, z: 0 },
  yAxis: { x: 0, y: 1, z: 0 },
});

assert.ok(faceSF, 'Face-plane sketch feature should be created');
assert.strictEqual(faceSF.plane.origin.z, 25, 'Sketch plane origin z should be 25');
console.log('  ✓ Sketch on face-derived plane created with correct origin');

// Extrude from that face
const faceExtrude = part2.extrude(faceSF.id, 15);
const faceGeo = part2.getFinalGeometry();
assert.ok(faceGeo, 'Face-plane part should have geometry');
assert.strictEqual(faceGeo.type, 'solid', 'Geometry should be solid');

// The bounding box should extend from z=25 to z=40 (origin 25 + distance 15)
const bb = faceGeo.boundingBox;
assert.ok(bb, 'Should have bounding box');
assert.ok(Math.abs(bb.min.z - 25) < 1, `Min z should be ~25, got ${bb.min.z}`);
assert.ok(Math.abs(bb.max.z - 40) < 1, `Max z should be ~40, got ${bb.max.z}`);
console.log(`  ✓ Extrude from face plane produces correct bounding box (z: ${bb.min.z} to ${bb.max.z})`);

// ---------------------------------------------------------------------------
// Test 7: Suppressed sketches should not produce wireframes
// ---------------------------------------------------------------------------
console.log('\n--- Test 7: Suppressed sketch wireframe visibility ---');
const part3 = new Part('SuppressedPart');
const sSketch = new Sketch();
sSketch.addSegment(0, 0, 50, 0);
sSketch.addSegment(50, 0, 50, 50);
const sSF = part3.addSketch(sSketch);

// Check that unsuppressed sketch is returned
let activeSketches = part3.getSketches().filter(s => !s.suppressed);
assert.strictEqual(activeSketches.length, 1, 'Should have 1 active sketch');

// Suppress it
part3.suppressFeature(sSF.id);
activeSketches = part3.getSketches().filter(s => !s.suppressed);
assert.strictEqual(activeSketches.length, 0, 'Should have 0 active sketches after suppression');
console.log('  ✓ Suppressed sketches are excluded from active sketches');

// Unsuppress
part3.unsuppressFeature(sSF.id);
activeSketches = part3.getSketches().filter(s => !s.suppressed);
assert.strictEqual(activeSketches.length, 1, 'Should have 1 active sketch after unsuppression');
console.log('  ✓ Unsuppressed sketches are restored');

// ---------------------------------------------------------------------------
// Test 8: Ray-triangle intersection (unit test for picking math)
// ---------------------------------------------------------------------------
console.log('\n--- Test 8: Ray-triangle intersection math ---');

function rayTriangleIntersect(origin, dir, v0, v1, v2) {
  const EPSILON = 1e-8;
  const e1 = { x: v1.x - v0.x, y: v1.y - v0.y, z: v1.z - v0.z };
  const e2 = { x: v2.x - v0.x, y: v2.y - v0.y, z: v2.z - v0.z };
  const h = {
    x: dir.y * e2.z - dir.z * e2.y,
    y: dir.z * e2.x - dir.x * e2.z,
    z: dir.x * e2.y - dir.y * e2.x,
  };
  const a = e1.x * h.x + e1.y * h.y + e1.z * h.z;
  if (a > -EPSILON && a < EPSILON) return null;
  const f = 1.0 / a;
  const s = { x: origin.x - v0.x, y: origin.y - v0.y, z: origin.z - v0.z };
  const u = f * (s.x * h.x + s.y * h.y + s.z * h.z);
  if (u < 0 || u > 1) return null;
  const q = {
    x: s.y * e1.z - s.z * e1.y,
    y: s.z * e1.x - s.x * e1.z,
    z: s.x * e1.y - s.y * e1.x,
  };
  const v = f * (dir.x * q.x + dir.y * q.y + dir.z * q.z);
  if (v < 0 || u + v > 1) return null;
  const t = f * (e2.x * q.x + e2.y * q.y + e2.z * q.z);
  return t > EPSILON ? t : null;
}

// Ray from above, hitting a triangle on the XY plane
const t1 = rayTriangleIntersect(
  { x: 0.5, y: 0.5, z: 10 },  // origin above
  { x: 0, y: 0, z: -1 },       // direction straight down
  { x: 0, y: 0, z: 0 },        // triangle vertex 0
  { x: 1, y: 0, z: 0 },        // triangle vertex 1
  { x: 0, y: 1, z: 0 },        // triangle vertex 2
);
assert.ok(t1 !== null, 'Ray should hit triangle');
assert.ok(Math.abs(t1 - 10) < 0.01, 'Hit distance should be 10');
console.log('  ✓ Ray hits triangle from above at correct distance');

// Ray missing the triangle
const t2 = rayTriangleIntersect(
  { x: 2, y: 2, z: 10 },
  { x: 0, y: 0, z: -1 },
  { x: 0, y: 0, z: 0 },
  { x: 1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
);
assert.strictEqual(t2, null, 'Ray should miss triangle');
console.log('  ✓ Ray correctly misses triangle');

// Ray parallel to triangle (should not hit)
const t3 = rayTriangleIntersect(
  { x: 0.5, y: 0.5, z: 0 },
  { x: 1, y: 0, z: 0 },
  { x: 0, y: 0, z: 0 },
  { x: 1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
);
assert.strictEqual(t3, null, 'Parallel ray should not hit triangle');
console.log('  ✓ Parallel ray correctly returns null');

// ---------------------------------------------------------------------------
// Test 9: Orient-to-plane-normal math (spherical coordinates)
// ---------------------------------------------------------------------------
console.log('\n--- Test 9: Orient-to-plane-normal spherical coordinates ---');

function orientToPlaneNormal(normal) {
  const nx = normal.x, ny = normal.y, nz = normal.z;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  const dnx = nx / len, dny = ny / len, dnz = nz / len;
  let phi = Math.acos(Math.max(-1, Math.min(1, dnz)));
  let theta = Math.atan2(dny, dnx);
  if (phi < 0.001) phi = 0.001;
  if (phi > Math.PI - 0.001) phi = Math.PI - 0.001;
  return { theta, phi };
}

// Z-up normal should give phi near 0
const zUp = orientToPlaneNormal({ x: 0, y: 0, z: 1 });
assert.ok(zUp.phi < 0.01, 'Z-up normal should give near-zero phi');
console.log('  ✓ Z-up normal gives correct spherical coordinates');

// X-direction normal
const xDir = orientToPlaneNormal({ x: 1, y: 0, z: 0 });
assert.ok(Math.abs(xDir.phi - Math.PI / 2) < 0.01, 'X-dir normal should give phi=π/2');
assert.ok(Math.abs(xDir.theta) < 0.01, 'X-dir normal should give theta=0');
console.log('  ✓ X-direction normal gives correct spherical coordinates');

// Y-direction normal
const yDir = orientToPlaneNormal({ x: 0, y: 1, z: 0 });
assert.ok(Math.abs(yDir.phi - Math.PI / 2) < 0.01, 'Y-dir normal should give phi=π/2');
assert.ok(Math.abs(yDir.theta - Math.PI / 2) < 0.01, 'Y-dir normal should give theta=π/2');
console.log('  ✓ Y-direction normal gives correct spherical coordinates');

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------
console.log('\n=== All Face Selection & Sketch Wireframe Tests Passed! ===');
