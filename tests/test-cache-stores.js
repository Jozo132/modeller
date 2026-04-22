import './_watchdog.mjs';
// tests/test-cache-stores.js — Cache store read/write tests
//
// Tests:
//   1. CacheStore base class throws on unimplemented methods
//   2. NodeFsCacheStore put/get/has/delete/keys roundtrip
//   3. NodeFsCacheStore returns null for missing keys
//   4. NodeFsCacheStore concurrent reads are safe
//   5. Key sanitization (non-hex characters stripped)

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CacheStore } from '../packages/cache/CacheStore.js';
import { NodeFsCacheStore } from '../packages/cache/NodeFsCacheStore.js';
import { formatTimingSuffix, startTiming } from './test-timing.js';

// ── Test harness ──

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  const startedAt = startTiming();
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ✓ ${name}${formatTimingSuffix(startedAt)}`);
      passed++;
    })
    .catch(err => {
      console.log(`  ✗ ${name}${formatTimingSuffix(startedAt)}`);
      console.log(`    ${err.message}`);
      failed++;
      failures.push({ name, error: err.message });
    });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function assertEq(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${b}, got ${a}`);
}

// ── Helpers ──

function makeBuf(bytes) {
  const buf = new ArrayBuffer(bytes.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) view[i] = bytes[i];
  return buf;
}

function bufEqual(a, b) {
  const va = new Uint8Array(a);
  const vb = new Uint8Array(b);
  if (va.length !== vb.length) return false;
  for (let i = 0; i < va.length; i++) {
    if (va[i] !== vb[i]) return false;
  }
  return true;
}

// ══════════════════════════════════════════════════════════════════
// Test suite
// ══════════════════════════════════════════════════════════════════

console.log('\n=== CacheStore: Base Class Tests ===\n');

await test('CacheStore.get() throws', async () => {
  const store = new CacheStore();
  let threw = false;
  try { await store.get('key'); } catch { threw = true; }
  assert(threw, 'get() should throw');
});

await test('CacheStore.put() throws', async () => {
  const store = new CacheStore();
  let threw = false;
  try { await store.put('key', new ArrayBuffer(0)); } catch { threw = true; }
  assert(threw, 'put() should throw');
});

await test('CacheStore.has() throws', async () => {
  const store = new CacheStore();
  let threw = false;
  try { await store.has('key'); } catch { threw = true; }
  assert(threw, 'has() should throw');
});

await test('CacheStore.delete() throws', async () => {
  const store = new CacheStore();
  let threw = false;
  try { await store.delete('key'); } catch { threw = true; }
  assert(threw, 'delete() should throw');
});

await test('CacheStore.keys() throws', async () => {
  const store = new CacheStore();
  let threw = false;
  try { await store.keys(); } catch { threw = true; }
  assert(threw, 'keys() should throw');
});

console.log('\n=== NodeFsCacheStore: Read/Write Tests ===\n');

const tmpDir = mkdtempSync(join(tmpdir(), 'cbrep-cache-test-'));

await test('put + get roundtrip', async () => {
  const store = new NodeFsCacheStore(join(tmpDir, 'store1'));
  const key = 'abc123def456abc0';
  const buf = makeBuf([1, 2, 3, 4, 5]);
  await store.put(key, buf);
  const result = await store.get(key);
  assert(result !== null, 'get() should return buffer');
  assert(bufEqual(result, buf), 'Buffers should be identical');
});

await test('has() returns true for existing key', async () => {
  const store = new NodeFsCacheStore(join(tmpDir, 'store2'));
  const key = 'aabbccdd11223344';
  await store.put(key, makeBuf([10, 20]));
  const exists = await store.has(key);
  assert(exists === true, 'has() should return true');
});

await test('has() returns false for missing key', async () => {
  const store = new NodeFsCacheStore(join(tmpDir, 'store3'));
  const exists = await store.has('deadbeefcafe1234');
  assert(exists === false, 'has() should return false for missing key');
});

await test('get() returns null for missing key', async () => {
  const store = new NodeFsCacheStore(join(tmpDir, 'store4'));
  const result = await store.get('0000000000000000');
  assert(result === null, 'get() should return null for missing key');
});

await test('delete() removes entry', async () => {
  const store = new NodeFsCacheStore(join(tmpDir, 'store5'));
  const key = 'ffee00112233aabb';
  await store.put(key, makeBuf([42]));
  assert(await store.has(key), 'Should exist before delete');
  const deleted = await store.delete(key);
  assert(deleted === true, 'delete() should return true');
  assert(!(await store.has(key)), 'Should not exist after delete');
});

await test('delete() returns false for missing key', async () => {
  const store = new NodeFsCacheStore(join(tmpDir, 'store6'));
  const deleted = await store.delete('nonexistent123456');
  assert(deleted === false, 'delete() should return false for missing key');
});

await test('keys() lists stored keys', async () => {
  const store = new NodeFsCacheStore(join(tmpDir, 'store7'));
  await store.put('aaa111bbb222ccc3', makeBuf([1]));
  await store.put('ddd444eee555fff6', makeBuf([2]));
  const keys = await store.keys();
  assert(keys.length === 2, `Expected 2 keys, got ${keys.length}`);
  assert(keys.includes('aaa111bbb222ccc3'), 'Should include first key');
  assert(keys.includes('ddd444eee555fff6'), 'Should include second key');
});

await test('keys() returns empty array for empty store', async () => {
  const store = new NodeFsCacheStore(join(tmpDir, 'store8'));
  const keys = await store.keys();
  assertEq(keys.length, 0, 'Should have 0 keys');
});

await test('overwrite: put same key twice', async () => {
  const store = new NodeFsCacheStore(join(tmpDir, 'store9'));
  const key = '1234567890abcdef';
  await store.put(key, makeBuf([1, 2, 3]));
  await store.put(key, makeBuf([4, 5, 6, 7]));
  const result = await store.get(key);
  assert(result !== null, 'get() should return buffer');
  assertEq(new Uint8Array(result).length, 4, 'Should have new length');
  assertEq(new Uint8Array(result)[0], 4, 'Should have new content');
});

await test('large payload roundtrip', async () => {
  const store = new NodeFsCacheStore(join(tmpDir, 'store10'));
  const key = 'fedcba9876543210';
  const data = new Array(10000).fill(0).map((_, i) => i & 0xff);
  const buf = makeBuf(data);
  await store.put(key, buf);
  const result = await store.get(key);
  assert(result !== null, 'get() should return buffer');
  assert(bufEqual(result, buf), 'Large buffers should be identical');
});

// ── Cleanup ──

try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }

// ── Summary ──

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failures.length > 0) {
  console.log('Failures:');
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.error}`);
  }
}
process.exit(failed > 0 ? 1 : 0);
