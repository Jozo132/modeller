// tests/bench/evaluator-bench.js — Evaluator throughput benchmark
//
// Measures single-point and batch evaluation throughput for
// both WASM and JS fallback paths across various geometry fixtures.
// Includes allocation count tracking.
//
// Usage: node tests/bench/evaluator-bench.js

import { NurbsCurve, NurbsSurface, wasmTessellation, GeometryEvaluator } from '../../js/cad/index.js';

function bench(name, fn, iterations) {
  // Warmup
  for (let i = 0; i < Math.min(100, iterations); i++) fn();

  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsed = performance.now() - start;

  const opsPerSec = (iterations / elapsed * 1000).toFixed(0);
  const usPerOp = ((elapsed * 1000) / iterations).toFixed(2);
  console.log(`  ${name}: ${opsPerSec} ops/s  (${usPerOp} µs/op, ${iterations} iters in ${elapsed.toFixed(1)} ms)`);
  return { name, opsPerSec: parseFloat(opsPerSec), usPerOp: parseFloat(usPerOp), elapsed };
}

/**
 * Measure allocation counts using V8's gc() if exposed, or
 * approximate via heapUsed delta.
 */
function measureAllocations(name, fn, iterations) {
  const gc = globalThis.gc;
  if (gc) gc();

  const before = process.memoryUsage();
  for (let i = 0; i < iterations; i++) fn();
  const after = process.memoryUsage();

  const heapDelta = after.heapUsed - before.heapUsed;
  const bytesPerOp = (heapDelta / iterations).toFixed(0);
  console.log(`  ${name}: ~${bytesPerOp} bytes/op heap delta (${iterations} iters)`);
  return { name, heapDelta, bytesPerOp: parseFloat(bytesPerOp) };
}

// ─── Setup ────────────────────────────────────────────────────────────

console.log('=== Geometry Evaluator Benchmark ===\n');

const wasmReady = await wasmTessellation.init();
const geomReady = await GeometryEvaluator.initWasm();
console.log(`WASM available: ${wasmReady && geomReady}\n`);

// ─── Fixtures ─────────────────────────────────────────────────────────

const line = NurbsCurve.createLine({ x: 0, y: 0, z: 0 }, { x: 10, y: 5, z: 3 });
const arc = NurbsCurve.createArc(
  { x: 0, y: 0, z: 0 }, 5,
  { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 },
  0, Math.PI
);
const circle = NurbsCurve.createCircle(
  { x: 0, y: 0, z: 0 }, 5,
  { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }
);
const plane = NurbsSurface.createPlane(
  { x: 0, y: 0, z: 0 },
  { x: 10, y: 0, z: 0 },
  { x: 0, y: 10, z: 0 }
);
const cylinder = NurbsSurface.createCylinder(
  { x: 0, y: 0, z: 0 },
  { x: 0, y: 0, z: 1 }, 5, 10,
  { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }
);

const N = 10000;
const results = [];

// ─── Curve benchmarks ─────────────────────────────────────────────────

console.log('--- Curve evaluation (throughput) ---');

results.push(bench('evalCurve(line)', () => GeometryEvaluator.evalCurve(line, 0.5), N));
results.push(bench('evalCurve(arc)', () => GeometryEvaluator.evalCurve(arc, 0.5), N));
results.push(bench('evalCurve(circle)', () => GeometryEvaluator.evalCurve(circle, 0.37), N));

// Batch curve
const curveBatchParams = new Float64Array(100);
for (let i = 0; i < 100; i++) curveBatchParams[i] = i / 99;

results.push(bench('evalCurveBatch(circle, 100)', () => GeometryEvaluator.evalCurveBatch(circle, curveBatchParams), N / 10));

// ─── Surface benchmarks ──────────────────────────────────────────────

console.log('\n--- Surface evaluation (throughput) ---');

results.push(bench('evalSurface(plane)', () => GeometryEvaluator.evalSurface(plane, 0.5, 0.5), N));
results.push(bench('evalSurface(cylinder)', () => GeometryEvaluator.evalSurface(cylinder, 0.5, 0.5), N));

// Batch surface
const surfBatchParams = new Float64Array(200);
for (let i = 0; i < 100; i++) {
  surfBatchParams[i * 2] = (i % 10) / 9;
  surfBatchParams[i * 2 + 1] = Math.floor(i / 10) / 9;
}

results.push(bench('evalSurfaceBatch(cylinder, 100)', () => GeometryEvaluator.evalSurfaceBatch(cylinder, surfBatchParams), N / 10));

// ─── Comparison: old evaluate() vs new evalCurve() ───────────────────

console.log('\n--- Comparison: evaluate() vs evalCurve() ---');

results.push(bench('circle.evaluate(0.37)', () => circle.evaluate(0.37), N));
results.push(bench('GeomEval.evalCurve(circle, 0.37)', () => GeometryEvaluator.evalCurve(circle, 0.37), N));

results.push(bench('plane.evaluate(0.5, 0.5)', () => plane.evaluate(0.5, 0.5), N));
results.push(bench('GeomEval.evalSurface(plane, 0.5, 0.5)', () => GeometryEvaluator.evalSurface(plane, 0.5, 0.5), N));

// ─── Allocation tracking ─────────────────────────────────────────────

console.log('\n--- Allocation tracking (heap delta per op) ---');

const allocN = 1000;
measureAllocations('evalCurve(circle)', () => GeometryEvaluator.evalCurve(circle, 0.37), allocN);
measureAllocations('evalSurface(cylinder)', () => GeometryEvaluator.evalSurface(cylinder, 0.5, 0.5), allocN);
measureAllocations('evalCurveBatch(circle, 100)', () => GeometryEvaluator.evalCurveBatch(circle, curveBatchParams), allocN);
measureAllocations('evalSurfaceBatch(cyl, 100)', () => GeometryEvaluator.evalSurfaceBatch(cylinder, surfBatchParams), allocN);

// ─── Summary ─────────────────────────────────────────────────────────

console.log('\n--- Summary ---');
console.log(`Total benchmarks: ${results.length}`);
console.log(`WASM backend: ${wasmReady && geomReady ? 'active' : 'JS fallback'}`);

console.log('\n=== Done ===');
