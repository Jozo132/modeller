import './_watchdog.mjs';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Scene } from '../js/cad/Scene.js';
import { computeFullyConstrained } from '../js/cad/ConstraintAnalysis.js';
import {
  Angle,
  EqualLength,
  Fixed,
  Length,
  OnCircle,
  OnLine,
  RadiusConstraint,
  Tangent,
  clearVariables,
  setVariable,
} from '../js/cad/Constraint.js';
import { DimensionPrimitive, detectAllDimensionTypes } from '../js/cad/DimensionPrimitive.js';
import { solveSceneWithSketchToolkit } from '../js/cad/occt/SketchToolkitSceneAdapter.js';
import { formatTimingSuffix, startTiming } from './test-timing.js';

let passed = 0;
let failed = 0;

function approx(actual, expected, tolerance = 1e-6, label = 'value') {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected}, got ${actual}`);
}

function pointLineDistance(point, line) {
  const dx = line.p2.x - line.p1.x;
  const dy = line.p2.y - line.p1.y;
  const length = Math.hypot(dx, dy);
  if (length <= 1e-12) {
    throw new Error('line length must be non-zero');
  }
  return Math.abs(dx * (line.p1.y - point.y) - dy * (line.p1.x - point.x)) / length;
}

function addDrivingDimension(scene, options) {
  const dimension = new DimensionPrimitive(0, 0, 0, 0, 10, {
    dimType: options.dimType,
    isConstraint: true,
    formula: options.formula,
    sourceAId: options.sourceA?.id ?? null,
    sourceBId: options.sourceB?.id ?? null,
    sourceA: options.sourceA ?? null,
    sourceB: options.sourceB ?? null,
    angleEndpointAKey: options.angleEndpointAKey ?? null,
    angleEndpointBKey: options.angleEndpointBKey ?? null,
  });
  dimension.syncFromSources();
  scene.dimensions.push(dimension);
  scene.constraints.push(dimension);
  return dimension;
}

async function test(label, fn) {
  const startedAt = startTiming();
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${label}${formatTimingSuffix(startedAt)}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${label}${formatTimingSuffix(startedAt)}`);
    console.log(`    ${error.message}`);
  } finally {
    clearVariables();
  }
}

async function loadSketchToolkitFactory() {
  try {
    const imported = await import('occt-kernel-wasm/sketch-toolkit');
    if (typeof imported.createSketchToolkit === 'function') {
      return imported.createSketchToolkit;
    }
  } catch {
    // Fall through to the monorepo sibling dist bundle.
  }

  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const siblingDistModule = path.resolve(currentDir, '../../occt-kernel-wasm/dist/sketch-toolkit.js');
  if (!fs.existsSync(siblingDistModule)) {
    return null;
  }

  const imported = await import(pathToFileURL(siblingDistModule).href);
  return imported.createSketchToolkit || imported.default?.createSketchToolkit || imported.default || null;
}

console.log('OCCT Sketch Toolkit Scene Adapter');

const createSketchToolkit = await loadSketchToolkitFactory();
if (typeof createSketchToolkit !== 'function') {
  console.log('  - skipped: sketch-toolkit bundle is unavailable');
  process.exit(0);
}

const toolkit = await createSketchToolkit();

await test('infers smart arc and circle dimension defaults', async () => {
  const scene = new Scene();
  const circle = scene.addCircle(0, 0, 4, { merge: false });
  const arc = scene.addArc(0, 0, 4, 0, Math.PI / 2, { merge: false });

  const circleTypes = detectAllDimensionTypes(circle, null);
  const arcTypes = detectAllDimensionTypes(arc, null);

  assert.equal(circleTypes[0]?.dimType, 'diameter', 'expected full circles to default to diameter');
  assert.equal(circleTypes[1]?.dimType, 'radius', 'expected full circles to offer radius as an alternate');
  assert.equal(arcTypes[0]?.dimType, 'radius', 'expected arcs to default to radius');
  assert.equal(arcTypes[1]?.dimType, 'diameter', 'expected arcs to offer diameter as an alternate');
});

await test('infers smart segment angle direction and inverted alternative', async () => {
  const scene = new Scene();
  const base = scene.addSegment(0, 0, 10, 0, { merge: false });
  const branch = scene.addSegment(5, 5, 0, 0, { merge: false });

  const options = detectAllDimensionTypes(base, branch);
  const angle = options.find((candidate) => candidate.label === 'Angle');
  const inverted = options.find((candidate) => candidate.label === 'Angle (Inverted)');

  assert.ok(angle, 'expected smart angle option');
  assert.ok(inverted, 'expected inverted smart angle option');
  approx(angle.angleSweep, Math.PI / 4, 1e-6, 'angle.angleSweep');
  approx(inverted.angleSweep, -Math.PI / 4, 1e-6, 'inverted.angleSweep');
  assert.equal(angle.sourceA, base, 'expected default angle to preserve the original source ordering');
  assert.equal(angle.sourceB, branch, 'expected default angle to preserve the original source ordering');
  assert.equal(inverted.sourceA, branch, 'expected inverted angle to swap the source ordering');
  assert.equal(inverted.sourceB, base, 'expected inverted angle to swap the source ordering');
});

await test('infers smart parallel segment dimensions as distance', async () => {
  const scene = new Scene();
  const segmentA = scene.addSegment(0, 0, 10, 0, { merge: false });
  const segmentB = scene.addSegment(0, 5, 10, 5, { merge: false });

  const options = detectAllDimensionTypes(segmentA, segmentB);

  assert.equal(options.length, 1, 'expected parallel segments to expose a single distance mode by default');
  assert.equal(options[0]?.dimType, 'distance', 'expected parallel segments to infer distance');
  assert.equal(options[0]?.label, 'Distance', 'expected the inferred parallel-segment mode to be distance');
});

await test('solves a variable-backed angle and length scene through the sketch toolkit adapter', async () => {
  const scene = new Scene();
  const base = scene.addSegment(0, 0, 10, 0, { merge: false });
  const branch = scene.addSegment(2, 1, 5, 4, { merge: false });

  setVariable('theta', Math.PI / 4);
  setVariable('len', 10);

  scene.constraints.push(new Fixed(base.p1, 0, 0));
  scene.constraints.push(new Fixed(base.p2, 10, 0));
  scene.constraints.push(new Fixed(branch.p1, 2, 1));
  scene.constraints.push(new Angle(base, branch, 'theta'));
  scene.constraints.push(new Length(branch, 'len'));

  const { result, unsupportedConstraints } = solveSceneWithSketchToolkit(scene, toolkit);
  const expectedOffset = 10 / Math.sqrt(2);

  assert.equal(unsupportedConstraints.length, 0, 'expected fully supported scene subset');
  assert.equal(result.converged, true, 'expected native adapter solve to converge');
  assert.equal(result.status, 'fully-defined', 'expected fully-defined native solve status');
  assert.ok(result.maxScaledResidual <= 1e-6, `expected bounded residual, got ${result.maxScaledResidual}`);

  approx(branch.p2.x, 2 + expectedOffset, 1e-6, 'branch.p2.x');
  approx(branch.p2.y, 1 + expectedOffset, 1e-6, 'branch.p2.y');
});

await test('maps OnLine onto native point-line distance against the x-axis reference', async () => {
  const scene = new Scene();
  const segment = scene.addSegment(0, 0, 3, 4, { merge: false });

  setVariable('radius', 5);

  scene.constraints.push(new Fixed(segment.p1, 0, 0));
  scene.constraints.push(new Length(segment, 'radius'));
  scene.constraints.push(new OnLine(segment.p2, scene._xAxisLine));

  const { result, unsupportedConstraints } = solveSceneWithSketchToolkit(scene, toolkit);

  assert.equal(unsupportedConstraints.length, 0, 'expected fully supported scene subset');
  assert.equal(result.converged, true, 'expected native adapter solve to converge');
  assert.equal(result.status, 'fully-defined', 'expected fully-defined native solve status');
  assert.ok(result.maxScaledResidual <= 1e-6, `expected bounded residual, got ${result.maxScaledResidual}`);

  approx(segment.p2.x, 5, 1e-6, 'segment.p2.x');
  approx(segment.p2.y, 0, 1e-6, 'segment.p2.y');
});

await test('maps OnCircle onto native point distance with a variable-backed radius', async () => {
  const scene = new Scene();
  const circle = scene.addCircle(0, 0, 2, { merge: false });
  const point = scene.addPoint(10, 0);
  const guide = scene.addSegment(0, 0, 10, 0, { merge: false });
  point.standalone = true;

  setVariable('r', 5);

  scene.constraints.push(new Fixed(circle.center, 0, 0));
  scene.constraints.push(new Fixed(guide.p1, 0, 0));
  scene.constraints.push(new Fixed(guide.p2, 10, 0));
  scene.constraints.push(new RadiusConstraint(circle, 'r'));
  scene.constraints.push(new OnLine(point, guide));
  scene.constraints.push(new OnCircle(point, circle));

  const { result, unsupportedConstraints } = solveSceneWithSketchToolkit(scene, toolkit);

  assert.equal(unsupportedConstraints.length, 0, 'expected fully supported scene subset');
  assert.equal(result.converged, true, 'expected native adapter solve to converge');
  assert.equal(result.status, 'fully-defined', 'expected fully-defined native solve status');
  assert.ok(result.maxScaledResidual <= 1e-6, `expected bounded residual, got ${result.maxScaledResidual}`);

  approx(circle.radius, 5, 1e-9, 'circle.radius');
  approx(point.x, 5, 1e-6, 'point.x');
  approx(point.y, 0, 1e-6, 'point.y');
});

await test('maps line-circle tangent onto native point-line distance', async () => {
  const scene = new Scene();
  const circle = scene.addCircle(0, 0, 5, { merge: false });
  const line = scene.addSegment(5, 0, 3, 4, { merge: false });

  scene.constraints.push(new Fixed(circle.center, 0, 0));
  scene.constraints.push(new Fixed(line.p1, 5, 0));
  scene.constraints.push(new RadiusConstraint(circle, 5));
  scene.constraints.push(new Length(line, 4));
  scene.constraints.push(new Tangent(line, circle));

  const { result, unsupportedConstraints } = solveSceneWithSketchToolkit(scene, toolkit);

  assert.equal(unsupportedConstraints.length, 0, 'expected fully supported scene subset');
  assert.equal(result.converged, true, 'expected native adapter solve to converge');
  assert.equal(result.status, 'fully-defined', 'expected fully-defined native solve status');
  assert.ok(result.maxScaledResidual <= 1e-6, `expected bounded residual, got ${result.maxScaledResidual}`);

  approx(Math.hypot(line.p2.x - line.p1.x, line.p2.y - line.p1.y), 4, 1e-6, 'line length');
  approx(pointLineDistance(circle.center, line), circle.radius, 1e-6, 'center-to-line distance');
});

await test('supports endpoint-aware native arc entities in equal-radius tangent scenes', async () => {
  const scene = new Scene();
  const arc = scene.addArc(0, 0, 3, 0, Math.PI / 2, { merge: false });
  const circle = scene.addCircle(10, 0, 5, { merge: false });
  const xGuide = scene.addSegment(0, 0, 10, 0, { merge: false });
  const yGuide = scene.addSegment(0, 0, 0, 10, { merge: false });

  scene.constraints.push(new Fixed(arc.center, 0, 0));
  scene.constraints.push(new Fixed(xGuide.p1, 0, 0));
  scene.constraints.push(new Fixed(xGuide.p2, 10, 0));
  scene.constraints.push(new Fixed(yGuide.p1, 0, 0));
  scene.constraints.push(new Fixed(yGuide.p2, 0, 10));
  scene.constraints.push(new RadiusConstraint(arc, 4));
  scene.constraints.push(new EqualLength(arc, circle));
  scene.constraints.push(new OnLine(arc.startPoint, xGuide));
  scene.constraints.push(new OnLine(arc.endPoint, yGuide));
  scene.constraints.push(new OnLine(circle.center, xGuide));
  scene.constraints.push(new Tangent(arc, circle));

  const { result, snapshot, unsupportedConstraints } = solveSceneWithSketchToolkit(scene, toolkit);

  assert.equal(unsupportedConstraints.length, 0, 'expected fully supported scene subset');
  assert.equal(result.converged, true, 'expected native adapter solve to converge');
  assert.equal(result.status, 'fully-defined', 'expected fully-defined native solve status');
  assert.ok(result.maxScaledResidual <= 1e-6, `expected bounded residual, got ${result.maxScaledResidual}`);

  const solvedArc = snapshot.entities.find((entity) => entity.id && entity.kind === 'arc');

  assert.ok(solvedArc, 'expected adapter snapshot to preserve a native arc entity');
  approx(arc.radius, circle.radius, 1e-6, 'equal radii');
  approx(arc.radius, 4, 1e-6, 'arc.radius');
  approx(arc.startPoint.x, 4, 1e-6, 'arc.startPoint.x');
  approx(arc.startPoint.y, 0, 1e-6, 'arc.startPoint.y');
  approx(arc.endPoint.x, 0, 1e-6, 'arc.endPoint.x');
  approx(arc.endPoint.y, 4, 1e-6, 'arc.endPoint.y');
  approx(Math.hypot(circle.center.x - arc.center.x, circle.center.y - arc.center.y), arc.radius + circle.radius, 1e-6, 'center distance');
});

await test('supports driving smart horizontal dimensions between points', async () => {
  const scene = new Scene();
  const pointA = scene.addPoint(0, 0);
  const pointB = scene.addPoint(2, 3);
  pointA.standalone = true;
  pointB.standalone = true;

  scene.constraints.push(new Fixed(pointA, 0, 0));
  const dimension = addDrivingDimension(scene, {
    dimType: 'dx',
    formula: 5,
    sourceA: pointA,
    sourceB: pointB,
  });

  const { result, unsupportedConstraints } = solveSceneWithSketchToolkit(scene, toolkit);

  assert.equal(unsupportedConstraints.length, 0, 'expected fully supported smart dimension scene subset');
  assert.equal(result.converged, true, 'expected native adapter solve to converge');
  assert.ok(result.maxScaledResidual <= 1e-6, `expected bounded residual, got ${result.maxScaledResidual}`);

  approx(pointB.x, 5, 1e-6, 'pointB.x');
  approx(pointB.y, 0, 1e-6, 'pointB.y');
  approx(dimension.value, 5, 1e-6, 'dimension.value');

  const constrained = computeFullyConstrained(scene);
  assert.equal(constrained.points.has(pointB), true, 'expected smart dx dimension to fully constrain the second point');
});

await test('supports driving smart point-line dimensions', async () => {
  const scene = new Scene();
  const guide = scene.addSegment(0, 0, 10, 0, { merge: false });
  const point = scene.addPoint(4, 1);
  point.standalone = true;

  scene.constraints.push(new Fixed(guide.p1, 0, 0));
  scene.constraints.push(new Fixed(guide.p2, 10, 0));
  const dimension = addDrivingDimension(scene, {
    dimType: 'distance',
    formula: 5,
    sourceA: point,
    sourceB: guide,
  });

  const { result, unsupportedConstraints } = solveSceneWithSketchToolkit(scene, toolkit);

  assert.equal(unsupportedConstraints.length, 0, 'expected fully supported smart dimension scene subset');
  assert.equal(result.converged, true, 'expected native adapter solve to converge');
  assert.ok(result.maxScaledResidual <= 1e-6, `expected bounded residual, got ${result.maxScaledResidual}`);

  approx(point.x, 4, 1e-6, 'point.x');
  approx(point.y, 5, 1e-6, 'point.y');
  approx(dimension.value, 5, 1e-6, 'dimension.value');

  const constrained = computeFullyConstrained(scene);
  assert.equal(constrained.points.has(point), false, 'expected point-line smart distance to remain underdefined without an additional x lock');
});

await test('supports driving smart diameter dimensions on circles', async () => {
  const scene = new Scene();
  const circle = scene.addCircle(0, 0, 2, { merge: false });

  scene.constraints.push(new Fixed(circle.center, 0, 0));
  const dimension = addDrivingDimension(scene, {
    dimType: 'diameter',
    formula: 10,
    sourceA: circle,
  });

  const { result, unsupportedConstraints } = solveSceneWithSketchToolkit(scene, toolkit);

  assert.equal(unsupportedConstraints.length, 0, 'expected fully supported smart dimension scene subset');
  assert.equal(result.converged, true, 'expected native adapter solve to converge');
  assert.ok(result.maxScaledResidual <= 1e-6, `expected bounded residual, got ${result.maxScaledResidual}`);

  approx(circle.radius, 5, 1e-6, 'circle.radius');
  approx(dimension.value, 10, 1e-6, 'dimension.value');

  const constrained = computeFullyConstrained(scene);
  assert.equal(constrained.entities.has(circle), true, 'expected smart diameter dimension to fully constrain the circle radius');
});

await test('supports driving smart segment-to-curve distance dimensions via midpoint helpers', async () => {
  const scene = new Scene();
  const segment = scene.addSegment(-2, 0, 2, 0, { merge: false });
  const circle = scene.addCircle(3, 4, 1, { merge: false });

  scene.constraints.push(new Fixed(segment.p1, -2, 0));
  scene.constraints.push(new Fixed(segment.p2, 2, 0));
  scene.constraints.push(new RadiusConstraint(circle, 1));
  scene.constraints.push(new OnLine(circle.center, scene._xAxisLine));
  const dimension = addDrivingDimension(scene, {
    dimType: 'distance',
    formula: 7,
    sourceA: segment,
    sourceB: circle,
  });

  const { result, unsupportedConstraints } = solveSceneWithSketchToolkit(scene, toolkit);

  assert.equal(unsupportedConstraints.length, 0, 'expected fully supported smart dimension scene subset');
  assert.equal(result.converged, true, 'expected native adapter solve to converge');
  assert.ok(result.maxScaledResidual <= 1e-6, `expected bounded residual, got ${result.maxScaledResidual}`);

  approx(circle.center.x, 7, 1e-6, 'circle.center.x');
  approx(circle.center.y, 0, 1e-6, 'circle.center.y');
  approx(dimension.value, 7, 1e-6, 'dimension.value');

  const constrained = computeFullyConstrained(scene);
  assert.equal(constrained.points.has(circle.center), true, 'expected midpoint-based smart distance plus OnLine to fully constrain the circle center');
  assert.equal(constrained.entities.has(circle), true, 'expected the circle to be fully constrained once its center and radius are fixed');
});

await test('supports driving smart angle dimensions with inferred segment direction', async () => {
  const scene = new Scene();
  const base = scene.addSegment(0, 0, 10, 0, { merge: false });
  const branch = scene.addSegment(5, 5, 0, 0, { merge: false });

  scene.constraints.push(new Fixed(base.p1, 0, 0));
  scene.constraints.push(new Fixed(base.p2, 10, 0));
  scene.constraints.push(new Fixed(branch.p2, 0, 0));
  scene.constraints.push(new Length(branch, Math.sqrt(50)));

  const angleInfo = detectAllDimensionTypes(base, branch).find((candidate) => candidate.label === 'Angle');
  const dimension = addDrivingDimension(scene, {
    dimType: 'angle',
    formula: Math.PI / 4,
    sourceA: angleInfo.sourceA,
    sourceB: angleInfo.sourceB,
    angleEndpointAKey: angleInfo.angleEndpointAKey,
    angleEndpointBKey: angleInfo.angleEndpointBKey,
  });

  const { result, unsupportedConstraints } = solveSceneWithSketchToolkit(scene, toolkit);

  assert.equal(unsupportedConstraints.length, 0, 'expected fully supported smart dimension scene subset');
  assert.equal(result.converged, true, 'expected native adapter solve to converge');
  assert.ok(result.maxScaledResidual <= 1e-6, `expected bounded residual, got ${result.maxScaledResidual}`);

  approx(branch.p1.x, 5, 1e-6, 'branch.p1.x');
  approx(branch.p1.y, 5, 1e-6, 'branch.p1.y');
  approx(dimension.value, Math.PI / 4, 1e-6, 'dimension.value');
});

await test('reports measured driven smart dimensions through the toolkit result path', async () => {
  const scene = new Scene();
  const pointA = scene.addPoint(0, 0);
  const pointB = scene.addPoint(3, 4);
  pointA.standalone = true;
  pointB.standalone = true;

  const dimension = new DimensionPrimitive(0, 0, 0, 0, 10, {
    dimType: 'distance',
    isConstraint: false,
    sourceAId: pointA.id,
    sourceBId: pointB.id,
    sourceA: pointA,
    sourceB: pointB,
  });
  dimension.syncFromSources();
  scene.dimensions.push(dimension);
  scene.constraints.push(dimension);

  const { result, unsupportedConstraints } = solveSceneWithSketchToolkit(scene, toolkit);

  assert.equal(unsupportedConstraints.length, 0, 'expected driven smart dimensions to lower cleanly');
  const reported = result.drivenDimensions.find((entry) => entry.name === `dimension:${dimension.id}`);
  assert.ok(reported, 'expected toolkit result to include the driven smart dimension');
  approx(reported.value, 5, 1e-6, 'reported driven smart distance');
  assert.equal(reported.kind, 'distance-point-point', 'expected driven smart distance to lower to point-point measurement');
  approx(dimension.measuredValue, 5, 1e-6, 'dimension.measuredValue after solve');

  dimension.x2 = 100;
  dimension.y2 = 0;
  approx(dimension.value, 5, 1e-6, 'dimension.value should use toolkit-reported driven value after solve');

  pointB.x = 6;
  pointB.y = 8;
  dimension.syncFromSources();
  assert.equal(dimension.measuredValue, null, 'expected plain geometry sync to clear stale driven measurement cache');
  approx(dimension.value, 10, 1e-6, 'dimension.value after plain geometry sync');
});

await test('keeps toolkit-reported driven values attached through Scene.solve', async () => {
  const scene = new Scene();
  const pointA = scene.addPoint(0, 0);
  const pointB = scene.addPoint(3, 4);
  pointA.standalone = true;
  pointB.standalone = true;

  const dimension = new DimensionPrimitive(0, 0, 0, 0, 10, {
    dimType: 'distance',
    isConstraint: false,
    sourceAId: pointA.id,
    sourceBId: pointB.id,
    sourceA: pointA,
    sourceB: pointB,
  });
  dimension.syncFromSources();
  scene.dimensions.push(dimension);
  scene.constraints.push(dimension);

  const result = scene.solve({ maxIter: 64, tolerance: 1e-8 });

  const reported = result.drivenDimensions.find((entry) => entry.name === `dimension:${dimension.id}`);
  assert.ok(reported, 'expected Scene.solve to surface the toolkit-reported driven smart dimension');
  approx(dimension.measuredValue, 5, 1e-6, 'dimension.measuredValue after Scene.solve');

  dimension.x2 = 100;
  dimension.y2 = 0;
  approx(dimension.value, 5, 1e-6, 'dimension.value should still reflect the toolkit-reported value after Scene.solve');
});

await test('surfaces driving smart dimensions as driven-conversion candidates in overdefined scenes', async () => {
  const scene = new Scene();
  const pointA = scene.addPoint(0, 0);
  const pointB = scene.addPoint(5, 0);
  pointA.standalone = true;
  pointB.standalone = true;
  pointA.fixed = true;
  pointB.fixed = true;

  const dimension = new DimensionPrimitive(0, 0, 0, 0, 10, {
    dimType: 'distance',
    isConstraint: true,
    formula: 5,
    sourceAId: pointA.id,
    sourceBId: pointB.id,
    sourceA: pointA,
    sourceB: pointB,
  });
  dimension.syncFromSources();
  scene.dimensions.push(dimension);
  scene.constraints.push(dimension);

  const result = scene.solve({ maxIter: 32, tolerance: 1e-8 });
  const diagnostic = result.diagnostics.items.find((item) => item.code === 'DRIVING_DIMENSION_CONVERSION_CANDIDATES');

  assert.equal(result.status, 'overdefined', 'expected fixed-point driving dimension scene to be structurally overdefined');
  assert.ok(diagnostic, 'expected a driven-conversion candidate diagnostic for the driving smart dimension');
  assert.match(diagnostic.message, new RegExp(`dimension:${dimension.id}`), 'expected diagnostic to reference the driving smart dimension name');
  assert.ok(diagnostic.constraintIds.includes(result.drivenDimensions?.[0]?.constraintId ?? -1) === false, 'expected conversion candidates to target driving, not driven, constraints');
});

if (failed > 0) {
  process.exit(1);
}

console.log(`\nPassed: ${passed}, Failed: ${failed}`);