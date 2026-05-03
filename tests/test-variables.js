import './_watchdog.mjs';
import assert from 'node:assert';

import {
  clearVariables,
  resolveAllVariables,
  resolveValue,
  setVariable,
} from '../js/cad/Constraint.js';
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

console.log('Variable resolver tests');

test('batch variable resolver matches scalar resolver for formulas', () => {
  clearVariables();
  setVariable('width', 20);
  setVariable('height', 'width * 2');
  setVariable('depth', 'height + width / 2');

  const resolved = resolveAllVariables();
  assert.strictEqual(resolved.get('width'), resolveValue('width'));
  assert.strictEqual(resolved.get('height'), resolveValue('height'));
  assert.strictEqual(resolved.get('depth'), resolveValue('depth'));
});

test('batch variable resolver memoizes long dependency chains', () => {
  clearVariables();
  const count = 1000;
  for (let i = 0; i < count; i++) {
    setVariable(`v${i}`, i === 0 ? 1 : `v${i - 1} + 1`);
  }

  const resolved = resolveAllVariables();
  assert.strictEqual(resolved.size, count);
  assert.strictEqual(resolved.get(`v${count - 1}`), count);
});

test('batch variable resolver returns NaN for cycles', () => {
  clearVariables();
  setVariable('a', 'b + 1');
  setVariable('b', 'a + 1');

  const resolved = resolveAllVariables();
  assert.ok(Number.isNaN(resolved.get('a')));
  assert.ok(Number.isNaN(resolved.get('b')));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
