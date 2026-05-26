import './_watchdog.mjs';

import assert from 'node:assert/strict';

import { FilletFeature } from '../js/cad/FilletFeature.js';
import { ChamferFeature } from '../js/cad/ChamferFeature.js';

const fillet = new FilletFeature('Fillet', 2.5);
const filletEdgeRefs = [{ stableHash: 'E:fillet-edge-1' }];
const defaultFilletSpec = fillet.buildOcctSpec(filletEdgeRefs);

assert.equal(defaultFilletSpec.schemaVersion, 1);
assert.equal(defaultFilletSpec.unit.length, 'model');
assert.equal(defaultFilletSpec.edges.length, 1);
assert.equal(defaultFilletSpec.edges[0].edge.stableHash, 'E:fillet-edge-1');
assert.equal(defaultFilletSpec.edges[0].radiusMode, 'constant');
assert.equal(defaultFilletSpec.edges[0].radius, 2.5);

fillet.setOcctSpec({
  continuity: 'C1',
  blendShape: 'polynomial',
  overflowMode: 'fail',
  edges: [{ radiusMode: 'startEnd', startRadius: 1.5, endRadius: 3.0 }],
});
const customFilletSpec = fillet.buildOcctSpec(filletEdgeRefs);

assert.equal(customFilletSpec.continuity, 'C1');
assert.equal(customFilletSpec.blendShape, 'polynomial');
assert.equal(customFilletSpec.overflowMode, 'fail');
assert.equal(customFilletSpec.edges[0].edge.stableHash, 'E:fillet-edge-1');
assert.equal(customFilletSpec.edges[0].radiusMode, 'startEnd');
assert.equal(customFilletSpec.edges[0].startRadius, 1.5);
assert.equal(customFilletSpec.edges[0].endRadius, 3.0);

const serializedFillet = fillet.serialize();
const roundTrippedFillet = FilletFeature.deserialize(serializedFillet);
assert.equal(roundTrippedFillet.occtSpec.blendShape, 'polynomial');
assert.equal(roundTrippedFillet.occtSpec.edges[0].endRadius, 3.0);

fillet.setOcctSpec({
  radiusMode: 'startEnd',
  startRadius: 0.5,
  endRadius: 2.25,
});
const startEndFilletSpec = fillet.buildOcctSpec(filletEdgeRefs);
assert.equal(startEndFilletSpec.radiusMode, 'startEnd');
assert.equal(startEndFilletSpec.startRadius, 0.5);
assert.equal(startEndFilletSpec.endRadius, 2.25);
assert.equal('radius' in startEndFilletSpec, false);

const chamfer = new ChamferFeature('Chamfer', 1.25);
const chamferEdgeRefs = [{ topoId: 42 }];
const defaultChamferSpec = chamfer.buildOcctSpec(chamferEdgeRefs);

assert.equal(defaultChamferSpec.schemaVersion, 1);
assert.equal(defaultChamferSpec.mode, 'symmetric');
assert.equal(defaultChamferSpec.distance, 1.25);
assert.equal(defaultChamferSpec.edges.length, 1);
assert.equal(defaultChamferSpec.edges[0].edge.topoId, 42);

chamfer.setOcctSpec({
  mode: 'distanceAngle',
  contourMode: 'intersection',
  edges: [{ distance: 0.8, angleDegrees: 35, referenceFace: { topoId: 9 } }],
});
const customChamferSpec = chamfer.buildOcctSpec(chamferEdgeRefs);

assert.equal(customChamferSpec.mode, 'distanceAngle');
assert.equal(customChamferSpec.contourMode, 'intersection');
assert.equal(customChamferSpec.edges[0].edge.topoId, 42);
assert.equal(customChamferSpec.edges[0].distance, 0.8);
assert.equal(customChamferSpec.edges[0].angleDegrees, 35);
assert.equal(customChamferSpec.edges[0].referenceFace.topoId, 9);

const serializedChamfer = chamfer.serialize();
const roundTrippedChamfer = ChamferFeature.deserialize(serializedChamfer);
assert.equal(roundTrippedChamfer.occtSpec.mode, 'distanceAngle');
assert.equal(roundTrippedChamfer.occtSpec.edges[0].referenceFace.topoId, 9);

chamfer.setOcctSpec({
  mode: 'distanceAngle',
  angleDegrees: 45,
  distance1: 4,
  distance2: 2,
  referenceFace: { stableHash: 'F:1' },
  unit: { angle: 'degrees' },
});
const distanceAngleSpec = chamfer.buildOcctSpec(chamferEdgeRefs);
assert.equal(distanceAngleSpec.mode, 'distanceAngle');
assert.equal(distanceAngleSpec.distance, 1.25);
assert.equal(distanceAngleSpec.angleDegrees, 45);
assert.equal(distanceAngleSpec.referenceFace.stableHash, 'F:1');
assert.equal('distance1' in distanceAngleSpec, false);
assert.equal('distance2' in distanceAngleSpec, false);

console.log('ok');