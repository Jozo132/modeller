// tests/test-multi-sketch-planes.js — Tests for multi-sketch, plane visibility,
// sketch-feature linking, and active sketch management

import assert from 'assert';
import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { SketchFeature } from '../js/cad/SketchFeature.js';
import { Feature, resetFeatureIds } from '../js/cad/Feature.js';

console.log('=== Multi-Sketch & Plane Management Tests ===\n');

// Reset feature IDs for predictable test output
resetFeatureIds();

// ---------------------------------------------------------------------------
// Test 1: Feature visible property
// ---------------------------------------------------------------------------
console.log('--- Test 1: Feature visible property ---');
const feature = new Feature('TestFeature');
assert.strictEqual(feature.visible, true, 'Features should be visible by default');

feature.setVisible(false);
assert.strictEqual(feature.visible, false, 'Feature visibility should be settable to false');

feature.setVisible(true);
assert.strictEqual(feature.visible, true, 'Feature visibility should be settable to true');
console.log('  ✓ Feature visible property works correctly');

// ---------------------------------------------------------------------------
// Test 2: Feature children management
// ---------------------------------------------------------------------------
console.log('\n--- Test 2: Feature children management ---');
const parent = new Feature('Parent');
const child1 = new Feature('Child1');
const child2 = new Feature('Child2');

parent.addChild(child1.id);
assert.strictEqual(parent.children.length, 1, 'Should have 1 child');
assert.strictEqual(parent.children[0], child1.id, 'Child ID should match');

parent.addChild(child2.id);
assert.strictEqual(parent.children.length, 2, 'Should have 2 children');

// Adding same child again should not duplicate
parent.addChild(child1.id);
assert.strictEqual(parent.children.length, 2, 'Should still have 2 children (no duplicate)');

parent.removeChild(child1.id);
assert.strictEqual(parent.children.length, 1, 'Should have 1 child after removal');
assert.strictEqual(parent.children[0], child2.id, 'Remaining child should be child2');
console.log('  ✓ Feature children management works correctly');

// ---------------------------------------------------------------------------
// Test 3: Serialization of visible and children properties
// ---------------------------------------------------------------------------
console.log('\n--- Test 3: Serialization of new Feature properties ---');
const serFeature = new Feature('SerTest');
serFeature.setVisible(false);
serFeature.addChild('some_child_id');

const serialized = serFeature.serialize();
assert.strictEqual(serialized.visible, false, 'Serialized visible should be false');
assert.deepStrictEqual(serialized.children, ['some_child_id'], 'Serialized children should match');

const deserialized = Feature.deserialize(serialized);
assert.strictEqual(deserialized.visible, false, 'Deserialized visible should be false');
assert.deepStrictEqual(deserialized.children, ['some_child_id'], 'Deserialized children should match');
console.log('  ✓ Serialization of new Feature properties works correctly');

// ---------------------------------------------------------------------------
// Test 4: Part origin planes
// ---------------------------------------------------------------------------
console.log('\n--- Test 4: Part origin planes ---');
const part = new Part('PlanePart');

// Check default origin planes
const planes = part.getOriginPlanes();
assert.ok(planes.XY, 'XY plane should exist');
assert.ok(planes.XZ, 'XZ plane should exist');
assert.ok(planes.YZ, 'YZ plane should exist');
assert.strictEqual(planes.XY.visible, true, 'XY plane should be visible by default');
assert.strictEqual(planes.XZ.visible, true, 'XZ plane should be visible by default');
assert.strictEqual(planes.YZ.visible, true, 'YZ plane should be visible by default');

// Toggle visibility
part.setOriginPlaneVisible('XY', false);
assert.strictEqual(part.getOriginPlanes().XY.visible, false, 'XY plane should be hidden');

part.setOriginPlaneVisible('XY', true);
assert.strictEqual(part.getOriginPlanes().XY.visible, true, 'XY plane should be visible again');
console.log('  ✓ Part origin planes work correctly');

// ---------------------------------------------------------------------------
// Test 5: Extrude links sketch as child and hides it
// ---------------------------------------------------------------------------
console.log('\n--- Test 5: Extrude links sketch as child ---');
const part2 = new Part('LinkPart');

const sketch1 = new Sketch();
sketch1.addSegment(-10, -10, 10, -10);
sketch1.addSegment(10, -10, 10, 10);
sketch1.addSegment(10, 10, -10, 10);
sketch1.addSegment(-10, 10, -10, -10);

const sf1 = part2.addSketch(sketch1);
assert.strictEqual(sf1.visible, true, 'Sketch should be visible before extrusion');

const ef1 = part2.extrude(sf1.id, 20);
assert.strictEqual(sf1.visible, false, 'Sketch should be hidden after extrusion');
assert.ok(ef1.children.includes(sf1.id), 'Extrude should have sketch as child');
console.log('  ✓ Extrude correctly links sketch as child and hides it');

// ---------------------------------------------------------------------------
// Test 6: Revolve links sketch as child and hides it
// ---------------------------------------------------------------------------
console.log('\n--- Test 6: Revolve links sketch as child ---');
const part3 = new Part('RevolvePart');

const sketch2 = new Sketch();
const numSegs = 8;
for (let i = 0; i < numSegs; i++) {
  const a1 = (i / numSegs) * Math.PI * 2;
  const a2 = ((i + 1) / numSegs) * Math.PI * 2;
  sketch2.addSegment(
    20 + Math.cos(a1) * 5, Math.sin(a1) * 5,
    20 + Math.cos(a2) * 5, Math.sin(a2) * 5
  );
}

const sf2 = part3.addSketch(sketch2);
assert.strictEqual(sf2.visible, true, 'Sketch should be visible before revolve');

const rf1 = part3.revolve(sf2.id, Math.PI);
assert.strictEqual(sf2.visible, false, 'Sketch should be hidden after revolve');
assert.ok(rf1.children.includes(sf2.id), 'Revolve should have sketch as child');
console.log('  ✓ Revolve correctly links sketch as child and hides it');

// ---------------------------------------------------------------------------
// Test 7: Multiple sketches on different planes
// ---------------------------------------------------------------------------
console.log('\n--- Test 7: Multiple sketches on different planes ---');
const part4 = new Part('MultiSketchPart');

// XY plane sketch
const xySketch = new Sketch();
xySketch.addSegment(0, 0, 50, 0);
xySketch.addSegment(50, 0, 50, 30);
xySketch.addSegment(50, 30, 0, 30);
xySketch.addSegment(0, 30, 0, 0);

const xySF = part4.addSketch(xySketch, {
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  xAxis: { x: 1, y: 0, z: 0 },
  yAxis: { x: 0, y: 1, z: 0 },
});

// XZ plane sketch
const xzSketch = new Sketch();
xzSketch.addSegment(0, 0, 50, 0);
xzSketch.addSegment(50, 0, 50, 30);
xzSketch.addSegment(50, 30, 0, 30);
xzSketch.addSegment(0, 30, 0, 0);

const xzSF = part4.addSketch(xzSketch, {
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 1, z: 0 },
  xAxis: { x: 1, y: 0, z: 0 },
  yAxis: { x: 0, y: 0, z: 1 },
});

// YZ plane sketch
const yzSketch = new Sketch();
yzSketch.addSegment(0, 0, 40, 0);
yzSketch.addSegment(40, 0, 40, 20);
yzSketch.addSegment(40, 20, 0, 20);
yzSketch.addSegment(0, 20, 0, 0);

const yzSF = part4.addSketch(yzSketch, {
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 1, y: 0, z: 0 },
  xAxis: { x: 0, y: 1, z: 0 },
  yAxis: { x: 0, y: 0, z: 1 },
});

const allSketches = part4.getSketches();
assert.strictEqual(allSketches.length, 3, 'Should have 3 sketches on different planes');

// Verify each plane is different
assert.deepStrictEqual(xySF.plane.normal, { x: 0, y: 0, z: 1 }, 'XY plane normal');
assert.deepStrictEqual(xzSF.plane.normal, { x: 0, y: 1, z: 0 }, 'XZ plane normal');
assert.deepStrictEqual(yzSF.plane.normal, { x: 1, y: 0, z: 0 }, 'YZ plane normal');
console.log('  ✓ Multiple sketches on different planes work correctly');

// ---------------------------------------------------------------------------
// Test 8: Active sketch management
// ---------------------------------------------------------------------------
console.log('\n--- Test 8: Active sketch management ---');
assert.strictEqual(part4.getActiveSketchId(), null, 'No sketch should be active by default');

part4.setActiveSketch(xySF.id);
assert.strictEqual(part4.getActiveSketchId(), xySF.id, 'XY sketch should be active');

part4.setActiveSketch(xzSF.id);
assert.strictEqual(part4.getActiveSketchId(), xzSF.id, 'XZ sketch should be active');

part4.setActiveSketch(null);
assert.strictEqual(part4.getActiveSketchId(), null, 'No sketch should be active after clearing');
console.log('  ✓ Active sketch management works correctly');

// ---------------------------------------------------------------------------
// Test 9: Origin planes serialization round-trip
// ---------------------------------------------------------------------------
console.log('\n--- Test 9: Origin planes serialization ---');
const part5 = new Part('SerPlanePart');
part5.setOriginPlaneVisible('XZ', false);
part5.setOriginPlaneVisible('YZ', false);

const ser5 = part5.serialize();
assert.ok(ser5.originPlanes, 'Serialized data should have originPlanes');
assert.strictEqual(ser5.originPlanes.XY.visible, true, 'XY should be visible in serialized data');
assert.strictEqual(ser5.originPlanes.XZ.visible, false, 'XZ should be hidden in serialized data');
assert.strictEqual(ser5.originPlanes.YZ.visible, false, 'YZ should be hidden in serialized data');

const des5 = Part.deserialize(ser5);
assert.strictEqual(des5.getOriginPlanes().XY.visible, true, 'XY should be visible after deserialize');
assert.strictEqual(des5.getOriginPlanes().XZ.visible, false, 'XZ should be hidden after deserialize');
assert.strictEqual(des5.getOriginPlanes().YZ.visible, false, 'YZ should be hidden after deserialize');
console.log('  ✓ Origin planes serialization round-trip works correctly');

// ---------------------------------------------------------------------------
// Test 10: Sketch visibility with feature linking and serialization
// ---------------------------------------------------------------------------
console.log('\n--- Test 10: Sketch visibility with feature linking ---');
const part6 = new Part('VisibilityPart');

const sketch3 = new Sketch();
sketch3.addSegment(0, 0, 100, 0);
sketch3.addSegment(100, 0, 100, 50);
sketch3.addSegment(100, 50, 0, 50);
sketch3.addSegment(0, 50, 0, 0);

const sf3 = part6.addSketch(sketch3);
const ef3 = part6.extrude(sf3.id, 30);

// Sketch should be hidden since it's linked to extrude
assert.strictEqual(sf3.visible, false, 'Sketch linked to extrude should be hidden');

// Serialize and deserialize
const ser6 = part6.serialize();
const des6 = Part.deserialize(ser6);

const desSketches = des6.getSketches();
assert.strictEqual(desSketches.length, 1, 'Deserialized part should have 1 sketch');
assert.strictEqual(desSketches[0].visible, false, 'Deserialized sketch should still be hidden');

const desFeatures = des6.getFeatures();
const desExtrude = desFeatures.find(f => f.type === 'extrude');
assert.ok(desExtrude.children.includes(desSketches[0].id), 'Deserialized extrude should have sketch as child');
console.log('  ✓ Sketch visibility persists through serialization');

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------
console.log('\n=== All Multi-Sketch & Plane Management Tests Passed! ===');
