import assert from 'node:assert/strict';
import { startTiming, formatTimingSuffix } from './test-timing.js';
import { buildToolpathMotionTimeline, normalizeCamConfig, simulateStockRemoval } from '../js/cam/index.js';

function test(name, fn) {
  const startedAt = startTiming();
  fn();
  console.log(`ok - ${name}${formatTimingSuffix(startedAt)}`);
}

const loop = [
  { x: 0, y: 0 },
  { x: 20, y: 0 },
  { x: 20, y: 20 },
  { x: 0, y: 20 },
];

function sampleCam() {
  return normalizeCamConfig({
    stock: { min: { x: -2, y: -2, z: -4 }, max: { x: 22, y: 22, z: 2 } },
    tools: [{ id: 'tool-a', type: 'endmill', diameter: 4 }],
    operations: [{ id: 'pocket-a', type: 'pocket', toolId: 'tool-a', source: { loops: [loop] }, topZ: 2, bottomZ: -2, stepDown: 2, stepover: 4 }],
  });
}

function sampleSequentialCam() {
  return normalizeCamConfig({
    stock: { min: { x: -2, y: -2, z: -4 }, max: { x: 22, y: 22, z: 2 } },
    tools: [{ id: 'tool-a', type: 'endmill', diameter: 4 }],
    operations: [
      { id: 'rough-a', type: 'pocket', toolId: 'tool-a', source: { loops: [loop] }, topZ: 2, bottomZ: 0, stepDown: 2, stepover: 4 },
      { id: 'finish-a', type: 'pocket', toolId: 'tool-a', source: { loops: [loop] }, topZ: 0, bottomZ: -2, stepDown: 2, stepover: 4 },
    ],
  });
}

test('stock simulation creates a height grid and lowers cut samples', () => {
  const simulation = simulateStockRemoval(sampleCam(), { resolution: 16, progress: 1 });

  assert.ok(simulation);
  assert.equal(simulation.columns, 16);
  assert.ok(simulation.rows > 0);
  assert.ok(simulation.feedSegmentCount > 0);
  assert.equal(simulation.processedSegmentCount, simulation.feedSegmentCount);
  assert.ok(simulation.totalCutSeconds > 0);
  assert.equal(simulation.processedCutSeconds, simulation.totalCutSeconds);
  assert.ok(simulation.removedVertexCount > 0);
  assert.ok(simulation.minHeight <= -2);
});

test('stock simulation progress limits processed toolpath segments', () => {
  const full = simulateStockRemoval(sampleCam(), { resolution: 16, progress: 1 });
  const partial = simulateStockRemoval(sampleCam(), { resolution: 16, progress: 0.25 });

  assert.ok(partial.processedSegmentCount < full.processedSegmentCount);
  assert.ok(partial.removedVertexCount <= full.removedVertexCount);
});

test('stock simulation tracks the full motion timeline and current tool state', () => {
  const simulation = simulateStockRemoval(sampleCam(), { resolution: 16, progress: 0.5 });

  assert.ok(simulation.motionSegmentCount >= simulation.feedSegmentCount);
  assert.ok(simulation.totalMotionSeconds >= simulation.totalCutSeconds);
  assert.ok(simulation.processedMotionSeconds <= simulation.totalMotionSeconds);
  assert.ok(Array.isArray(simulation.motionSegments));
  assert.ok(simulation.motionSegments.some((segment) => segment.moveType === 'rapid'));
  assert.ok(simulation.toolState);
  assert.equal(simulation.toolState.toolId, 'tool-a');
  assert.ok(Number.isFinite(simulation.toolState.position.x));
  assert.ok(Number.isFinite(simulation.toolState.position.y));
  assert.ok(Number.isFinite(simulation.toolState.position.z));
});

test('motion timeline builder exposes full machine motion without stock simulation', () => {
  const timeline = buildToolpathMotionTimeline(sampleCam());

  assert.ok(Array.isArray(timeline.motionSegments));
  assert.equal(timeline.motionSegmentCount, timeline.motionSegments.length);
  assert.equal(timeline.feedSegmentCount, timeline.feedSegments.length);
  assert.ok(timeline.totalMotionSeconds >= timeline.totalCutSeconds);
  assert.ok(timeline.motionSegments.some((segment) => segment.moveType === 'rapid'));
  assert.ok(timeline.motionSegments.some((segment) => Math.abs(segment.start.z - segment.end.z) > 1e-9));
});

test('stock simulation exposes sequential operation stock states', () => {
  const simulation = simulateStockRemoval(sampleSequentialCam(), { resolution: 16, progress: 1 });

  assert.ok(Array.isArray(simulation.operationStates));
  assert.equal(simulation.operationStates.length, 2);
  assert.equal(simulation.operationStates[0].operationId, 'rough-a');
  assert.equal(simulation.operationStates[0].sequenceIndex, 0);
  assert.deepEqual(simulation.operationStates[0].remainingOperationIds, ['finish-a']);
  assert.equal(simulation.operationStates[1].operationId, 'finish-a');
  assert.ok(simulation.operationStates[0].removedVolume > 0);
  assert.ok(simulation.operationStates[1].removedVolume >= simulation.operationStates[0].removedVolume);
  assert.ok(simulation.operationStates[1].remainingVolume <= simulation.operationStates[0].remainingVolume);
});
