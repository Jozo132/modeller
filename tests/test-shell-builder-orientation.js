import assert from 'node:assert/strict';
import { buildTopoBody, SurfaceType } from '../js/cad/BRepTopology.js';
import { buildBody } from '../js/cad/ShellBuilder.js';
import { resetFlags, setFlag } from '../js/featureFlags.js';
import { startTiming, formatTimingSuffix } from './test-timing.js';

function test(name, fn) {
  const startedAt = startTiming();
  try {
    fn();
    console.log(`ok - ${name}${formatTimingSuffix(startedAt)}`);
  } finally {
    resetFlags();
  }
}

function boxFaceDescs() {
  const corners = [
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 10, y: 8, z: 0 },
    { x: 0, y: 8, z: 0 },
    { x: 0, y: 0, z: 6 },
    { x: 10, y: 0, z: 6 },
    { x: 10, y: 8, z: 6 },
    { x: 0, y: 8, z: 6 },
  ];
  return [
    [corners[3], corners[2], corners[1], corners[0]],
    [corners[4], corners[5], corners[6], corners[7]],
    [corners[0], corners[1], corners[5], corners[4]],
    [corners[1], corners[2], corners[6], corners[5]],
    [corners[2], corners[3], corners[7], corners[6]],
    [corners[3], corners[0], corners[4], corners[7]],
  ].map((vertices) => ({ surfaceType: SurfaceType.PLANE, vertices }));
}

test('shell stitching orientation is independent of tessellation fallback policy', () => {
  setFlag('CAD_REQUIRE_WASM_TESSELLATION', true);
  const source = buildTopoBody(boxFaceDescs());
  const body = buildBody(source.faces());
  assert.equal(body.shells.length, 1);
  assert.equal(body.faces().length, 6);
  assert.equal(body.outerShell().closed, true);
});
