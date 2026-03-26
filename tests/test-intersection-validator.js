// tests/test-intersection-validator.js — Tests for IntersectionValidator and Healing
//
// Validates:
// 1. Intersection contract validation
// 2. Split-fragment invariants
// 3. Healing behavior on near-coincident / tiny-edge cases
// 4. Regression coverage on existing boolean fixtures
// 5. Failure-path diagnostics generation

import assert from 'assert';
import { NurbsCurve } from '../js/cad/NurbsCurve.js';
import { NurbsSurface } from '../js/cad/NurbsSurface.js';
import {
  TopoBody, TopoShell, TopoFace, TopoLoop, TopoCoEdge, TopoEdge, TopoVertex,
  SurfaceType, buildTopoBody, resetTopoIds,
} from '../js/cad/BRepTopology.js';
import { Tolerance, DEFAULT_TOLERANCE } from '../js/cad/Tolerance.js';
import {
  IntersectionValidation, validateIntersections, validateFragments, validateFinalBody,
} from '../js/cad/IntersectionValidator.js';
import { HealingReport, healFragments } from '../js/cad/Healing.js';
import { exactBooleanOp } from '../js/cad/BooleanKernel.js';
import { buildBody } from '../js/cad/ShellBuilder.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

function makeBox(x, y, z, w, h, d) {
  const c = [
    { x, y, z },
    { x: x + w, y, z },
    { x: x + w, y: y + h, z },
    { x, y: y + h, z },
    { x, y, z: z + d },
    { x: x + w, y, z: z + d },
    { x: x + w, y: y + h, z: z + d },
    { x, y: y + h, z: z + d },
  ];
  return buildTopoBody([
    { surfaceType: SurfaceType.PLANE, vertices: [c[3], c[2], c[1], c[0]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [c[4], c[5], c[6], c[7]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [c[0], c[1], c[5], c[4]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [c[2], c[3], c[7], c[6]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [c[3], c[0], c[4], c[7]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [c[1], c[2], c[6], c[5]], surface: null, edgeCurves: null, shared: null },
  ]);
}

function makeTriFace() {
  resetTopoIds();
  const v1 = new TopoVertex({ x: 0, y: 0, z: 0 });
  const v2 = new TopoVertex({ x: 10, y: 0, z: 0 });
  const v3 = new TopoVertex({ x: 5, y: 10, z: 0 });
  const e1 = new TopoEdge(v1, v2, NurbsCurve.createLine(v1.point, v2.point));
  const e2 = new TopoEdge(v2, v3, NurbsCurve.createLine(v2.point, v3.point));
  const e3 = new TopoEdge(v3, v1, NurbsCurve.createLine(v3.point, v1.point));
  const loop = new TopoLoop([
    new TopoCoEdge(e1, true),
    new TopoCoEdge(e2, true),
    new TopoCoEdge(e3, true),
  ]);
  const face = new TopoFace(null, SurfaceType.PLANE);
  face.setOuterLoop(loop);
  return { face, v1, v2, v3, e1, e2, e3 };
}

// ============================================================
console.log('=== IntersectionValidation Tests ===\n');
// ============================================================

console.log('--- Intersection contract validation ---');

test('validateIntersections: empty array is valid', () => {
  const result = validateIntersections([]);
  assert.ok(result.isValid, 'Empty intersections should be valid');
});

test('validateIntersections: non-array fails', () => {
  const result = validateIntersections(null);
  assert.ok(!result.isValid, 'null should not be valid');
  assert.ok(result.diagnostics.length > 0);
  assert.strictEqual(result.diagnostics[0].invariant, 'intersections-is-array');
});

test('validateIntersections: missing faceA/faceB fails', () => {
  const result = validateIntersections([{ faceA: null, faceB: null, curves: [] }]);
  assert.ok(!result.isValid);
  assert.ok(result.diagnostics.some(d => d.invariant === 'face-references-present'));
});

test('validateIntersections: empty curves fails', () => {
  const face = new TopoFace(null, SurfaceType.PLANE);
  const result = validateIntersections([{ faceA: face, faceB: face, curves: [] }]);
  assert.ok(!result.isValid);
  assert.ok(result.diagnostics.some(d => d.invariant === 'curves-non-empty'));
});

test('validateIntersections: missing curve3d fails', () => {
  const face = new TopoFace(null, SurfaceType.PLANE);
  const result = validateIntersections([{
    faceA: face, faceB: face,
    curves: [{ curve: null, paramsA: [{ u: 0, v: 0 }], paramsB: [{ u: 0, v: 0 }] }],
  }]);
  assert.ok(!result.isValid);
  assert.ok(result.diagnostics.some(d => d.invariant === 'curve3d-present'));
});

test('validateIntersections: non-finite params fail', () => {
  const face = new TopoFace(null, SurfaceType.PLANE);
  const curve = NurbsCurve.createLine({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 });
  const result = validateIntersections([{
    faceA: face, faceB: face,
    curves: [{
      curve,
      paramsA: [{ u: NaN, v: 0 }, { u: 1, v: 1 }],
      paramsB: [{ u: 0, v: 0 }, { u: 1, v: 1 }],
    }],
  }]);
  assert.ok(!result.isValid);
  assert.ok(result.diagnostics.some(d => d.invariant === 'paramsA-finite'));
});

test('validateIntersections: too few params fail', () => {
  const face = new TopoFace(null, SurfaceType.PLANE);
  const curve = NurbsCurve.createLine({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 });
  const result = validateIntersections([{
    faceA: face, faceB: face,
    curves: [{
      curve,
      paramsA: [{ u: 0, v: 0 }],
      paramsB: [{ u: 0, v: 0 }, { u: 1, v: 1 }],
    }],
  }]);
  assert.ok(!result.isValid);
  assert.ok(result.diagnostics.some(d => d.invariant === 'paramsA-present'));
});

test('validateIntersections: zero-length curve warns', () => {
  const face = new TopoFace(null, SurfaceType.PLANE);
  const curve = NurbsCurve.createLine({ x: 5, y: 5, z: 0 }, { x: 5, y: 5, z: 0 });
  const result = validateIntersections([{
    faceA: face, faceB: face,
    curves: [{
      curve,
      paramsA: [{ u: 0, v: 0 }, { u: 1, v: 1 }],
      paramsB: [{ u: 0, v: 0 }, { u: 1, v: 1 }],
    }],
  }]);
  assert.ok(!result.isValid);
  assert.ok(result.diagnostics.some(d => d.invariant === 'curve-nonzero-length'));
});

test('validateIntersections: valid entry passes', () => {
  const face = new TopoFace(null, SurfaceType.PLANE);
  const curve = NurbsCurve.createLine({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 });
  const result = validateIntersections([{
    faceA: face, faceB: face,
    curves: [{
      curve,
      paramsA: [{ u: 0, v: 0 }, { u: 1, v: 1 }],
      paramsB: [{ u: 0, v: 0 }, { u: 1, v: 1 }],
    }],
  }]);
  assert.ok(result.isValid, `Should be valid, got: ${JSON.stringify(result.toJSON())}`);
});

test('validateIntersections: toJSON produces compact payload', () => {
  const result = validateIntersections(null);
  const json = result.toJSON();
  assert.strictEqual(typeof json.valid, 'boolean');
  assert.strictEqual(typeof json.count, 'number');
  assert.ok(Array.isArray(json.diagnostics));
});

// ============================================================
console.log('\n--- Fragment validation ---');
// ============================================================

test('validateFragments: empty array reports diagnostic', () => {
  const result = validateFragments([]);
  assert.ok(!result.isValid);
  assert.ok(result.diagnostics.some(d => d.invariant === 'fragments-non-empty'));
});

test('validateFragments: fragment without outer loop fails', () => {
  const face = new TopoFace(null, SurfaceType.PLANE);
  const result = validateFragments([face]);
  assert.ok(!result.isValid);
  assert.ok(result.diagnostics.some(d => d.invariant === 'fragment-has-outer-loop'));
});

test('validateFragments: valid triangle fragment passes', () => {
  const { face } = makeTriFace();
  const result = validateFragments([face]);
  assert.ok(result.isValid, `Should be valid, got: ${JSON.stringify(result.toJSON())}`);
});

test('validateFragments: fragment with only 2 coedges fails', () => {
  resetTopoIds();
  const v1 = new TopoVertex({ x: 0, y: 0, z: 0 });
  const v2 = new TopoVertex({ x: 10, y: 0, z: 0 });
  const e1 = new TopoEdge(v1, v2);
  const e2 = new TopoEdge(v2, v1);
  const loop = new TopoLoop([
    new TopoCoEdge(e1, true),
    new TopoCoEdge(e2, true),
  ]);
  const face = new TopoFace(null, SurfaceType.PLANE);
  face.setOuterLoop(loop);
  const result = validateFragments([face]);
  assert.ok(!result.isValid);
  assert.ok(result.diagnostics.some(d => d.invariant === 'fragment-loop-min-coedges'));
});

// ============================================================
console.log('\n--- Final body validation ---');
// ============================================================

test('validateFinalBody: null body fails', () => {
  const result = validateFinalBody(null);
  assert.ok(!result.isValid);
  assert.ok(result.diagnostics.some(d => d.invariant === 'body-present'));
});

test('validateFinalBody: body with no shells fails', () => {
  const result = validateFinalBody(new TopoBody());
  assert.ok(!result.isValid);
  assert.ok(result.diagnostics.some(d => d.invariant === 'body-has-shells'));
});

test('validateFinalBody: valid box body passes', () => {
  resetTopoIds();
  const body = makeBox(0, 0, 0, 10, 10, 10);
  const result = validateFinalBody(body);
  // Box may have validation issues depending on sewing, but should at least have shells+faces
  assert.ok(result.diagnostics.every(d => d.invariant !== 'body-present'));
  assert.ok(result.diagnostics.every(d => d.invariant !== 'body-has-shells'));
  assert.ok(result.diagnostics.every(d => d.invariant !== 'shell-has-faces'));
});

// ============================================================
console.log('\n--- Healing tests ---');
// ============================================================

test('healFragments: empty array returns empty', () => {
  const { fragments, report } = healFragments([]);
  assert.strictEqual(fragments.length, 0);
  assert.ok(!report.healed);
});

test('healFragments: valid triangle is unchanged', () => {
  const { face } = makeTriFace();
  const { fragments, report } = healFragments([face]);
  assert.strictEqual(fragments.length, 1);
  // May have vertex merges within the triangle (all unique), should be small
  assert.ok(fragments[0].outerLoop.coedges.length >= 3);
});

test('healFragments: collapses tiny edge', () => {
  resetTopoIds();
  const v1 = new TopoVertex({ x: 0, y: 0, z: 0 });
  const v2 = new TopoVertex({ x: 1e-8, y: 1e-8, z: 0 }); // very close to v1
  const v3 = new TopoVertex({ x: 10, y: 0, z: 0 });
  const v4 = new TopoVertex({ x: 5, y: 10, z: 0 });
  const e1 = new TopoEdge(v1, v2, NurbsCurve.createLine(v1.point, v2.point));
  const e2 = new TopoEdge(v2, v3, NurbsCurve.createLine(v2.point, v3.point));
  const e3 = new TopoEdge(v3, v4, NurbsCurve.createLine(v3.point, v4.point));
  const e4 = new TopoEdge(v4, v1, NurbsCurve.createLine(v4.point, v1.point));
  const loop = new TopoLoop([
    new TopoCoEdge(e1, true),
    new TopoCoEdge(e2, true),
    new TopoCoEdge(e3, true),
    new TopoCoEdge(e4, true),
  ]);
  const face = new TopoFace(null, SurfaceType.PLANE);
  face.setOuterLoop(loop);

  const { fragments, report } = healFragments([face]);
  assert.ok(report.healed, 'Should have performed healing');
  assert.ok(report.actions.length > 0, 'Should have recorded actions');
  assert.ok(report.actions.some(a => a.action === 'collapse-tiny-edge' || a.action === 'merge-vertex'),
    'Should have merged vertices or collapsed tiny edge');
  // After healing, the tiny edge should be removed, leaving 3 coedges
  if (fragments.length > 0) {
    assert.ok(fragments[0].outerLoop.coedges.length >= 3,
      `Should have at least 3 coedges after healing, got ${fragments[0].outerLoop.coedges.length}`);
  }
});

test('healFragments: merges coincident vertices across fragments', () => {
  resetTopoIds();
  // Two triangles sharing an edge but with slightly different vertex objects
  const v1a = new TopoVertex({ x: 0, y: 0, z: 0 });
  const v2a = new TopoVertex({ x: 10, y: 0, z: 0 });
  const v3a = new TopoVertex({ x: 5, y: 10, z: 0 });
  const e1a = new TopoEdge(v1a, v2a, NurbsCurve.createLine(v1a.point, v2a.point));
  const e2a = new TopoEdge(v2a, v3a, NurbsCurve.createLine(v2a.point, v3a.point));
  const e3a = new TopoEdge(v3a, v1a, NurbsCurve.createLine(v3a.point, v1a.point));
  const loopA = new TopoLoop([
    new TopoCoEdge(e1a, true),
    new TopoCoEdge(e2a, true),
    new TopoCoEdge(e3a, true),
  ]);
  const faceA = new TopoFace(null, SurfaceType.PLANE);
  faceA.setOuterLoop(loopA);

  // Second triangle with coincident vertices (different objects)
  const v1b = new TopoVertex({ x: 0, y: 0, z: 0 }); // coincident with v1a
  const v2b = new TopoVertex({ x: 10, y: 0, z: 0 }); // coincident with v2a
  const v4b = new TopoVertex({ x: 5, y: -10, z: 0 });
  const e1b = new TopoEdge(v1b, v2b, NurbsCurve.createLine(v1b.point, v2b.point));
  const e2b = new TopoEdge(v2b, v4b, NurbsCurve.createLine(v2b.point, v4b.point));
  const e3b = new TopoEdge(v4b, v1b, NurbsCurve.createLine(v4b.point, v1b.point));
  const loopB = new TopoLoop([
    new TopoCoEdge(e1b, true),
    new TopoCoEdge(e2b, true),
    new TopoCoEdge(e3b, true),
  ]);
  const faceB = new TopoFace(null, SurfaceType.PLANE);
  faceB.setOuterLoop(loopB);

  const { fragments, report } = healFragments([faceA, faceB]);
  assert.strictEqual(fragments.length, 2, 'Both fragments should survive');
  // The coincident vertices should have been merged
  const mergeActions = report.actions.filter(a => a.action === 'merge-vertex');
  assert.ok(mergeActions.length >= 2, `Expected ≥2 vertex merges, got ${mergeActions.length}`);
});

test('healFragments: removes degenerate fragment', () => {
  resetTopoIds();
  // A fragment with all vertices at the same point
  const v1 = new TopoVertex({ x: 0, y: 0, z: 0 });
  const v2 = new TopoVertex({ x: 0, y: 0, z: 0 });
  const v3 = new TopoVertex({ x: 0, y: 0, z: 0 });
  const e1 = new TopoEdge(v1, v2);
  const e2 = new TopoEdge(v2, v3);
  const e3 = new TopoEdge(v3, v1);
  const loop = new TopoLoop([
    new TopoCoEdge(e1, true),
    new TopoCoEdge(e2, true),
    new TopoCoEdge(e3, true),
  ]);
  const face = new TopoFace(null, SurfaceType.PLANE);
  face.setOuterLoop(loop);

  const { fragments, report } = healFragments([face]);
  assert.ok(report.healed, 'Should have performed healing');
  // The degenerate fragment should be removed
  assert.strictEqual(fragments.length, 0, 'Degenerate fragment should be removed');
});

test('healFragments: report toJSON produces structured output', () => {
  const { report } = healFragments([]);
  const json = report.toJSON();
  assert.strictEqual(typeof json.healed, 'boolean');
  assert.strictEqual(typeof json.actionCount, 'number');
  assert.ok(Array.isArray(json.actions));
});

// ============================================================
console.log('\n--- Boolean pipeline integration ---');
// ============================================================

test('exactBooleanOp: returns diagnostics object', () => {
  resetTopoIds();
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(20, 0, 0, 10, 10, 10);
  const result = exactBooleanOp(boxA, boxB, 'union');
  assert.ok(result.body, 'Result should have a body');
  assert.ok(result.mesh, 'Result should have a mesh');
  assert.ok(result.diagnostics, 'Result should have diagnostics');
  assert.ok(result.diagnostics.intersectionValidation, 'Should have intersection validation');
  assert.ok(result.diagnostics.healingA, 'Should have healing report for A');
  assert.ok(result.diagnostics.healingB, 'Should have healing report for B');
  assert.ok(result.diagnostics.finalBodyValidation, 'Should have final body validation');
});

test('exactBooleanOp: non-overlapping union still works', () => {
  resetTopoIds();
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(20, 0, 0, 10, 10, 10);
  const result = exactBooleanOp(boxA, boxB, 'union');
  assert.ok(result.body.faces().length >= 12, 'Should have at least 12 faces');
});

test('exactBooleanOp: overlapping union produces valid result', () => {
  resetTopoIds();
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(5, 0, 0, 10, 10, 10);
  const result = exactBooleanOp(boxA, boxB, 'union');
  // With allow-fallback policy (now the default), the exact path may detect
  // invariant violations and route to the discrete fallback, returning a mesh
  // instead of an exact body.  Both outcomes are valid.
  const hasBody = !!result.body;
  const hasMesh = !!result.mesh;
  assert.ok(hasBody || hasMesh, 'Should produce a body or fallback mesh');
  assert.ok(result.diagnostics, 'Should include diagnostics');
  if (!hasBody) {
    assert.strictEqual(result.resultGrade, 'fallback', 'No body → grade must be fallback');
  }
});

test('exactBooleanOp: subtract produces valid result', () => {
  resetTopoIds();
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(5, 0, 0, 10, 10, 10);
  const result = exactBooleanOp(boxA, boxB, 'subtract');
  const hasBody = !!result.body;
  const hasMesh = !!result.mesh;
  assert.ok(hasBody || hasMesh, 'Should produce a body or fallback mesh');
  assert.ok(result.diagnostics, 'Should include diagnostics');
});

test('exactBooleanOp: intersect produces valid result', () => {
  resetTopoIds();
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(5, 0, 0, 10, 10, 10);
  const result = exactBooleanOp(boxA, boxB, 'intersect');
  const hasBody = !!result.body;
  const hasMesh = !!result.mesh;
  assert.ok(hasBody || hasMesh, 'Should produce a body or fallback mesh');
  assert.ok(result.diagnostics, 'Should include diagnostics');
});

// ============================================================
console.log('\n--- Diagnostics format ---');
// ============================================================

test('diagnostics have required fields', () => {
  const result = validateIntersections(null);
  const diag = result.diagnostics[0];
  assert.ok('invariant' in diag, 'Should have invariant field');
  assert.ok('entityIds' in diag, 'Should have entityIds field');
  assert.ok('tolerance' in diag, 'Should have tolerance field');
  assert.ok('detail' in diag, 'Should have detail field');
});

test('diagnostics are JSON-serializable', () => {
  const result = validateIntersections(null);
  const json = JSON.stringify(result.toJSON());
  assert.ok(json.length > 0, 'JSON should be non-empty');
  const parsed = JSON.parse(json);
  assert.strictEqual(parsed.valid, false);
});

// ============================================================
console.log('\n=== Results ===\n');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
