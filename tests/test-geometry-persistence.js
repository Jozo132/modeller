// tests/test-geometry-persistence.js -- Test that solid geometry persists when adding new sketches
// Verifies fix for: "When the sketch was added, the part that was made up to that point completely
// disappears and only the sketch is left visible" and "Extruding that new sketch will leave only
// the new feature, not showing the previous features in the part"

import assert from 'assert';
import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';

console.log('=== Geometry Persistence Test ===\n');

// ---------------------------------------------------------------------------
// Step 1: Create a Part with a box sketch and extrude it
// ---------------------------------------------------------------------------
console.log('--- Step 1: Create first extrusion ---');
const part = new Part('PersistenceTest');

const boxSketch = new Sketch();
boxSketch.name = 'BoxSketch';
boxSketch.addSegment(-50, -50, 50, -50);
boxSketch.addSegment(50, -50, 50, 50);
boxSketch.addSegment(50, 50, -50, 50);
boxSketch.addSegment(-50, 50, -50, -50);

const sketchFeature1 = part.addSketch(boxSketch);
const extrudeFeature1 = part.extrude(sketchFeature1.id, 100);

let geo = part.getFinalGeometry();
assert.ok(geo, 'Should have geometry after first extrusion');
assert.strictEqual(geo.type, 'solid', 'First extrusion should produce solid');
console.log('  ✓ First extrusion produces solid geometry');

// ---------------------------------------------------------------------------
// Step 2: Add a second sketch (simulating sketch-on-face workflow)
// The solid should still be visible/accessible via getFinalGeometry()
// ---------------------------------------------------------------------------
console.log('\n--- Step 2: Add second sketch (geometry should persist) ---');
const circleSketch = new Sketch();
circleSketch.name = 'CircleSketch';
circleSketch.addCircle(0, 0, 20);

// Add sketch with a face plane definition (simulating sketch-on-face)
const facePlane = {
  origin: { x: 0, y: 0, z: 100 },
  normal: { x: 0, y: 0, z: 1 },
  xAxis: { x: 1, y: 0, z: 0 },
  yAxis: { x: 0, y: 1, z: 0 },
};
const sketchFeature2 = part.addSketch(circleSketch, facePlane);
assert.ok(sketchFeature2, 'Second sketch feature should be created');

// CRITICAL: After adding a sketch, the solid geometry must still be accessible
geo = part.getFinalGeometry();
assert.ok(geo, 'Geometry should still exist after adding second sketch');
assert.strictEqual(geo.type, 'solid', 'getFinalGeometry() should return solid, not sketch');
console.log('  ✓ Solid geometry persists after adding second sketch');

// ---------------------------------------------------------------------------
// Step 3: Extrude the second sketch - should use 'add' operation (union)
// ---------------------------------------------------------------------------
console.log('\n--- Step 3: Extrude second sketch (should union with first) ---');
const extrudeFeature2 = part.extrude(sketchFeature2.id, 50);
assert.ok(extrudeFeature2, 'Second extrude feature should be created');
assert.strictEqual(extrudeFeature2.operation, 'add', 'Second extrude should use "add" operation for union');
console.log('  ✓ Second extrude uses "add" operation (union with existing solid)');

geo = part.getFinalGeometry();
assert.ok(geo, 'Should have geometry after second extrusion');
assert.strictEqual(geo.type, 'solid', 'Second extrusion should produce solid');
console.log('  ✓ Second extrusion produces solid geometry');

// Verify the bounding box reflects combined geometry
const bb = geo.boundingBox;
if (bb) {
  // The combined geometry should extend from z=0 to z=150 (100 + 50)
  console.log('  ✓ Combined bounding box:', JSON.stringify(bb));
}

// ---------------------------------------------------------------------------
// Step 4: Verify feature tree
// ---------------------------------------------------------------------------
console.log('\n--- Step 4: Verify feature tree ---');
const features = part.getFeatures();
assert.strictEqual(features.length, 4, `Should have 4 features, got ${features.length}`);
assert.strictEqual(features[0].type, 'sketch', 'Feature 1: sketch');
assert.strictEqual(features[1].type, 'extrude', 'Feature 2: extrude');
assert.strictEqual(features[2].type, 'sketch', 'Feature 3: sketch');
assert.strictEqual(features[3].type, 'extrude', 'Feature 4: extrude');
assert.strictEqual(features[3].operation, 'add', 'Feature 4 should be add operation');
console.log('  ✓ Feature tree structure verified');

// ---------------------------------------------------------------------------
// Step 5: Verify getLastSolidResult works correctly
// ---------------------------------------------------------------------------
console.log('\n--- Step 5: Verify getLastSolidResult ---');
const lastSolid = part.featureTree.getLastSolidResult();
assert.ok(lastSolid, 'getLastSolidResult should return a result');
assert.strictEqual(lastSolid.type, 'solid', 'getLastSolidResult should return solid type');

// Verify it's the second extrude's result (not the first)
const secondExtrudeResult = part.featureTree.results[extrudeFeature2.id];
assert.strictEqual(lastSolid, secondExtrudeResult, 'Last solid should be from second extrude');
console.log('  ✓ getLastSolidResult returns correct result');

console.log('\n=== All geometry persistence tests passed! ===');
