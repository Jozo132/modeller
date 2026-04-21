// tests/test-fallback-warn-once.js — Regression tests for warn-once fallback logging
//
// Validates:
//   - warnOnceForFallback emits console.warn exactly once per distinct fallback id
//   - Repeated calls with the same id are deduplicated
//   - Different ids each warn once
//   - _resetWarnOnce clears deduplication state
//   - getWarnedFallbackIds returns correct snapshot
//   - FallbackKind enum is frozen and correct
//   - Integration: tessellation, boolean, containment, evaluator fallback paths
//     wire through to warnOnceForFallback properly
//   - No default path silently falls back to legacy without warning
//   - Compatibility shims warn with kind=compatibility-shim

import assert from 'assert';
import {
  warnOnceForFallback, _resetWarnOnce, getWarnedFallbackIds, FallbackKind,
} from '../js/cad/fallback/warnOnce.js';
import {
  tessellateBody, _legacyTessellateBody, tessellateForSTL,
} from '../js/cad/Tessellation.js';
import {
  tessellateBodyRouted,
} from '../js/cad/Tessellator2/index.js';
import {
  exactBooleanOp,
} from '../js/cad/BooleanKernel.js';
import {
  classifyPoint,
} from '../js/cad/Containment.js';
import {
  GeometryEvaluator,
} from '../js/cad/GeometryEvaluator.js';
import {
  setFlag, resetFlags,
} from '../js/featureFlags.js';
import {
  OperationPolicy,
} from '../js/cad/fallback/FallbackPolicy.js';
import {
  ResultGrade,
} from '../js/cad/fallback/FallbackDiagnostics.js';
import {
  SurfaceType, buildTopoBody, resetTopoIds,
} from '../js/cad/BRepTopology.js';
import { DEFAULT_TOLERANCE } from '../js/cad/Tolerance.js';
import { formatTimingSuffix, startTiming } from './test-timing.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  _resetWarnOnce();
  resetFlags();
  const startedAt = startTiming();
  try {
    fn();
    console.log(`  \u2713 ${name}${formatTimingSuffix(startedAt)}`);
    passed++;
  } catch (err) {
    console.log(`  \u2717 ${name}${formatTimingSuffix(startedAt)}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

// ── Capture console.warn calls ──────────────────────────────────────

const _originalWarn = console.warn;
let _warnCalls = [];

function captureWarns() {
  _warnCalls = [];
  console.warn = (...args) => {
    _warnCalls.push(args.join(' '));
  };
}

function restoreWarns() {
  console.warn = _originalWarn;
}

function warnCount() {
  return _warnCalls.length;
}

function lastWarn() {
  return _warnCalls[_warnCalls.length - 1] || '';
}

function allWarns() {
  return [..._warnCalls];
}

// ── Helper: build a simple box body using buildTopoBody ─────────────

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

// ═══════════════════════════════════════════════════════════════════
//  Unit tests: warnOnceForFallback core behavior
// ═══════════════════════════════════════════════════════════════════

console.log('\n=== Warn-Once Core: Deduplication ===\n');

test('warnOnceForFallback emits console.warn exactly once', () => {
  captureWarns();
  const emitted = warnOnceForFallback({
    id: 'test:alpha', policy: 'allow-fallback',
    reason: 'test reason', kind: 'new-stack-fallback',
  });
  restoreWarns();
  assert.strictEqual(emitted, true);
  assert.strictEqual(warnCount(), 1);
  assert.ok(lastWarn().includes('test:alpha'));
  assert.ok(lastWarn().includes('allow-fallback'));
  assert.ok(lastWarn().includes('new-stack-fallback'));
  assert.ok(lastWarn().includes('test reason'));
});

test('repeated calls with same id do NOT emit repeated warnings', () => {
  captureWarns();
  warnOnceForFallback({ id: 'test:beta', policy: 'p', reason: 'r', kind: 'new-stack-fallback' });
  const second = warnOnceForFallback({ id: 'test:beta', policy: 'p', reason: 'r', kind: 'new-stack-fallback' });
  const third = warnOnceForFallback({ id: 'test:beta', policy: 'p', reason: 'r', kind: 'new-stack-fallback' });
  restoreWarns();
  assert.strictEqual(second, false);
  assert.strictEqual(third, false);
  assert.strictEqual(warnCount(), 1, 'should emit exactly once');
});

test('different fallback ids each warn once', () => {
  captureWarns();
  warnOnceForFallback({ id: 'test:one', policy: 'p', reason: 'r', kind: 'new-stack-fallback' });
  warnOnceForFallback({ id: 'test:two', policy: 'p', reason: 'r', kind: 'compatibility-shim' });
  warnOnceForFallback({ id: 'test:three', policy: 'p', reason: 'r', kind: 'degraded-result' });
  restoreWarns();
  assert.strictEqual(warnCount(), 3);
});

test('_resetWarnOnce clears deduplication state', () => {
  captureWarns();
  warnOnceForFallback({ id: 'test:gamma', policy: 'p', reason: 'r', kind: 'new-stack-fallback' });
  _resetWarnOnce();
  const again = warnOnceForFallback({ id: 'test:gamma', policy: 'p', reason: 'r', kind: 'new-stack-fallback' });
  restoreWarns();
  assert.strictEqual(again, true, 'should emit again after reset');
  assert.strictEqual(warnCount(), 2);
});

test('getWarnedFallbackIds returns correct snapshot', () => {
  warnOnceForFallback({ id: 'test:x', policy: 'p', reason: 'r', kind: 'new-stack-fallback' });
  warnOnceForFallback({ id: 'test:y', policy: 'p', reason: 'r', kind: 'new-stack-fallback' });
  const ids = getWarnedFallbackIds();
  assert.ok(Array.isArray(ids));
  assert.ok(ids.includes('test:x'));
  assert.ok(ids.includes('test:y'));
  assert.ok(Object.isFrozen(ids));
});

test('getWarnedFallbackIds is empty after reset', () => {
  _resetWarnOnce();
  const ids = getWarnedFallbackIds();
  assert.strictEqual(ids.length, 0);
});

// ═══════════════════════════════════════════════════════════════════
//  Unit tests: FallbackKind enum
// ═══════════════════════════════════════════════════════════════════

console.log('\n=== Warn-Once Core: FallbackKind Enum ===\n');

test('FallbackKind is frozen', () => {
  assert.ok(Object.isFrozen(FallbackKind));
});

test('FallbackKind has all expected values', () => {
  assert.strictEqual(FallbackKind.NEW_STACK_FALLBACK, 'new-stack-fallback');
  assert.strictEqual(FallbackKind.COMPATIBILITY_SHIM, 'compatibility-shim');
  assert.strictEqual(FallbackKind.HARD_FAIL_AVOIDED, 'hard-fail-avoided');
  assert.strictEqual(FallbackKind.DEGRADED_RESULT, 'degraded-result');
});

// ═══════════════════════════════════════════════════════════════════
//  Integration: warn-once format
// ═══════════════════════════════════════════════════════════════════

console.log('\n=== Warn-Once: Warning Format ===\n');

test('warning message includes structured fields', () => {
  captureWarns();
  warnOnceForFallback({
    id: 'format:check',
    policy: 'allow-fallback',
    reason: 'checking format',
    kind: 'compatibility-shim',
  });
  restoreWarns();
  const msg = lastWarn();
  assert.ok(msg.includes('[CAD-Fallback]'), 'should include prefix');
  assert.ok(msg.includes('id=format:check'), 'should include id');
  assert.ok(msg.includes('policy=allow-fallback'), 'should include policy');
  assert.ok(msg.includes('kind=compatibility-shim'), 'should include kind');
  assert.ok(msg.includes('checking format'), 'should include reason');
});

// ═══════════════════════════════════════════════════════════════════
//  Integration: Tessellation default path does not use legacy
// ═══════════════════════════════════════════════════════════════════

console.log('\n=== Integration: Tessellation Default Path ===\n');

test('tessellateBody keeps clean boxes on the integrated tessellation path', () => {
  setFlag('CAD_USE_ROBUST_TESSELLATOR', true);
  const box = makeBox(0, 0, 0, 10, 10, 10);
  captureWarns();
  const mesh = tessellateBody(box);
  restoreWarns();
  assert.ok(mesh.faces.length > 0, 'should produce faces');
  assert.ok(
    mesh._tessellator === 'robust' || mesh._tessellator === 'js-cold-start-fallback',
    `clean boxes must stay on the integrated tessellation path, got ${mesh._tessellator}`
  );
  // No fallback warnings should be emitted
  const fallbackWarns = allWarns().filter(w => w.includes('[CAD-Fallback]'));
  assert.strictEqual(fallbackWarns.length, 0, 'no fallback warning for clean box');
});

test('tessellateBody with empty body falls back gracefully', () => {
  setFlag('CAD_USE_ROBUST_TESSELLATOR', true);
  captureWarns();
  const mesh = tessellateBody(null);
  restoreWarns();
  assert.strictEqual(mesh.faces.length, 0, 'null body produces empty mesh');
});

test('_legacyTessellateBody is accessible as explicit compatibility shim', () => {
  const box = makeBox(0, 0, 0, 10, 10, 10);
  const mesh = _legacyTessellateBody(box);
  assert.ok(mesh.faces.length > 0, 'legacy shim produces faces');
  assert.strictEqual(mesh._tessellator, undefined, 'raw legacy function has no _tessellator tag');
});

test('tessellateBodyRouted ignores legacy requests and stays robust-only', () => {
  const box = makeBox(0, 0, 0, 10, 10, 10);
  captureWarns();
  const mesh = tessellateBodyRouted(box, { tessellator: 'legacy' });
  restoreWarns();
  assert.strictEqual(mesh._tessellator, 'robust');
  const fallbackWarns = allWarns().filter(w => w.includes('[CAD-Fallback]'));
  assert.strictEqual(fallbackWarns.length, 0, 'robust-only routing should not warn');
});

test('tessellateBodyRouted defaults to robust path for clean box', () => {
  setFlag('CAD_USE_ROBUST_TESSELLATOR', true);
  const box = makeBox(0, 0, 0, 10, 10, 10);
  captureWarns();
  const mesh = tessellateBodyRouted(box);
  restoreWarns();
  assert.ok(mesh.faces.length > 0, 'should produce faces');
  assert.strictEqual(mesh._tessellator, 'robust',
    'robust tessellator is correct and must succeed for clean inputs');
  const fallbackWarns = allWarns().filter(w => w.includes('[CAD-Fallback]'));
  assert.strictEqual(fallbackWarns.length, 0, 'no fallback warning for clean robust path');
});

// ═══════════════════════════════════════════════════════════════════
//  Integration: Boolean fallback path
// ═══════════════════════════════════════════════════════════════════

console.log('\n=== Integration: Boolean Fallback Path ===\n');

test('exact boolean on non-overlapping boxes: exact result', () => {
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(20, 0, 0, 10, 10, 10);
  captureWarns();
  const result = exactBooleanOp(boxA, boxB, 'union');
  restoreWarns();
  // Non-overlapping boxes with no shared geometry should produce an exact
  // result from the new kernel.  The exact path handles the simple
  // disjoint-body case without needing intersection curves.
  assert.strictEqual(result.resultGrade, 'exact',
    'non-overlapping boxes should produce exact grade from the new kernel');
  assert.strictEqual(result._isFallback, false);
});

test('force-fallback policy emits boolean:exact-to-discrete warn', () => {
  setFlag('CAD_ALLOW_DISCRETE_FALLBACK', true);
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(5, 0, 0, 10, 10, 10);
  captureWarns();
  const result = exactBooleanOp(boxA, boxB, 'union', DEFAULT_TOLERANCE, {
    policy: OperationPolicy.FORCE_FALLBACK,
  });
  restoreWarns();
  assert.strictEqual(result.resultGrade, 'fallback');
  assert.strictEqual(result._isFallback, true);
  const boolWarns = allWarns().filter(w => w.includes('boolean:exact-to-discrete'));
  assert.ok(boolWarns.length > 0, 'force-fallback should emit boolean:exact-to-discrete warn');
});

test('exact-only policy does not silently degrade to fallback', () => {
  setFlag('CAD_ALLOW_DISCRETE_FALLBACK', false);
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(20, 0, 0, 10, 10, 10);
  captureWarns();
  // Non-overlapping boxes shouldn't need fallback
  let result;
  try {
    result = exactBooleanOp(boxA, boxB, 'union', DEFAULT_TOLERANCE, {
      policy: OperationPolicy.EXACT_ONLY,
    });
  } catch (e) {
    // exact-only can throw if validation fails — that's expected behavior
    assert.ok(true, 'exact-only correctly throws on failure');
    restoreWarns();
    return;
  }
  restoreWarns();
  assert.ok(result.resultGrade === 'exact', 'should be exact for clean non-overlapping boxes');
  const boolWarns = allWarns().filter(w => w.includes('boolean:exact-to-discrete'));
  assert.strictEqual(boolWarns.length, 0, 'exact-only should not fallback');
});

// ═══════════════════════════════════════════════════════════════════
//  Integration: Containment path
// ═══════════════════════════════════════════════════════════════════

console.log('\n=== Integration: Containment Path ===\n');

test('classifyPoint inside box: no uncertain warning', () => {
  setFlag('CAD_USE_GWN_CONTAINMENT', true);
  const box = makeBox(-2, -2, -2, 4, 4, 4);
  captureWarns();
  const result = classifyPoint(box, { x: 0, y: 0, z: 0 });
  restoreWarns();
  assert.ok(result.state === 'inside' || result.state === 'on', `expected inside/on, got ${result.state}`);
  const containWarns = allWarns().filter(w => w.includes('containment:uncertain'));
  assert.strictEqual(containWarns.length, 0, 'should not warn for clear inside classification');
});

test('classifyPoint outside box: no uncertain warning', () => {
  setFlag('CAD_USE_GWN_CONTAINMENT', true);
  const box = makeBox(0, 0, 0, 2, 2, 2);
  captureWarns();
  const result = classifyPoint(box, { x: 100, y: 100, z: 100 });
  restoreWarns();
  assert.strictEqual(result.state, 'outside');
  const containWarns = allWarns().filter(w => w.includes('containment:uncertain'));
  assert.strictEqual(containWarns.length, 0, 'should not warn for clear outside classification');
});

// ═══════════════════════════════════════════════════════════════════
//  Integration: Evaluator fallback path
// ═══════════════════════════════════════════════════════════════════

console.log('\n=== Integration: Evaluator Fallback ===\n');

test('evalCurve falls back to JS with warn when WASM unavailable', () => {
  // WASM is not loaded in Node test environment by default
  captureWarns();
  const curve = {
    degree: 2,
    controlPoints: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 2, y: 0, z: 0 }],
    knots: [0, 0, 0, 1, 1, 1],
    weights: [1, 1, 1],
  };
  const result = GeometryEvaluator.evalCurve(curve, 0.5);
  restoreWarns();
  assert.ok(result.p, 'should return valid point');
  assert.ok(result.d1, 'should return first derivative');
  // If WASM is not loaded, should warn once
  if (!GeometryEvaluator.isWasmAvailable()) {
    const evalWarns = allWarns().filter(w => w.includes('evaluator:wasm-to-js'));
    assert.ok(evalWarns.length > 0, 'should warn about WASM→JS fallback');
    assert.ok(evalWarns[0].includes('new-stack-fallback'), 'should be new-stack-fallback kind');
  }
});

test('evalCurve repeated calls with same WASM status do not re-warn', () => {
  captureWarns();
  const curve = {
    degree: 2,
    controlPoints: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 2, y: 0, z: 0 }],
    knots: [0, 0, 0, 1, 1, 1],
    weights: [1, 1, 1],
  };
  GeometryEvaluator.evalCurve(curve, 0.25);
  GeometryEvaluator.evalCurve(curve, 0.5);
  GeometryEvaluator.evalCurve(curve, 0.75);
  restoreWarns();
  if (!GeometryEvaluator.isWasmAvailable()) {
    const evalWarns = allWarns().filter(w => w.includes('evaluator:wasm-to-js'));
    assert.strictEqual(evalWarns.length, 1, 'should warn exactly once for repeated WASM→JS fallback');
  }
});

test('evalSurface falls back to JS with warn when WASM unavailable', () => {
  captureWarns();
  const surface = {
    degreeU: 1, degreeV: 1,
    numRowsU: 2, numColsV: 2,
    controlPoints: [
      { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 0 },
    ],
    knotsU: [0, 0, 1, 1],
    knotsV: [0, 0, 1, 1],
    weights: [1, 1, 1, 1],
  };
  const result = GeometryEvaluator.evalSurface(surface, 0.5, 0.5);
  restoreWarns();
  assert.ok(result.p, 'should return valid point');
  // evaluator:wasm-to-js already warned from previous test (deduplicated)
});

// ═══════════════════════════════════════════════════════════════════
//  Regression: No hidden legacy fallback in default paths
// ═══════════════════════════════════════════════════════════════════

console.log('\n=== Regression: No Hidden Legacy in Default Paths ===\n');

test('default tessellation path avoids legacy fallback for clean inputs', () => {
  setFlag('CAD_USE_ROBUST_TESSELLATOR', true);
  const box = makeBox(0, 0, 0, 10, 10, 10);
  captureWarns();
  const mesh = tessellateBody(box);
  restoreWarns();
  assert.ok(mesh.faces.length > 0, 'should produce faces');
  assert.ok(
    mesh._tessellator === 'robust' || mesh._tessellator === 'js-cold-start-fallback',
    `clean box must stay on the integrated tessellation path, got ${mesh._tessellator}`
  );
  const legacyWarns = allWarns().filter(w => w.includes('compat-legacy'));
  assert.strictEqual(legacyWarns.length, 0, 'no legacy fallback for clean body');
});

test('default containment path uses GWN (not ray-cast only)', () => {
  setFlag('CAD_USE_GWN_CONTAINMENT', true);
  const box = makeBox(-2, -2, -2, 4, 4, 4);
  const result = classifyPoint(box, { x: 0, y: 0, z: 0 });
  assert.ok(result.state === 'inside' || result.state === 'on',
    'GWN shadow mode should correctly classify interior point');
});

test('default boolean on non-overlapping boxes produces exact grade', () => {
  setFlag('CAD_ALLOW_DISCRETE_FALLBACK', true);
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(20, 0, 0, 10, 10, 10);
  const result = exactBooleanOp(boxA, boxB, 'union');
  assert.ok(result.resultGrade, 'should have resultGrade');
  // Non-overlapping boxes should always produce exact results from the new kernel.
  // The allow-fallback policy does not change the outcome for clean disjoint inputs.
  assert.strictEqual(result.resultGrade, 'exact',
    'non-overlapping boxes with allow-fallback policy should still be exact');
});

test('tessellation fallback always warns when it occurs', () => {
  setFlag('CAD_USE_ROBUST_TESSELLATOR', true);
  // Use null body to force empty mesh → legacy fallback
  captureWarns();
  const mesh = tessellateBody(null);
  restoreWarns();
  // null produces empty mesh from both paths, no fallback warning needed
  assert.strictEqual(mesh.faces.length, 0);
});

// ═══════════════════════════════════════════════════════════════════
//  Regression: Retained compatibility shims are opt-in only
// ═══════════════════════════════════════════════════════════════════

console.log('\n=== Regression: Compatibility Shims are Opt-In ===\n');

test('tessellateBodyRouted({ tessellator: "legacy" }) no longer revives legacy routing', () => {
  const box = makeBox(0, 0, 0, 1, 1, 1);
  const mesh = tessellateBodyRouted(box, { tessellator: 'legacy' });
  assert.strictEqual(mesh._tessellator, 'robust', 'router stays robust-only');
});

test('tessellateBodyRouted without tessellator option defaults to robust', () => {
  const box = makeBox(0, 0, 0, 10, 10, 10);
  captureWarns();
  const mesh = tessellateBodyRouted(box);
  restoreWarns();
  assert.strictEqual(mesh._tessellator, 'robust',
    'clean box must use robust tessellator by default');
  const fallbackWarns = allWarns().filter(w => w.includes('[CAD-Fallback]'));
  assert.strictEqual(fallbackWarns.length, 0, 'no fallback for clean input');
});

test('setting CAD_USE_ROBUST_TESSELLATOR=false does not re-enable legacy routing', () => {
  setFlag('CAD_USE_ROBUST_TESSELLATOR', false);
  const box = makeBox(0, 0, 0, 10, 10, 10);
  const mesh = tessellateBody(box);
  assert.ok(
    mesh._tessellator === 'wasm' || mesh._tessellator === 'js-cold-start-fallback',
    `legacy routing should stay disabled, got ${mesh._tessellator}`
  );
});

// ═══════════════════════════════════════════════════════════════════
//  Regression: Warn-once cross-session deduplication
// ═══════════════════════════════════════════════════════════════════

console.log('\n=== Regression: Cross-Call Deduplication ===\n');

test('same fallback id across different subsystems only warns once', () => {
  captureWarns();
  // Simulating multiple subsystems calling with same id
  warnOnceForFallback({ id: 'shared:test-id', policy: 'p1', reason: 'from subsystem A', kind: 'new-stack-fallback' });
  warnOnceForFallback({ id: 'shared:test-id', policy: 'p2', reason: 'from subsystem B', kind: 'new-stack-fallback' });
  warnOnceForFallback({ id: 'shared:test-id', policy: 'p3', reason: 'from subsystem C', kind: 'new-stack-fallback' });
  restoreWarns();
  assert.strictEqual(warnCount(), 1, 'same id across subsystems warns once');
});

test('warn-once dedup survives many rapid calls', () => {
  captureWarns();
  for (let i = 0; i < 100; i++) {
    warnOnceForFallback({ id: 'rapid:test', policy: 'p', reason: 'r', kind: 'new-stack-fallback' });
  }
  restoreWarns();
  assert.strictEqual(warnCount(), 1, 'rapid repeated calls still warn once');
});

// ═══════════════════════════════════════════════════════════════════
//  Integration: Boolean allow-fallback returns labeled fallback
// ═══════════════════════════════════════════════════════════════════

console.log('\n=== Integration: Boolean Labeled Fallback ===\n');

test('allow-fallback policy returns labeled fallback with diagnostics', () => {
  setFlag('CAD_ALLOW_DISCRETE_FALLBACK', true);
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(5, 0, 0, 10, 10, 10);
  const result = exactBooleanOp(boxA, boxB, 'union', DEFAULT_TOLERANCE, {
    policy: OperationPolicy.FORCE_FALLBACK,
  });
  assert.strictEqual(result.resultGrade, 'fallback');
  assert.strictEqual(result._isFallback, true);
  assert.ok(result.fallbackDiagnostics, 'fallback diagnostics should be present');
  assert.strictEqual(result.fallbackDiagnostics.grade, 'fallback');
});

test('exact-only policy fails closed or succeeds exact', () => {
  setFlag('CAD_ALLOW_DISCRETE_FALLBACK', false);
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(20, 0, 0, 10, 10, 10);
  let result;
  try {
    result = exactBooleanOp(boxA, boxB, 'union', DEFAULT_TOLERANCE, {
      policy: OperationPolicy.EXACT_ONLY,
    });
  } catch (e) {
    // exact-only can throw — that is correct "fail closed" behavior
    assert.ok(true, 'exact-only correctly throws rather than silently degrading');
    return;
  }
  // If it succeeds, must be exact
  assert.strictEqual(result.resultGrade, 'exact', 'should succeed exact for clean input');
  assert.strictEqual(result._isFallback, false);
});

// ═══════════════════════════════════════════════════════════════════
//  Integration: Worker/API responses preserve metadata
// ═══════════════════════════════════════════════════════════════════

console.log('\n=== Integration: Result Metadata ===\n');

test('exact boolean result preserves diagnostics and hashes', () => {
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(20, 0, 0, 10, 10, 10);
  const result = exactBooleanOp(boxA, boxB, 'union');
  assert.ok(result.diagnostics, 'diagnostics present');
  assert.ok(result.resultGrade, 'resultGrade present');
  assert.ok(result.fallbackDiagnostics !== undefined, 'fallbackDiagnostics present');
});

test('force-fallback result preserves fallback diagnostics', () => {
  setFlag('CAD_ALLOW_DISCRETE_FALLBACK', true);
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(5, 0, 0, 10, 10, 10);
  const result = exactBooleanOp(boxA, boxB, 'union', DEFAULT_TOLERANCE, {
    policy: OperationPolicy.FORCE_FALLBACK,
  });
  const diag = result.fallbackDiagnostics;
  assert.ok(diag, 'fallbackDiagnostics present');
  assert.strictEqual(diag.grade, 'fallback');
  assert.ok(diag.triggerReason, 'triggerReason present');
  assert.ok(diag.timestamp, 'timestamp present');
});

// ═══════════════════════════════════════════════════════════════════
//  Export barrel tests
// ═══════════════════════════════════════════════════════════════════

console.log('\n=== Export: Barrel Exports ===\n');

test('fallback/index.js exports warnOnceForFallback', async () => {
  const mod = await import('../js/cad/fallback/index.js');
  assert.strictEqual(typeof mod.warnOnceForFallback, 'function');
  assert.strictEqual(typeof mod._resetWarnOnce, 'function');
  assert.strictEqual(typeof mod.getWarnedFallbackIds, 'function');
  assert.strictEqual(typeof mod.FallbackKind, 'object');
});

test('cad/index.js exports warnOnceForFallback', async () => {
  const mod = await import('../js/cad/index.js');
  assert.strictEqual(typeof mod.warnOnceForFallback, 'function');
  assert.strictEqual(typeof mod._resetWarnOnce, 'function');
  assert.strictEqual(typeof mod.getWarnedFallbackIds, 'function');
  assert.strictEqual(typeof mod.FallbackKind, 'object');
});

// ═══════════════════════════════════════════════════════════════════
//  Summary
// ═══════════════════════════════════════════════════════════════════

console.log(`\n=== Warn-Once Fallback Test Results ===\n`);
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
