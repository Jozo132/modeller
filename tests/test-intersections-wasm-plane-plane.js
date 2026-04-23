import './_watchdog.mjs';

import assert from 'node:assert/strict';

import * as wasmKernel from '../build/release.js';
import { NurbsSurface } from '../js/cad/NurbsSurface.js';
import { SurfaceType } from '../js/cad/BRepTopology.js';
import { GeometryEvaluator } from '../js/cad/GeometryEvaluator.js';
import { surfaceSurfaceIntersect } from '../js/cad/SurfaceSurfaceIntersect.js';
import {
  _getIntersectionsDebugStateForTests,
  _resetIntersectionsDebugStateForTests,
  intersectSurfaces,
  preloadIntersectionsWasm,
} from '../js/cad/Intersections.js';

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    const maybePromise = fn();
    if (maybePromise && typeof maybePromise.then === 'function') {
      return maybePromise.then(
        () => {
          console.log(`  ✓ ${label}`);
          passed++;
        },
        (err) => {
          console.log(`  ✗ ${label}`);
          console.log(`    ${err && err.stack ? err.stack : err}`);
          failed++;
        },
      );
    }
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${label}`);
    console.log(`    ${err && err.stack ? err.stack : err}`);
    failed++;
  }
}

function makePerpendicularPlanes() {
  const planeXY = NurbsSurface.createPlane(
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 0, y: 10, z: 0 },
  );
  const planeXZ = NurbsSurface.createPlane(
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 0, y: 0, z: 10 },
  );
  return { planeXY, planeXZ };
}

function makeObliquePlanes() {
  const planeA = NurbsSurface.createPlane(
    { x: 4, y: -2, z: 1 },
    { x: 2, y: 0, z: 1 },
    { x: 0, y: 3, z: -1 },
  );
  const planeB = NurbsSurface.createPlane(
    { x: -1, y: 1, z: 2 },
    { x: 1, y: 2, z: 0 },
    { x: 0, y: 1, z: 3 },
  );
  return { planeA, planeB };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function normalize(v) {
  const len = Math.hypot(v.x, v.y, v.z);
  return len === 0 ? { x: 0, y: 0, z: 0 } : {
    x: v.x / len,
    y: v.y / len,
    z: v.z / len,
  };
}

function lineDataFromCurve(curve) {
  const p0 = curve.evaluate(0);
  const p1 = curve.evaluate(1);
  return {
    point: p0,
    dir: normalize({ x: p1.x - p0.x, y: p1.y - p0.y, z: p1.z - p0.z }),
  };
}

function pointLineDistance(point, line) {
  const offset = { x: point.x - line.point.x, y: point.y - line.point.y, z: point.z - line.point.z };
  const perp = cross(offset, line.dir);
  return Math.hypot(perp.x, perp.y, perp.z);
}

function planeEval(plane) {
  return GeometryEvaluator.evalSurface(plane, 0.5, 0.5);
}

function planeResidual(plane, point) {
  const ev = planeEval(plane);
  const offset = { x: point.x - ev.p.x, y: point.y - ev.p.y, z: point.z - ev.p.z };
  return Math.abs(dot(offset, ev.n));
}

function assertLineLiesOnPlanes(line, planeA, planeB, label) {
  assert.ok(planeResidual(planeA, line.point) < 1e-9, `${label}: point must lie on plane A`);
  assert.ok(planeResidual(planeB, line.point) < 1e-9, `${label}: point must lie on plane B`);
  const sample = {
    x: line.point.x + line.dir.x * 17.25,
    y: line.point.y + line.dir.y * 17.25,
    z: line.point.z + line.dir.z * 17.25,
  };
  assert.ok(planeResidual(planeA, sample) < 1e-9, `${label}: direction must stay on plane A`);
  assert.ok(planeResidual(planeB, sample) < 1e-9, `${label}: direction must stay on plane B`);
}

console.log('\n=== Intersections — WASM plane/plane narrowphase (H8 slice) ===\n');

await test('preload required: plane/plane stays on JS before preload', () => {
  const { planeXY, planeXZ } = makePerpendicularPlanes();
  _resetIntersectionsDebugStateForTests();
  const results = intersectSurfaces(planeXY, SurfaceType.PLANE, planeXZ, SurfaceType.PLANE);
  assert.equal(results.length, 1);
  const mid = results[0].curve.evaluate(0.5);
  assert.ok(Math.abs(mid.y) < 1e-6);
  assert.ok(Math.abs(mid.z) < 1e-6);
  const debug = _getIntersectionsDebugStateForTests();
  assert.equal(debug.last, 'js');
  assert.equal(debug.wasmPlanePlaneCalls, 0);
});

await test('after preload: plane/plane dispatches through WASM narrowphase', async () => {
  const ok = await preloadIntersectionsWasm();
  assert.equal(ok, true, 'WASM build must be available for the H8 slice');

  const { planeXY, planeXZ } = makePerpendicularPlanes();
  _resetIntersectionsDebugStateForTests();
  const results = intersectSurfaces(planeXY, SurfaceType.PLANE, planeXZ, SurfaceType.PLANE);
  assert.equal(results.length, 1);

  const start = results[0].curve.evaluate(0.0);
  const end = results[0].curve.evaluate(1.0);
  assert.ok(Math.abs(start.y) < 1e-6 && Math.abs(start.z) < 1e-6);
  assert.ok(Math.abs(end.y) < 1e-6 && Math.abs(end.z) < 1e-6);
  assert.ok(Math.abs(end.x - start.x) > 1000, 'intersection line should be extended along X');

  const debug = _getIntersectionsDebugStateForTests();
  assert.equal(debug.last, 'wasm-plane-plane');
  assert.equal(debug.wasmPlanePlaneCalls, 1);
});

await test('parallel planes still report no intersection through the WASM path', async () => {
  const ok = await preloadIntersectionsWasm();
  assert.equal(ok, true, 'WASM build must be available for the H8 slice');

  const plane1 = NurbsSurface.createPlane(
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 0, y: 10, z: 0 },
  );
  const plane2 = NurbsSurface.createPlane(
    { x: 0, y: 0, z: 5 },
    { x: 10, y: 0, z: 0 },
    { x: 0, y: 10, z: 0 },
  );

  _resetIntersectionsDebugStateForTests();
  const results = intersectSurfaces(plane1, SurfaceType.PLANE, plane2, SurfaceType.PLANE);
  assert.equal(results.length, 0);
  const debug = _getIntersectionsDebugStateForTests();
  assert.equal(debug.last, 'wasm-plane-plane');
  assert.equal(debug.wasmPlanePlaneCalls, 1);
});

await test('raw WASM helper returns a line that lies on both oblique planes', async () => {
  const ok = await preloadIntersectionsWasm();
  assert.equal(ok, true, 'WASM build must be available for the H8 slice');

  const { planeA, planeB } = makeObliquePlanes();
  const evalA = planeEval(planeA);
  const evalB = planeEval(planeB);
  const hit = wasmKernel.planePlaneIntersect(
    evalA.p.x, evalA.p.y, evalA.p.z,
    evalA.n.x, evalA.n.y, evalA.n.z,
    evalB.p.x, evalB.p.y, evalB.p.z,
    evalB.n.x, evalB.n.y, evalB.n.z,
    1e-6,
  );
  assert.equal(hit, 1, 'oblique planes must intersect');

  const out = new Float64Array(wasmKernel.memory.buffer, wasmKernel.getPlanePlaneIntersectPtr(), 6);
  const line = {
    point: { x: out[0], y: out[1], z: out[2] },
    dir: normalize({ x: out[3], y: out[4], z: out[5] }),
  };
  assertLineLiesOnPlanes(line, planeA, planeB, 'raw helper');

  const expectedDir = normalize(cross(evalA.n, evalB.n));
  assert.ok(Math.abs(dot(line.dir, expectedDir)) > 0.999999,
    'raw helper direction must match the plane-normal cross product');
});

await test('JS fallback and WASM dispatch agree on the same oblique infinite line', async () => {
  const { planeA, planeB } = makeObliquePlanes();

  const jsResults = surfaceSurfaceIntersect(planeA, SurfaceType.PLANE, planeB, SurfaceType.PLANE);
  assert.equal(jsResults.length, 1);
  const jsLine = lineDataFromCurve(jsResults[0].curve);
  assertLineLiesOnPlanes(jsLine, planeA, planeB, 'JS solver');

  const ok = await preloadIntersectionsWasm();
  assert.equal(ok, true, 'WASM build must be available for the H8 slice');
  _resetIntersectionsDebugStateForTests();
  const wasmResults = intersectSurfaces(planeA, SurfaceType.PLANE, planeB, SurfaceType.PLANE);
  const wasmDebug = _getIntersectionsDebugStateForTests();
  assert.equal(wasmDebug.last, 'wasm-plane-plane');
  assert.equal(wasmResults.length, 1);
  const wasmLine = lineDataFromCurve(wasmResults[0].curve);
  assertLineLiesOnPlanes(wasmLine, planeA, planeB, 'WASM dispatch');

  assert.ok(Math.abs(dot(jsLine.dir, wasmLine.dir)) > 0.999999,
    'JS and WASM must agree on the infinite-line direction');
  assert.ok(pointLineDistance(jsLine.point, wasmLine) < 1e-9,
    'JS line anchor must lie on the WASM line');
  assert.ok(pointLineDistance(wasmLine.point, jsLine) < 1e-9,
    'WASM line anchor must lie on the JS line');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;