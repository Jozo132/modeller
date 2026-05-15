import './_watchdog.mjs';

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { booleanOp } from '../js/cad/BooleanDispatch.js';
import { ensureOcctBooleanShadowReady, exactBooleanOp } from '../js/cad/BooleanKernel.js';
import { buildTopoBody, SurfaceType } from '../js/cad/BRepTopology.js';
import { invalidateOcctKernelModuleCache } from '../js/cad/occt/index.js';
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
    if (existsSync(path.join(candidate, 'occt-kernel.js')) &&
        existsSync(path.join(candidate, 'occt-kernel.wasm'))) {
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

console.log('OCCT boolean shadow integration\n');

const distPath = resolveDistPath();
if (!distPath) {
  console.log('  skip  OCCT_KERNEL_DIST is unset and no ignored local OCCT dist was found');
  process.exit(0);
}

const previousOcctDist = process.env.OCCT_KERNEL_DIST;
process.env.OCCT_KERNEL_DIST = distPath;

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

setFlag('CAD_USE_OCCT_BOOLEAN_SHADOW', true);

await check('exactBooleanOp reports shadow not ready before preload', async () => {
  invalidateOcctKernelModuleCache();
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(20, 0, 0, 10, 10, 10);
  const result = exactBooleanOp(boxA, boxB, 'union');
  assert.equal(result._occtShadow?.enabled, true, 'shadow metadata should be attached');
  assert.equal(result._occtShadow?.ready, false, 'shadow should be skipped before preload');
  assert.equal(result._occtShadow?.skippedReason, 'occt-not-ready');
});

await check('explicit preload enables exact boolean OCCT shadow summaries', async () => {
  const ready = await ensureOcctBooleanShadowReady({ occtBooleanShadow: true, occtDistPath: distPath });
  assert.equal(ready, true, 'preload should resolve successfully');

  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(20, 0, 0, 10, 10, 10);
  const result = exactBooleanOp(boxA, boxB, 'union');
  const operandA = result._occtShadow?.imports?.operandA;
  const operandB = result._occtShadow?.imports?.operandB;
  assert.equal(result._occtShadow?.ok, true, 'shadow boolean should succeed');
  assert.equal(result._occtShadow?.valid, true, 'shadow boolean should now validate in OCCT');
  assert.equal(operandA?.transferStatus, 'DONE', 'operand A STEP transfer should succeed');
  assert.equal(operandB?.transferStatus, 'DONE', 'operand B STEP transfer should succeed');
  assert.ok(operandA?.shapeHandle > 0, 'operand A should produce an OCCT shape handle');
  assert.ok(operandB?.shapeHandle > 0, 'operand B should produce an OCCT shape handle');
  assert.equal(operandA?.isValid, true, 'operand A import should now validate in OCCT');
  assert.equal(operandB?.isValid, true, 'operand B import should now validate in OCCT');
  assert.equal(operandA?.messageList?.some((message) => message.phase === 'validation'), false,
    'operand A import should not emit validation warnings');
  assert.equal(operandB?.messageList?.some((message) => message.phase === 'validation'), false,
    'operand B import should not emit validation warnings');
  assert.ok(result._occtShadow?.summary?.occt?.meshFaceCount > 0, 'shadow mesh should contain faces');
  assert.ok(result._occtShadow?.summary?.comparison?.boundingBoxDelta?.maxAbsDelta < 0.1,
    'shadow bounding box should remain close to the primary boolean result');
  assert.ok(result.diagnostics?.occtShadow?.timings?.totalMs >= 0, 'shadow timings should be recorded in diagnostics');
});

await check('BooleanDispatch preserves OCCT shadow metadata', async () => {
  const boxA = makeBox(0, 0, 0, 10, 10, 10);
  const boxB = makeBox(20, 0, 0, 10, 10, 10);
  const geom = booleanOp({ topoBody: boxA }, { topoBody: boxB }, 'union');
  assert.equal(geom._occtShadow?.ok, true, 'dispatcher result should preserve shadow metadata');
  assert.ok(geom.diagnostics?.occtShadow?.summary, 'dispatcher result should preserve diagnostics');
  assert.ok(geom.resultGrade, 'dispatcher result should preserve boolean result grade');
});

resetFlags();
if (previousOcctDist == null) delete process.env.OCCT_KERNEL_DIST;
else process.env.OCCT_KERNEL_DIST = previousOcctDist;

console.log(`\nOCCT boolean shadow: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);