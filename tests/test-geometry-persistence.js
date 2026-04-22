import './_watchdog.mjs';
// tests/test-geometry-persistence.js -- Test that solid geometry persists when adding new sketches
// Verifies fix for: "When the sketch was added, the part that was made up to that point completely
// disappears and only the sketch is left visible" and "Extruding that new sketch will leave only
// the new feature, not showing the previous features in the part"

import assert from 'assert';
import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { calculateMeshVolume } from '../js/cad/CSG.js';

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

// ---------------------------------------------------------------------------
// Step 6: Left-handed face planes from older files should still extrude correctly
// ---------------------------------------------------------------------------
console.log('\n--- Step 6: Extrude from a legacy left-handed face plane ---');
const legacyPart = new Part('LegacyFacePlane');
const baseSketch = new Sketch();
baseSketch.addSegment(0, 0, 10, 0);
baseSketch.addSegment(10, 0, 10, 10);
baseSketch.addSegment(10, 10, 0, 10);
baseSketch.addSegment(0, 10, 0, 0);

const legacyBase = legacyPart.addSketch(baseSketch);
legacyPart.extrude(legacyBase.id, 10);

const legacyFacePlane = {
  origin: { x: 5.814691488167698, y: 10, z: 7.066122114020926 },
  normal: { x: 0, y: 1, z: 0 },
  xAxis: { x: 1, y: 0, z: 0 },
  yAxis: { x: 0, y: 0, z: 1 },
};

const legacySketch = new Sketch();
legacySketch.addSegment(2.956468792214851, 1.8593414879815384, -0.3695585366887606, 1.8593414879815384);
legacySketch.addSegment(-0.3695585366887606, 1.8593414879815384, -0.3695585366887606, -0.8430555429871127);
legacySketch.addSegment(-0.3695585366887606, -0.8430555429871127, 2.956468792214851, -0.8430555429871127);
legacySketch.addSegment(2.956468792214851, -0.8430555429871127, 2.956468792214851, 1.8593414879815384);

const legacyFeature = legacyPart.addSketch(legacySketch, legacyFacePlane);
const legacyExtrude = legacyPart.extrude(legacyFeature.id, 2);
assert.strictEqual(legacyExtrude.operation, 'add', 'Legacy face-plane extrude should still union with the existing solid');

const legacyResult = legacyPart.getFinalGeometry();
assert.ok(legacyResult && legacyResult.type === 'solid', 'Legacy face-plane extrude should produce a solid');
assert.ok(calculateMeshVolume(legacyResult.geometry) > 1000, 'Legacy face-plane extrude should preserve the original body volume');
assert.ok(legacyResult.boundingBox.min.x <= 0.001, `Legacy result min.x should keep the base body, got ${legacyResult.boundingBox.min.x}`);
assert.ok(legacyResult.boundingBox.max.x >= 9.999, `Legacy result max.x should keep the base body, got ${legacyResult.boundingBox.max.x}`);
assert.ok(legacyResult.boundingBox.max.y >= 11.999, `Legacy result max.y should include the added boss, got ${legacyResult.boundingBox.max.y}`);
console.log('  ✓ Legacy left-handed face planes still extrude as additive solids');

// ---------------------------------------------------------------------------
// Step 7: Multiple disjoint profiles on a legacy face plane should all add
// ---------------------------------------------------------------------------
console.log('\n--- Step 7: Multi-profile extrude on a legacy left-handed face plane ---');
const dualPart = new Part('LegacyFacePlaneDual');
const dualBaseSketch = new Sketch();
dualBaseSketch.addSegment(0, 0, 10, 0);
dualBaseSketch.addSegment(10, 0, 10, 10);
dualBaseSketch.addSegment(10, 10, 0, 10);
dualBaseSketch.addSegment(0, 10, 0, 0);

const dualBase = dualPart.addSketch(dualBaseSketch);
dualPart.extrude(dualBase.id, 10);

const dualSketch = new Sketch();
dualSketch.addSegment(2.956468792214851, 1.8593414879815384, -0.3695585366887606, 1.8593414879815384);
dualSketch.addSegment(-0.3695585366887606, 1.8593414879815384, -0.3695585366887606, -0.8430555429871127);
dualSketch.addSegment(-0.3695585366887606, -0.8430555429871127, 2.956468792214851, -0.8430555429871127);
dualSketch.addSegment(2.956468792214851, -0.8430555429871127, 2.956468792214851, 1.8593414879815384);
dualSketch.addSegment(-2.006822698185274, 0.8131779857457326, -4.734580551615946, 0.8131779857457326);
dualSketch.addSegment(-4.734580551615946, 0.8131779857457326, -4.734580551615946, -1.6317013972137966);
dualSketch.addSegment(-4.734580551615946, -1.6317013972137966, -2.006822698185274, -1.6317013972137966);
dualSketch.addSegment(-2.006822698185274, -1.6317013972137966, -2.006822698185274, 0.8131779857457326);

const dualFeature = dualPart.addSketch(dualSketch, legacyFacePlane);
const dualExtrude = dualPart.extrude(dualFeature.id, 2);
assert.strictEqual(dualExtrude.operation, 'add', 'Dual legacy face-plane extrude should use add operation');

const dualResult = dualPart.getFinalGeometry();
assert.ok(dualResult && dualResult.type === 'solid', 'Dual legacy face-plane extrude should produce a solid');
const dualVolume = calculateMeshVolume(dualResult.geometry);
assert.ok(Math.abs(dualVolume - 1031.3145706322168) < 0.01, `Dual legacy face-plane extrude volume mismatch: ${dualVolume}`);
assert.ok(dualResult.boundingBox.min.x <= 0.001, `Dual result min.x should keep the base body, got ${dualResult.boundingBox.min.x}`);
assert.ok(dualResult.boundingBox.max.x >= 9.999, `Dual result max.x should keep the base body, got ${dualResult.boundingBox.max.x}`);
assert.ok(dualResult.boundingBox.max.y >= 11.999, `Dual result max.y should include both added bosses, got ${dualResult.boundingBox.max.y}`);
console.log('  ✓ Multi-profile legacy face planes add all bosses without cutting holes');

console.log('\n=== All geometry persistence tests passed! ===');
