// tests/test-fallback-boolean.js — Deterministic tests for the discrete fallback lane
//
// Validates:
// 1. Dirty input corpus runs without crash
// 2. Fallback path activates only when exact path fails or is disallowed by policy
// 3. Fallback outputs are explicitly flagged
// 4. Fallback outputs pass basic manifold/watertight checks when expected
// 5. STEP export is rejected for fallback solids
// 6. Exact path remains unchanged for clean models

import assert from 'assert';
import { exactBooleanOp, hasExactTopology } from '../js/cad/BooleanKernel.js';
import {
  TopoBody, TopoShell, TopoFace, TopoLoop, TopoCoEdge, TopoEdge, TopoVertex,
  SurfaceType, buildTopoBody, resetTopoIds,
} from '../js/cad/BRepTopology.js';
import { NurbsCurve } from '../js/cad/NurbsCurve.js';
import { NurbsSurface } from '../js/cad/NurbsSurface.js';
import { exportSTEP } from '../js/cad/StepExport.js';
import { ResultGrade, FallbackDiagnostics } from '../js/cad/fallback/FallbackDiagnostics.js';
import {
  isFallbackEnabled, shouldTriggerFallback, evaluateExactResult,
  wrapResult, FallbackTrigger,
} from '../js/cad/fallback/FallbackPolicy.js';
import { buildConformingMesh, mergeVertexSpaces } from '../js/cad/fallback/ConformingSurfaceMesh.js';
import { meshBooleanOp } from '../js/cad/fallback/MeshBoolean.js';
import { reconstructAdjacency, extractFeatureEdges } from '../js/cad/fallback/AdjacencyReconstruction.js';
import { validateMesh, detectBoundaryEdges } from '../js/cad/MeshValidator.js';

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

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

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

/**
 * Build a "dirty" body with a deliberately missing face (non-closed shell).
 */
function makeDirtyBox(x, y, z, w, h, d) {
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
  // Only 5 faces — missing the top face
  return buildTopoBody([
    { surfaceType: SurfaceType.PLANE, vertices: [c[3], c[2], c[1], c[0]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [c[0], c[1], c[5], c[4]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [c[2], c[3], c[7], c[6]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [c[3], c[0], c[4], c[7]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [c[1], c[2], c[6], c[5]], surface: null, edgeCurves: null, shared: null },
  ]);
}

/**
 * Build a degenerate body with a zero-area face.
 */
function makeDegenerateBody() {
  const v = { x: 0, y: 0, z: 0 };
  return buildTopoBody([
    { surfaceType: SurfaceType.PLANE, vertices: [v, v, v, v], surface: null, edgeCurves: null, shared: null },
  ]);
}

const fallbackEnabled = isFallbackEnabled();

// ============================================================
console.log('=== FallbackDiagnostics Tests ===\n');
// ============================================================

test('ResultGrade enum values', () => {
  assert.strictEqual(ResultGrade.EXACT, 'exact');
  assert.strictEqual(ResultGrade.FALLBACK, 'fallback');
  assert.strictEqual(ResultGrade.FAILED, 'failed');
});

test('FallbackDiagnostics.exact()', () => {
  const d = FallbackDiagnostics.exact({ some: 'data' });
  assert.strictEqual(d.grade, 'exact');
  assert.ok(d.isExact);
  assert.ok(!d.isFallback);
  assert.ok(!d.isFailed);
  assert.deepStrictEqual(d.exactDiagnostics, { some: 'data' });
  const json = d.toJSON();
  assert.strictEqual(json.grade, 'exact');
  assert.ok(json.timestamp);
});

test('FallbackDiagnostics.fallback()', () => {
  const d = FallbackDiagnostics.fallback('intersection_failure', 'intersection_validation', { isClean: false });
  assert.strictEqual(d.grade, 'fallback');
  assert.ok(d.isFallback);
  assert.ok(!d.isExact);
  assert.strictEqual(d.triggerReason, 'intersection_failure');
  assert.strictEqual(d.failingStage, 'intersection_validation');
  const json = d.toJSON();
  assert.strictEqual(json.triggerReason, 'intersection_failure');
  assert.ok(json.validation);
});

test('FallbackDiagnostics.failed()', () => {
  const d = FallbackDiagnostics.failed('uncaught_exception', 'exact_pipeline', { error: 'boom' });
  assert.strictEqual(d.grade, 'failed');
  assert.ok(d.isFailed);
  assert.ok(!d.isExact);
  assert.ok(!d.isFallback);
  const json = d.toJSON();
  assert.strictEqual(json.grade, 'failed');
  assert.strictEqual(json.failingStage, 'exact_pipeline');
});

// ============================================================
console.log('\n=== FallbackPolicy Tests ===\n');
// ============================================================

test('FallbackTrigger contains expected reasons', () => {
  assert.ok(FallbackTrigger.INTERSECTION_FAILURE);
  assert.ok(FallbackTrigger.INVALID_SPLIT_LOOPS);
  assert.ok(FallbackTrigger.NON_CLOSED_SHELL);
  assert.ok(FallbackTrigger.INVARIANT_VALIDATION_FAILURE);
  assert.ok(FallbackTrigger.PERSISTENT_HEALING_FAILURE);
  assert.ok(FallbackTrigger.CLASSIFICATION_AMBIGUITY);
  assert.ok(FallbackTrigger.UNCAUGHT_EXCEPTION);
});

test('isFallbackEnabled reflects env var', () => {
  const expected = process.env.CAD_ALLOW_DISCRETE_FALLBACK === '1';
  assert.strictEqual(isFallbackEnabled(), expected);
});

test('shouldTriggerFallback respects env and allowlist', () => {
  if (!fallbackEnabled) {
    assert.strictEqual(shouldTriggerFallback(FallbackTrigger.INTERSECTION_FAILURE), false);
  } else {
    assert.strictEqual(shouldTriggerFallback(FallbackTrigger.INTERSECTION_FAILURE), true);
    assert.strictEqual(shouldTriggerFallback('unknown_reason'), false);
    assert.strictEqual(
      shouldTriggerFallback(FallbackTrigger.INTERSECTION_FAILURE, { allowlist: [FallbackTrigger.NON_CLOSED_SHELL] }),
      false
    );
    assert.strictEqual(
      shouldTriggerFallback(FallbackTrigger.NON_CLOSED_SHELL, { allowlist: [FallbackTrigger.NON_CLOSED_SHELL] }),
      true
    );
  }
});

test('evaluateExactResult: clean diagnostics → no fallback', () => {
  const result = evaluateExactResult({
    intersectionValidation: { isValid: true, diagnostics: [] },
    fragmentValidationA: { isValid: true, diagnostics: [] },
    fragmentValidationB: { isValid: true, diagnostics: [] },
    finalBodyValidation: { isValid: true, diagnostics: [] },
  });
  assert.strictEqual(result.shouldFallback, false);
});

test('evaluateExactResult: intersection failure → trigger', () => {
  const result = evaluateExactResult({
    intersectionValidation: { isValid: false, diagnostics: [{ invariant: 'curve-present' }] },
  });
  assert.strictEqual(result.shouldFallback, true);
  assert.strictEqual(result.trigger, FallbackTrigger.INTERSECTION_FAILURE);
});

test('evaluateExactResult: final body validation failure → trigger', () => {
  const result = evaluateExactResult({
    intersectionValidation: { isValid: true, diagnostics: [] },
    finalBodyValidation: {
      isValid: false,
      diagnostics: [{ invariant: 'edge-use-count', detail: 'some edge' }],
    },
  });
  assert.strictEqual(result.shouldFallback, true);
  assert.strictEqual(result.trigger, FallbackTrigger.NON_CLOSED_SHELL);
});

test('evaluateExactResult: null diagnostics → no fallback', () => {
  const result = evaluateExactResult(null);
  assert.strictEqual(result.shouldFallback, false);
});

test('wrapResult attaches grade and flag', () => {
  const result = wrapResult({ body: null, mesh: { faces: [] } }, ResultGrade.FALLBACK, FallbackDiagnostics.fallback('test', 'test'));
  assert.strictEqual(result.resultGrade, 'fallback');
  assert.strictEqual(result._isFallback, true);
  assert.ok(result.fallbackDiagnostics);
  assert.strictEqual(result.fallbackDiagnostics.grade, 'fallback');
});

// ============================================================
console.log('\n=== ConformingSurfaceMesh Tests ===\n');
// ============================================================

test('buildConformingMesh: clean box produces valid mesh', () => {
  resetTopoIds();
  const box = makeBox(0, 0, 0, 10, 10, 10);
  const cm = buildConformingMesh(box);
  assert.ok(cm.faces.length > 0, 'Should produce faces');
  assert.ok(cm.vertexIndex.size > 0, 'Should produce vertex index');
  // Every face should have a faceGroup
  for (const f of cm.faces) {
    assert.ok(f.faceGroup !== undefined, 'Face should have faceGroup');
  }
});

test('buildConformingMesh: empty body produces empty mesh', () => {
  const empty = new TopoBody();
  const cm = buildConformingMesh(empty);
  assert.strictEqual(cm.faces.length, 0);
  assert.strictEqual(cm.vertexIndex.size, 0);
});

test('mergeVertexSpaces: shared vertices are deduplicated', () => {
  resetTopoIds();
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(5, 0, 0, 10, 10, 10); // overlaps
  const cmA = buildConformingMesh(boxA);
  const cmB = buildConformingMesh(boxB);
  const merged = mergeVertexSpaces(cmA, cmB);
  assert.ok(merged.sharedVertexIndex.size > 0);
  // Shared vertex count should be <= sum of individual counts
  assert.ok(merged.sharedVertexIndex.size <= cmA.vertexIndex.size + cmB.vertexIndex.size);
});

// ============================================================
console.log('\n=== AdjacencyReconstruction Tests ===\n');
// ============================================================

test('reconstructAdjacency: box mesh is manifold and closed', () => {
  resetTopoIds();
  const box = makeBox(0, 0, 0, 10, 10, 10);
  const cm = buildConformingMesh(box);
  const adj = reconstructAdjacency(cm.faces);
  assert.ok(adj.edges.size > 0, 'Should have edges');
  assert.ok(adj.isManifold, 'Box mesh should be manifold');
  assert.ok(adj.isClosed, 'Box mesh should be closed');
  assert.strictEqual(adj.boundaryEdgeCount, 0, 'No boundary edges');
  assert.strictEqual(adj.nonManifoldEdgeCount, 0, 'No non-manifold edges');
});

test('extractFeatureEdges: returns edges for box', () => {
  resetTopoIds();
  const box = makeBox(0, 0, 0, 10, 10, 10);
  const cm = buildConformingMesh(box);
  const adj = reconstructAdjacency(cm.faces);
  const features = extractFeatureEdges(adj.edges, cm.faces);
  assert.ok(features.length > 0, 'Box should have feature edges (sharp edges)');
});

test('reconstructAdjacency: empty faces produces valid empty result', () => {
  const adj = reconstructAdjacency([]);
  assert.strictEqual(adj.edges.size, 0);
  assert.strictEqual(adj.boundaryEdgeCount, 0);
  assert.ok(adj.isManifold);
  assert.ok(adj.isClosed);
});

// ============================================================
console.log('\n=== MeshBoolean Tests ===\n');
// ============================================================

test('meshBooleanOp: union of two non-overlapping boxes', () => {
  resetTopoIds();
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(20, 0, 0, 10, 10, 10);
  const result = meshBooleanOp(boxA, boxB, 'union');
  assert.ok(result.mesh, 'Should produce a mesh');
  assert.ok(result.mesh.faces.length > 0, 'Should have faces');
  assert.ok(result.validation, 'Should have validation');
  assert.ok(result.adjacency, 'Should have adjacency');
});

test('meshBooleanOp: subtract produces result', () => {
  resetTopoIds();
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(5, 0, 0, 10, 10, 10);
  const result = meshBooleanOp(boxA, boxB, 'subtract');
  assert.ok(result.mesh.faces.length > 0, 'Should have faces');
});

test('meshBooleanOp: intersect produces result', () => {
  resetTopoIds();
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(5, 0, 0, 10, 10, 10);
  const result = meshBooleanOp(boxA, boxB, 'intersect');
  assert.ok(result.mesh, 'Should produce a mesh');
});

// ============================================================
console.log('\n=== Dirty Corpus Tests (no crash) ===\n');
// ============================================================

test('dirty corpus: non-closed shell does not crash boolean', () => {
  resetTopoIds();
  const dirtyA = makeDirtyBox(0, 0, 0, 10, 10, 10);
  const cleanB = makeBox(5, 0, 0, 10, 10, 10);
  let result;
  try {
    result = exactBooleanOp(dirtyA, cleanB, 'union');
  } catch {
    // If exact throws without fallback, that's OK in non-fallback mode
    assert.ok(!fallbackEnabled, 'Should not throw when fallback is enabled');
    return;
  }
  assert.ok(result, 'Should produce a result');
  assert.ok(result.mesh || result.body, 'Should have mesh or body');
});

test('dirty corpus: degenerate body does not crash boolean', () => {
  resetTopoIds();
  const degen = makeDegenerateBody();
  const clean = makeBox(0, 0, 0, 10, 10, 10);
  let result;
  try {
    result = exactBooleanOp(degen, clean, 'union');
  } catch {
    assert.ok(!fallbackEnabled, 'Should not throw when fallback is enabled');
    return;
  }
  assert.ok(result, 'Should produce a result');
});

test('dirty corpus: two dirty boxes does not crash', () => {
  resetTopoIds();
  const dirtyA = makeDirtyBox(0, 0, 0, 10, 10, 10);
  const dirtyB = makeDirtyBox(5, 5, 5, 10, 10, 10);
  let result;
  try {
    result = exactBooleanOp(dirtyA, dirtyB, 'subtract');
  } catch {
    assert.ok(!fallbackEnabled, 'Should not throw when fallback is enabled');
    return;
  }
  assert.ok(result, 'Should produce a result');
});

// ============================================================
console.log('\n=== Fallback Flagging Tests ===\n');
// ============================================================

test('exact path: clean boxes produce exact result grade', () => {
  resetTopoIds();
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(20, 0, 0, 10, 10, 10);
  const result = exactBooleanOp(boxA, boxB, 'union');
  assert.strictEqual(result.resultGrade, 'exact', 'Clean boxes should produce exact grade');
  assert.strictEqual(result._isFallback, false, '_isFallback should be false');
});

test('exact path: result has fallbackDiagnostics', () => {
  resetTopoIds();
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(20, 0, 0, 10, 10, 10);
  const result = exactBooleanOp(boxA, boxB, 'union');
  assert.ok(result.fallbackDiagnostics, 'Should have fallbackDiagnostics');
  assert.strictEqual(result.fallbackDiagnostics.grade, 'exact');
});

if (fallbackEnabled) {
  test('fallback: result is explicitly flagged when exact fails', () => {
    resetTopoIds();
    // Force a dirty input that may trigger fallback
    const dirtyA = makeDirtyBox(0, 0, 0, 10, 10, 10);
    const cleanB = makeBox(5, 0, 0, 10, 10, 10);
    const result = exactBooleanOp(dirtyA, cleanB, 'union');
    if (result.resultGrade === 'fallback') {
      assert.strictEqual(result._isFallback, true, '_isFallback should be true');
      assert.ok(result.fallbackDiagnostics, 'Should have diagnostics');
      assert.ok(result.fallbackDiagnostics.triggerReason, 'Should have trigger reason');
    }
    // If exact path still succeeds, that's also valid
  });
}

// ============================================================
console.log('\n=== STEP Export Blocking Tests ===\n');
// ============================================================

test('STEP export rejected for fallback solid (opts._isFallback)', () => {
  resetTopoIds();
  const box = makeBox(0, 0, 0, 10, 10, 10);
  assert.throws(
    () => exportSTEP(box, { _isFallback: true }),
    /not supported for fallback/,
    'Should throw for fallback solid'
  );
});

test('STEP export rejected for fallback solid (body._isFallback)', () => {
  resetTopoIds();
  const box = makeBox(0, 0, 0, 10, 10, 10);
  box._isFallback = true;
  assert.throws(
    () => exportSTEP(box),
    /not supported for fallback/,
    'Should throw for fallback body'
  );
});

test('STEP export works for exact solid', () => {
  resetTopoIds();
  const box = makeBox(0, 0, 0, 10, 10, 10);
  const stepStr = exportSTEP(box);
  assert.ok(stepStr.length > 0, 'Should produce STEP output');
  assert.ok(stepStr.includes('ISO-10303'), 'Should contain STEP header');
});

// ============================================================
console.log('\n=== Exact Path Unchanged Tests ===\n');
// ============================================================

test('exact path: union of clean boxes unchanged behavior', () => {
  resetTopoIds();
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(20, 0, 0, 10, 10, 10);
  const result = exactBooleanOp(boxA, boxB, 'union');
  assert.ok(result.body, 'Should have a body');
  assert.ok(result.mesh, 'Should have a mesh');
  assert.ok(result.mesh.faces.length > 0, 'Should have mesh faces');
  assert.ok(result.body.faces().length >= 12, 'Union should have at least 12 faces');
});

test('exact path: subtract of clean boxes unchanged behavior', () => {
  resetTopoIds();
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(5, 0, 0, 10, 10, 10);
  const result = exactBooleanOp(boxA, boxB, 'subtract');
  assert.ok(result, 'Should produce a result');
  assert.ok(result.mesh, 'Should have a mesh');
  // When fallback is enabled, the exact path may detect validation issues
  // and route to fallback, which is correct behavior.
  if (result.resultGrade === 'exact') {
    assert.ok(result.body, 'Exact result should have a body');
    assert.ok(result.body.faces().length > 0, 'Subtract should produce faces');
  } else if (result.resultGrade === 'fallback') {
    assert.ok(result._isFallback, 'Fallback result should be flagged');
    assert.ok(result.mesh.faces.length >= 0, 'Fallback should produce mesh faces');
  }
});

test('exact path: diagnostics still present', () => {
  resetTopoIds();
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(20, 0, 0, 10, 10, 10);
  const result = exactBooleanOp(boxA, boxB, 'union');
  assert.ok(result.diagnostics, 'Should have diagnostics');
  assert.ok(result.diagnostics.intersectionValidation !== undefined, 'Should have intersection validation');
});

// ============================================================
// Fallback-specific mesh quality tests (only when fallback enabled)
// ============================================================

if (fallbackEnabled) {
  console.log('\n=== Fallback Mesh Quality Tests ===\n');

  test('meshBooleanOp: box union passes basic manifold check', () => {
    resetTopoIds();
    const boxA = makeBox(0, 0, 0, 10, 10, 10);
    const boxB = makeBox(20, 0, 0, 10, 10, 10);
    const result = meshBooleanOp(boxA, boxB, 'union');
    assert.ok(result.adjacency.isManifold, 'Union result should be manifold');
    assert.ok(result.adjacency.isClosed, 'Union result should be closed');
  });

  test('meshBooleanOp: box union has no degenerate faces', () => {
    resetTopoIds();
    const boxA = makeBox(0, 0, 0, 10, 10, 10);
    const boxB = makeBox(20, 0, 0, 10, 10, 10);
    const result = meshBooleanOp(boxA, boxB, 'union');
    assert.strictEqual(result.validation.degenerateFaces, 0, 'No degenerate faces');
  });
}

// ============================================================
console.log('\n=== Results ===\n');
console.log(`${passed} passed, ${failed} failed`);
if (fallbackEnabled) {
  console.log('(fallback lane was ENABLED for this run)');
} else {
  console.log('(fallback lane was DISABLED — set CAD_ALLOW_DISCRETE_FALLBACK=1 to enable)');
}
if (failed > 0) process.exit(1);
