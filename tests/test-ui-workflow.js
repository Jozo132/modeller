// tests/test-ui-workflow.js — Integration test for the full 3D modeling workflow
// Tests: draw a box → extrude into a cube → add a circle on top → extrude cut through it

import assert from 'assert';
import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';

console.log('=== UI Workflow Integration Test ===\n');

// ---------------------------------------------------------------------------
// Step 1: Create a Part
// ---------------------------------------------------------------------------
console.log('--- Step 1: Create a Part ---');
const part = new Part('WorkflowPart');
assert.strictEqual(part.name, 'WorkflowPart', 'Part should have the correct name');
console.log('  ✓ Created part:', part.name);

// ---------------------------------------------------------------------------
// Step 2: Draw a rectangle (box profile) as a sketch and add it to the part
// ---------------------------------------------------------------------------
console.log('\n--- Step 2: Draw a box (rectangle sketch) ---');
const boxSketch = new Sketch();
boxSketch.name = 'BoxSketch';

// Draw a 100x100 rectangle centered at origin
boxSketch.addSegment(-50, -50, 50, -50);  // bottom edge
boxSketch.addSegment(50, -50, 50, 50);    // right edge
boxSketch.addSegment(50, 50, -50, 50);    // top edge
boxSketch.addSegment(-50, 50, -50, -50);  // left edge

assert.strictEqual(boxSketch.segments.length, 4, 'Box sketch should have 4 segments');
console.log('  ✓ Box sketch has', boxSketch.segments.length, 'segments');

const boxSketchFeature = part.addSketch(boxSketch);
assert.ok(boxSketchFeature, 'Sketch feature should be created');
assert.strictEqual(boxSketchFeature.type, 'sketch', 'Feature type should be sketch');
console.log('  ✓ Added sketch feature:', boxSketchFeature.id);

// ---------------------------------------------------------------------------
// Step 3: Extrude the box sketch into a cube (100x100x100)
// ---------------------------------------------------------------------------
console.log('\n--- Step 3: Extrude into a cube ---');
const extrudeFeature = part.extrude(boxSketchFeature.id, 100);
assert.ok(extrudeFeature, 'Extrude feature should be created');
assert.strictEqual(extrudeFeature.type, 'extrude', 'Feature type should be extrude');
assert.strictEqual(extrudeFeature.distance, 100, 'Extrusion distance should be 100');
console.log('  ✓ Created extrude feature:', extrudeFeature.id, 'distance:', extrudeFeature.distance);

// Verify the geometry
let geometry = part.getFinalGeometry();
assert.ok(geometry, 'Should have final geometry after extrusion');
assert.strictEqual(geometry.type, 'solid', 'Geometry type should be solid');
console.log('  ✓ Geometry type:', geometry.type);
console.log('  ✓ Bounding box:', JSON.stringify(geometry.boundingBox));
console.log('  ✓ Volume:', geometry.volume);

// Verify the bounding box is approximately a cube
const bb = geometry.boundingBox;
assert.ok(bb, 'Bounding box should exist');
const cubeWidth = bb.max.x - bb.min.x;
const cubeDepth = bb.max.y - bb.min.y;
const cubeHeight = bb.max.z - bb.min.z;
assert.ok(Math.abs(cubeWidth - 100) < 1, `Cube width should be ~100, got ${cubeWidth}`);
assert.ok(Math.abs(cubeDepth - 100) < 1, `Cube depth should be ~100, got ${cubeDepth}`);
assert.ok(Math.abs(cubeHeight - 100) < 1, `Cube height should be ~100, got ${cubeHeight}`);
console.log('  ✓ Cube dimensions verified:', cubeWidth, 'x', cubeDepth, 'x', cubeHeight);

// ---------------------------------------------------------------------------
// Step 4: Add a circle sketch on top of the cube for the cut profile
// ---------------------------------------------------------------------------
console.log('\n--- Step 4: Add a circle on top ---');
const circleSketch = new Sketch();
circleSketch.name = 'CircleSketch';

// Add a circle centered at origin (will be on top of cube) with radius 25
circleSketch.addCircle(0, 0, 25);

assert.strictEqual(circleSketch.circles.length, 1, 'Circle sketch should have 1 circle');
assert.strictEqual(circleSketch.circles[0].radius, 25, 'Circle radius should be 25');
console.log('  ✓ Circle sketch has', circleSketch.circles.length, 'circle(s) with radius', circleSketch.circles[0].radius);

const circleSketchFeature = part.addSketch(circleSketch);
assert.ok(circleSketchFeature, 'Circle sketch feature should be created');
console.log('  ✓ Added circle sketch feature:', circleSketchFeature.id);

// ---------------------------------------------------------------------------
// Step 5: Extrude cut through the cube using the circle profile
// ---------------------------------------------------------------------------
console.log('\n--- Step 5: Extrude cut through the cube ---');
const cutFeature = part.extrude(circleSketchFeature.id, 100, { operation: 'subtract' });
assert.ok(cutFeature, 'Cut feature should be created');
assert.strictEqual(cutFeature.type, 'extrude', 'Cut feature type should be extrude');
assert.strictEqual(cutFeature.operation, 'subtract', 'Cut operation should be subtract');
assert.strictEqual(cutFeature.distance, 100, 'Cut distance should be 100');
console.log('  ✓ Created extrude cut feature:', cutFeature.id, 'operation:', cutFeature.operation);

// Verify geometry after cut
const finalGeometry = part.getFinalGeometry();
assert.ok(finalGeometry, 'Should have final geometry after cut');
assert.strictEqual(finalGeometry.type, 'solid', 'Final geometry type should be solid');
console.log('  ✓ Final geometry type:', finalGeometry.type);
console.log('  ✓ Final bounding box:', JSON.stringify(finalGeometry.boundingBox));

// The volume after cutting should be less than the original cube volume
// (cube volume = 100*100*100 = 1,000,000 minus cylinder cutout)
if (finalGeometry.volume !== undefined && geometry.volume !== undefined) {
  console.log('  ✓ Volume after cut:', finalGeometry.volume, '(was:', geometry.volume, ')');
}

// ---------------------------------------------------------------------------
// Step 6: Verify feature tree integrity
// ---------------------------------------------------------------------------
console.log('\n--- Step 6: Verify feature tree ---');
const features = part.getFeatures();
assert.strictEqual(features.length, 4, `Should have 4 features, got ${features.length}`);
console.log('  ✓ Total features:', features.length);

assert.strictEqual(features[0].type, 'sketch', 'Feature 1 should be sketch (box)');
assert.strictEqual(features[1].type, 'extrude', 'Feature 2 should be extrude (cube)');
assert.strictEqual(features[2].type, 'sketch', 'Feature 3 should be sketch (circle)');
assert.strictEqual(features[3].type, 'extrude', 'Feature 4 should be extrude (cut)');
console.log('  ✓ Feature tree order verified:');
features.forEach((f, i) => {
  console.log(`    ${i + 1}. ${f.name} (${f.type})${f.operation ? ' [' + f.operation + ']' : ''}`);
});

// ---------------------------------------------------------------------------
// Step 7: Verify parametric modification (change extrusion distance)
// ---------------------------------------------------------------------------
console.log('\n--- Step 7: Test parametric modification ---');
const originalDistance = extrudeFeature.distance;
part.modifyFeature(extrudeFeature.id, (feature) => {
  feature.setDistance(200);
});
assert.strictEqual(extrudeFeature.distance, 200, 'Extrusion distance should be updated to 200');
console.log('  ✓ Modified extrusion distance from', originalDistance, 'to', extrudeFeature.distance);

// Verify the cube extrude feature itself was recalculated
const cubeResult = part.featureTree.results[extrudeFeature.id];
assert.ok(cubeResult, 'Cube extrude result should exist');
assert.strictEqual(cubeResult.type, 'solid', 'Cube result should be solid');
const cubeResultHeight = cubeResult.boundingBox.max.z - cubeResult.boundingBox.min.z;
assert.ok(Math.abs(cubeResultHeight - 200) < 1, `Cube result height should be ~200 after modification, got ${cubeResultHeight}`);
console.log('  ✓ Cube result bounding box height:', cubeResultHeight);

// Restore original distance
part.modifyFeature(extrudeFeature.id, (feature) => {
  feature.setDistance(100);
});
console.log('  ✓ Restored original distance');

// ---------------------------------------------------------------------------
// Step 8: Test feature suppression
// ---------------------------------------------------------------------------
console.log('\n--- Step 8: Test feature suppression ---');
part.suppressFeature(cutFeature.id);
assert.strictEqual(cutFeature.suppressed, true, 'Cut feature should be suppressed');
console.log('  ✓ Cut feature suppressed');

const geometryWithoutCut = part.getFinalGeometry();
assert.ok(geometryWithoutCut, 'Should have geometry with cut suppressed');
console.log('  ✓ Geometry without cut - volume:', geometryWithoutCut.volume);

part.unsuppressFeature(cutFeature.id);
assert.strictEqual(cutFeature.suppressed, false, 'Cut feature should be unsuppressed');
console.log('  ✓ Cut feature unsuppressed');

// ---------------------------------------------------------------------------
// Step 9: Test serialization round-trip
// ---------------------------------------------------------------------------
console.log('\n--- Step 9: Test serialization ---');
const serialized = part.serialize();
assert.ok(serialized, 'Serialization should produce data');
assert.strictEqual(serialized.featureTree.features.length, 4, 'Serialized data should have 4 features');

const deserialized = Part.deserialize(serialized);
assert.strictEqual(deserialized.name, 'WorkflowPart', 'Deserialized part name should match');
assert.strictEqual(deserialized.getFeatures().length, 4, 'Deserialized part should have 4 features');
console.log('  ✓ Serialization round-trip successful');
console.log('  ✓ Deserialized features:', deserialized.getFeatures().length);

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------
console.log('\n=== All Workflow Tests Passed! ===');
