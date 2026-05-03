import './_watchdog.mjs';
import assert from 'node:assert';

import { SketchFeature } from '../js/cad/SketchFeature.js';
import { WasmRenderer, extractRenderableSketchProfiles, triangulateSketchProfileFill } from '../js/wasm-renderer.js';
import { formatTimingSuffix, startTiming } from './test-timing.js';

let passed = 0;
let failed = 0;

function test(label, fn) {
  const startedAt = startTiming();
  try {
    fn();
    passed++;
    console.log(`  ✓ ${label}${formatTimingSuffix(startedAt)}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${label}${formatTimingSuffix(startedAt)}`);
    console.log(`    ${err.message}`);
  }
}

function addRect(sketchFeature, x1, y1, x2, y2) {
  sketchFeature.sketch.addSegment(x1, y1, x2, y1);
  sketchFeature.sketch.addSegment(x2, y1, x2, y2);
  sketchFeature.sketch.addSegment(x2, y2, x1, y2);
  sketchFeature.sketch.addSegment(x1, y2, x1, y1);
}

function triangleArea(triangle) {
  const [a, b, c] = triangle;
  return Math.abs(
    (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y)) * 0.5,
  );
}

function pointInTriangle(point, triangle) {
  const [a, b, c] = triangle;
  const cross = (p1, p2, p3) => (p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x);
  const d1 = cross(point, a, b);
  const d2 = cross(point, b, c);
  const d3 = cross(point, c, a);
  const hasNeg = d1 < -1e-8 || d2 < -1e-8 || d3 < -1e-8;
  const hasPos = d1 > 1e-8 || d2 > 1e-8 || d3 > 1e-8;
  return !(hasNeg && hasPos);
}

function pointCovered(point, triangles) {
  return triangles.some((triangle) => pointInTriangle(point, triangle));
}

function createFakeSketchPicker({ segments = [], triangles = [] } = {}) {
  return {
    canvas: {
      getBoundingClientRect() {
        return { left: 0, top: 0, width: 100, height: 100 };
      },
    },
    _sketchPickSegments: segments,
    _sketchPickTriangles: triangles,
    _computeMVP() {
      return [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
      ];
    },
    _mat4Invert: WasmRenderer.prototype._mat4Invert,
    _mat4TransformVec4: WasmRenderer.prototype._mat4TransformVec4,
    _rayLineClosest: WasmRenderer.prototype._rayLineClosest,
    _rayTriangleIntersect: WasmRenderer.prototype._rayTriangleIntersect,
  };
}

console.log('Sketch preview fill tests');

test('renderer preview fill follows odd-even nesting for valid nested loops', () => {
  const sketchFeature = new SketchFeature('NestedPreviewFill');
  addRect(sketchFeature, 0, 0, 40, 40);
  addRect(sketchFeature, 5, 5, 35, 35);
  addRect(sketchFeature, 10, 10, 30, 30);
  addRect(sketchFeature, 15, 15, 25, 25);

  const profiles = extractRenderableSketchProfiles(sketchFeature.sketch);
  assert.strictEqual(profiles.length, 4, 'expected all nested loops to be extracted for preview fill');

  const triangles = triangulateSketchProfileFill(profiles);
  assert.ok(triangles.length > 0, 'expected non-empty fill triangulation');
  assert.strictEqual(pointCovered({ x: 2, y: 2 }, triangles), true, 'outer shell should be filled');
  assert.strictEqual(pointCovered({ x: 7, y: 7 }, triangles), false, 'depth-1 hole should be empty');
  assert.strictEqual(pointCovered({ x: 12, y: 12 }, triangles), true, 'depth-2 island should be filled');
  assert.strictEqual(pointCovered({ x: 17, y: 17 }, triangles), false, 'depth-3 hole should be empty');
});

test('renderer preview fill subtracts circular holes from filled profiles', () => {
  const sketchFeature = new SketchFeature('CircularHolePreviewFill');
  addRect(sketchFeature, 0, 0, 50, 50);
  sketchFeature.sketch.addCircle(25, 25, 10);

  const profiles = extractRenderableSketchProfiles(sketchFeature.sketch);
  assert.strictEqual(profiles.length, 2, 'expected outer loop plus circular hole profile');

  const triangles = triangulateSketchProfileFill(profiles);
  assert.ok(triangles.length > 0, 'expected non-empty fill triangulation for circle hole');
  const filledArea = triangles.reduce((sum, triangle) => sum + triangleArea(triangle), 0);
  const expectedArea = 2500 - Math.PI * 100;
  assert.ok(Math.abs(filledArea - expectedArea) < 40, `expected fill area near ${expectedArea}, got ${filledArea}`);
  assert.strictEqual(pointCovered({ x: 5, y: 5 }, triangles), true, 'outer region should stay filled');
  assert.strictEqual(pointCovered({ x: 25, y: 25 }, triangles), false, 'circular hole center should stay empty');
});

test('executed sketch profiles classify near-boundary holes with inward samples', () => {
  const sketchFeature = new SketchFeature('NearBoundaryHoleProfile');
  addRect(sketchFeature, 0, 0, 10, 10);
  addRect(sketchFeature, 1, 5e-7, 2, 1);

  const result = sketchFeature.execute({});
  assert.strictEqual(result.profiles.length, 2, 'expected outer loop plus near-boundary inner loop');

  const hole = result.profiles.find((profile) => profile.isHole);
  assert.ok(hole, 'expected near-boundary inner loop to be classified as a hole');
  assert.strictEqual(hole.nestingDepth, 1, 'near-boundary hole should have odd nesting depth');
});

test('sketch picking falls back to filled face triangles in part mode', () => {
  const picker = createFakeSketchPicker({
    triangles: [{
      featureId: 'feature_sketch_face',
      triangles: [[
        { x: -0.4, y: -0.4, z: 0 },
        { x: 0.4, y: -0.4, z: 0 },
        { x: 0, y: 0.4, z: 0 },
      ]],
    }],
  });

  const hit = WasmRenderer.prototype.pickSketch.call(picker, 50, 50);
  assert.deepStrictEqual(hit, { featureId: 'feature_sketch_face' });
});

test('sketch picking can ignore filled faces for outline-only selection', () => {
  const picker = createFakeSketchPicker({
    triangles: [{
      featureId: 'feature_sketch_face',
      triangles: [[
        { x: -0.4, y: -0.4, z: 0 },
        { x: 0.4, y: -0.4, z: 0 },
        { x: 0, y: 0.4, z: 0 },
      ]],
    }],
  });

  const hit = WasmRenderer.prototype.pickSketch.call(picker, 50, 50, { includeFaces: false });
  assert.strictEqual(hit, null);
});

test('sketch picking still prefers nearby edges over filled faces', () => {
  const picker = createFakeSketchPicker({
    segments: [{
      featureId: 'feature_sketch_edge',
      segments: [{
        a: { x: -0.4, y: 0, z: 0 },
        b: { x: 0.4, y: 0, z: 0 },
      }],
    }],
    triangles: [{
      featureId: 'feature_sketch_face',
      triangles: [[
        { x: -0.45, y: -0.45, z: 0 },
        { x: 0.45, y: -0.45, z: 0 },
        { x: 0, y: 0.45, z: 0 },
      ]],
    }],
  });

  const hit = WasmRenderer.prototype.pickSketch.call(picker, 50, 50);
  assert.deepStrictEqual(hit, { featureId: 'feature_sketch_edge' });
});

test('deselecting a sketch rebuilds the rendered sketch overlay', () => {
  const renderedPart = { id: 'part_for_sketch_overlay' };
  const renderer = {
    _selectedFeatureId: 'feature_selected_sketch',
    _renderedPart: renderedPart,
    rebuiltFromPart: null,
    _buildSketchWireframes(part) {
      this.rebuiltFromPart = part;
    },
  };

  WasmRenderer.prototype.setSelectedFeature.call(renderer, null);

  assert.strictEqual(renderer._selectedFeatureId, null, 'selected feature should clear');
  assert.strictEqual(renderer.rebuiltFromPart, renderedPart, 'deselect should rebuild sketch wireframes from the current part');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
