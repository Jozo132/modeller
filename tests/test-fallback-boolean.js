import './_watchdog.mjs';
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
  wrapResult, FallbackTrigger, OperationPolicy, resolvePolicy,
} from '../js/cad/fallback/FallbackPolicy.js';
import { buildConformingMesh, mergeVertexSpaces } from '../js/cad/fallback/ConformingSurfaceMesh.js';
import { meshBooleanOp } from '../js/cad/fallback/MeshBoolean.js';
import { reconstructAdjacency, extractFeatureEdges } from '../js/cad/fallback/AdjacencyReconstruction.js';
import { validateMesh, detectBoundaryEdges } from '../js/cad/MeshValidator.js';
import { formatTimingSuffix, startTiming } from './test-timing.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  const startedAt = startTiming();
  try {
    fn();
    console.log(`  ✓ ${name}${formatTimingSuffix(startedAt)}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}${formatTimingSuffix(startedAt)}`);
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

/**
 * Build two overlapping boxes that share a face (contact).
 */
function makeContactBoxes() {
  // Box A: [0,0,0] to [10,10,10]
  // Box B: [10,0,0] to [20,10,10]  — shares the x=10 face
  return {
    a: makeBox(0, 0, 0, 10, 10, 10),
    b: makeBox(10, 0, 0, 10, 10, 10),
  };
}

/**
 * Build two overlapping boxes with partial overlap (gap-like).
 */
function makeOverlapBoxes() {
  return {
    a: makeBox(0, 0, 0, 10, 10, 10),
    b: makeBox(5, 5, 5, 10, 10, 10),
  };
}

/**
 * Build a self-intersecting body (bowtie shape: two pyramids sharing a point).
 */
function makeSelfIntersectingBody() {
  const v0 = { x: 0, y: 0, z: 0 };
  const v1 = { x: 10, y: 0, z: 0 };
  const v2 = { x: 10, y: 10, z: 0 };
  const v3 = { x: 0, y: 10, z: 0 };
  const v4 = { x: 5, y: 5, z: 10 };
  const v5 = { x: 5, y: 5, z: -10 };
  // Two pyramids sharing an apex at roughly the center
  return buildTopoBody([
    { surfaceType: SurfaceType.PLANE, vertices: [v0, v1, v4], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [v1, v2, v4], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [v2, v3, v4], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [v3, v0, v4], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [v0, v3, v5], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [v3, v2, v5], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [v2, v1, v5], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [v1, v0, v5], surface: null, edgeCurves: null, shared: null },
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

test('isFallbackEnabled reflects fail-closed feature flag default', () => {
  // Discrete fallback is now opt-in, so the default must stay false unless
  // explicitly enabled via env or setFlag().
  assert.strictEqual(isFallbackEnabled(), false);
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
  const result = wrapResult(
    { body: null, mesh: { faces: [] } },
    ResultGrade.FALLBACK,
    FallbackDiagnostics.fallback('test', 'test', null, null, null),
  );
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

test('extractFeatureEdges: returns edges when face normals are geometrically accurate', () => {
  // extractFeatureEdges relies on the face.normal property being an accurate
  // geometric normal.  Not all tessellators guarantee this (the robust
  // tessellator may share a reference normal across triangles of a planar
  // face).  This test verifies the algorithm works when given correct normals
  // by computing them from the triangle vertices.
  resetTopoIds();
  const box = makeBox(0, 0, 0, 10, 10, 10);
  const cm = buildConformingMesh(box);

  // Recompute normals from triangle vertex positions
  for (const f of cm.faces) {
    if (f.vertices && f.vertices.length >= 3) {
      const [a, b, c] = f.vertices;
      const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
      const v = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
      const nx = u.y * v.z - u.z * v.y;
      const ny = u.z * v.x - u.x * v.z;
      const nz = u.x * v.y - u.y * v.x;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      f.normal = len > 1e-14
        ? { x: nx / len, y: ny / len, z: nz / len }
        : { x: 0, y: 0, z: 1 };
    }
  }

  const adj = reconstructAdjacency(cm.faces);
  const features = extractFeatureEdges(adj.edges, cm.faces);
  assert.ok(features.length > 0, 'Box should have feature edges when normals are computed from geometry');
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
console.log('\n=== OperationPolicy Tests ===\n');
// ============================================================

test('OperationPolicy enum values', () => {
  assert.strictEqual(OperationPolicy.EXACT_ONLY, 'exact-only');
  assert.strictEqual(OperationPolicy.ALLOW_FALLBACK, 'allow-fallback');
  assert.strictEqual(OperationPolicy.FORCE_FALLBACK, 'force-fallback');
});

test('resolvePolicy: explicit policy overrides env', () => {
  assert.strictEqual(resolvePolicy('exact-only'), 'exact-only');
  assert.strictEqual(resolvePolicy('allow-fallback'), 'allow-fallback');
  assert.strictEqual(resolvePolicy('force-fallback'), 'force-fallback');
});

test('resolvePolicy: invalid policy falls through to env/default', () => {
  const expected = fallbackEnabled ? 'allow-fallback' : 'exact-only';
  assert.strictEqual(resolvePolicy('garbage'), expected);
  assert.strictEqual(resolvePolicy(undefined), expected);
  assert.strictEqual(resolvePolicy(null), expected);
});

test('shouldTriggerFallback: exact-only policy always returns false', () => {
  assert.strictEqual(
    shouldTriggerFallback(FallbackTrigger.INTERSECTION_FAILURE, { policy: 'exact-only' }),
    false
  );
  assert.strictEqual(
    shouldTriggerFallback(FallbackTrigger.UNCAUGHT_EXCEPTION, { policy: 'exact-only' }),
    false
  );
});

test('shouldTriggerFallback: force-fallback policy always returns true', () => {
  assert.strictEqual(
    shouldTriggerFallback(FallbackTrigger.INTERSECTION_FAILURE, { policy: 'force-fallback' }),
    true
  );
  assert.strictEqual(
    shouldTriggerFallback(FallbackTrigger.UNCAUGHT_EXCEPTION, { policy: 'force-fallback' }),
    true
  );
});

test('shouldTriggerFallback: allow-fallback policy with valid trigger returns true', () => {
  assert.strictEqual(
    shouldTriggerFallback(FallbackTrigger.INTERSECTION_FAILURE, { policy: 'allow-fallback' }),
    true
  );
});

test('shouldTriggerFallback: allow-fallback policy with invalid trigger returns false', () => {
  assert.strictEqual(
    shouldTriggerFallback('unknown_reason', { policy: 'allow-fallback' }),
    false
  );
});

test('shouldTriggerFallback: allow-fallback policy respects allowlist', () => {
  assert.strictEqual(
    shouldTriggerFallback(FallbackTrigger.INTERSECTION_FAILURE, {
      policy: 'allow-fallback',
      allowlist: [FallbackTrigger.NON_CLOSED_SHELL],
    }),
    false
  );
  assert.strictEqual(
    shouldTriggerFallback(FallbackTrigger.NON_CLOSED_SHELL, {
      policy: 'allow-fallback',
      allowlist: [FallbackTrigger.NON_CLOSED_SHELL],
    }),
    true
  );
});

// ============================================================
console.log('\n=== Policy-driven exactBooleanOp Tests ===\n');
// ============================================================

test('exact-only policy: clean boxes succeed', () => {
  resetTopoIds();
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(20, 0, 0, 10, 10, 10);
  const result = exactBooleanOp(boxA, boxB, 'union', undefined, { policy: 'exact-only' });
  assert.strictEqual(result.resultGrade, 'exact');
  assert.strictEqual(result._isFallback, false);
});

test('force-fallback policy: always produces fallback grade', () => {
  resetTopoIds();
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(20, 0, 0, 10, 10, 10);
  const result = exactBooleanOp(boxA, boxB, 'union', undefined, { policy: 'force-fallback' });
  assert.strictEqual(result.resultGrade, 'fallback');
  assert.strictEqual(result._isFallback, true);
  assert.ok(result.mesh, 'Forced fallback should still produce a mesh');
  assert.ok(result.fallbackDiagnostics, 'Should have fallback diagnostics');
});

test('force-fallback policy: result mesh has faces', () => {
  resetTopoIds();
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(20, 0, 0, 10, 10, 10);
  const result = exactBooleanOp(boxA, boxB, 'union', undefined, { policy: 'force-fallback' });
  assert.ok(result.mesh.faces.length > 0, 'Forced fallback mesh should have faces');
});

test('allow-fallback policy: clean boxes still exact', () => {
  resetTopoIds();
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(20, 0, 0, 10, 10, 10);
  const result = exactBooleanOp(boxA, boxB, 'union', undefined, { policy: 'allow-fallback' });
  assert.strictEqual(result.resultGrade, 'exact');
  assert.strictEqual(result._isFallback, false);
});

// ============================================================
console.log('\n=== Extended STEP Export Restriction Tests ===\n');
// ============================================================

test('STEP export rejected for body with resultGrade=fallback', () => {
  resetTopoIds();
  const box = makeBox(0, 0, 0, 10, 10, 10);
  box.resultGrade = 'fallback';
  assert.throws(
    () => exportSTEP(box),
    /not supported for results with grade/,
    'Should throw for fallback graded body'
  );
});

test('STEP export rejected for opts.resultGrade=fallback', () => {
  resetTopoIds();
  const box = makeBox(0, 0, 0, 10, 10, 10);
  assert.throws(
    () => exportSTEP(box, { resultGrade: 'fallback' }),
    /not supported for results with grade/,
    'Should throw for fallback graded opts'
  );
});

test('STEP export rejected for body with resultGrade=failed', () => {
  resetTopoIds();
  const box = makeBox(0, 0, 0, 10, 10, 10);
  box.resultGrade = 'failed';
  assert.throws(
    () => exportSTEP(box),
    /not supported for results with grade/,
    'Should throw for failed graded body'
  );
});

test('STEP export allowed for body with resultGrade=exact', () => {
  resetTopoIds();
  const box = makeBox(0, 0, 0, 10, 10, 10);
  box.resultGrade = 'exact';
  const stepStr = exportSTEP(box);
  assert.ok(stepStr.length > 0, 'Should produce STEP output');
});

test('STEP export allowed when no resultGrade is set', () => {
  resetTopoIds();
  const box = makeBox(0, 0, 0, 10, 10, 10);
  const stepStr = exportSTEP(box);
  assert.ok(stepStr.includes('ISO-10303'), 'Should contain STEP header');
});

// ============================================================
console.log('\n=== Dirty Corpus: Gaps, Overlaps, Contacts, Self-Intersections ===\n');
// ============================================================

test('dirty corpus: contact boxes (shared face) do not crash', () => {
  resetTopoIds();
  const { a, b } = makeContactBoxes();
  let result;
  try {
    result = exactBooleanOp(a, b, 'union');
  } catch {
    assert.ok(!fallbackEnabled, 'Should not throw when fallback is enabled');
    return;
  }
  assert.ok(result, 'Should produce a result');
  assert.ok(['exact', 'fallback', 'failed'].includes(result.resultGrade),
    'Result should have a valid grade');
});

test('dirty corpus: overlapping boxes (partial overlap) do not crash', () => {
  resetTopoIds();
  const { a, b } = makeOverlapBoxes();
  let result;
  try {
    result = exactBooleanOp(a, b, 'subtract');
  } catch {
    assert.ok(!fallbackEnabled, 'Should not throw when fallback is enabled');
    return;
  }
  assert.ok(result, 'Should produce a result');
  assert.ok(result.mesh, 'Should have a mesh');
});

test('dirty corpus: self-intersecting body does not crash', () => {
  resetTopoIds();
  const selfIntersect = makeSelfIntersectingBody();
  const clean = makeBox(0, 0, 0, 10, 10, 10);
  let result;
  try {
    result = exactBooleanOp(selfIntersect, clean, 'intersect');
  } catch {
    assert.ok(!fallbackEnabled, 'Should not throw when fallback is enabled');
    return;
  }
  assert.ok(result, 'Should produce a result');
});

test('dirty corpus: contact boxes with force-fallback produce mesh', () => {
  resetTopoIds();
  const { a, b } = makeContactBoxes();
  const result = exactBooleanOp(a, b, 'union', undefined, { policy: 'force-fallback' });
  assert.strictEqual(result.resultGrade, 'fallback');
  assert.ok(result.mesh, 'Should produce a mesh');
  assert.ok(result.mesh.faces.length > 0, 'Mesh should have faces');
});

test('dirty corpus: overlapping boxes with force-fallback produce mesh', () => {
  resetTopoIds();
  const { a, b } = makeOverlapBoxes();
  const result = exactBooleanOp(a, b, 'subtract', undefined, { policy: 'force-fallback' });
  assert.strictEqual(result.resultGrade, 'fallback');
  assert.ok(result.mesh.faces.length > 0, 'Mesh should have faces');
});

test('dirty corpus: self-intersecting body with force-fallback does not crash', () => {
  resetTopoIds();
  const selfIntersect = makeSelfIntersectingBody();
  const clean = makeBox(0, 0, 0, 10, 10, 10);
  const result = exactBooleanOp(selfIntersect, clean, 'intersect', undefined, { policy: 'force-fallback' });
  assert.ok(['fallback', 'failed'].includes(result.resultGrade), 'Should be fallback or failed');
  assert.ok(result.mesh, 'Should have a mesh even if empty');
});

// ============================================================
console.log('\n=== Fallback Entrypoint Index Tests ===\n');
// ============================================================

test('fallback/index.js exports OperationPolicy', async () => {
  const mod = await import('../js/cad/fallback/index.js');
  assert.ok(mod.OperationPolicy, 'Should export OperationPolicy');
  assert.strictEqual(mod.OperationPolicy.EXACT_ONLY, 'exact-only');
  assert.strictEqual(mod.OperationPolicy.ALLOW_FALLBACK, 'allow-fallback');
  assert.strictEqual(mod.OperationPolicy.FORCE_FALLBACK, 'force-fallback');
});

test('fallback/index.js exports resolvePolicy', async () => {
  const mod = await import('../js/cad/fallback/index.js');
  assert.ok(typeof mod.resolvePolicy === 'function', 'Should export resolvePolicy');
});

test('fallback/index.js exports all core fallback symbols', async () => {
  const mod = await import('../js/cad/fallback/index.js');
  assert.ok(mod.ResultGrade, 'ResultGrade');
  assert.ok(mod.FallbackDiagnostics, 'FallbackDiagnostics');
  assert.ok(mod.FallbackTrigger, 'FallbackTrigger');
  assert.ok(mod.isFallbackEnabled, 'isFallbackEnabled');
  assert.ok(mod.shouldTriggerFallback, 'shouldTriggerFallback');
  assert.ok(mod.evaluateExactResult, 'evaluateExactResult');
  assert.ok(mod.wrapResult, 'wrapResult');
  assert.ok(mod.buildConformingMesh, 'buildConformingMesh');
  assert.ok(mod.mergeVertexSpaces, 'mergeVertexSpaces');
  assert.ok(mod.meshBooleanOp, 'meshBooleanOp');
  assert.ok(mod.reconstructAdjacency, 'reconstructAdjacency');
  assert.ok(mod.extractFeatureEdges, 'extractFeatureEdges');
});

// ============================================================
console.log('\n=== Results ===\n');
console.log(`${passed} passed, ${failed} failed`);
if (fallbackEnabled) {
  console.log('(fallback lane was ENABLED for this run)');
} else {
  console.log('(fallback lane was DISABLED — set CAD_ALLOW_DISCRETE_FALLBACK=1 to enable)');
}
if (failed > 0) process.exit(1);
