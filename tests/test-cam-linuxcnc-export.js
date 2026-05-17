import assert from 'node:assert/strict';
import { startTiming, formatTimingSuffix } from './test-timing.js';
import {
  exportGCode,
  generateToolpaths,
  listPostprocessors,
  normalizeCamConfig,
  getPostprocessor,
  registerPostprocessor,
} from '../js/cam/index.js';

function test(name, fn) {
  const startedAt = startTiming();
  fn();
  console.log(`ok - ${name}${formatTimingSuffix(startedAt)}`);
}

const rect = [
  { x: 0, y: 0 },
  { x: 8, y: 0 },
  { x: 8, y: 4 },
  { x: 0, y: 4 },
];

function sampleCam() {
  return normalizeCamConfig({
    tools: [{ id: 'tool-7', number: 7, name: 'Rougher', type: 'endmill', diameter: 2, feedRate: 321, plungeRate: 87, spindleRpm: 12000, coolant: true }],
    operations: [{ id: 'profile-a', name: 'Outside wall', type: 'profile', toolId: 'tool-7', side: 'along', source: { loops: [rect] }, topZ: 0, bottomZ: -1, stepDown: 1 }],
  });
}

test('LinuxCNC export includes modal setup, tool change, spindle, coolant, and end code', () => {
  const { gcode, warnings } = exportGCode(sampleCam(), { programName: 'Bracket job' });

  assert.equal(warnings.length, 0);
  assert.match(gcode, /\(Bracket job\)/);
  assert.match(gcode, /G21\nG90\nG17/);
  assert.match(gcode, /T7 M6/);
  assert.match(gcode, /S12000 M3/);
  assert.match(gcode, /M8/);
  assert.match(gcode, /G1 Z-1 F87/);
  assert.match(gcode, /G1 X8 Y0 F321/);
  assert.match(gcode, /M2/);
});

test('explicit toolpaths can be postprocessed without regenerating', () => {
  const cam = sampleCam();
  const generated = generateToolpaths(cam);
  const { gcode } = exportGCode(cam, generated.toolpaths, { programName: 'Explicit paths' });
  assert.match(gcode, /\(Explicit paths\)/);
  assert.match(gcode, /Outside wall/);
});

test('postprocessor registry supports future custom processors', () => {
  registerPostprocessor('unit-test-custom', (toolpaths, options) => `${options.camConfig.units}:${toolpaths.length}`);
  const cam = normalizeCamConfig({ ...sampleCam(), postprocessorId: 'unit-test-custom' });
  const { gcode } = exportGCode(cam);
  assert.equal(gcode, 'mm:1');
  assert.ok(listPostprocessors().some((entry) => entry.id === 'unit-test-custom'));
  assert.throws(() => getPostprocessor('missing-custom-post'), /Unknown postprocessor/);
});

test('LinuxCNC coordinates use CAM tolerance-based precision', () => {
  const cam = normalizeCamConfig({
    ...sampleCam(),
    tolerance: 0.01,
    operations: [{
      id: 'profile-a',
      name: 'Precision check',
      type: 'profile',
      toolId: 'tool-7',
      side: 'along',
      source: { loops: [[{ x: 0, y: 0 }, { x: 1.23456, y: 0 }, { x: 1.23456, y: 1.23456 }, { x: 0, y: 1.23456 }]] },
      topZ: 0,
      bottomZ: -1.23456,
      stepDown: 1,
    }],
  });
  const { gcode } = exportGCode(cam);
  assert.match(gcode, /G1 Z-1\.23 F87/);
  assert.match(gcode, /G1 X1\.23 Y0 F321/);
  assert.doesNotMatch(gcode, /1\.2346/);
});

test('LinuxCNC export emits circular interpolation when arc moves are present', () => {
  const cam = normalizeCamConfig({ tools: [{ id: 'tool-a', number: 3, diameter: 6 }] });
  const toolpaths = [{
    operationId: 'arc-op',
    toolId: 'tool-a',
    toolNumber: 3,
    moves: [
      { type: 'rapid', z: 5 },
      { type: 'rapid', x: 1, y: 0 },
      { type: 'feed', z: -1, feed: 120 },
      { type: 'arc', x: 0, y: 1, centerX: 0, centerY: 0, clockwise: false, feed: 300 },
    ],
  }];

  const { gcode } = exportGCode(cam, toolpaths, { programName: 'Arc test' });
  assert.match(gcode, /G3 X0 Y1 I-1 J0 F300/);
});

test('LinuxCNC export emits G5 cubic splines by default', () => {
  const cam = normalizeCamConfig({ tools: [{ id: 'tool-a', number: 3, diameter: 6 }] });
  const toolpaths = [{
    operationId: 'cubic-op',
    toolId: 'tool-a',
    toolNumber: 3,
    moves: [
      { type: 'rapid', z: 5 },
      { type: 'rapid', x: 0, y: 0 },
      { type: 'feed', z: -1, feed: 120 },
      { type: 'cubic', x: 3, y: 0, control1X: 1, control1Y: 1, control2X: 2, control2Y: 1, feed: 300 },
    ],
  }];

  const { gcode } = exportGCode(cam, toolpaths, { programName: 'Spline test' });
  assert.match(gcode, /G5 X3 Y0 I1 J1 P-1 Q1 F300/);
});
