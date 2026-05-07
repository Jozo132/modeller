import assert from 'node:assert/strict';
import { startTiming, formatTimingSuffix } from './test-timing.js';
import { normalizeCamConfig, simulateStockRemoval } from '../js/cam/index.js';

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
