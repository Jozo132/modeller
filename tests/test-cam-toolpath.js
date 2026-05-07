import assert from 'node:assert/strict';
import { startTiming, formatTimingSuffix } from './test-timing.js';
import { depthPasses, generateToolpaths, normalizeCamConfig, offsetPolygon } from '../js/cam/index.js';

function test(name, fn) {
  const startedAt = startTiming();
  fn();
  console.log(`ok - ${name}${formatTimingSuffix(startedAt)}`);
}

const rect = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 5 },
  { x: 0, y: 5 },
];

test('polygon offset grows and shrinks a rectangle by tool radius', () => {
  const outside = offsetPolygon(rect, 1);
  const inside = offsetPolygon(rect, -1);
  assert.deepEqual(outside[0], { x: -1, y: -1 });
  assert.deepEqual(inside[0], { x: 1, y: 1 });
  assert.deepEqual(offsetPolygon(rect, -6), []);
});

test('profile toolpaths offset outside contours and cut requested depth passes', () => {
  const cam = normalizeCamConfig({
    stock: { min: { x: 0, y: 0, z: -2 }, max: { x: 10, y: 5, z: 0 } },
    tools: [{ id: 'tool-a', number: 3, type: 'endmill', diameter: 2, feedRate: 300, plungeRate: 90 }],
    operations: [{ id: 'profile-a', type: 'profile', toolId: 'tool-a', side: 'outside', source: { loops: [rect] }, topZ: 0, bottomZ: -2, stepDown: 1 }],
  });
  const { toolpaths, warnings } = generateToolpaths(cam);

  assert.equal(warnings.length, 0);
  assert.equal(toolpaths.length, 1);
  const firstXYRapid = toolpaths[0].moves.find((move) => move.type === 'rapid' && move.x != null && move.y != null);
  assert.deepEqual({ x: firstXYRapid.x, y: firstXYRapid.y }, { x: -1, y: -1 });
  const plungeDepths = toolpaths[0].moves.filter((move) => move.type === 'feed' && move.z != null).map((move) => move.z);
  assert.deepEqual(plungeDepths, [-1, -2]);
});

test('pocket toolpaths create inward stepover loops', () => {
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  const cam = normalizeCamConfig({
    tools: [{ id: 'tool-a', type: 'endmill', diameter: 2 }],
    operations: [{ id: 'pocket-a', type: 'pocket', toolId: 'tool-a', source: { loops: [square] }, topZ: 0, bottomZ: -1, stepDown: 1, stepoverPercent: 75 }],
  });
  const { toolpaths } = generateToolpaths(cam);
  const xyRapids = toolpaths[0].moves.filter((move) => move.type === 'rapid' && move.x != null && move.y != null);

  assert.ok(xyRapids.length >= 2);
  assert.deepEqual({ x: xyRapids[0].x, y: xyRapids[0].y }, { x: 1, y: 1 });
  assert.ok(xyRapids[1].x > xyRapids[0].x);
  assert.ok(xyRapids[1].y > xyRapids[0].y);
  for (const rapid of xyRapids) {
    assert.ok(rapid.x >= 0 && rapid.x <= 10);
    assert.ok(rapid.y >= 0 && rapid.y <= 10);
  }
});

test('lead-in parameters add a zig-zag before the selected path start', () => {
  const cam = normalizeCamConfig({
    tools: [{ id: 'tool-a', type: 'endmill', diameter: 2 }],
    operations: [{
      id: 'profile-a',
      type: 'profile',
      toolId: 'tool-a',
      side: 'along',
      source: { loops: [rect] },
      topZ: 0,
      bottomZ: -1,
      stepDown: 1,
      leadInEnabled: true,
      leadInLength: 2,
      leadInZigZagAmplitude: 0.5,
      leadInZigZagCount: 2,
      leadInPosition: 0.5,
    }],
  });
  const { toolpaths } = generateToolpaths(cam);
  const xyFeeds = toolpaths[0].moves.filter((move) => move.type === 'feed' && move.x != null && move.y != null);
  assert.ok(xyFeeds.length > rect.length);
  assert.deepEqual({ x: xyFeeds[1].x, y: xyFeeds[1].y }, { x: 10, y: 5 });
});

test('operation order controls generated toolpath execution order', () => {
  const firstLoop = [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 4 },
    { x: 0, y: 4 },
  ];
  const secondLoop = [
    { x: 10, y: 10 },
    { x: 14, y: 10 },
    { x: 14, y: 14 },
    { x: 10, y: 14 },
  ];
  const cam = normalizeCamConfig({
    tools: [{ id: 'tool-a', type: 'endmill', diameter: 2 }],
    operations: [
      { id: 'profile-first', name: 'First op', type: 'profile', toolId: 'tool-a', source: { loops: [firstLoop] }, topZ: 0, bottomZ: -1, stepDown: 1 },
      { id: 'profile-second', name: 'Second op', type: 'profile', toolId: 'tool-a', source: { loops: [secondLoop] }, topZ: 0, bottomZ: -1, stepDown: 1 },
    ],
  });

  assert.deepEqual(generateToolpaths(cam).toolpaths.map((toolpath) => toolpath.operationId), ['profile-first', 'profile-second']);

  const reorderedCam = normalizeCamConfig({ ...cam, operations: [cam.operations[1], cam.operations[0]] });
  assert.deepEqual(generateToolpaths(reorderedCam).toolpaths.map((toolpath) => toolpath.operationId), ['profile-second', 'profile-first']);
});

test('depth pass helper includes the exact final depth', () => {
  assert.deepEqual(depthPasses(0, -2.5, 1), [-1, -2, -2.5]);
  assert.deepEqual(depthPasses(-2, 0, 1.25), [-0.75, 0]);
});
