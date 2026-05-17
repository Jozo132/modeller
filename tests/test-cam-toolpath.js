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

test('pocket toolpaths keep islands clear and treat narrow necks as separate pockets', () => {
  const outer = [
    { x: 0, y: 0 },
    { x: 24, y: 0 },
    { x: 24, y: 20 },
    { x: 0, y: 20 },
  ];
  const island = [
    { x: 8, y: 6 },
    { x: 16, y: 6 },
    { x: 16, y: 20 },
    { x: 8, y: 20 },
  ];
  const cam = normalizeCamConfig({
    tools: [{ id: 'tool-a', type: 'endmill', diameter: 6 }],
    operations: [{
      id: 'pocket-islands',
      type: 'pocket',
      toolId: 'tool-a',
      source: { loops: [outer, island] },
      topZ: 0,
      bottomZ: -1,
      stepDown: 1,
      stepoverPercent: 100,
    }],
  });
  const { toolpaths } = generateToolpaths(cam);
  const xyRapids = toolpaths[0].moves.filter((move) => move.type === 'rapid' && move.x != null && move.y != null);

  assert.ok(xyRapids.some((move) => move.x < 8), 'left pocket should be machined');
  assert.ok(xyRapids.some((move) => move.x > 16), 'right pocket should be machined');
  assert.ok(xyRapids.every((move) => !(move.x > 8 && move.x < 16 && move.y > 6 && move.y < 20)), 'island and blocked neck should stay clear');
});

test('concave pocket surfaces split narrow bridges that are smaller than the tool diameter', () => {
  const dumbbell = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 4 },
    { x: 14, y: 4 },
    { x: 14, y: 0 },
    { x: 24, y: 0 },
    { x: 24, y: 10 },
    { x: 14, y: 10 },
    { x: 14, y: 6 },
    { x: 10, y: 6 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  const cam = normalizeCamConfig({
    tools: [{ id: 'tool-a', type: 'endmill', diameter: 6 }],
    operations: [{
      id: 'concave-pocket',
      type: 'pocket',
      toolId: 'tool-a',
      source: { loops: [dumbbell] },
      topZ: 0,
      bottomZ: -1,
      stepDown: 1,
      stepoverPercent: 100,
    }],
  });
  const { toolpaths } = generateToolpaths(cam);
  const xyRapids = toolpaths[0].moves.filter((move) => move.type === 'rapid' && move.x != null && move.y != null);

  assert.ok(xyRapids.some((move) => move.x < 10), 'left lobe should be machined');
  assert.ok(xyRapids.some((move) => move.x > 14), 'right lobe should be machined');
  assert.ok(xyRapids.every((move) => !(move.x > 10 && move.x < 14 && move.y > 4 && move.y < 6)), 'bridge smaller than the cutter should stay clear');
});

test('pocket order can finish each pocket before moving to the next depth', () => {
  const leftPocket = [
    { x: 0, y: 0 },
    { x: 6, y: 0 },
    { x: 6, y: 6 },
    { x: 0, y: 6 },
  ];
  const rightPocket = [
    { x: 12, y: 0 },
    { x: 18, y: 0 },
    { x: 18, y: 6 },
    { x: 12, y: 6 },
  ];
  const cam = normalizeCamConfig({
    tools: [{ id: 'tool-a', type: 'endmill', diameter: 2 }],
    operations: [{
      id: 'pocket-order',
      type: 'pocket',
      toolId: 'tool-a',
      source: { loops: [leftPocket, rightPocket] },
      topZ: 0,
      bottomZ: -2,
      stepDown: 1,
      stepoverPercent: 100,
      pocketOrder: 'per-pocket',
    }],
  });
  const { toolpaths } = generateToolpaths(cam);
  const plungeStarts = [];
  let pendingRapid = null;
  for (const move of toolpaths[0].moves) {
    if (move.type === 'rapid' && move.x != null && move.y != null) {
      pendingRapid = { x: move.x, y: move.y };
      continue;
    }
    if (move.type === 'feed' && move.z != null && pendingRapid) {
      plungeStarts.push({ ...pendingRapid, z: move.z });
      pendingRapid = null;
    }
  }

  assert.deepEqual(
    plungeStarts.slice(0, 4).map(({ x, z }) => ({ side: x < 10 ? 'left' : 'right', z })),
    [
      { side: 'left', z: -1 },
      { side: 'left', z: -2 },
      { side: 'right', z: -1 },
      { side: 'right', z: -2 },
    ],
  );
});

test('pocket strategies can switch raster direction', () => {
  const baseOperation = {
    id: 'op-pocket',
    name: 'Pocket',
    type: 'pocket',
    toolId: 'tool-pocket',
    topZ: 0,
    bottomZ: -1,
    stepDown: 1,
    stepoverPercent: 100,
    source: {
      loops: [[
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 12 },
        { x: 0, y: 12 },
      ]],
    },
  };

  const horizontalConfig = normalizeCamConfig({
    tools: [{ id: 'tool-pocket', type: 'flat-endmill', diameter: 2, feedRate: 500, plungeRate: 120 }],
    operations: [{ ...baseOperation, id: 'op-pocket-x', pocketStrategy: 'zigzag-x' }],
  });
  const verticalConfig = normalizeCamConfig({
    tools: [{ id: 'tool-pocket', type: 'flat-endmill', diameter: 2, feedRate: 500, plungeRate: 120 }],
    operations: [{ ...baseOperation, id: 'op-pocket-y', pocketStrategy: 'zigzag-y' }],
  });

  const horizontalMoves = generateToolpaths(horizontalConfig).toolpaths[0].moves.filter((move) => move.type === 'feed' && Number.isFinite(move.x) && Number.isFinite(move.y));
  const verticalMoves = generateToolpaths(verticalConfig).toolpaths[0].moves.filter((move) => move.type === 'feed' && Number.isFinite(move.x) && Number.isFinite(move.y));

  const longestHorizontalStep = longestFeedStep(horizontalMoves);
  const longestVerticalStep = longestFeedStep(verticalMoves);
  assert.ok(longestHorizontalStep);
  assert.ok(longestVerticalStep);

  const horizontalDx = Math.abs(longestHorizontalStep.to.x - longestHorizontalStep.from.x);
  const horizontalDy = Math.abs(longestHorizontalStep.to.y - longestHorizontalStep.from.y);
  const verticalDx = Math.abs(longestVerticalStep.to.x - longestVerticalStep.from.x);
  const verticalDy = Math.abs(longestVerticalStep.to.y - longestVerticalStep.from.y);

  assert.ok(horizontalDx > horizontalDy, `expected horizontal zig-zag pass, got dx=${horizontalDx}, dy=${horizontalDy}`);
  assert.ok(verticalDy > verticalDx, `expected vertical zig-zag pass, got dx=${verticalDx}, dy=${verticalDy}`);
});

test('zig-zag pockets stay down across connected scan lines', () => {
  const cam = normalizeCamConfig({
    tools: [{ id: 'tool-pocket', type: 'flat-endmill', diameter: 2, feedRate: 500, plungeRate: 120 }],
    operations: [{
      id: 'op-pocket-x',
      type: 'pocket',
      toolId: 'tool-pocket',
      topZ: 0,
      bottomZ: -1,
      stepDown: 1,
      stepoverPercent: 100,
      pocketStrategy: 'zigzag-x',
      source: {
        loops: [[
          { x: 0, y: 0 },
          { x: 20, y: 0 },
          { x: 20, y: 12 },
          { x: 0, y: 12 },
        ]],
      },
    }],
  });

  const moves = generateToolpaths(cam).toolpaths[0].moves;
  const plungeMoves = moves.filter((move) => move.type === 'feed' && Number.isFinite(move.z));
  const xyRapids = moves.filter((move) => move.type === 'rapid' && Number.isFinite(move.x) && Number.isFinite(move.y));

  assert.equal(plungeMoves.length, 1);
  assert.equal(xyRapids.length, 1);
});

test('profile along exact segment loops preserves arc moves', () => {
  const camConfig = normalizeCamConfig({
    tools: [{ id: 'tool-profile', type: 'flat-endmill', diameter: 2, feedRate: 400, plungeRate: 120 }],
    operations: [{
      id: 'op-profile',
      name: 'Arc profile',
      type: 'profile',
      toolId: 'tool-profile',
      side: 'along',
      topZ: 0,
      bottomZ: -1,
      stepDown: 1,
      source: {
        loops: [[
          { x: 0, y: 0 },
          { x: 4, y: 0 },
          { x: 0, y: 4 },
        ]],
        segmentLoops: [[
          { type: 'line', start: { x: 0, y: 0 }, end: { x: 4, y: 0 } },
          { type: 'arc', start: { x: 4, y: 0 }, end: { x: 0, y: 4 }, center: { x: 0, y: 0 }, clockwise: false },
          { type: 'line', start: { x: 0, y: 4 }, end: { x: 0, y: 0 } },
        ]],
      },
    }],
  });

  const { toolpaths } = generateToolpaths(camConfig);
  assert.ok(toolpaths[0].moves.some((move) => move.type === 'arc'));
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

function longestFeedStep(moves) {
  let best = null;
  for (let index = 1; index < moves.length; index++) {
    const from = moves[index - 1];
    const to = moves[index];
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    if (!best || length > best.length) best = { from, to, length };
  }
  return best;
}
