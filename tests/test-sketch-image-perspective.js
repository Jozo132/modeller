import './_watchdog.mjs';
import assert from 'node:assert';

import { ImagePrimitive, Scene } from '../js/cad/index.js';
import { state } from '../js/state.js';
import { SelectTool } from '../js/tools/SelectTool.js';

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${label}`);
    console.log(`    ${err.message}`);
  }
}

function assertApproxEqual(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `Expected ${actual} to be within ${tolerance} of ${expected}`);
}

function assertQuadApproxEqual(actual, expected, tolerance = 1e-9) {
  assert.strictEqual(actual.length, expected.length);
  for (let index = 0; index < actual.length; index++) {
    assertApproxEqual(actual[index].u, expected[index].u, tolerance);
    assertApproxEqual(actual[index].v, expected[index].v, tolerance);
  }
}

console.log('Sketch image perspective tests');

test('perspective draft keeps the rendered image on the original projection until apply', () => {
  const image = new ImagePrimitive('data:image/png;base64,AAAA', 10, 20, 100, 50, {
    perspectiveEnabled: true,
    sourceQuad: [
      { u: 0.1, v: 0.2 },
      { u: 0.9, v: 0.15 },
      { u: 0.85, v: 0.95 },
      { u: 0.05, v: 0.9 },
    ],
  });

  image.beginPerspectiveEdit();
  assert.strictEqual(image.isPerspectiveEditing(), true);
  assert.deepStrictEqual(image.getRenderSourceQuad(), ImagePrimitive.fullSourceQuad());
  assert.deepStrictEqual(image.getPerspectiveGuideQuad(), [
    { u: 0.1, v: 0.2 },
    { u: 0.9, v: 0.15 },
    { u: 0.85, v: 0.95 },
    { u: 0.05, v: 0.9 },
  ]);
});

test('perspective draft can extend outside the original image bounds and only commits on apply', () => {
  const image = new ImagePrimitive('data:image/png;base64,BBBB', 0, 0, 100, 50, {
    perspectiveEnabled: true,
    gridWidth: 240,
    gridHeight: 120,
  });

  image.beginPerspectiveEdit();
  image.setPerspectiveDraftPoint(2, 1.4, 1.25);
  image.setPerspectiveDraftPoint(0, -0.2, -0.1);

  assert.deepStrictEqual(image.sourceQuad, ImagePrimitive.fullSourceQuad());
  assert.deepStrictEqual(image.getPerspectiveGuideQuad(), [
    { u: -0.2, v: -0.1 },
    { u: 1, v: 0 },
    { u: 1.4, v: 1.25 },
    { u: 0, v: 1 },
  ]);

  image.applyPerspectiveEdit({
    targetWidth: image.gridWidth,
    targetHeight: image.gridHeight,
    moveToOrigin: true,
    placeOnGrid: true,
  });
  assert.strictEqual(image.isPerspectiveEditing(), false);
  assert.deepStrictEqual(image.sourceQuad, [
    { u: -0.2, v: -0.1 },
    { u: 1, v: 0 },
    { u: 1.4, v: 1.25 },
    { u: 0, v: 1 },
  ]);
  assert.strictEqual(image.perspectiveEnabled, true);
  assert.strictEqual(image.x, 0);
  assert.strictEqual(image.y, 0);
  assert.strictEqual(image.width, 240);
  assert.strictEqual(image.height, 120);
  assert.strictEqual(image.rotation, 0);
  assert.strictEqual(image.scaleX, 1);
  assert.strictEqual(image.scaleY, 1);
  assert.deepStrictEqual(image.getLocalQuad(), [
    { x: 0, y: 0 },
    { x: 240, y: 0 },
    { x: 240, y: 120 },
    { x: 0, y: 120 },
  ]);
});

test('canceling a perspective edit leaves the committed correction untouched', () => {
  const image = new ImagePrimitive('data:image/png;base64,CCCC', 0, 0, 100, 50, {
    perspectiveEnabled: true,
    sourceQuad: [
      { u: 0.15, v: 0.1 },
      { u: 0.85, v: 0.05 },
      { u: 0.8, v: 0.9 },
      { u: 0.2, v: 0.95 },
    ],
  });

  image.beginPerspectiveEdit();
  image.setPerspectiveDraftPoint(1, 1.2, -0.3);
  image.cancelPerspectiveEdit();

  assert.strictEqual(image.isPerspectiveEditing(), false);
  assert.deepStrictEqual(image.sourceQuad, [
    { u: 0.15, v: 0.1 },
    { u: 0.85, v: 0.05 },
    { u: 0.8, v: 0.9 },
    { u: 0.2, v: 0.95 },
  ]);
});

test('select tool updates the draft perspective quad instead of the committed correction', () => {
  state.scene = new Scene();
  state.selectedEntities = [];
  const image = state.scene.addImage('data:image/png;base64,DDDD', 10, 20, 100, 50, {
    perspectiveEnabled: true,
  });
  image.beginPerspectiveEdit();
  state.select(image);

  const app = {
    renderer: { previewEntities: [], hoverEntity: null },
    viewport: { zoom: 10 },
    _sketchingOnPlane: false,
    _renderer3d: null,
    setStatus() {},
  };
  const tool = new SelectTool(app);
  const handle = image.getSourceHandlePoints()[2];

  tool.onMouseDown(handle.x, handle.y, 100, 100, { button: 0 });
  tool.onMouseMove(155, 92.5, 120, 130);
  tool.onMouseUp(155, 92.5, {});

  assert.deepStrictEqual(image.sourceQuad, ImagePrimitive.fullSourceQuad());
  assert.ok(image.getPerspectiveGuideQuad()[2].u > 1);
  assert.ok(image.getPerspectiveGuideQuad()[2].v > 1);
});

test('source quad bounds normalize correctly for expanded perspective sampling', () => {
  const image = new ImagePrimitive('data:image/png;base64,EEEE', 0, 0, 100, 50, {
    perspectiveEnabled: true,
    sourceQuad: [
      { u: -0.2, v: -0.1 },
      { u: 1.0, v: 0.0 },
      { u: 1.4, v: 1.25 },
      { u: 0.0, v: 1.0 },
    ],
  });

  const bounds = image.getSourceQuadBounds();
  assert.strictEqual(bounds.minU, -0.2);
  assert.strictEqual(bounds.maxU, 1.4);
  assert.strictEqual(bounds.minV, -0.1);
  assert.strictEqual(bounds.maxV, 1.25);
  assertApproxEqual(bounds.spanU, 1.6);
  assertApproxEqual(bounds.spanV, 1.35);
  assertQuadApproxEqual(image.normalizeSourceQuadToBounds(), [
    { u: 0, v: 0 },
    { u: 0.75, v: 0.07407407407407407 },
    { u: 1, v: 1 },
    { u: 0.125, v: 0.8148148148148149 },
  ]);
});

test('select tool keeps the editing image selected until perspective edit is finished', () => {
  state.scene = new Scene();
  state.selectedEntities = [];
  const activeImage = state.scene.addImage('data:image/png;base64,FFFF', 0, 0, 100, 50, {
    perspectiveEnabled: true,
  });
  const otherImage = state.scene.addImage('data:image/png;base64,GGGG', 300, 0, 100, 50, {
    perspectiveEnabled: false,
  });
  activeImage.beginPerspectiveEdit();
  state.select(activeImage);

  const app = {
    renderer: { previewEntities: [], hoverEntity: null },
    viewport: { zoom: 10 },
    _sketchingOnPlane: false,
    _renderer3d: null,
    setStatus() {},
  };
  const tool = new SelectTool(app);
  tool.onClick(otherImage.x + 5, otherImage.y + 5, { shiftKey: false });

  assert.deepStrictEqual(state.selectedEntities, [activeImage]);
  assert.strictEqual(activeImage.selected, true);
  assert.strictEqual(otherImage.selected, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);