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
  assert.equal(cam.stock.opacity, 0.18);
  assert.equal(cam.stock.visible, true);
  assert.deepEqual(cam.machineOrigin.position, { x: 5, y: 15, z: 9 });
  assert.equal(cam.safeZ, 19);
  assert.equal(cam.clearanceZ, 14);
  assert.equal(cam.rapidZRetract, true);
  assert.equal(cam.tools.length, 1);
  assert.equal(cam.tools[0].type, 'endmill');
  assert.equal(cam.activeToolId, cam.tools[0].id);
  assert.deepEqual(cam.operations, []);
  assert.equal(cam.activeOperationId, null);
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
    safeZ: 22,
    clearanceZ: 17,
    rapidZRetract: false,
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
  assert.equal(cam.operations[1].pocketOrder, 'per-level');
  assert.equal(cam.operations[1].pocketStrategy, 'contour');
  assert.equal(cam.operations[1].sideEntryEnabled, false);
  assert.equal(cam.safeZ, 22);
  assert.equal(cam.clearanceZ, 17);
  assert.equal(cam.rapidZRetract, false);
  assert.equal(cam.operations[0].safeZ, 22);
  assert.equal(cam.operations[1].safeZ, 22);
  assert.equal(cam.operations[0].clearanceZ, 17);
  assert.equal(cam.operations[1].clearanceZ, 17);
  assert.equal(cam.operations[0].rapidZRetract, false);
  assert.equal(cam.operations[1].rapidZRetract, false);
  assert.equal(cam.operations[0].visible, true);
  assert.equal(cam.operations[1].visible, true);
  assert.equal(cam.linuxCncUseG5, true);
});

test('face milling operations normalize to stock outline defaults', () => {
  const cam = normalizeCamConfig({
    stock: { min: { x: 1, y: 2, z: -1 }, max: { x: 11, y: 12, z: 4 } },
    tools: [{ id: 't1', type: 'endmill', diameter: 6 }],
    operations: [{ id: 'face-a', type: 'face', toolId: 't1' }],
  });

  assert.equal(cam.operations[0].type, 'face');
  assert.equal(cam.operations[0].source.type, 'stock-outline');
  assert.deepEqual(cam.operations[0].source.loops[0], [
    { x: 1, y: 2 },
    { x: 11, y: 2 },
    { x: 11, y: 12 },
    { x: 1, y: 12 },
  ]);
  assert.equal(cam.operations[0].bottomZ, 4);
  assert.equal(cam.operations[0].pocketOrder, 'per-level');
  assert.equal(cam.operations[0].pocketStrategy, 'zigzag-x');
  assert.equal(cam.operations[0].sideEntryEnabled, false);
});

test('preview visibility flags normalize independently from machining flags', () => {
  const cam = normalizeCamConfig({
    stock: { visible: false },
    tools: [{ id: 't1', type: 'endmill', diameter: 6 }],
    operations: [{ id: 'profile-a', type: 'profile', toolId: 't1', enabled: false, visible: false, source: { loops: [rect] } }],
  });

  assert.equal(cam.stock.enabled, true);
  assert.equal(cam.stock.visible, false);
  assert.equal(cam.operations[0].enabled, false);
  assert.equal(cam.operations[0].visible, false);
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

test('face-derived source metadata keeps topobody references and tolerance', () => {
  const cam = normalizeCamConfig({
    tools: [{ id: 't1', type: 'endmill', diameter: 6 }],
    operations: [{
      id: 'profile-a',
      type: 'profile',
      toolId: 't1',
      source: {
        type: 'face',
        referenceId: 'topoface-42',
        faceIndex: 7,
        topoFaceId: 42,
        tolerance: 0.0005,
        loops: [rect],
      },
    }],
  });
  assert.equal(cam.operations[0].source.referenceId, 'topoface-42');
  assert.equal(cam.operations[0].source.faceIndex, 7);
  assert.equal(cam.operations[0].source.topoFaceId, 42);
  assert.equal(cam.operations[0].source.tolerance, 0.0005);
});
