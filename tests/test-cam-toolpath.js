import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startTiming, formatTimingSuffix } from './test-timing.js';
import { depthPasses, generateToolpaths, normalizeCamConfig, offsetPolygon } from '../js/cam/index.js';
import { parseCMOD } from '../js/cmod.js';

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

test('rapid Z retract toggle can emit feed retracts for all toolpaths', () => {
  const cam = normalizeCamConfig({
    safeZ: 6,
    clearanceZ: 4,
    rapidZRetract: false,
    stock: { min: { x: 0, y: 0, z: -1 }, max: { x: 10, y: 5, z: 0 } },
    tools: [{ id: 'tool-a', number: 3, type: 'endmill', diameter: 2, feedRate: 300, plungeRate: 90 }],
    operations: [{ id: 'profile-a', type: 'profile', toolId: 'tool-a', side: 'outside', source: { loops: [rect] }, topZ: 0, bottomZ: -1, stepDown: 1 }],
  });
  const { toolpaths } = generateToolpaths(cam);
  const zRapids = toolpaths[0].moves.filter((move) => move.type === 'rapid' && move.z != null);
  const zFeeds = toolpaths[0].moves.filter((move) => move.type === 'feed' && move.z != null);
  const xyRapids = toolpaths[0].moves.filter((move) => move.type === 'rapid' && move.x != null && move.y != null);

  assert.equal(zRapids.length, 0);
  assert.ok(zFeeds.some((move) => move.z === 4), 'expected clearance retract to use a feed move');
  assert.ok(zFeeds.some((move) => move.z === 6), 'expected safe Z retract to use a feed move');
  assert.ok(xyRapids.length > 0, 'expected XY traverses to remain rapid');
});

test('face milling operations raster the stock outline', () => {
  const cam = normalizeCamConfig({
    stock: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 6, z: 2 } },
    tools: [{ id: 'tool-a', type: 'endmill', diameter: 2, feedRate: 300, plungeRate: 90 }],
    operations: [{ id: 'face-a', type: 'face', toolId: 'tool-a', topZ: 2, bottomZ: 1.5, stepDown: 0.5 }],
  });
  const { toolpaths, warnings } = generateToolpaths(cam);

  assert.equal(warnings.length, 0);
  assert.equal(toolpaths.length, 1);
  assert.equal(toolpaths[0].operationType, 'face');
  assert.ok(toolpaths[0].moves.some((move) => move.type === 'feed' && move.x != null && move.y != null));
  const firstXYRapid = toolpaths[0].moves.find((move) => move.type === 'rapid' && move.x != null && move.y != null);
  assert.ok(firstXYRapid.x >= 0 && firstXYRapid.x <= 10);
  assert.ok(firstXYRapid.y >= 0 && firstXYRapid.y <= 6);
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
  const plungeMoves = toolpaths[0].moves.filter((move) => move.type === 'feed' && move.z != null);
  const xyFeeds = toolpaths[0].moves.filter((move) => move.type === 'feed' && move.x != null && move.y != null);
  const innerShellIndex = xyFeeds.findIndex((move) => Math.abs(move.x - 5) < 1e-6 && Math.abs(move.y - 5.5) < 1e-6);
  const outerShellIndex = xyFeeds.findIndex((move) => Math.abs(move.x - 5) < 1e-6 && Math.abs(move.y - 1) < 1e-6);

  assert.equal(xyRapids.length, 1);
  assert.equal(plungeMoves.length, 1);
  assert.deepEqual({ x: xyRapids[0].x, y: xyRapids[0].y }, { x: 5, y: 5 });
  assert.ok(innerShellIndex >= 0, 'expected an innermost contour shell to start from the center anchor');
  assert.ok(outerShellIndex > innerShellIndex, 'expected contour shells to expand from the center out to the wall');
  assert.ok(xyFeeds.some((move) => Math.abs(move.x - 5) < 1e-6 && Math.abs(move.y - 2.5) < 1e-6), 'expected an intermediate contour shell');
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

test('one-way pockets retract between scan lines and keep one cutting direction', () => {
  const cam = normalizeCamConfig({
    tools: [{ id: 'tool-pocket', type: 'flat-endmill', diameter: 2, feedRate: 500, plungeRate: 120 }],
    operations: [{
      id: 'op-pocket-oneway',
      type: 'pocket',
      toolId: 'tool-pocket',
      topZ: 0,
      bottomZ: -1,
      stepDown: 1,
      stepoverPercent: 100,
      pocketStrategy: 'oneway-x',
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
  const passEntries = collectPassEntries(moves);

  assert.equal(plungeMoves.length, xyRapids.length);
  assert.ok(plungeMoves.length > 1, 'one-way pockets should re-enter for each scan line');
  assert.ok(passEntries.length >= 4, 'expected several one-way raster cuts');
  assert.ok(passEntries.every((entry) => entry.end.x > entry.start.x), 'one-way-x should cut in a single positive X direction');
  assert.ok(passEntries.every((entry) => Math.abs(entry.end.y - entry.start.y) <= 1e-6), 'one-way passes should stay on a single scan line');
});

test('complex contour pockets stay contour-parallel instead of rasterizing', () => {
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
    tools: [{ id: 'tool-a', type: 'endmill', diameter: 4, feedRate: 300, plungeRate: 90 }],
    operations: [{
      id: 'pocket-contour-island',
      type: 'pocket',
      toolId: 'tool-a',
      source: { loops: [outer, island] },
      topZ: 0,
      bottomZ: -1,
      stepDown: 1,
      stepoverPercent: 50,
      pocketStrategy: 'contour',
    }],
  });

  const moves = generateToolpaths(cam).toolpaths[0].moves;
  const plungeMoves = moves.filter((move) => move.type === 'feed' && Number.isFinite(move.z));
  const xyRapids = moves.filter((move) => move.type === 'rapid' && Number.isFinite(move.x) && Number.isFinite(move.y));

  assert.equal(plungeMoves.length, xyRapids.length);
  assert.ok(plungeMoves.length > 2, 'complex contour pockets should create multiple contour shells, not a single raster path');
  assert.ok(xyRapids.some((move) => move.x < 8), 'left side of the pocket should be machined');
  assert.ok(xyRapids.some((move) => move.x > 16), 'right side of the pocket should be machined');
  assert.ok(xyRapids.every((move) => !(move.x > 8 && move.x < 16 && move.y > 6 && move.y < 20)), 'contour shells should keep the island clear');
});

test('face-surface pockets re-evaluate active sub-pockets at each depth', () => {
  const outer = [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 20 },
    { x: 0, y: 20 },
  ];
  const inner = [
    { x: 6, y: 6 },
    { x: 14, y: 6 },
    { x: 14, y: 14 },
    { x: 6, y: 14 },
  ];
  const cam = normalizeCamConfig({
    tools: [{ id: 'tool-a', type: 'endmill', diameter: 2, feedRate: 300, plungeRate: 90 }],
    operations: [{
      id: 'surface-pocket',
      type: 'pocket',
      toolId: 'tool-a',
      topZ: 0,
      bottomZ: -4,
      stepDown: 2,
      pocketStrategy: 'contour',
      source: {
        type: 'face',
        loops: [outer, inner],
        surfaces: [
          { referenceId: 'surface-outer', label: 'Outer shelf', z: -2, loops: [outer] },
          { referenceId: 'surface-inner', label: 'Inner relief', z: -4, loops: [inner] },
        ],
      },
    }],
  });

  const moves = generateToolpaths(cam).toolpaths[0].moves;
  const plungeStarts = collectPlungeStarts(moves);
  const shallowStarts = plungeStarts.filter((entry) => Math.abs(entry.z - (-2)) <= 1e-6);
  const deepStarts = plungeStarts.filter((entry) => Math.abs(entry.z - (-4)) <= 1e-6);

  assert.equal(shallowStarts.length, 2, 'expected the shallower depth to machine both active surface pockets');
  assert.equal(deepStarts.length, 1, 'expected only the deeper inner relief to remain active at the second depth');
});

test('sample contour pocket uses contour shells when exact face geometry is available', () => {
  const samplePath = new URL('./samples/machinning-sample.cmod', import.meta.url);
  const parsed = parseCMOD(readFileSync(samplePath, 'utf8'));
  assert.equal(parsed.ok, true);

  const cam = normalizeCamConfig(parsed.data.cam);
  const operation = cam.operations.find((candidate) => candidate.type === 'pocket');
  assert.ok(operation);
  operation.source.segmentLoops = operation.source.loops.map((loop) => loop.map((start, index) => ({
    type: 'line',
    start,
    end: loop[(index + 1) % loop.length],
  })));

  const moves = generateToolpaths(cam).toolpaths[0].moves;
  const feedSegments = collectFeedSegments(moves).slice(0, 20);
  assert.ok(!hasRasterSweepPattern(feedSegments, 15, 2), 'expected contour-following opening moves instead of stepped raster sweeps');
});

test('contour pockets can plunge outside stock and feed in from an open side', () => {
  const cam = normalizeCamConfig({
    stock: { min: { x: 0, y: 0, z: -1 }, max: { x: 20, y: 20, z: 0 } },
    tools: [{ id: 'tool-pocket', type: 'flat-endmill', diameter: 2, feedRate: 500, plungeRate: 120 }],
    operations: [{
      id: 'op-pocket-side-entry',
      type: 'pocket',
      toolId: 'tool-pocket',
      topZ: 0,
      bottomZ: -1,
      stepDown: 1,
      stepoverPercent: 75,
      pocketStrategy: 'contour',
      sideEntryEnabled: true,
      leadInLength: 3,
      source: {
        loops: [[
          { x: 0, y: 4 },
          { x: 12, y: 4 },
          { x: 12, y: 16 },
          { x: 0, y: 16 },
        ]],
      },
    }],
  });

  const moves = generateToolpaths(cam).toolpaths[0].moves;
  const firstXYRapid = moves.find((move) => move.type === 'rapid' && Number.isFinite(move.x) && Number.isFinite(move.y));
  const firstPlungeIndex = moves.findIndex((move) => move.type === 'feed' && Number.isFinite(move.z));
  const firstContourFeed = moves.slice(firstPlungeIndex + 1).find((move) => move.type === 'feed' && Number.isFinite(move.x) && Number.isFinite(move.y));

  assert.deepEqual({ x: firstXYRapid.x, y: firstXYRapid.y }, { x: -3, y: 10 });
  assert.ok(firstPlungeIndex >= 0, 'expected a plunge move');
  assert.deepEqual({ x: firstContourFeed.x, y: firstContourFeed.y }, { x: 5.5, y: 10 });
});

test('contour side-entry falls back to a normal entry when the pocket is closed in stock', () => {
  const cam = normalizeCamConfig({
    stock: { min: { x: 0, y: 0, z: -1 }, max: { x: 20, y: 20, z: 0 } },
    tools: [{ id: 'tool-pocket', type: 'flat-endmill', diameter: 2, feedRate: 500, plungeRate: 120 }],
    operations: [{
      id: 'op-pocket-closed-side-entry',
      type: 'pocket',
      toolId: 'tool-pocket',
      topZ: 0,
      bottomZ: -1,
      stepDown: 1,
      stepoverPercent: 75,
      pocketStrategy: 'contour',
      sideEntryEnabled: true,
      leadInLength: 3,
      source: {
        loops: [[
          { x: 4, y: 4 },
          { x: 12, y: 4 },
          { x: 12, y: 16 },
          { x: 4, y: 16 },
        ]],
      },
    }],
  });

  const moves = generateToolpaths(cam).toolpaths[0].moves;
  const firstXYRapid = moves.find((move) => move.type === 'rapid' && Number.isFinite(move.x) && Number.isFinite(move.y));

  assert.deepEqual({ x: firstXYRapid.x, y: firstXYRapid.y }, { x: 8, y: 10 });
});

test('open contour side-entry extends outside stock by at least one tool diameter', () => {
  const cam = normalizeCamConfig({
    stock: { min: { x: 0, y: 0, z: -1 }, max: { x: 20, y: 20, z: 0 } },
    tools: [{ id: 'tool-pocket', type: 'flat-endmill', diameter: 2, feedRate: 500, plungeRate: 120 }],
    operations: [{
      id: 'op-pocket-diameter-extension',
      type: 'pocket',
      toolId: 'tool-pocket',
      topZ: 0,
      bottomZ: -1,
      stepDown: 1,
      stepoverPercent: 75,
      pocketStrategy: 'contour',
      sideEntryEnabled: true,
      leadInLength: 0,
      source: {
        loops: [[
          { x: 0, y: 4 },
          { x: 12, y: 4 },
          { x: 12, y: 16 },
          { x: 0, y: 16 },
        ]],
      },
    }],
  });

  const moves = generateToolpaths(cam).toolpaths[0].moves;
  const firstXYRapid = moves.find((move) => move.type === 'rapid' && Number.isFinite(move.x) && Number.isFinite(move.y));

  assert.deepEqual({ x: firstXYRapid.x, y: firstXYRapid.y }, { x: -2, y: 10 });
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

function collectPassEntries(moves) {
  const passes = [];
  let pendingStart = null;
  let armedAfterPlunge = false;

  for (const move of moves) {
    if (move.type === 'rapid' && Number.isFinite(move.x) && Number.isFinite(move.y)) {
      pendingStart = { x: move.x, y: move.y };
      armedAfterPlunge = false;
      continue;
    }
    if (move.type === 'feed' && Number.isFinite(move.z) && pendingStart) {
      armedAfterPlunge = true;
      continue;
    }
    if (armedAfterPlunge && move.type === 'feed' && Number.isFinite(move.x) && Number.isFinite(move.y)) {
      passes.push({ start: pendingStart, end: { x: move.x, y: move.y } });
      pendingStart = null;
      armedAfterPlunge = false;
    }
  }

  return passes;
}

function collectPlungeStarts(moves) {
  const starts = [];
  let pendingRapid = null;
  for (const move of moves) {
    if (move.type === 'rapid' && Number.isFinite(move.x) && Number.isFinite(move.y)) {
      pendingRapid = { x: move.x, y: move.y };
      continue;
    }
    if (move.type === 'feed' && Number.isFinite(move.z) && pendingRapid) {
      starts.push({ ...pendingRapid, z: move.z });
      pendingRapid = null;
    }
  }
  return starts;
}

function collectFeedSegments(moves) {
  const segments = [];
  let previous = null;
  for (const move of moves) {
    if (move.type !== 'feed' || !Number.isFinite(move.x) || !Number.isFinite(move.y)) continue;
    if (previous && Number.isFinite(previous.x) && Number.isFinite(previous.y)) {
      const dx = move.x - previous.x;
      const dy = move.y - previous.y;
      segments.push({
        from: { x: previous.x, y: previous.y },
        to: { x: move.x, y: move.y },
        axis: Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y',
        length: Math.hypot(dx, dy),
      });
    }
    previous = move;
  }
  return segments;
}

function hasRasterSweepPattern(segments, minSweepLength, maxStepOver) {
  for (let index = 0; index + 2 < segments.length; index++) {
    const first = segments[index];
    const connector = segments[index + 1];
    const second = segments[index + 2];
    const firstDx = first.to.x - first.from.x;
    const secondDx = second.to.x - second.from.x;
    if (first.axis !== 'x' || second.axis !== 'x' || connector.axis !== 'y') continue;
    if (first.length <= minSweepLength || second.length <= minSweepLength) continue;
    if (connector.length > maxStepOver) continue;
    if (Math.sign(firstDx) === 0 || Math.sign(secondDx) === 0) continue;
    if (Math.sign(firstDx) !== Math.sign(secondDx)) return true;
  }
  return false;
}
