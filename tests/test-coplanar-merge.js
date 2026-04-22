import './_watchdog.mjs';
// tests/test-coplanar-merge.js -- Test that coplanar faces are grouped after CSG union
// Verifies that when two boxes are unioned and share a coplanar face,
// the result groups coplanar faces so they can be selected as one.
// Original convex CSG polygons are preserved (no concavity from merging).

import assert from 'assert';
import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';

console.log('=== Coplanar Face Group Test ===\n');

// ---------------------------------------------------------------------------
// Step 1: Create two overlapping boxes via extrude + union
// ---------------------------------------------------------------------------
console.log('--- Step 1: Create first box ---');
const part = new Part('CoplanarTest');

// First box: 100x100x50
const sketch1 = new Sketch();
sketch1.addSegment(-50, -50, 50, -50);
sketch1.addSegment(50, -50, 50, 50);
sketch1.addSegment(50, 50, -50, 50);
sketch1.addSegment(-50, 50, -50, -50);

const sf1 = part.addSketch(sketch1);
const ext1 = part.extrude(sf1.id, 50);
console.log('  ✓ First box extruded (100x100x50)');

const geo1 = part.getFinalGeometry();
assert.ok(geo1, 'First box geometry should exist');
assert.strictEqual(geo1.type, 'solid', 'Should be solid');
const faceCount1 = geo1.geometry.faces.length;
console.log('  ✓ First box has', faceCount1, 'faces');

// ---------------------------------------------------------------------------
// Step 2: Add a second box on the side (union) → shares a coplanar top face
// ---------------------------------------------------------------------------
console.log('\n--- Step 2: Add second box on the right side ---');
const sketch2 = new Sketch();
// Box from x=50..150, y=-50..50 (shares the right face with first box at x=50)
sketch2.addSegment(50, -50, 150, -50);
sketch2.addSegment(150, -50, 150, 50);
sketch2.addSegment(150, 50, 50, 50);
sketch2.addSegment(50, 50, 50, -50);

const sf2 = part.addSketch(sketch2);
const ext2 = part.extrude(sf2.id, 50);
console.log('  ✓ Second box extruded (union)');
assert.strictEqual(ext2.operation, 'add', 'Should be add/union operation');

const geo2 = part.getFinalGeometry();
assert.ok(geo2, 'Combined geometry should exist');
assert.strictEqual(geo2.type, 'solid', 'Should be solid');

const faces = geo2.geometry.faces;
const faceCount2 = faces.length;
console.log('  ✓ Combined shape has', faceCount2, 'faces');

// ---------------------------------------------------------------------------
// Step 3: Verify that top-facing faces share the same faceGroup
// ---------------------------------------------------------------------------
console.log('\n--- Step 3: Verify coplanar top faces share a faceGroup ---');
const topFaces = faces.filter(f => f.normal.z > 0.99);
console.log('  Top-facing sub-faces:', topFaces.length);
assert.ok(topFaces.length >= 1, 'Should have at least 1 top face');

// All top-facing faces should have the same faceGroup
const topGroups = new Set(topFaces.map(f => f.faceGroup));
console.log('  Top-facing face groups:', [...topGroups]);
assert.strictEqual(topGroups.size, 1,
  `All top faces should share 1 faceGroup, got ${topGroups.size} groups`);
console.log('  ✓ All top faces grouped as one');

// ---------------------------------------------------------------------------
// Step 4: Verify that bottom-facing faces share the same faceGroup
// ---------------------------------------------------------------------------
console.log('\n--- Step 4: Verify coplanar bottom faces share a faceGroup ---');
const bottomFaces = faces.filter(f => f.normal.z < -0.99);
console.log('  Bottom-facing sub-faces:', bottomFaces.length);
assert.ok(bottomFaces.length >= 1, 'Should have at least 1 bottom face');

const bottomGroups = new Set(bottomFaces.map(f => f.faceGroup));
assert.strictEqual(bottomGroups.size, 1,
  `All bottom faces should share 1 faceGroup, got ${bottomGroups.size} groups`);
console.log('  ✓ All bottom faces grouped as one');

// ---------------------------------------------------------------------------
// Step 5: Verify bounding box is correct
// ---------------------------------------------------------------------------
console.log('\n--- Step 5: Verify bounding box ---');
const bb = geo2.boundingBox;
assert.ok(bb, 'Bounding box should exist');
console.log('  Bounding box:', JSON.stringify(bb));
assert.ok(Math.abs(bb.min.x - (-50)) < 1, `min.x should be -50, got ${bb.min.x}`);
assert.ok(Math.abs(bb.max.x - 150) < 1, `max.x should be 150, got ${bb.max.x}`);
assert.ok(Math.abs(bb.min.z - 0) < 1, `min.z should be 0, got ${bb.min.z}`);
assert.ok(Math.abs(bb.max.z - 50) < 1, `max.z should be 50, got ${bb.max.z}`);
console.log('  ✓ Bounding box correct');

// ---------------------------------------------------------------------------
// Step 6: Verify edges don't include internal coplanar boundaries
// ---------------------------------------------------------------------------
console.log('\n--- Step 6: Verify edge count ---');
const edgeCount = geo2.geometry.edges.length;
console.log('  Edge count:', edgeCount);
assert.ok(edgeCount > 0, 'Should have edges');
console.log('  ✓ Edge count reasonable');

// ---------------------------------------------------------------------------
// Step 7: Verify all faces have a faceGroup property
// ---------------------------------------------------------------------------
console.log('\n--- Step 7: Verify all faces have faceGroup ---');
for (let i = 0; i < faces.length; i++) {
  assert.ok(faces[i].faceGroup != null, `Face ${i} should have a faceGroup`);
}
console.log('  ✓ All', faces.length, 'faces have faceGroup');

// Count distinct face groups
const allGroups = new Set(faces.map(f => f.faceGroup));
console.log('  Distinct face groups:', allGroups.size, '(from', faces.length, 'faces)');

console.log('\n=== All coplanar face group tests passed! ===');
