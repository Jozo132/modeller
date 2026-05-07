import assert from 'node:assert/strict';
import { startTiming, formatTimingSuffix } from './test-timing.js';
import {
  createDefaultCamConfig,
  normalizeCamConfig,
  normalizeOperation,
  normalizeTool,
} from '../js/cam/index.js';

function test(name, fn) {
  const startedAt = startTiming();
  fn();
  console.log(`ok - ${name}${formatTimingSuffix(startedAt)}`);
}

const rect = [
  { x: 0, y: 0 },
  { x: 20, y: 0 },
  { x: 20, y: 10 },
  { x: 0, y: 10 },
];

test('default config creates stock, origin, and a usable tool', () => {
  const cam = createDefaultCamConfig({
    bounds: { min: { x: 10, y: 20, z: -2 }, max: { x: 30, y: 50, z: 4 } },
  });

  assert.equal(cam.version, 1);
  assert.equal(cam.units, 'mm');
  assert.equal(cam.postprocessorId, 'linuxcnc');
  assert.deepEqual(cam.stock.min, { x: 5, y: 15, z: -2 });
  assert.deepEqual(cam.stock.max, { x: 35, y: 55, z: 9 });
  assert.deepEqual(cam.machineOrigin.position, { x: 5, y: 15, z: 9 });
  assert.equal(cam.tools.length, 1);
  assert.equal(cam.tools[0].type, 'endmill');
  assert.equal(cam.activeToolId, cam.tools[0].id);
});

test('tool type parameters normalize for ball, cone, drill, and endmill', () => {
  assert.equal(normalizeTool({ type: 'ball', diameter: 8 }).ballRadius, 4);
  assert.equal(normalizeTool({ type: 'cone', diameter: 6, tipDiameter: 1, taperAngle: 45 }).tipDiameter, 1);
  assert.equal(normalizeTool({ type: 'cone', diameter: 6, tipDiameter: 1, taperAngle: 45 }).taperAngle, 45);
  assert.equal(normalizeTool({ type: 'drill', diameter: 3 }).pointAngle, 118);
  assert.equal(normalizeTool({ type: 'endmill', diameter: 4, cornerRadius: 0.25 }).cornerRadius, 0.25);
});

test('profile and pocket operations keep contours and machining defaults', () => {
  const cam = normalizeCamConfig({
    tools: [{ id: 't1', type: 'endmill', diameter: 6, feedRate: 500, plungeRate: 140 }],
    operations: [
      { id: 'profile-a', type: 'profile', toolId: 't1', side: 'inside', source: { loops: [rect] }, topZ: 0, bottomZ: -3, stepDown: 1 },
      { id: 'pocket-a', type: 'pocket', toolId: 't1', source: { loops: [rect] }, topZ: 0, bottomZ: -2 },
    ],
  });

  assert.equal(cam.operations[0].side, 'inside');
  assert.equal(cam.operations[0].source.loops[0].length, 4);
  assert.equal(cam.operations[0].feedRate, 500);
  assert.equal(cam.operations[0].plungeRate, 140);
  assert.ok(Math.abs(cam.operations[1].stepover - 2.4) < 1e-9);
});

test('operation normalization rejects invalid enum values conservatively', () => {
  const operation = normalizeOperation({ type: 'unknown', side: 'invalid', source: { loops: [rect] } }, 0, {
    tools: [normalizeTool({ id: 't1', type: 'endmill' })],
    activeToolId: 't1',
  });

  assert.equal(operation.type, 'profile');
  assert.equal(operation.side, 'outside');
  assert.equal(operation.toolId, 't1');
});