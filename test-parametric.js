// test-parametric.js — Test the parametric 3D modeling system

import { Part } from './js/cad/Part.js';
import { Sketch } from './js/cad/Sketch.js';

console.log('=== Testing Parametric 3D Modeling System ===\n');

// Create a new part
const part = new Part('TestPart');
console.log('1. Created part:', part.name);

// Create a sketch with a simple rectangle
const sketch1 = new Sketch();
sketch1.name = 'RectangleSketch';
sketch1.addSegment(0, 0, 100, 0);
sketch1.addSegment(100, 0, 100, 50);
sketch1.addSegment(100, 50, 0, 50);
sketch1.addSegment(0, 50, 0, 0);
console.log('2. Created sketch with', sketch1.segments.length, 'segments');

// Add sketch as a feature to the part
const sketchFeature = part.addSketch(sketch1);
console.log('3. Added sketch feature:', sketchFeature.id);

// Extrude the sketch
const extrudeFeature = part.extrude(sketchFeature.id, 25);
console.log('4. Added extrude feature:', extrudeFeature.id);

// Check the results
console.log('\n--- Feature Tree State ---');
console.log('Number of features:', part.getFeatures().length);
console.log('Features:');
part.getFeatures().forEach((f, i) => {
  console.log(`  ${i + 1}. ${f.name} (${f.type}) - ${f.suppressed ? 'suppressed' : 'active'}`);
});

// Get final geometry
const finalGeometry = part.getFinalGeometry();
console.log('\n--- Final Geometry ---');
if (finalGeometry) {
  console.log('Type:', finalGeometry.type);
  console.log('Vertices:', finalGeometry.geometry.vertices.length);
  console.log('Faces:', finalGeometry.geometry.faces.length);
  console.log('Volume:', finalGeometry.volume);
  console.log('Bounding box:', finalGeometry.boundingBox);
} else {
  console.log('No final geometry');
}

// Test parametric modification - change extrusion distance
console.log('\n--- Testing Parametric Recalculation ---');
console.log('Original extrusion distance:', extrudeFeature.distance);
part.modifyFeature(extrudeFeature.id, (feature) => {
  feature.setDistance(50); // Double the distance
});
console.log('New extrusion distance:', extrudeFeature.distance);

const updatedGeometry = part.getFinalGeometry();
console.log('Updated geometry vertices:', updatedGeometry.geometry.vertices.length);
console.log('Updated bounding box:', updatedGeometry.boundingBox);

// Test feature suppression
console.log('\n--- Testing Feature Suppression ---');
part.suppressFeature(extrudeFeature.id);
console.log('Extrude feature suppressed:', extrudeFeature.suppressed);
const geometryAfterSuppression = part.getFinalGeometry();
console.log('Geometry after suppression:', geometryAfterSuppression ? geometryAfterSuppression.type : 'null');

part.unsuppressFeature(extrudeFeature.id);
console.log('Extrude feature unsuppressed:', extrudeFeature.suppressed);

// Test with revolve feature
console.log('\n--- Testing Revolve Feature ---');
const sketch2 = new Sketch();
sketch2.name = 'CircleSketch';
// Create a circular profile
const numSegments = 16;
for (let i = 0; i < numSegments; i++) {
  const angle1 = (i / numSegments) * Math.PI * 2;
  const angle2 = ((i + 1) / numSegments) * Math.PI * 2;
  const radius = 20;
  const x1 = 50 + Math.cos(angle1) * radius;
  const y1 = 0 + Math.sin(angle1) * radius;
  const x2 = 50 + Math.cos(angle2) * radius;
  const y2 = 0 + Math.sin(angle2) * radius;
  sketch2.addSegment(x1, y1, x2, y2);
}
console.log('Created circular sketch with', sketch2.segments.length, 'segments');

const sketchFeature2 = part.addSketch(sketch2);
const revolveFeature = part.revolve(sketchFeature2.id, Math.PI * 2); // 360 degrees
console.log('Added revolve feature:', revolveFeature.id);

console.log('\n--- Final Feature Tree ---');
console.log('Total features:', part.getFeatures().length);
part.getFeatures().forEach((f, i) => {
  const result = part.featureTree.results[f.id];
  const status = f.suppressed ? 'suppressed' : (result && result.error ? `error: ${result.error}` : 'ok');
  console.log(`  ${i + 1}. ${f.name} (${f.type}) - ${status}`);
  if (f.dependencies.length > 0) {
    console.log(`     Dependencies: ${f.dependencies.join(', ')}`);
  }
});

// Test serialization
console.log('\n--- Testing Serialization ---');
const serialized = part.serialize();
console.log('Serialized part data keys:', Object.keys(serialized));
console.log('Serialized features:', serialized.featureTree.features.length);

const deserialized = Part.deserialize(serialized);
console.log('Deserialized part:', deserialized.name);
console.log('Deserialized features:', deserialized.getFeatures().length);

// Test dependency tracking
console.log('\n--- Testing Dependency Tracking ---');
const deps = part.featureTree.getAllDependencies(extrudeFeature.id);
console.log('Dependencies of', extrudeFeature.name + ':', deps.map(f => f.name).join(', '));

const dependents = part.featureTree.getAllDependents(sketchFeature.id);
console.log('Dependents of', sketchFeature.name + ':', dependents.map(f => f.name).join(', '));

console.log('\n=== All Tests Completed Successfully! ===');
