import './_watchdog.mjs';
// tests/test-feature-flags.js — Tests for the centralized feature-flag module
//
// Verifies:
//   - Kernel-stack flags default to ON (new integrated stack)
//   - Safety flags (strict invariants, diagnostics) default to OFF
//   - Boolean parsing accepts '1', 'true', 'yes' (case-insensitive)
//   - Programmatic override via setFlag / resetFlags
//   - allFlags() snapshot reflects overrides
//   - flagDefinitions() returns expected entries
//   - Unknown flag names return undefined

import assert from 'assert';
import {
  getFlag, setFlag, resetFlags, allFlags, flagDefinitions,
} from '../js/featureFlags.js';
import { formatTimingSuffix, startTiming } from './test-timing.js';

let passed = 0;
let failed = 0;

function test(label, fn) {
  const startedAt = startTiming();
  try {
    fn();
    passed++;
    console.log(`  ✓ ${label}${formatTimingSuffix(startedAt)}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${label}${formatTimingSuffix(startedAt)}`);
    console.log(`    ${err.message}`);
  }
}

console.log('Feature-flag tests');

// ── Defaults ────────────────────────────────────────────────────────

test('CAD_USE_IR_CACHE defaults to true', () => {
  resetFlags();
  assert.strictEqual(getFlag('CAD_USE_IR_CACHE'), true);
});

test('CAD_IR_CACHE_MODE defaults to "memory"', () => {
  resetFlags();
  assert.strictEqual(getFlag('CAD_IR_CACHE_MODE'), 'memory');
});

test('CAD_USE_WASM_EVAL defaults to true', () => {
  resetFlags();
  assert.strictEqual(getFlag('CAD_USE_WASM_EVAL'), true);
});

test('CAD_USE_GWN_CONTAINMENT defaults to true', () => {
  resetFlags();
  assert.strictEqual(getFlag('CAD_USE_GWN_CONTAINMENT'), true);
});

test('CAD_USE_ROBUST_TESSELLATOR defaults to true', () => {
  resetFlags();
  assert.strictEqual(getFlag('CAD_USE_ROBUST_TESSELLATOR'), true);
});

test('CAD_REQUIRE_WASM_TESSELLATION defaults to false', () => {
  resetFlags();
  assert.strictEqual(getFlag('CAD_REQUIRE_WASM_TESSELLATION'), false);
});

test('CAD_ALLOW_DISCRETE_FALLBACK defaults to false', () => {
  resetFlags();
  assert.strictEqual(getFlag('CAD_ALLOW_DISCRETE_FALLBACK'), false);
});

test('CAD_STRICT_INVARIANTS defaults to false', () => {
  resetFlags();
  assert.strictEqual(getFlag('CAD_STRICT_INVARIANTS'), false);
});

test('CAD_DIAGNOSTICS_DIR defaults to empty string', () => {
  resetFlags();
  assert.strictEqual(getFlag('CAD_DIAGNOSTICS_DIR'), '');
});

test('CAD_USE_OCCT_STEP_SHADOW defaults to false', () => {
  resetFlags();
  assert.strictEqual(getFlag('CAD_USE_OCCT_STEP_SHADOW'), false);
});

test('CAD_USE_OCCT_BOOLEAN_SHADOW defaults to false', () => {
  resetFlags();
  assert.strictEqual(getFlag('CAD_USE_OCCT_BOOLEAN_SHADOW'), false);
});

test('CAD_USE_OCCT_SKETCH_SOLIDS defaults to false', () => {
  resetFlags();
  assert.strictEqual(getFlag('CAD_USE_OCCT_SKETCH_SOLIDS'), false);
});

// ── Unknown flag ────────────────────────────────────────────────────

test('Unknown flag returns undefined', () => {
  resetFlags();
  assert.strictEqual(getFlag('CAD_NONEXISTENT'), undefined);
});

// ── Programmatic override ───────────────────────────────────────────

test('setFlag overrides a boolean flag', () => {
  resetFlags();
  setFlag('CAD_USE_IR_CACHE', true);
  assert.strictEqual(getFlag('CAD_USE_IR_CACHE'), true);
});

test('setFlag overrides a string flag', () => {
  resetFlags();
  setFlag('CAD_DIAGNOSTICS_DIR', '/tmp/diag');
  assert.strictEqual(getFlag('CAD_DIAGNOSTICS_DIR'), '/tmp/diag');
});

test('setFlag(name, undefined) clears override', () => {
  resetFlags();
  setFlag('CAD_USE_IR_CACHE', false);
  assert.strictEqual(getFlag('CAD_USE_IR_CACHE'), false);
  setFlag('CAD_USE_IR_CACHE', undefined);
  assert.strictEqual(getFlag('CAD_USE_IR_CACHE'), true);
});

test('resetFlags clears all overrides', () => {
  setFlag('CAD_USE_IR_CACHE', false);
  setFlag('CAD_STRICT_INVARIANTS', true);
  resetFlags();
  assert.strictEqual(getFlag('CAD_USE_IR_CACHE'), true);
  assert.strictEqual(getFlag('CAD_STRICT_INVARIANTS'), false);
});

// ── Environment variable parsing (boolean) ──────────────────────────

test('Env "1" → true for boolean flag', () => {
  resetFlags();
  const orig = process.env.CAD_USE_WASM_EVAL;
  try {
    process.env.CAD_USE_WASM_EVAL = '1';
    assert.strictEqual(getFlag('CAD_USE_WASM_EVAL'), true);
  } finally {
    if (orig === undefined) delete process.env.CAD_USE_WASM_EVAL;
    else process.env.CAD_USE_WASM_EVAL = orig;
  }
});

test('Env "true" → true for boolean flag', () => {
  resetFlags();
  const orig = process.env.CAD_USE_WASM_EVAL;
  try {
    process.env.CAD_USE_WASM_EVAL = 'true';
    assert.strictEqual(getFlag('CAD_USE_WASM_EVAL'), true);
  } finally {
    if (orig === undefined) delete process.env.CAD_USE_WASM_EVAL;
    else process.env.CAD_USE_WASM_EVAL = orig;
  }
});

test('Env "YES" → true for boolean flag (case-insensitive)', () => {
  resetFlags();
  const orig = process.env.CAD_USE_WASM_EVAL;
  try {
    process.env.CAD_USE_WASM_EVAL = 'YES';
    assert.strictEqual(getFlag('CAD_USE_WASM_EVAL'), true);
  } finally {
    if (orig === undefined) delete process.env.CAD_USE_WASM_EVAL;
    else process.env.CAD_USE_WASM_EVAL = orig;
  }
});

test('Env "0" → false for boolean flag', () => {
  resetFlags();
  const orig = process.env.CAD_USE_WASM_EVAL;
  try {
    process.env.CAD_USE_WASM_EVAL = '0';
    assert.strictEqual(getFlag('CAD_USE_WASM_EVAL'), false);
  } finally {
    if (orig === undefined) delete process.env.CAD_USE_WASM_EVAL;
    else process.env.CAD_USE_WASM_EVAL = orig;
  }
});

test('Env "random" → false for boolean flag', () => {
  resetFlags();
  const orig = process.env.CAD_USE_WASM_EVAL;
  try {
    process.env.CAD_USE_WASM_EVAL = 'random';
    assert.strictEqual(getFlag('CAD_USE_WASM_EVAL'), false);
  } finally {
    if (orig === undefined) delete process.env.CAD_USE_WASM_EVAL;
    else process.env.CAD_USE_WASM_EVAL = orig;
  }
});

// ── Environment variable parsing (string) ───────────────────────────

test('Env value used as-is for string flag', () => {
  resetFlags();
  const orig = process.env.CAD_IR_CACHE_MODE;
  try {
    process.env.CAD_IR_CACHE_MODE = 'memory';
    assert.strictEqual(getFlag('CAD_IR_CACHE_MODE'), 'memory');
  } finally {
    if (orig === undefined) delete process.env.CAD_IR_CACHE_MODE;
    else process.env.CAD_IR_CACHE_MODE = orig;
  }
});

// ── Override wins over env ──────────────────────────────────────────

test('Programmatic override takes precedence over env', () => {
  const orig = process.env.CAD_USE_WASM_EVAL;
  try {
    process.env.CAD_USE_WASM_EVAL = '1';
    resetFlags();
    setFlag('CAD_USE_WASM_EVAL', false);
    assert.strictEqual(getFlag('CAD_USE_WASM_EVAL'), false);
  } finally {
    resetFlags();
    if (orig === undefined) delete process.env.CAD_USE_WASM_EVAL;
    else process.env.CAD_USE_WASM_EVAL = orig;
  }
});

// ── allFlags snapshot ───────────────────────────────────────────────

test('allFlags() returns snapshot of all 12 flags', () => {
  resetFlags();
  const snap = allFlags();
  assert.strictEqual(Object.keys(snap).length, 12);
  assert.strictEqual(snap.CAD_USE_IR_CACHE, true);
  assert.strictEqual(snap.CAD_IR_CACHE_MODE, 'memory');
  assert.strictEqual(snap.CAD_DIAGNOSTICS_DIR, '');
  assert.strictEqual(snap.CAD_USE_OCCT_STEP_SHADOW, false);
  assert.strictEqual(snap.CAD_USE_OCCT_BOOLEAN_SHADOW, false);
  assert.strictEqual(snap.CAD_USE_OCCT_SKETCH_SOLIDS, false);
});

test('allFlags() snapshot is frozen', () => {
  resetFlags();
  const snap = allFlags();
  assert.throws(() => { snap.CAD_USE_IR_CACHE = false; }, TypeError);
});

// ── flagDefinitions ─────────────────────────────────────────────────

test('flagDefinitions() returns 12 entries', () => {
  const defs = flagDefinitions();
  assert.strictEqual(defs.length, 12);
});

test('flagDefinitions() entries have expected shape', () => {
  const defs = flagDefinitions();
  for (const d of defs) {
    assert.ok(typeof d.name === 'string' && d.name.startsWith('CAD_'), `${d.name} starts with CAD_`);
    assert.ok(d.type === 'boolean' || d.type === 'string', `${d.name} type`);
    assert.ok(typeof d.description === 'string' && d.description.length > 0, `${d.name} description`);
  }
});

test('flagDefinitions() entries are frozen', () => {
  const defs = flagDefinitions();
  assert.throws(() => { defs[0].name = 'X'; }, TypeError);
});

// ── Summary ─────────────────────────────────────────────────────────

resetFlags(); // Clean up
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
