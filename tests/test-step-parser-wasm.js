// tests/test-step-parser-wasm.js — parity test for the native STEP entity parser
//
// Stage B of the WASM STEP migration.  Verifies parseStepEntitiesSync()
// produces the same {id, type, args} shape as the existing JS
// _resolveEntities() for every simple entity in the corpus.
//
// Complex entities are checked structurally — the WASM parser emits
// __COMPLEX_WASM__ with sub-entity pairs; the JS parser emits the
// merged type (e.g. RATIONAL_B_SPLINE_CURVE) with combined args.  Both
// must reach the same merged form after the wiring in StepImport.js.

import './_watchdog.mjs';
import assert from 'assert';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { ensureStepParserReady, parseStepEntitiesSync } from '../js/cad/StepParserWasm.js';
import { _resolveEntitiesForTest } from '../js/cad/StepImport.js';
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
    if (err.stack) {
      for (const l of err.stack.split('\n').slice(1, 4)) console.log(`    ${l.trim()}`);
    }
    failed++;
  }
}

await ensureStepParserReady();

console.log('Running test-step-parser-wasm.js');

const files = [
  fileURLToPath(new URL('./step/box-fillet-3.step', import.meta.url)),
  fileURLToPath(new URL('./step/Unnamed-Body.step', import.meta.url)),
];

function argsEqual(a, b, path) {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) throw new Error(`${path}: length ${a.length} vs ${b.length}`);
    for (let i = 0; i < a.length; i++) argsEqual(a[i], b[i], `${path}[${i}]`);
    return;
  }
  if (a === null || b === null) {
    if (a !== b) throw new Error(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    return;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    if (a !== b && !(Number.isNaN(a) && Number.isNaN(b))) {
      // numbers must match exactly — both come from parseFloat on identical text
      throw new Error(`${path}: number ${a} vs ${b}`);
    }
    return;
  }
  if (a !== b) {
    throw new Error(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
}

for (const path of files) {
  const name = path.split(/[\\/]/).pop();
  const src = readFileSync(path, 'utf-8');

  test(`${name} — entity count matches JS`, () => {
    const jsMap = _resolveEntitiesForTest(src);
    const wasmMap = parseStepEntitiesSync(src);
    assert.strictEqual(wasmMap.size, jsMap.size,
      `entity count: WASM ${wasmMap.size} vs JS ${jsMap.size}`);
  });

  test(`${name} — every simple entity has identical args`, () => {
    const jsMap = _resolveEntitiesForTest(src);
    const wasmMap = parseStepEntitiesSync(src);
    let checked = 0;
    let skippedComplex = 0;
    for (const [id, wasmEnt] of wasmMap) {
      if (wasmEnt.type === '__COMPLEX_WASM__') { skippedComplex++; continue; }
      const jsEnt = jsMap.get(id);
      if (!jsEnt) throw new Error(`entity #${id} missing in JS`);
      // Simple entities should have the same type token
      assert.strictEqual(wasmEnt.type, jsEnt.type,
        `entity #${id}: type WASM=${wasmEnt.type} JS=${jsEnt.type}`);
      argsEqual(wasmEnt.args, jsEnt.args, `#${id}.args`);
      checked++;
    }
    console.log(`    (${checked} simple entities checked, ${skippedComplex} complex)`);
  });

  test(`${name} — complex entities decode as pair lists`, () => {
    const wasmMap = parseStepEntitiesSync(src);
    let complexCount = 0;
    for (const [, ent] of wasmMap) {
      if (ent.type !== '__COMPLEX_WASM__') continue;
      complexCount++;
      assert.ok(Array.isArray(ent.args), 'complex args is array');
      for (const pair of ent.args) {
        assert.ok(Array.isArray(pair) && pair.length === 2, 'pair = [keyword, args]');
        assert.strictEqual(typeof pair[0], 'string', 'keyword is string');
        assert.ok(Array.isArray(pair[1]), 'sub-args is array');
      }
    }
    console.log(`    (${complexCount} complex entities)`);
  });
}

// ── Synthetic: null / ref / nested lists / escaped string ──────────
test('synthetic — full arg-kind coverage', () => {
  const src = `ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1 = FOO('a''b', 42, -1.5E-3, #2, $, *, .T., (#3, #4));\n#2 = BAR();\n#3 = BAZ();\n#4 = BAZ();\nENDSEC;\nEND-ISO-10303-21;\n`;
  const js = _resolveEntitiesForTest(src);
  const wasm = parseStepEntitiesSync(src);
  assert.strictEqual(wasm.size, js.size);
  for (const [id, jsEnt] of js) {
    argsEqual(wasm.get(id).args, jsEnt.args, `#${id}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
