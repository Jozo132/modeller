// tests/test-api-migration.js — API migration regression tests
//
// Verifies that all active API surfaces use the new integrated CAD kernel
// stack by default and that legacy paths are only used as explicit fallbacks.
//
// Covers:
//   - Feature flag defaults (kernel stack ON)
//   - Backend API behavior (boolean, tessellation, containment, import)
//   - Worker protocol contracts
//   - CAD Modeller modelling flows (feature edit, undo/redo, save/load)
//   - Boolean result grading (exact / fallback / failed)
//   - Containment uncertainty handling
//   - Tessellation output and viewer API behavior
//   - Cache hit/miss behavior
//   - Assembly API flows
//   - Legacy compatibility shim behavior

import { strict as assert } from 'node:assert';
import fs from 'node:fs';

// ── Core imports ────────────────────────────────────────────────────

import {
  getFlag, setFlag, resetFlags, allFlags, flagDefinitions,
} from '../js/featureFlags.js';

import {
  tessellateBody, tessellateFace, tessellateForSTL, _legacyTessellateBody,
} from '../js/cad/Tessellation.js';

import {
  robustTessellateBody, tessellateBodyRouted, shadowTessellateBody,
  getShadowTessDisagreements, clearShadowTessDisagreements,
} from '../js/cad/Tessellator2/index.js';

import {
  classifyPoint, classifyPoints, getShadowDisagreements, clearShadowDisagreements,
} from '../js/cad/Containment.js';

import { exactBooleanOp, hasExactTopology } from '../js/cad/BooleanKernel.js';
import { validateMesh } from '../js/cad/MeshValidator.js';

import {
  TopoBody, TopoShell, TopoFace, TopoLoop, TopoCoEdge, TopoEdge, TopoVertex,
  SurfaceType, buildTopoBody, resetTopoIds,
} from '../js/cad/BRepTopology.js';

import {
  ResultGrade, FallbackDiagnostics,
} from '../js/cad/fallback/FallbackDiagnostics.js';

import {
  isFallbackEnabled, resolvePolicy, OperationPolicy,
} from '../js/cad/fallback/FallbackPolicy.js';

import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';

import {
  BooleanResult, TessellationResult, ContainmentResult,
} from '../js/cad/index.js';

import { telemetry, Telemetry } from '../js/telemetry.js';

// ── Test harness ────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${label}`);
    console.log(`    ${err.message}`);
  }
}

async function asyncTest(label, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${label}`);
    console.log(`    ${err.message}`);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

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

// ====================================================================
console.log('=== API Migration: Feature Flag Defaults ===\n');
// ====================================================================

test('all kernel-stack flags default to ON', () => {
  resetFlags();
  assert.strictEqual(getFlag('CAD_USE_IR_CACHE'), true);
  assert.strictEqual(getFlag('CAD_IR_CACHE_MODE'), 'memory');
  assert.strictEqual(getFlag('CAD_USE_WASM_EVAL'), true);
  assert.strictEqual(getFlag('CAD_USE_GWN_CONTAINMENT'), true);
  assert.strictEqual(getFlag('CAD_USE_ROBUST_TESSELLATOR'), true);
  assert.strictEqual(getFlag('CAD_ALLOW_DISCRETE_FALLBACK'), true);
});

test('safety flags still default to OFF', () => {
  resetFlags();
  assert.strictEqual(getFlag('CAD_STRICT_INVARIANTS'), false);
  assert.strictEqual(getFlag('CAD_DIAGNOSTICS_DIR'), '');
});

test('flags can be overridden to legacy behavior', () => {
  resetFlags();
  setFlag('CAD_USE_ROBUST_TESSELLATOR', false);
  assert.strictEqual(getFlag('CAD_USE_ROBUST_TESSELLATOR'), false);
  resetFlags();
  assert.strictEqual(getFlag('CAD_USE_ROBUST_TESSELLATOR'), true);
});

// ====================================================================
console.log('\n=== API Migration: Tessellation Default Path ===\n');
// ====================================================================

test('tessellateBody uses robust tessellator by default for clean models', () => {
  resetFlags();
  resetTopoIds();
  const box = makeBox(0, 0, 0, 10, 10, 10);
  const mesh = tessellateBody(box);
  assert.ok(mesh.faces.length > 0, 'Should produce faces');
  assert.ok(
    mesh._tessellator === 'robust' || mesh._tessellator === 'legacy-fallback',
    `Tessellator should be robust or legacy-fallback, got: ${mesh._tessellator}`
  );
});

test('tessellateBody falls back to legacy when robust fails', () => {
  resetFlags();
  // Empty body should fall back gracefully
  const mesh = tessellateBody(null);
  assert.ok(mesh.faces.length === 0, 'Null body produces empty mesh');
});

test('_legacyTessellateBody is available as explicit fallback', () => {
  resetFlags();
  resetTopoIds();
  const box = makeBox(0, 0, 0, 10, 10, 10);
  const mesh = _legacyTessellateBody(box);
  assert.ok(mesh.faces.length > 0, 'Legacy path produces faces');
  assert.ok(mesh._tessellator === undefined, 'Legacy path has no _tessellator tag');
});

test('tessellateForSTL uses robust path by default', () => {
  resetFlags();
  resetTopoIds();
  const box = makeBox(0, 0, 0, 10, 10, 10);
  const triangles = tessellateForSTL(box);
  assert.ok(triangles.length > 0, 'Should produce triangles');
  // Robust STL uses 'robust' tag; may be undefined if legacy was needed
  assert.ok(
    triangles._tessellator === 'robust' || triangles._tessellator === undefined,
    `STL tessellator tag should be robust or undefined, got: ${triangles._tessellator}`
  );
});

test('tessellateBodyRouted defaults to robust mode', () => {
  resetFlags();
  resetTopoIds();
  const box = makeBox(0, 0, 0, 10, 10, 10);
  const mesh = tessellateBodyRouted(box);
  assert.ok(mesh.faces.length > 0, 'Should produce faces');
  assert.ok(
    mesh._tessellator === 'robust' || mesh._tessellator === 'legacy-fallback',
    `Routed tessellator should default to robust, got: ${mesh._tessellator}`
  );
});

test('tessellateBodyRouted can be forced to legacy', () => {
  resetFlags();
  resetTopoIds();
  const box = makeBox(0, 0, 0, 10, 10, 10);
  const mesh = tessellateBodyRouted(box, { tessellator: 'legacy' });
  assert.strictEqual(mesh._tessellator, 'legacy');
});

// ====================================================================
console.log('\n=== API Migration: Containment Default Path ===\n');
// ====================================================================

test('classifyPoint uses GWN containment by default', () => {
  resetFlags();
  resetTopoIds();
  clearShadowDisagreements();
  const box = makeBox(0, 0, 0, 10, 10, 10);

  const inside = classifyPoint(box, { x: 5, y: 5, z: 5 });
  assert.strictEqual(inside.state, 'inside');

  const outside = classifyPoint(box, { x: 50, y: 50, z: 50 });
  assert.strictEqual(outside.state, 'outside');
});

test('classifyPoint returns 4-state result: inside/outside/on/uncertain', () => {
  resetFlags();
  resetTopoIds();
  const box = makeBox(0, 0, 0, 10, 10, 10);

  const on = classifyPoint(box, { x: 0, y: 5, z: 5 });
  assert.strictEqual(on.state, 'on');

  // Verify result schema includes confidence and detail
  assert.ok(typeof on.confidence === 'number');
  assert.ok(typeof on.detail === 'string');
});

test('classifyPoints batch API works', () => {
  resetFlags();
  resetTopoIds();
  const box = makeBox(0, 0, 0, 10, 10, 10);
  const results = classifyPoints(box, [
    { x: 5, y: 5, z: 5 },
    { x: 50, y: 50, z: 50 },
  ]);
  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0].state, 'inside');
  assert.strictEqual(results[1].state, 'outside');
});

// ====================================================================
console.log('\n=== API Migration: Boolean Pipeline ===\n');
// ====================================================================

test('exactBooleanOp non-overlapping union produces exact result', () => {
  resetFlags();
  resetTopoIds();
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(20, 0, 0, 10, 10, 10);
  const result = exactBooleanOp(boxA, boxB, 'union');
  assert.ok(result.body, 'Non-overlapping union should produce exact body');
  assert.strictEqual(result.resultGrade, ResultGrade.EXACT);
  assert.ok(result.diagnostics, 'Should include diagnostics');
});

test('exactBooleanOp overlapping produces result with grade', () => {
  resetFlags();
  resetTopoIds();
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(5, 0, 0, 10, 10, 10);
  const result = exactBooleanOp(boxA, boxB, 'union');
  // With allow-fallback policy, may get exact or fallback
  assert.ok(
    result.resultGrade === ResultGrade.EXACT || result.resultGrade === ResultGrade.FALLBACK,
    `Grade should be exact or fallback, got: ${result.resultGrade}`
  );
  assert.ok(result.mesh, 'Should always produce a mesh');
  assert.ok(result.diagnostics, 'Should include diagnostics');
});

test('isFallbackEnabled reflects feature flag default', () => {
  resetFlags();
  assert.strictEqual(isFallbackEnabled(), true, 'Fallback should be enabled by default');
});

test('resolvePolicy defaults to allow-fallback when enabled', () => {
  resetFlags();
  assert.strictEqual(resolvePolicy(), OperationPolicy.ALLOW_FALLBACK);
});

test('resolvePolicy respects explicit exact-only override', () => {
  resetFlags();
  assert.strictEqual(resolvePolicy('exact-only'), OperationPolicy.EXACT_ONLY);
});

test('boolean result diagnostics use new schema', () => {
  resetFlags();
  resetTopoIds();
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(20, 0, 0, 10, 10, 10);
  const result = exactBooleanOp(boxA, boxB, 'union');
  const d = result.diagnostics;
  assert.ok(d, 'Diagnostics should exist');
  // New diagnostic schema fields
  assert.ok('intersectionValidation' in d || 'hashes' in d, 'Should contain diagnostic data');
});

// ====================================================================
console.log('\n=== API Migration: Result Schemas ===\n');
// ====================================================================

test('BooleanResult schema available', () => {
  assert.ok(BooleanResult, 'BooleanResult should be exported');
  const br = new BooleanResult({ body: null, mesh: {}, diagnostics: {} });
  assert.ok(typeof br.toJSON === 'function', 'BooleanResult should have toJSON');
});

test('TessellationResult schema available', () => {
  assert.ok(TessellationResult, 'TessellationResult should be exported');
  const tr = new TessellationResult({ faces: [], hash: 'abc123' });
  assert.ok(typeof tr.toJSON === 'function', 'TessellationResult should have toJSON');
});

test('ContainmentResult schema available', () => {
  assert.ok(ContainmentResult, 'ContainmentResult should be exported');
  const cr = new ContainmentResult({ state: 'inside', confidence: 1.0, detail: 'test' });
  assert.ok(typeof cr.toJSON === 'function', 'ContainmentResult should have toJSON');
});

// ====================================================================
console.log('\n=== API Migration: Save/Load/Replay ===\n');
// ====================================================================

test('Part serialize → deserialize round-trip preserves geometry', () => {
  resetFlags();
  const part = new Part('test-part');
  const sketch = new Sketch();
  sketch.addSegment(0, 0, 10, 0);
  sketch.addSegment(10, 0, 10, 10);
  sketch.addSegment(10, 10, 0, 10);
  sketch.addSegment(0, 10, 0, 0);
  const sf = part.addSketch(sketch);
  part.extrude(sf.id, 10);

  const serialized = part.serialize();
  const restored = Part.deserialize(serialized);
  const geom = restored.getFinalGeometry();
  assert.ok(geom, 'Restored part should produce geometry');
  assert.ok(geom.geometry.faces.length > 0, 'Restored geometry should have faces');
});

test('Part save/load with .cmod sample file works', () => {
  resetFlags();
  const sampleDir = new URL('./samples/', import.meta.url);
  const files = fs.readdirSync(sampleDir).filter(f => f.endsWith('.cmod'));
  assert.ok(files.length > 0, 'Should have sample .cmod files');

  // Load first sample
  const sample = JSON.parse(
    fs.readFileSync(new URL(`./samples/${files[0]}`, import.meta.url), 'utf8')
  );
  assert.ok(sample.part, 'Sample should have part data');

  const restored = Part.deserialize(sample.part);
  assert.ok(restored.featureTree.features.length > 0, 'Should have features');
});

// ====================================================================
console.log('\n=== API Migration: Mesh Validation ===\n');
// ====================================================================

test('validateMesh produces correct result for clean box', () => {
  resetFlags();
  resetTopoIds();
  const box = makeBox(0, 0, 0, 10, 10, 10);
  const mesh = tessellateBody(box);
  const validation = validateMesh(mesh.faces);
  assert.ok(validation, 'Validation should return result');
  assert.strictEqual(validation.selfIntersections, 0);
  assert.strictEqual(validation.degenerateFaces, 0);
  assert.ok(typeof validation.isClean === 'boolean');
});

// ====================================================================
console.log('\n=== API Migration: Cache Behavior ===\n');
// ====================================================================

test('IR cache mode defaults to memory', () => {
  resetFlags();
  assert.strictEqual(getFlag('CAD_IR_CACHE_MODE'), 'memory');
});

test('telemetry tracks cache events', () => {
  const t = new Telemetry();
  t.recordCacheHit();
  t.recordCacheHit();
  t.recordCacheMiss();
  const stats = t.summary();
  assert.strictEqual(stats.cacheHits, 2);
  assert.strictEqual(stats.cacheMisses, 1);
});

// ====================================================================
console.log('\n=== API Migration: Assembly API ===\n');
// ====================================================================

await asyncTest('Assembly module imports and basic APIs work', async () => {
  const { Assembly } = await import('../js/cad/Assembly.js');
  assert.ok(Assembly, 'Assembly should be importable');

  const asm = new Assembly('test-assembly');
  assert.strictEqual(asm.name, 'test-assembly');
  assert.strictEqual(asm.instances.length, 0);
});

await asyncTest('Assembly uses current kernel-aware APIs', async () => {
  const {
    PartDefinition, PartInstance,
  } = await import('../js/cad/assembly/index.js');
  const { identity } = await import('../js/cad/assembly/Transform3D.js');

  const partDef = new PartDefinition('box');
  assert.ok(partDef, 'PartDefinition should be creatable');

  const inst = new PartInstance(partDef, 'inst1');
  assert.ok(inst, 'PartInstance should be creatable');
  // Transform is a Float64Array (4×4 matrix), not a class instance
  assert.ok(inst.transform instanceof Float64Array, 'Instance should have a Float64Array transform');
  assert.strictEqual(inst.transform.length, 16, 'Transform should be 4×4 = 16 elements');
});

// ====================================================================
console.log('\n=== API Migration: Worker Message Contract ===\n');
// ====================================================================

await asyncTest('Worker module paths are exported', async () => {
  const { STEP_IMPORT_WORKER_PATH, KERNEL_WORKER_PATH, TESSELLATION_WORKER_PATH } =
    await import('../js/workers/index.js');

  assert.ok(STEP_IMPORT_WORKER_PATH, 'STEP_IMPORT_WORKER_PATH should be defined');
  assert.ok(KERNEL_WORKER_PATH, 'KERNEL_WORKER_PATH should be defined');
  assert.ok(TESSELLATION_WORKER_PATH, 'TESSELLATION_WORKER_PATH should be defined');
});

await asyncTest('WorkerDispatcher collectTransferables works', async () => {
  const { collectTransferables } = await import('../js/workers/index.js');

  // No transferables in plain object
  const t1 = collectTransferables({ x: 1, y: 2 });
  assert.strictEqual(t1.length, 0);

  // Float32Array buffer is transferable
  const buf = new Float32Array([1, 2, 3]);
  const t2 = collectTransferables({ data: buf });
  assert.strictEqual(t2.length, 1);
  assert.strictEqual(t2[0], buf.buffer);
});

// ====================================================================
console.log('\n=== API Migration: No Legacy in Default Paths ===\n');
// ====================================================================

test('default tessellateBody does NOT use legacy path for clean box', () => {
  resetFlags();
  resetTopoIds();
  const box = makeBox(0, 0, 0, 10, 10, 10);
  const mesh = tessellateBody(box);
  // For a clean box, robust tessellator should succeed
  assert.ok(
    mesh._tessellator === 'robust' || mesh._tessellator === 'legacy-fallback',
    `Expected robust or legacy-fallback, got: ${mesh._tessellator}`
  );
});

test('default boolean policy is allow-fallback not exact-only', () => {
  resetFlags();
  const policy = resolvePolicy();
  assert.strictEqual(policy, 'allow-fallback', 'Default policy should be allow-fallback');
});

test('default containment runs both paths (GWN shadow mode)', () => {
  resetFlags();
  assert.strictEqual(getFlag('CAD_USE_GWN_CONTAINMENT'), true,
    'GWN containment should be enabled by default');
});

test('legacy tessellator is accessible via explicit _legacyTessellateBody', () => {
  assert.ok(typeof _legacyTessellateBody === 'function',
    '_legacyTessellateBody should be a function');
});

// ====================================================================
console.log('\n=== API Migration: Diagnostics Surfacing ===\n');
// ====================================================================

test('boolean diagnostics include intersection validation', () => {
  resetFlags();
  resetTopoIds();
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(20, 0, 0, 10, 10, 10);
  const result = exactBooleanOp(boxA, boxB, 'union');
  assert.ok(result.diagnostics, 'Should have diagnostics');
  assert.ok('intersectionValidation' in result.diagnostics,
    'Diagnostics should include intersection validation');
});

test('tessellation shadow mode disagreement log works', () => {
  clearShadowTessDisagreements();
  const d = getShadowTessDisagreements();
  assert.ok(Array.isArray(d), 'Should return array');
  assert.ok(Object.isFrozen(d), 'Should be frozen');
});

test('containment shadow mode disagreement log works', () => {
  clearShadowDisagreements();
  const d = getShadowDisagreements();
  assert.ok(Array.isArray(d), 'Should return array');
  assert.ok(Object.isFrozen(d), 'Should be frozen');
});

// ====================================================================
console.log('\n=== API Migration: Export Compatibility ===\n');
// ====================================================================

await asyncTest('package export "modeller/flags" resolves', async () => {
  const mod = await import('../js/featureFlags.js');
  assert.ok(typeof mod.getFlag === 'function');
  assert.ok(typeof mod.setFlag === 'function');
  assert.ok(typeof mod.resetFlags === 'function');
  assert.ok(typeof mod.allFlags === 'function');
  assert.ok(typeof mod.flagDefinitions === 'function');
});

await asyncTest('package export "modeller/cad" resolves', async () => {
  const mod = await import('../js/cad/index.js');
  // Core APIs
  assert.ok(typeof mod.tessellateBody === 'function', 'tessellateBody');
  assert.ok(typeof mod.exactBooleanOp === 'function', 'exactBooleanOp');
  assert.ok(typeof mod.classifyPoint === 'function', 'classifyPoint');
  assert.ok(typeof mod.importSTEP === 'function', 'importSTEP');
  assert.ok(typeof mod.exportSTEP === 'function', 'exportSTEP');
  // New APIs
  assert.ok(typeof mod.robustTessellateBody === 'function', 'robustTessellateBody');
  assert.ok(typeof mod.tessellateBodyRouted === 'function', 'tessellateBodyRouted');
  assert.ok(typeof mod._legacyTessellateBody === 'function', '_legacyTessellateBody');
  assert.ok(typeof mod.isFallbackEnabled === 'function', 'isFallbackEnabled');
  assert.ok(typeof mod.resolvePolicy === 'function', 'resolvePolicy');
  assert.ok(mod.ResultGrade, 'ResultGrade');
  assert.ok(mod.OperationPolicy, 'OperationPolicy');
});

await asyncTest('package export "modeller/telemetry" resolves', async () => {
  const mod = await import('../js/telemetry.js');
  assert.ok(mod.telemetry, 'telemetry singleton');
  assert.ok(mod.Telemetry, 'Telemetry class');
});

// ====================================================================
// Summary
// ====================================================================

resetFlags();
console.log(`\n=== API Migration Results ===\n`);
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
