import './_watchdog.mjs';

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ensureOcctStepShadowReady,
  importSTEP,
  importSTEPAsync,
} from '../js/cad/StepImport.js';
import { resetFlags, setFlag } from '../js/featureFlags.js';
import { invalidateOcctKernelModuleCache } from '../js/cad/occt/index.js';

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

const stepFilePath = fileURLToPath(new URL('./step/box-fillet-3.step', import.meta.url));
const stepData = readFileSync(stepFilePath, 'utf-8');
const distPath = resolveDistPath();

console.log('OCCT STEP shadow integration\n');

if (!distPath) {
  console.log('  skip  OCCT_KERNEL_DIST is unset and no ignored local OCCT dist was found');
  process.exit(0);
}

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

setFlag('CAD_USE_IR_CACHE', false);
setFlag('CAD_USE_OCCT_STEP_SHADOW', true);

await check('sync import reports OCCT shadow not ready before preload', async () => {
  invalidateOcctKernelModuleCache();
  const result = importSTEP(stepData, { occtShadow: true, occtDistPath: distPath });
  assert.equal(result._occtShadow?.enabled, true, 'shadow metadata should be attached');
  assert.equal(result._occtShadow?.ready, false, 'shadow should be skipped before preload');
  assert.equal(result._occtShadow?.skippedReason, 'occt-not-ready');
});

await check('explicit preload enables sync shadow import summaries', async () => {
  const ready = await ensureOcctStepShadowReady({ occtShadow: true, occtDistPath: distPath });
  assert.equal(ready, true, 'preload should resolve successfully');

  const result = importSTEP(stepData, { occtShadow: true, occtDistPath: distPath });
  assert.equal(result._occtShadow?.ok, true, 'shadow import should succeed');
  assert.equal(result._occtShadow?.valid, true, 'OCCT STEP shape should validate');
  assert.ok(result._occtShadow?.topology?.faceCount > 0, 'OCCT topology should be populated');
  assert.ok(result.timings.occtShadowTotalMs >= 0, 'shadow timings should be recorded');
  assert.ok(result._occtShadow?.summary?.comparison, 'shadow comparison summary should be present');
});

await check('async import preloads and records OCCT shadow automatically', async () => {
  invalidateOcctKernelModuleCache();
  const result = await importSTEPAsync(stepData, { occtShadow: true, occtDistPath: distPath });
  assert.equal(result._occtShadow?.ok, true, 'async import should attach a successful shadow result');
  assert.ok(result._occtShadow?.summary?.occt?.meshFaceCount > 0, 'OCCT shadow mesh should contain faces');
  assert.ok(result._occtShadow?.summary?.comparison?.boundingBoxDelta?.maxAbsDelta < 0.1,
    'shadow bounding box should remain close to the primary import');
});

resetFlags();

console.log(`\nOCCT STEP shadow: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);