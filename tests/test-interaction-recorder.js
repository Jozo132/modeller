// tests/test-interaction-recorder.js — Tests for the InteractionRecorder
// Validates: command generation, camera consolidation, playback

import { InteractionRecorder, PlaybackEngine } from '../js/interaction-recorder.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL: ${msg}`); }
}

// ---- Test 1: Basic command recording ----
{
  const rec = new InteractionRecorder();
  rec.start();
  rec.toolActivated('line');
  rec.faceSelected(3, 1, { x: 0, y: 0, z: 1 }, 'feat-1');
  rec.planeSelected('XY');
  const steps = rec.stop();

  assert(steps.length === 3, 'Should record 3 steps');
  assert(steps[0].command === 'tool line', `Tool command: ${steps[0].command}`);
  assert(steps[1].command.startsWith('select.face 3'), `Face command: ${steps[1].command}`);
  assert(steps[2].command === 'select.plane XY', `Plane command: ${steps[2].command}`);
}

// ---- Test 2: Camera consolidation ----
{
  const rec = new InteractionRecorder();
  rec.start();

  // Simulate: orbit → orbit → orbit → then select face
  // Only the LAST camera state before the face select should be recorded
  rec.orbitStart(1.0, 1.0, 25, { x: 0, y: 0, z: 0 });
  rec.orbitEnd(1.2, 1.1, 25, { x: 0, y: 0, z: 0 });
  // Second orbit immediately after
  rec.orbitStart(1.2, 1.1, 25, { x: 0, y: 0, z: 0 });
  rec.orbitEnd(1.5, 0.9, 30, { x: 1, y: 0, z: 0 });
  // Zoom
  rec.cameraSnapshot(1.5, 0.9, 20, { x: 1, y: 0, z: 0 });

  // Now a non-camera action: should flush the camera
  rec.faceSelected(5, 2, { x: 1, y: 0, z: 0 }, null);

  const steps = rec.stop();

  // Should have exactly 2 steps: 1 camera (consolidated) + 1 face select
  assert(steps.length === 2, `Expected 2 steps after consolidation, got ${steps.length}`);
  assert(steps[0].command.startsWith('camera.set'), `First should be camera: ${steps[0].command}`);
  // The camera should reflect the LAST state (the zoom snapshot)
  assert(steps[0].command.includes('20'), `Camera should have radius 20: ${steps[0].command}`);
  assert(steps[1].command.startsWith('select.face 5'), `Second should be face select: ${steps[1].command}`);
}

// ---- Test 3: Camera at end of recording ----
{
  const rec = new InteractionRecorder();
  rec.start();
  rec.cameraSnapshot(0.5, 1.0, 50, { x: 0, y: 0, z: 0 });
  // Stop without any non-camera action — the trailing camera should still be flushed
  const steps = rec.stop();
  assert(steps.length === 1, `Trailing camera should be flushed: got ${steps.length}`);
  assert(steps[0].command.startsWith('camera.set'), `Should be camera: ${steps[0].command}`);
}

// ---- Test 4: No camera recorded when not recording ----
{
  const rec = new InteractionRecorder();
  // Not started
  rec.cameraSnapshot(0.5, 1.0, 50, { x: 0, y: 0, z: 0 });
  rec.toolActivated('line');
  const steps = rec.getSteps();
  assert(steps.length === 0, 'Nothing recorded when not started');
}

// ---- Test 5: Sketch lifecycle commands ----
{
  const rec = new InteractionRecorder();
  rec.start();
  rec.sketchStarted('XZ', null);
  rec.entityCreated('segment', { x1: 0, y1: 0, x2: 10, y2: 0 });
  rec.entityCreated('segment', { x1: 10, y1: 0, x2: 10, y2: 10 });
  rec.sketchFinished('sketch-1', 2);
  rec.extrudeCreated('ext-1', 15, false);
  const steps = rec.stop();

  assert(steps.length === 5, `Expected 5 steps, got ${steps.length}`);
  assert(steps[0].command === 'sketch.start XZ', `Sketch start: ${steps[0].command}`);
  assert(steps[1].command.startsWith('draw.line 0'), `Draw line: ${steps[1].command}`);
  assert(steps[3].command === 'sketch.finish', `Sketch finish: ${steps[3].command}`);
  assert(steps[4].command === 'extrude 15', `Extrude: ${steps[4].command}`);
}

// ---- Test 6: Extrude cut command ----
{
  const rec = new InteractionRecorder();
  rec.start();
  rec.extrudeCreated('ext-2', 5, true);
  const steps = rec.stop();
  assert(steps[0].command === 'extrude 5 cut', `Extrude cut: ${steps[0].command}`);
}

// ---- Test 7: Export JSON format ----
{
  const rec = new InteractionRecorder();
  rec.start();
  rec.toolActivated('select');
  rec.stop();
  const json = JSON.parse(rec.exportJSON());
  assert(json.version === 1, 'Export has version 1');
  assert(Array.isArray(json.steps), 'Export has steps array');
  assert(json.steps[0].command === 'tool select', `Export step command: ${json.steps[0].command}`);
  assert(typeof json.steps[0].seq === 'number', 'Step has seq');
  assert(typeof json.steps[0].ts === 'number', 'Step has ts');
}

// ---- Test 8: getCommands() returns string array ----
{
  const rec = new InteractionRecorder();
  rec.start();
  rec.workspaceChanged('part');
  rec.toolActivated('line');
  rec.stop();
  const cmds = rec.getCommands();
  assert(Array.isArray(cmds), 'getCommands returns array');
  assert(cmds.length === 2, `Expected 2 commands, got ${cmds.length}`);
  assert(cmds[0] === 'workspace part', `First: ${cmds[0]}`);
  assert(cmds[1] === 'tool line', `Second: ${cmds[1]}`);
}

// ---- Test 9: Multiple camera consolidation with zoom in between ----
{
  const rec = new InteractionRecorder();
  rec.start();
  // orbit
  rec.orbitStart(0, 0, 25, { x: 0, y: 0, z: 0 });
  rec.orbitEnd(0.5, 0.5, 25, { x: 0, y: 0, z: 0 });
  // zoom (full state)
  rec.cameraSnapshot(0.5, 0.5, 15, { x: 0, y: 0, z: 0 });
  // pan
  rec.panStart({ x: 0, y: 0, z: 0 });
  rec.orbitEnd(0.5, 0.5, 15, { x: 5, y: 3, z: 0 });
  // Then action
  rec.planeSelected('XZ');
  const steps = rec.stop();

  assert(steps.length === 2, `Expected 2 (camera + plane), got ${steps.length}`);
  // Final camera should reflect the pan result with target 5,3,0
  assert(steps[0].command.includes('5'), `Should have target x=5: ${steps[0].command}`);
}

// ---- Test 10: Sketch on face command ----
{
  const rec = new InteractionRecorder();
  rec.start();
  rec.sketchStarted('FACE', {
    origin: { x: 1, y: 2, z: 3 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
  });
  const steps = rec.stop();
  assert(steps[0].command.startsWith('sketch.start FACE'), `Face sketch: ${steps[0].command}`);
  assert(steps[0].command.includes('1 2 3'), `Has origin: ${steps[0].command}`);
}

// ---- Test 11: onStep callback fires for each committed step ----
{
  const rec = new InteractionRecorder();
  const fired = [];
  rec.onStep = (step) => fired.push(step);
  rec.start();
  rec.toolActivated('line');
  rec.clickAt(1, 2);
  rec.clickAt(3, 4);
  rec.stop();
  // 3 action steps expected: tool, click, click
  assert(fired.length === 3, `onStep fired 3 times, got ${fired.length}`);
  assert(fired[0].command === 'tool line', `First callback: ${fired[0].command}`);
  assert(fired[1].command === 'click 1 2', `Second callback: ${fired[1].command}`);
  assert(fired[2].command === 'click 3 4', `Third callback: ${fired[2].command}`);
}

// ---- Test 12: onStep fires for flushed camera before non-camera step ----
{
  const rec = new InteractionRecorder();
  const fired = [];
  rec.onStep = (step) => fired.push(step);
  rec.start();
  rec.cameraSnapshot(1, 1, 25, { x: 0, y: 0, z: 0 });
  // Camera is pending, not yet fired
  assert(fired.length === 0, `Camera buffered, not fired yet: ${fired.length}`);
  rec.toolActivated('select');
  // Now camera should have flushed + tool
  assert(fired.length === 2, `Camera flush + tool = 2: ${fired.length}`);
  assert(fired[0].command.startsWith('camera.set'), `First is camera: ${fired[0].command}`);
  assert(fired[1].command === 'tool select', `Second is tool: ${fired[1].command}`);
  rec.stop();
}

// ---- Test 13: faceSelected records @point when provided ----
{
  const rec = new InteractionRecorder();
  rec.start();
  rec.faceSelected(2, 2, { x: 0, y: 1, z: 0 }, 'feature_2', { x: 1.5, y: 3.0, z: -0.5 });
  const steps = rec.stop();
  assert(steps[0].command.includes('@1.5 3 -0.5'), `Face has @point: ${steps[0].command}`);
  assert(steps[0].command.startsWith('select.face 2 2'), `Face idx/group correct: ${steps[0].command}`);
}

// ---- Test 14: planeSelected records @point when provided ----
{
  const rec = new InteractionRecorder();
  rec.start();
  rec.planeSelected('XY', { x: 2.5, y: -1.0, z: 0 });
  const steps = rec.stop();
  assert(steps[0].command.includes('@2.5 -1 0'), `Plane has @point: ${steps[0].command}`);
  assert(steps[0].command.startsWith('select.plane XY'), `Plane name correct: ${steps[0].command}`);
}

// ---- Test 15: faceDeselected records @point when provided ----
{
  const rec = new InteractionRecorder();
  rec.start();
  rec.faceDeselected({ x: 0, y: 0, z: 5.0 });
  const steps = rec.stop();
  assert(steps[0].command.includes('@0 0 5'), `Deselect has @point: ${steps[0].command}`);
  assert(steps[0].command.startsWith('deselect.face'), `Starts with deselect: ${steps[0].command}`);
}

// ---- Test 16: faceSelected without point still works ----
{
  const rec = new InteractionRecorder();
  rec.start();
  rec.faceSelected(5, 5, { x: 0, y: 0, z: 1 }, null);
  const steps = rec.stop();
  assert(!steps[0].command.includes('@'), `No @point when not provided: ${steps[0].command}`);
  assert(steps[0].command.startsWith('select.face 5 5'), `Face still correct: ${steps[0].command}`);
}

// ---- Test 17: featureModified records feature.modify command ----
{
  const rec = new InteractionRecorder();
  rec.start();
  rec.featureModified('feature_3', 'distance', 5);
  rec.featureModified('feature_3', 'operation', 'subtract');
  rec.featureModified('feature_3', 'direction', -1);
  const steps = rec.stop();
  assert(steps.length === 3, `Expected 3 steps, got ${steps.length}`);
  assert(steps[0].command === 'feature.modify feature_3 distance 5', `Distance modify: ${steps[0].command}`);
  assert(steps[1].command === 'feature.modify feature_3 operation subtract', `Operation modify: ${steps[1].command}`);
  assert(steps[2].command === 'feature.modify feature_3 direction -1', `Direction modify: ${steps[2].command}`);
}

console.log(`\nInteraction Recorder Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
