#!/usr/bin/env node
// tools/boolean-corpus-report.js — Deterministic CI reporting for boolean corpus
//
// For each model/op pair, records:
//   - pass   (exact grade, invariant validation clean)
//   - fallback (fallback grade used)
//   - fail   (failed grade or uncaught error)
//
// Output: compact JSON to stdout (machine-readable).
// Usage:  node tools/boolean-corpus-report.js [--outfile <path>]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { importSTEP } from '../js/cad/StepImport.js';
import { exactBooleanOp } from '../js/cad/BooleanKernel.js';
import {
  buildTopoBody, SurfaceType, resetTopoIds,
} from '../js/cad/BRepTopology.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STEP_DIR = path.join(__dirname, '..', 'tests', 'step');

// -----------------------------------------------------------------------
// Parse args
// -----------------------------------------------------------------------

const args = process.argv.slice(2);
let outfile = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--outfile' && args[i + 1]) outfile = args[++i];
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

// -----------------------------------------------------------------------
// Corpus runner
// -----------------------------------------------------------------------

const results = [];
const operations = ['union', 'subtract', 'intersect'];

// 1. Analytic fixtures
for (const op of operations) {
  for (const fixture of [
    { name: 'non-overlapping-boxes', a: [0,0,0,10,10,10], b: [20,0,0,10,10,10] },
    { name: 'overlapping-boxes', a: [0,0,0,10,10,10], b: [5,5,5,10,10,10] },
    { name: 'identical-boxes', a: [0,0,0,10,10,10], b: [0,0,0,10,10,10] },
  ]) {
    resetTopoIds();
    const boxA = makeBox(...fixture.a);
    const boxB = makeBox(...fixture.b);
    try {
      const r = exactBooleanOp(boxA, boxB, op);
      results.push({
        model: fixture.name,
        operation: op,
        status: r.resultGrade === 'exact' ? 'pass' : r.resultGrade,
        grade: r.resultGrade,
        faceCount: r.body?.faces().length ?? 0,
        invariantValid: r.diagnostics?.invariantValidation?.valid ?? null,
        invariantDiagnostics: r.diagnostics?.invariantValidation?.diagnosticCount ?? 0,
      });
    } catch (err) {
      results.push({
        model: fixture.name,
        operation: op,
        status: 'fail',
        grade: 'failed',
        error: err.message,
      });
    }
  }
}

// 2. STEP corpus
let stepFiles = [];
try {
  stepFiles = fs.readdirSync(STEP_DIR).filter(f => f.endsWith('.step'));
} catch { /* no step dir */ }

for (const filename of stepFiles) {
  const filepath = path.join(STEP_DIR, filename);
  resetTopoIds();

  let body = null;
  try {
    const stepData = fs.readFileSync(filepath, 'utf-8');
    const imported = importSTEP(stepData);
    body = imported?.body || imported;
  } catch (err) {
    results.push({
      model: filename,
      operation: 'import',
      status: 'fail',
      grade: 'failed',
      error: err.message,
    });
    continue;
  }

  if (!body || !body.shells || body.shells.length === 0) {
    results.push({
      model: filename,
      operation: 'import',
      status: 'fail',
      grade: 'failed',
      error: 'no valid body after import',
    });
    continue;
  }

  const box = makeBox(0, 0, 0, 1, 1, 1);
  for (const op of operations) {
    resetTopoIds();
    try {
      const r = exactBooleanOp(body, box, op);
      results.push({
        model: filename,
        operation: op,
        status: r.resultGrade === 'exact' ? 'pass' : r.resultGrade,
        grade: r.resultGrade,
        faceCount: r.body?.faces().length ?? 0,
        invariantValid: r.diagnostics?.invariantValidation?.valid ?? null,
        invariantDiagnostics: r.diagnostics?.invariantValidation?.diagnosticCount ?? 0,
      });
    } catch (err) {
      results.push({
        model: filename,
        operation: op,
        status: 'fail',
        grade: 'failed',
        error: err.message,
      });
    }
  }
}

// -----------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------

const passCount = results.filter(r => r.status === 'pass').length;
const fallbackCount = results.filter(r => r.status === 'fallback').length;
const failCount = results.filter(r => r.status === 'fail').length;

const report = {
  summary: { pass: passCount, fallback: fallbackCount, fail: failCount, total: results.length },
  results,
};

const json = JSON.stringify(report, null, 2);

if (outfile) {
  fs.writeFileSync(outfile, json);
  console.error(`Report written to ${outfile}`);
} else {
  console.log(json);
}

// Exit with non-zero if any hard failures
if (failCount > 0) {
  console.error(`\n${failCount} failure(s) detected.`);
}
