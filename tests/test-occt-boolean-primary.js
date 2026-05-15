import './_watchdog.mjs';

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { exactBooleanOp } from '../js/cad/BooleanKernel.js';
import { booleanOp } from '../js/cad/BooleanDispatch.js';
import { buildTopoBody, SurfaceType } from '../js/cad/BRepTopology.js';
import { tryBuildOcctExtrudeGeometrySync } from '../js/cad/occt/OcctSketchModeling.js';
import { loadOcctKernelModule } from '../js/cad/occt/OcctKernelLoader.js';
import { ensureWasmReady as ensureTessellationWasmReady } from '../js/cad/StepImportWasm.js';
import { resetFlags, setFlag } from '../js/featureFlags.js';

const LOCAL_DIST_CANDIDATES = [
  process.env.OCCT_KERNEL_DIST,
  process.env.CAD_OCCT_KERNEL_DIST,
  path.resolve('vendor/occt-kernel/dist'),
  path.resolve('vendor/occt-kernel'),
  path.resolve('external/occt-kernel/dist'),
  path.resolve('external/occt-kernel'),
].filter(Boolean);

function resolveDistPath() {
  for (const candidate of LOCAL_DIST_CANDIDATES) {
    if (existsSync(path.join(candidate, 'occt-kernel.js'))
        && existsSync(path.join(candidate, 'occt-kernel.wasm'))) {
      return candidate;
    }
  }
  return null;
}

function makeBox(x, y, z, w, h, d) {
  const c = [
    { x: x, y: y, z: z },
    { x: x + w, y: y, z: z },
    { x: x + w, y: y + h, z: z },
    { x: x, y: y + h, z: z },
    { x: x, y: y, z: z + d },
    { x: x + w, y: y, z: z + d },
    { x: x + w, y: y + h, z: z + d },
    { x: x, y: y + h, z: z + d },
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

function makeRectProfile(width = 10, height = 10) {
  return {
    points: [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ],
    edges: [
      { type: 'segment', pointStartIndex: 0, pointCount: 2 },
      { type: 'segment', pointStartIndex: 1, pointCount: 2 },
      { type: 'segment', pointStartIndex: 2, pointCount: 2 },
      { type: 'segment', pointStartIndex: 3, pointCount: 2 },
    ],
  };
}

console.log('OCCT boolean primary integration\n');

const distPath = resolveDistPath();
if (!distPath) {
  console.log('  skip  OCCT_KERNEL_DIST is unset and no ignored local OCCT dist was found');
  process.exit(0);
}

await Promise.all([
  loadOcctKernelModule({ distPath }),
  ensureTessellationWasmReady().catch(() => false),
]);

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (error) {
    console.error(`  FAIL  ${name}\n    ${error?.message || error}`);
    failed++;
  }
}

await check('exactBooleanOp promotes resident OCCT boolean authority into the result contract', async () => {
  const profile = makeRectProfile();
  const plane = { normal: { x: 0, y: 0, z: 1 } };
  const sketchToWorld = (point) => ({ x: point.x, y: point.y, z: 0 });

  resetFlags();
  setFlag('CAD_USE_OCCT_SKETCH_SOLIDS', true);

  const geomA = tryBuildOcctExtrudeGeometrySync({
    profile,
    plane,
    distance: 10,
    sketchToWorld,
    topoBody: makeBox(0, 0, 0, 10, 10, 10),
  });
  const geomB = tryBuildOcctExtrudeGeometrySync({
    profile,
    plane,
    distance: 10,
    sketchToWorld,
    topoBody: makeBox(0, 0, 0, 10, 10, 10),
  });

  assert.ok(geomA?.occtShapeHandle > 0, 'operand A should carry a resident OCCT handle');
  assert.ok(geomB?.occtShapeHandle > 0, 'operand B should carry a resident OCCT handle');

  const result = exactBooleanOp(
    makeBox(0, 0, 0, 10, 10, 10),
    makeBox(0, 0, 0, 10, 10, 10),
    'union',
    undefined,
    {
      policy: 'force-fallback',
      occtHandleA: geomA.occtShapeHandle,
      occtHandleB: geomB.occtShapeHandle,
    },
  );

  assert.ok(result._occtPrimary?.occtShapeHandle > 0, 'resident OCCT primary payload should be attached');
  assert.equal(result.occtShapeHandle, result._occtPrimary.occtShapeHandle,
    'kernel result should promote the resident OCCT handle to the top-level contract');
  assert.equal(result.occtShapeResident, true,
    'kernel result should expose resident OCCT authority at the top level');
  assert.equal(result.mesh?.occtShapeHandle, result._occtPrimary.occtShapeHandle,
    'kernel result mesh should be promoted to the resident OCCT mesh');
  assert.ok(result.mesh?.faces?.length > 0,
    'kernel result mesh should remain populated after OCCT promotion');
  assert.ok(Array.isArray(result._compatMesh?.faces),
    'kernel result should preserve the compatibility mesh shadow when OCCT is primary');
});

await check('BooleanDispatch consumes the promoted OCCT boolean contract directly', async () => {
  const profile = makeRectProfile();
  const plane = { normal: { x: 0, y: 0, z: 1 } };
  const sketchToWorld = (point) => ({ x: point.x, y: point.y, z: 0 });

  resetFlags();
  setFlag('CAD_USE_OCCT_SKETCH_SOLIDS', true);

  const geomA = tryBuildOcctExtrudeGeometrySync({
    profile,
    plane,
    distance: 10,
    sketchToWorld,
    topoBody: makeBox(0, 0, 0, 10, 10, 10),
  });
  const geomB = tryBuildOcctExtrudeGeometrySync({
    profile,
    plane,
    distance: 10,
    sketchToWorld,
    topoBody: makeBox(0, 0, 0, 10, 10, 10),
  });

  const result = booleanOp(
    { topoBody: makeBox(0, 0, 0, 10, 10, 10), occtShapeHandle: geomA.occtShapeHandle },
    { topoBody: makeBox(0, 0, 0, 10, 10, 10), occtShapeHandle: geomB.occtShapeHandle },
    'union',
  );

  assert.ok(result.occtShapeHandle > 0, 'dispatcher result should preserve the promoted OCCT handle');
  assert.equal(result.occtShapeResident, true,
    'dispatcher result should preserve resident OCCT authority');
  assert.ok(result.faces?.length > 0,
    'dispatcher result should expose the promoted OCCT mesh faces');
});

console.log(`\nOCCT boolean primary: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);