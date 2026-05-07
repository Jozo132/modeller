import assert from 'node:assert/strict';
import { startTiming, formatTimingSuffix } from './test-timing.js';
import {
  buildCMOD,
  parseCMOD,
  projectFromCMOD,
  projectToCMOD,
  setCmodCamConfigGetter,
} from '../js/cmod.js';
import { normalizeCamConfig } from '../js/cam/index.js';

function test(name, fn) {
  const startedAt = startTiming();
  fn();
  console.log(`ok - ${name}${formatTimingSuffix(startedAt)}`);
}

const cam = normalizeCamConfig({
  tools: [{ id: 'tool-a', number: 2, type: 'endmill', diameter: 4 }],
  operations: [{ id: 'profile-a', type: 'profile', toolId: 'tool-a', source: { loops: [[{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }]] } }],
});

test('headless CMOD build and parse preserve top-level cam config', () => {
  const cmod = buildCMOD(null, { cam });
  assert.deepEqual(cmod.cam, cam);

  const parsed = parseCMOD(JSON.stringify(cmod));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.data.cam, cam);
});

test('project import returns cam without requiring old files to have it', () => {
  const cmod = buildCMOD(null, { cam });
  const result = projectFromCMOD(cmod);
  assert.equal(result.ok, true);
  assert.deepEqual(result.cam, cam);

  const oldFile = { ...cmod };
  delete oldFile.cam;
  const oldResult = projectFromCMOD(oldFile);
  assert.equal(oldResult.ok, true);
  assert.equal(oldResult.cam, null);
});

test('browser CMOD export writes cam from registered getter', () => {
  setCmodCamConfigGetter(() => cam);
  const cmod = projectToCMOD();
  assert.deepEqual(cmod.cam, cam);
  setCmodCamConfigGetter(null);
});