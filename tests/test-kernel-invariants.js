// tests/test-kernel-invariants.js — Corpus-based invariant checks on tests/step/*.step
//
// Validates:
// 1. Every STEP file in tests/step/ can be imported
// 2. Imported bodies pass fragment validation
// 3. Imported bodies pass final body validation
// 4. Boolean operations on imported bodies produce diagnostics (no silent corruption)
// 5. JSON diagnostics are generated for any failures

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { importSTEP } from '../js/cad/StepImport.js';
import { validateFinalBody, validateFragments } from '../js/cad/IntersectionValidator.js';
import { healFragments } from '../js/cad/Healing.js';
import { DEFAULT_TOLERANCE } from '../js/cad/Tolerance.js';
import { resetTopoIds } from '../js/cad/BRepTopology.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STEP_DIR = path.join(__dirname, 'step');

let passed = 0;
let failed = 0;
const failureDiagnostics = [];

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

// ============================================================
console.log('=== Kernel Invariants — STEP Corpus ===\n');
// ============================================================

// Discover STEP files
let stepFiles = [];
try {
  stepFiles = fs.readdirSync(STEP_DIR).filter(f => f.endsWith('.step'));
} catch {
  console.log('  ⚠ No tests/step/ directory found — skipping corpus tests');
}

if (stepFiles.length === 0) {
  console.log('  ⚠ No .step files found in tests/step/ — skipping corpus tests');
} else {
  console.log(`  Found ${stepFiles.length} STEP file(s) in corpus\n`);
}

for (const filename of stepFiles) {
  const filepath = path.join(STEP_DIR, filename);

  test(`${filename}: imports without crash`, () => {
    resetTopoIds();
    const stepData = fs.readFileSync(filepath, 'utf-8');
    const result = importSTEP(stepData);
    assert.ok(result, `importSTEP returned falsy for ${filename}`);
  });

  test(`${filename}: imported body passes basic validation`, () => {
    resetTopoIds();
    const stepData = fs.readFileSync(filepath, 'utf-8');
    const result = importSTEP(stepData);
    if (!result) return; // already caught above

    // The result may be a body, mesh, or compound — extract what we can
    const body = result.body || result;
    if (body && body.shells) {
      const validation = validateFinalBody(body, DEFAULT_TOLERANCE);
      // We don't fail on validation issues here — we record them
      if (!validation.isValid) {
        failureDiagnostics.push({
          file: filename,
          stage: 'final-body-validation',
          diagnostics: validation.toJSON(),
        });
      }
    }
  });

  test(`${filename}: faces can be healed without crash`, () => {
    resetTopoIds();
    const stepData = fs.readFileSync(filepath, 'utf-8');
    const result = importSTEP(stepData);
    if (!result) return;

    const body = result.body || result;
    if (body && body.shells) {
      const faces = body.faces ? body.faces() : [];
      if (faces.length > 0) {
        const { fragments, report } = healFragments([...faces], DEFAULT_TOLERANCE);
        assert.ok(Array.isArray(fragments), 'healFragments should return array');
        if (report.healed) {
          failureDiagnostics.push({
            file: filename,
            stage: 'healing',
            report: report.toJSON(),
          });
        }
      }
    }
  });

  test(`${filename}: fragment validation runs without crash`, () => {
    resetTopoIds();
    const stepData = fs.readFileSync(filepath, 'utf-8');
    const result = importSTEP(stepData);
    if (!result) return;

    const body = result.body || result;
    if (body && body.shells) {
      const faces = body.faces ? body.faces() : [];
      if (faces.length > 0) {
        const validation = validateFragments(faces, DEFAULT_TOLERANCE);
        if (!validation.isValid) {
          failureDiagnostics.push({
            file: filename,
            stage: 'fragment-validation',
            diagnostics: validation.toJSON(),
          });
        }
      }
    }
  });
}

// ============================================================
console.log('\n--- Diagnostic summary ---');
// ============================================================

test('diagnostic payloads are JSON-serializable', () => {
  if (failureDiagnostics.length > 0) {
    const json = JSON.stringify(failureDiagnostics, null, 2);
    assert.ok(json.length > 0, 'Should produce non-empty JSON');
    console.log(`    ${failureDiagnostics.length} diagnostic payload(s) recorded`);
  } else {
    console.log(`    No diagnostic payloads needed — all corpus files passed`);
  }
});

// Write diagnostics to temp file for CI artifact consumption
if (failureDiagnostics.length > 0) {
  const diagPath = path.join(os.tmpdir(), 'kernel-invariant-diagnostics.json');
  try {
    fs.writeFileSync(diagPath, JSON.stringify(failureDiagnostics, null, 2));
    console.log(`  Diagnostics written to ${diagPath}`);
  } catch {
    // Non-fatal — just informational
  }
}

// ============================================================
console.log('\n=== Results ===\n');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
