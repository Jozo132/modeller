import './_watchdog.mjs';
import assert from 'node:assert';

import { traceImageDataContours } from '../js/image/trace-raster.js';

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${label}`);
    console.log(`    ${error.message}`);
  }
}

function makeRaster(width, height, fill) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const dark = fill(x, y);
      const value = dark ? 0 : 255;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return data;
}

console.log('Trace raster tests');

test('traceImageDataContours extracts a rectangular contour', () => {
  const width = 16;
  const height = 12;
  const data = makeRaster(width, height, (x, y) => x >= 4 && x < 12 && y >= 3 && y < 9);
  const contours = traceImageDataContours(data, width, height, {
    minArea: 4,
    simplifyTolerance: 0.1,
  });

  assert.strictEqual(contours.length, 1);
  const contour = contours[0];
  const xs = contour.map((point) => point.x);
  const ys = contour.map((point) => point.y);
  assert.strictEqual(Math.min(...xs), 4);
  assert.strictEqual(Math.max(...xs), 12);
  assert.strictEqual(Math.min(...ys), 3);
  assert.strictEqual(Math.max(...ys), 9);
  assert.ok(contour.length <= 8, 'expected straight runs to collapse to a simple polygon');
});

test('traceImageDataContours preserves holes as separate contours', () => {
  const width = 18;
  const height = 18;
  const data = makeRaster(width, height, (x, y) => {
    const inOuter = x >= 2 && x < 16 && y >= 2 && y < 16;
    const inHole = x >= 6 && x < 12 && y >= 6 && y < 12;
    return inOuter && !inHole;
  });
  const contours = traceImageDataContours(data, width, height, {
    minArea: 4,
    simplifyTolerance: 0.1,
  });

  assert.strictEqual(contours.length, 2);
  const sortedAreas = contours
    .map((contour) => {
      let area = 0;
      for (let index = 0; index < contour.length; index++) {
        const current = contour[index];
        const next = contour[(index + 1) % contour.length];
        area += current.x * next.y - next.x * current.y;
      }
      return Math.abs(area) * 0.5;
    })
    .sort((left, right) => left - right);
  assert.deepStrictEqual(sortedAreas, [36, 196]);
});

test('traceImageDataContours filters small specks before contouring', () => {
  const width = 20;
  const height = 20;
  const data = makeRaster(width, height, (x, y) => {
    const large = x >= 3 && x < 12 && y >= 3 && y < 12;
    const speck = x === 17 && y === 17;
    return large || speck;
  });
  const contours = traceImageDataContours(data, width, height, {
    thresholdMode: 'manual',
    threshold: 127,
    minArea: 0,
    minSpeckArea: 4,
    simplifyTolerance: 0.1,
  });

  assert.strictEqual(contours.length, 1);
});

test('traceImageDataContours supports edge detection mode', () => {
  const width = 20;
  const height = 20;
  const data = makeRaster(width, height, (x, y) => x >= 5 && x < 15 && y >= 5 && y < 15);
  const contours = traceImageDataContours(data, width, height, {
    detectionMode: 'edge',
    edgeThreshold: 24,
    minArea: 1,
    minSpeckArea: 0,
    simplifyTolerance: 0.1,
  });

  assert.ok(contours.length >= 1, 'expected edge contours around the contrast boundary');
});

if (failed > 0) {
  console.error(`Trace raster tests failed: ${failed} failing, ${passed} passing`);
  process.exit(1);
}

console.log(`Trace raster tests passed: ${passed}`);
