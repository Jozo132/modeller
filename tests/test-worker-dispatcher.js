import './_watchdog.mjs';
// tests/test-worker-dispatcher.js — Tests for WorkerDispatcher + collectTransferables
//
// These tests run in Node.js and exercise the Transferable-collection
// logic.  The actual Worker dispatch is browser-only, so we only test
// the utility functions here.

import { collectTransferables } from '../js/workers/WorkerDispatcher.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function assertEq(a, b, msg) {
  assert(a === b, `${msg} — expected ${b}, got ${a}`);
}

// ── collectTransferables ────────────────────────────────────────────

console.log('collectTransferables:');

{
  // Primitives return empty
  const r = collectTransferables('hello');
  assertEq(r.length, 0, 'string → no transferables');
}

{
  const r = collectTransferables(42);
  assertEq(r.length, 0, 'number → no transferables');
}

{
  const r = collectTransferables(null);
  assertEq(r.length, 0, 'null → no transferables');
}

{
  const r = collectTransferables(undefined);
  assertEq(r.length, 0, 'undefined → no transferables');
}

{
  const r = collectTransferables(true);
  assertEq(r.length, 0, 'boolean → no transferables');
}

{
  // ArrayBuffer is collected
  const buf = new ArrayBuffer(16);
  const r = collectTransferables(buf);
  assertEq(r.length, 1, 'ArrayBuffer → 1 transferable');
  assert(r[0] === buf, 'ArrayBuffer identity');
}

{
  // Zero-length ArrayBuffer is NOT collected
  const buf = new ArrayBuffer(0);
  const r = collectTransferables(buf);
  assertEq(r.length, 0, 'empty ArrayBuffer → no transferable');
}

{
  // Typed array → its underlying buffer
  const ta = new Float32Array(10);
  const r = collectTransferables(ta);
  assertEq(r.length, 1, 'Float32Array → 1 transferable');
  assert(r[0] === ta.buffer, 'Float32Array buffer identity');
}

{
  // Uint8Array
  const ta = new Uint8Array(8);
  const r = collectTransferables(ta);
  assertEq(r.length, 1, 'Uint8Array → 1 transferable');
}

{
  // Nested in plain object
  const obj = { a: 1, data: new Float32Array(5) };
  const r = collectTransferables(obj);
  assertEq(r.length, 1, 'nested typed array in object → 1 transferable');
}

{
  // Nested in array
  const arr = [new ArrayBuffer(4), 'hello', new Uint8Array(3)];
  const r = collectTransferables(arr);
  assertEq(r.length, 2, 'array with 2 buffers → 2 transferables');
}

{
  // Deduplicated — same buffer referenced multiple ways
  const buf = new ArrayBuffer(32);
  const a = new Float32Array(buf, 0, 4);
  const b = new Uint8Array(buf);
  const r = collectTransferables({ a, b, raw: buf });
  assertEq(r.length, 1, 'same buffer deduped → 1 transferable');
}

{
  // Deeply nested
  const buf = new ArrayBuffer(8);
  const r = collectTransferables({ x: { y: { z: buf } } });
  assertEq(r.length, 1, 'deeply nested buffer → 1 transferable');
}

{
  // Function values are skipped
  const r = collectTransferables({ fn: () => {} });
  assertEq(r.length, 0, 'function → no transferables');
}

{
  // Mixed payload with _dispatchId (real-world shape)
  const packed = new Float32Array(100);
  const msg = {
    type: 'result',
    vertices: packed,
    body: { faces: [{ normal: { x: 0, y: 0, z: 1 } }] },
    _dispatchId: 7,
  };
  const r = collectTransferables(msg);
  assertEq(r.length, 1, 'real-world message → 1 transferable');
  assert(r[0] === packed.buffer, 'real-world buffer identity');
}

console.log(`\ncollectTransferables: ${passed} passed, ${failed} failed`);

// ── Summary ─────────────────────────────────────────────────────────

console.log(`\nTotal: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
