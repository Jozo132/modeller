import './_watchdog.mjs';
import assert from 'node:assert';

import { createCanvas, loadImage } from '@napi-rs/canvas';
import { traceImageDataContours } from '../js/image/trace-raster.js';
import { buildFittedTraceEntities, buildHybridTraceEntities } from '../js/image/trace-fitting.js';

let passed = 0;
let failed = 0;

async function test(label, fn) {
  try {
    await fn();
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

await test('traceImageDataContours extracts a rectangular contour', () => {
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

await test('traceImageDataContours preserves holes as separate contours', () => {
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

await test('traceImageDataContours filters small specks before contouring', () => {
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

await test('traceImageDataContours supports edge detection mode', () => {
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

await test('buildHybridTraceEntities keeps short straight spans and smooths curved spans', () => {
  const points = [
    { x: 0, y: 0 },
    { x: 5, y: 0 },
    { x: 7, y: 0.4 },
    { x: 8.4, y: 1.6 },
    { x: 9, y: 3.5 },
    { x: 9, y: 7 },
    { x: 6, y: 10 },
    { x: 0, y: 10 },
  ];

  const fitted = buildHybridTraceEntities(points, {
    minSegmentLength: 0.2,
    lineTolerance: 0.35,
  });

  assert.ok(fitted.segments.some(({ start, end }) => (
    Math.abs(end.y - start.y) <= 0.5
    && Math.abs(end.x - start.x) >= 4.9
  )), 'expected the near-horizontal run to stay a line segment');
  assert.ok(fitted.segments.some(({ start, end }) => (
    Math.abs((end.x - start.x) + (end.y - start.y)) < 1e-9
    && Math.abs(end.x - start.x) >= 2.9
  )), 'expected the diagonal run to stay a line segment');
  assert.ok(fitted.splines.length >= 1, 'expected gradual curved samples to become a spline');
});

await test('buildHybridTraceEntities preserves noisy straight edges in edge mode', () => {
  const points = [
    { x: 0, y: 0 },
    { x: 2, y: 0.08 },
    { x: 4, y: -0.06 },
    { x: 6, y: 0.04 },
    { x: 8, y: 0 },
    { x: 8.08, y: 2 },
    { x: 7.94, y: 4 },
    { x: 8.04, y: 6 },
    { x: 8, y: 8 },
    { x: 6, y: 8.05 },
    { x: 4, y: 7.94 },
    { x: 2, y: 8.03 },
    { x: 0, y: 8 },
    { x: -0.04, y: 6 },
    { x: 0.06, y: 4 },
    { x: -0.03, y: 2 },
  ];

  const fitted = buildHybridTraceEntities(points, {
    minSegmentLength: 0.1,
    detectionMode: 'edge',
    simplifyTolerance: 1.4,
    unitPerPixel: 0.1,
  });

  assert.ok(fitted.segments.length >= 4, `expected dominant straight edges, got ${fitted.segments.length}`);
  assert.strictEqual(fitted.splines.length, 0, 'noisy rectangle edges should not become splines');
});

await test('buildHybridTraceEntities keeps smooth contours as curves', () => {
  const points = [];
  for (let index = 0; index < 32; index++) {
    const angle = (index / 32) * Math.PI * 2;
    points.push({ x: Math.cos(angle) * 5, y: Math.sin(angle) * 3 });
  }

  const fitted = buildHybridTraceEntities(points, {
    minSegmentLength: 0.1,
    detectionMode: 'contour',
    simplifyTolerance: 0.8,
    unitPerPixel: 0.1,
  });

  assert.ok(fitted.splines.length >= 1, 'smooth oval should be represented as a curve');
  assert.ok(fitted.segments.length <= 2, 'smooth oval should not be chopped into line segments');
});

await test('buildFittedTraceEntities fits smooth contours with fewer spline controls', () => {
  const points = [];
  for (let index = 0; index < 40; index++) {
    const angle = (index / 40) * Math.PI * 2;
    points.push({
      x: Math.cos(angle) * 8,
      y: Math.sin(angle) * 3.5,
    });
  }

  const fitted = buildFittedTraceEntities(points, {
    minSegmentLength: 0.05,
    fitTolerance: 0.7,
    fitMaxControls: 12,
    unitPerPixel: 0.1,
  });

  assert.strictEqual(fitted.segments.length, 0, 'smooth oval should stay as a fitted spline');
  assert.ok(fitted.splines.length >= 1, 'expected a fitted spline for the smooth oval');
  assert.ok(fitted.splines[0].length <= 12, `expected capped fitted control count, got ${fitted.splines[0].length}`);
  assert.ok(fitted.splines[0].length < points.length / 2, 'fitted mode should not keep raw contour points as controls');
});

await test('buildFittedTraceEntities keeps fitted controls local on sample artwork', async () => {
  const image = await loadImage('tests/samples/sample-image-oh-yeah.png');
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const imageData = context.getImageData(0, 0, image.width, image.height);
  const contours = traceImageDataContours(imageData.data, image.width, image.height, {
    minArea: 12,
    minSpeckArea: 8,
  });

  assert.ok(contours.length >= 8, 'expected the sample artwork to produce multiple closed contours');
  for (const contour of contours) {
    const fitted = buildFittedTraceEntities(contour, {
      minSegmentLength: 0.35,
      fitTolerance: 1.2,
      fitMaxControls: 16,
      unitPerPixel: 1,
    });
    const minX = Math.min(...contour.map((point) => point.x));
    const maxX = Math.max(...contour.map((point) => point.x));
    const minY = Math.min(...contour.map((point) => point.y));
    const maxY = Math.max(...contour.map((point) => point.y));
    const diagonal = Math.max(1, Math.hypot(maxX - minX, maxY - minY));
    for (const controls of fitted.splines) {
      for (const point of controls) {
        const outsideX = Math.max(minX - point.x, point.x - maxX, 0);
        const outsideY = Math.max(minY - point.y, point.y - maxY, 0);
        const overshoot = Math.hypot(outsideX, outsideY) / diagonal;
        assert.ok(overshoot <= 0.08, `fitted control escaped its contour bounds by ${(overshoot * 100).toFixed(1)}%`);
      }
    }
  }
});

await test('buildHybridTraceEntities adds detail around sharp corner clusters', () => {
  const points = [
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    { x: 4, y: 0.1 },
    { x: 5, y: 0.7 },
    { x: 5.2, y: 1.4 },
    { x: 5.0, y: 2.1 },
    { x: 4.1, y: 2.7 },
    { x: 2, y: 3 },
    { x: 0, y: 3 },
    { x: -0.2, y: 1.5 },
  ];

  const fitted = buildHybridTraceEntities(points, {
    minSegmentLength: 0.1,
    detectionMode: 'edge',
    simplifyTolerance: 1.4,
    unitPerPixel: 0.1,
  });

  assert.ok(fitted.segments.length >= 7, `expected extra corner detail segments, got ${fitted.segments.length}`);
  assert.ok(fitted.segments.some(({ start, end }) => (
    Math.abs(start.x - 5) < 1e-9
    && Math.abs(start.y - 0.7) < 1e-9
    && Math.abs(end.x - 5.2) < 1e-9
    && Math.abs(end.y - 1.4) < 1e-9
  )), 'expected the sharp convex/concave transition to keep its local detail point');
});

if (failed > 0) {
  console.error(`Trace raster tests failed: ${failed} failing, ${passed} passing`);
  process.exit(1);
}

console.log(`Trace raster tests passed: ${passed}`);
