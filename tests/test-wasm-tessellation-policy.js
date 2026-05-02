import './_watchdog.mjs';
import assert from 'node:assert';

import { buildTopoBody, SurfaceType } from '../js/cad/BRepTopology.js';
import { tessellateBody } from '../js/cad/Tessellation.js';
import { ensureWasmReady } from '../js/cad/StepImportWasm.js';
import { resetFlags, setFlag } from '../js/featureFlags.js';
import { formatTimingSuffix, startTiming } from './test-timing.js';

let passed = 0;
let failed = 0;

async function test(label, fn) {
  const startedAt = startTiming();
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${label}${formatTimingSuffix(startedAt)}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${label}${formatTimingSuffix(startedAt)}`);
    console.log(`    ${err.message}`);
  }
}

function makeBoxBody(x, y, z, width, height, depth) {
  const corners = [
    { x, y, z },
    { x: x + width, y, z },
    { x: x + width, y: y + height, z },
    { x, y: y + height, z },
    { x, y, z: z + depth },
    { x: x + width, y, z: z + depth },
    { x: x + width, y: y + height, z: z + depth },
    { x, y: y + height, z: z + depth },
  ];
  return buildTopoBody([
    { surfaceType: SurfaceType.PLANE, vertices: [corners[3], corners[2], corners[1], corners[0]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [corners[4], corners[5], corners[6], corners[7]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [corners[0], corners[1], corners[5], corners[4]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [corners[2], corners[3], corners[7], corners[6]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [corners[3], corners[0], corners[4], corners[7]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [corners[1], corners[2], corners[6], corners[5]], surface: null, edgeCurves: null, shared: null },
  ]);
}

console.log('WASM tessellation policy tests');

await test('strict tessellation policy keeps simple exact bodies on the WASM path', async () => {
  await ensureWasmReady();
  setFlag('CAD_REQUIRE_WASM_TESSELLATION', true);
  try {
    const mesh = tessellateBody(makeBoxBody(0, 0, 0, 20, 10, 8), { validate: false });
    assert.strictEqual(mesh?._tessellator, 'wasm');
    assert.ok(Array.isArray(mesh?.faces) && mesh.faces.length > 0, 'expected a non-empty mesh');
  } finally {
    resetFlags();
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);