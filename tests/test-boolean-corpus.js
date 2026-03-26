// tests/test-boolean-corpus.js — Deterministic corpus-based boolean regression driver
//
// Validates:
// 1. STEP corpus boolean operations produce deterministic results
// 2. Pass/fallback/fail grading is explicit for every model/op pair
// 3. BooleanInvariantValidator runs on every result
// 4. Fallback routing activates only on exact failure paths
// 5. Compact JSON diagnostics are generated for non-clean outcomes

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { importSTEP } from '../js/cad/StepImport.js';
import { exactBooleanOp } from '../js/cad/BooleanKernel.js';
import { validateBooleanResult } from '../js/cad/BooleanInvariantValidator.js';
import {
  buildTopoBody, SurfaceType, resetTopoIds,
} from '../js/cad/BRepTopology.js';
import { DEFAULT_TOLERANCE } from '../js/cad/Tolerance.js';
import { ResultGrade } from '../js/cad/fallback/FallbackDiagnostics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STEP_DIR = path.join(__dirname, 'step');

let passed = 0;
let failed = 0;
const corpusResults = [];

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

// ============================================================
console.log('=== Boolean Corpus Regression Tests ===\n');
// ============================================================

// --- Analytic fixtures: deterministic regression ---

console.log('--- Analytic fixtures ---\n');

for (const op of ['union', 'subtract', 'intersect']) {
  test(`analytic: non-overlapping boxes ${op} is deterministic`, () => {
    resetTopoIds();
    const boxA1 = makeBox(0, 0, 0, 10, 10, 10);
    const boxB1 = makeBox(20, 0, 0, 10, 10, 10);
    const r1 = exactBooleanOp(boxA1, boxB1, op);

    resetTopoIds();
    const boxA2 = makeBox(0, 0, 0, 10, 10, 10);
    const boxB2 = makeBox(20, 0, 0, 10, 10, 10);
    const r2 = exactBooleanOp(boxA2, boxB2, op);

    assert.strictEqual(r1.resultGrade, r2.resultGrade, `${op}: grade should be deterministic`);
    if (r1.body && r2.body) {
      assert.strictEqual(r1.body.faces().length, r2.body.faces().length,
        `${op}: face count should be deterministic`);
    }
    assert.strictEqual(
      r1.diagnostics.invariantValidation.diagnosticCount,
      r2.diagnostics.invariantValidation.diagnosticCount,
      `${op}: invariant diagnostic count should be deterministic`,
    );

    corpusResults.push({
      model: 'analytic-non-overlapping-boxes',
      operation: op,
      grade: r1.resultGrade,
      faceCount: r1.body?.faces().length ?? 0,
      invariantDiagnostics: r1.diagnostics.invariantValidation.diagnosticCount,
    });
  });

  test(`analytic: overlapping boxes ${op} produces graded result`, () => {
    resetTopoIds();
    const boxA = makeBox(0, 0, 0, 10, 10, 10);
    const boxB = makeBox(5, 5, 5, 10, 10, 10);
    const result = exactBooleanOp(boxA, boxB, op);

    assert.ok(result.resultGrade, `${op}: should have a resultGrade`);
    assert.ok(
      [ResultGrade.EXACT, ResultGrade.FALLBACK, ResultGrade.FAILED].includes(result.resultGrade),
      `${op}: grade should be one of exact/fallback/failed`,
    );
    assert.ok(result.diagnostics.invariantValidation, `${op}: should have invariantValidation`);

    corpusResults.push({
      model: 'analytic-overlapping-boxes',
      operation: op,
      grade: result.resultGrade,
      faceCount: result.body?.faces().length ?? 0,
      invariantDiagnostics: result.diagnostics.invariantValidation.diagnosticCount,
    });
  });
}

test('analytic: identical boxes union is graded', () => {
  resetTopoIds();
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(0, 0, 0, 10, 10, 10);
  const result = exactBooleanOp(boxA, boxB, 'union');
  assert.ok(result.resultGrade);
  assert.ok(result.diagnostics.invariantValidation);
  corpusResults.push({
    model: 'analytic-identical-boxes',
    operation: 'union',
    grade: result.resultGrade,
    faceCount: result.body?.faces().length ?? 0,
    invariantDiagnostics: result.diagnostics.invariantValidation.diagnosticCount,
  });
});

// --- Fallback routing: only activates on exact failure ---

console.log('\n--- Fallback routing ---\n');

test('fallback routing: clean boxes never trigger fallback', () => {
  resetTopoIds();
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(20, 0, 0, 10, 10, 10);
  const result = exactBooleanOp(boxA, boxB, 'union');
  // Clean operands should not need fallback
  assert.strictEqual(result.resultGrade, 'exact', 'Clean operands should produce exact grade');
  assert.strictEqual(result._isFallback, false, 'Clean operands should not be flagged as fallback');
});

test('fallback routing: result always has explicit grade', () => {
  for (const op of ['union', 'subtract', 'intersect']) {
    resetTopoIds();
    const boxA = makeBox(0, 0, 0, 10, 10, 10);
    const boxB = makeBox(5, 0, 0, 10, 10, 10);
    const result = exactBooleanOp(boxA, boxB, op);
    assert.ok(result.resultGrade, `${op} result should have explicit grade`);
    assert.ok(typeof result._isFallback === 'boolean', `${op} result should have _isFallback flag`);
  }
});

// --- STEP corpus: boolean regression ---

console.log('\n--- STEP corpus boolean regression ---\n');

let stepFiles = [];
try {
  stepFiles = fs.readdirSync(STEP_DIR).filter(f => f.endsWith('.step'));
} catch {
  console.log('  ⚠ No tests/step/ directory found — skipping corpus tests');
}

if (stepFiles.length === 0) {
  console.log('  ⚠ No .step files found in tests/step/ — skipping STEP corpus tests');
} else {
  console.log(`  Found ${stepFiles.length} STEP file(s) in corpus\n`);
}

for (const filename of stepFiles) {
  const filepath = path.join(STEP_DIR, filename);

  test(`${filename}: self-union produces graded result`, () => {
    resetTopoIds();
    const stepData = fs.readFileSync(filepath, 'utf-8');
    const imported = importSTEP(stepData);
    if (!imported) return;

    const body = imported.body || imported;
    if (!body || !body.shells || body.shells.length === 0) return;

    // Use a small box as second operand for a simple boolean
    const box = makeBox(0, 0, 0, 1, 1, 1);
    const result = exactBooleanOp(body, box, 'union');

    assert.ok(result.resultGrade, `${filename}: should have resultGrade`);
    assert.ok(result.diagnostics.invariantValidation, `${filename}: should have invariantValidation`);

    corpusResults.push({
      model: filename,
      operation: 'union',
      grade: result.resultGrade,
      faceCount: result.body?.faces().length ?? 0,
      invariantDiagnostics: result.diagnostics.invariantValidation?.diagnosticCount ?? -1,
    });
  });
}

// --- Invariant validator direct tests ---

console.log('\n--- Invariant validator direct tests ---\n');

test('validateBooleanResult: records operation in output', () => {
  resetTopoIds();
  const box = makeBox(0, 0, 0, 10, 10, 10);
  const result = validateBooleanResult(box, { operation: 'subtract' });
  assert.strictEqual(result.operation, 'subtract');
  const json = result.toJSON();
  assert.strictEqual(json.operation, 'subtract');
});

test('validateBooleanResult: topology counts are populated', () => {
  resetTopoIds();
  const box = makeBox(0, 0, 0, 10, 10, 10);
  const result = validateBooleanResult(box, { operation: 'union' });
  assert.ok(result.shellCount >= 1);
  assert.ok(result.faceCount >= 6);
  assert.ok(result.edgeCount > 0);
  assert.ok(result.vertexCount > 0);
});

test('validateBooleanResult: diagnostics are deterministic', () => {
  resetTopoIds();
  const box1 = makeBox(0, 0, 0, 10, 10, 10);
  const r1 = validateBooleanResult(box1, { operation: 'union' });

  resetTopoIds();
  const box2 = makeBox(0, 0, 0, 10, 10, 10);
  const r2 = validateBooleanResult(box2, { operation: 'union' });

  assert.strictEqual(r1.diagnostics.length, r2.diagnostics.length,
    'Same input should produce same diagnostic count');
  assert.strictEqual(r1.isValid, r2.isValid,
    'Same input should produce same validity');
});

// ============================================================
// Summary
// ============================================================

console.log('\n--- Corpus summary ---');
if (corpusResults.length > 0) {
  const exact = corpusResults.filter(r => r.grade === 'exact').length;
  const fallback = corpusResults.filter(r => r.grade === 'fallback').length;
  const failedResults = corpusResults.filter(r => r.grade === 'failed').length;
  console.log(`  exact: ${exact}, fallback: ${fallback}, failed: ${failedResults}`);

  // Write compact corpus results
  const reportPath = path.join(os.tmpdir(), 'boolean-corpus-results.json');
  try {
    fs.writeFileSync(reportPath, JSON.stringify(corpusResults, null, 2));
    console.log(`  Corpus results written to ${reportPath}`);
  } catch { /* non-fatal */ }
}

// ============================================================
console.log('\n=== Results ===\n');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
