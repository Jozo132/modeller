// tests/test-telemetry.js — Tests for the Telemetry module

import { Telemetry, telemetry } from '../js/telemetry.js';

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

function assertClose(a, b, eps, msg) {
  assert(Math.abs(a - b) <= eps, `${msg} — expected ~${b}, got ${a}`);
}

// ── Singleton exists ────────────────────────────────────────────────
console.log('Singleton:');
{
  assert(telemetry instanceof Telemetry, 'telemetry is a Telemetry');
  telemetry.reset();
}

// ── Timers ──────────────────────────────────────────────────────────
console.log('Timers:');
{
  telemetry.reset();
  telemetry.startTimer('test');
  // Simulate ~10 ms of work
  const start = Date.now();
  while (Date.now() - start < 10) { /* spin */ }
  const dur = telemetry.endTimer('test');
  assert(dur >= 5, `endTimer returns duration >= 5ms, got ${dur}`);

  const s = telemetry.summary();
  assertEq(s.timers.length, 1, 'one timer recorded');
  assertEq(s.timers[0].label, 'test', 'timer label');
  assert(s.timers[0].duration >= 5, `timer duration >= 5ms`);
}

{
  // endTimer with no matching start returns -1
  telemetry.reset();
  const dur = telemetry.endTimer('nonexistent');
  assertEq(dur, -1, 'no matching start → -1');
}

{
  telemetry.reset();
  const dur = telemetry.recordTimer('recorded', 12.5, 100);
  assertClose(dur, 12.5, 0.001, 'recordTimer returns recorded duration');
  const s = telemetry.summary();
  assertEq(s.timers.length, 1, 'one timer recorded via recordTimer()');
  assertEq(s.timers[0].label, 'recorded', 'recorded timer label');
  assertClose(s.timers[0].duration, 12.5, 0.001, 'recorded timer duration');
  assertClose(s.timers[0].startTime, 100, 0.001, 'recorded timer start time');
}

// ── time() convenience ──────────────────────────────────────────────
console.log('time():');
{
  telemetry.reset();
  const result = telemetry.time('sync-op', () => 42);
  assertEq(result, 42, 'time() returns function result');
  assertEq(telemetry.summary().timers.length, 1, 'one timer after time()');
}

// ── timeAsync() convenience ─────────────────────────────────────────
console.log('timeAsync():');
{
  telemetry.reset();
  const result = await telemetry.timeAsync('async-op', async () => {
    return 'done';
  });
  assertEq(result, 'done', 'timeAsync() returns async result');
  assertEq(telemetry.summary().timers.length, 1, 'one timer after timeAsync()');
}

// ── Cache tracking ──────────────────────────────────────────────────
console.log('Cache tracking:');
{
  telemetry.reset();
  telemetry.recordCacheHit();
  telemetry.recordCacheHit();
  telemetry.recordCacheMiss();

  const s = telemetry.summary();
  assertEq(s.cacheHits, 2, '2 hits');
  assertEq(s.cacheMisses, 1, '1 miss');
  assertClose(s.cacheHitRate, 2 / 3, 0.01, 'hit rate ~0.667');
}

{
  // No lookups → NaN hit rate
  telemetry.reset();
  const s = telemetry.summary();
  assert(Number.isNaN(s.cacheHitRate), 'no lookups → NaN hit rate');
}

// ── Interaction latency ─────────────────────────────────────────────
console.log('Interaction latency:');
{
  telemetry.reset();
  telemetry.recordInteraction(16.7);
  telemetry.recordInteraction(33.4);
  const s = telemetry.summary();
  assertEq(s.interactions.length, 2, '2 interaction samples');
  assertClose(s.interactions[0], 16.7, 0.01, 'first sample');
  assertClose(s.interactions[1], 33.4, 0.01, 'second sample');
}

// ── timersFor() ─────────────────────────────────────────────────────
console.log('timersFor():');
{
  telemetry.reset();
  telemetry.startTimer('import:step'); telemetry.endTimer('import:step');
  telemetry.startTimer('import:dxf');  telemetry.endTimer('import:dxf');
  telemetry.startTimer('tessellation'); telemetry.endTimer('tessellation');

  const importTimers = telemetry.timersFor('import');
  assertEq(importTimers.length, 2, '2 import timers');
  assertEq(telemetry.timersFor('tessellation').length, 1, '1 tessellation timer');
  assertEq(telemetry.timersFor('nonexistent').length, 0, '0 for unknown prefix');
}

// ── reset() ─────────────────────────────────────────────────────────
console.log('reset():');
{
  telemetry.recordCacheHit();
  telemetry.recordInteraction(10);
  telemetry.startTimer('x'); telemetry.endTimer('x');
  telemetry.reset();

  const s = telemetry.summary();
  assertEq(s.timers.length, 0, 'timers cleared');
  assertEq(s.cacheHits, 0, 'cache hits cleared');
  assertEq(s.cacheMisses, 0, 'cache misses cleared');
  assertEq(s.interactions.length, 0, 'interactions cleared');
  assertEq(s.longTasks.length, 0, 'long tasks cleared');
}

// ── summary() is frozen ─────────────────────────────────────────────
console.log('summary() frozen:');
{
  telemetry.reset();
  const s = telemetry.summary();
  assert(Object.isFrozen(s), 'summary is frozen');
}

// ── Multiple Telemetry instances ────────────────────────────────────
console.log('Multiple instances:');
{
  const t1 = new Telemetry();
  const t2 = new Telemetry();
  t1.recordCacheHit();
  assertEq(t2.summary().cacheHits, 0, 'instances are independent');
}

// ── Long tasks observer (no-op in Node) ─────────────────────────────
console.log('Long tasks observer:');
{
  telemetry.reset();
  // Should not throw in Node.js even though PerformanceObserver may not support longtask
  telemetry.observeLongTasks();
  telemetry.stopLongTaskObserver();
  assertEq(telemetry.summary().longTasks.length, 0, 'no long tasks in Node');
}

// ── Summary ─────────────────────────────────────────────────────────
console.log(`\nTotal: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
