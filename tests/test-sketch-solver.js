import './_watchdog.mjs';

import assert from 'node:assert/strict';

import { Scene } from '../js/cad/Scene.js';
import {
  Distance,
  EqualLength,
  Fixed,
  Horizontal,
  Length,
  OnCircle,
  OnLine,
  Perpendicular,
  RadiusConstraint,
  Tangent,
  Vertical,
} from '../js/cad/Constraint.js';
import { computeFullyConstrained } from '../js/cad/ConstraintAnalysis.js';
import { chamferSketchCorner, filletSketchCorner } from '../js/cad/Operations.js';
import { state } from '../js/state.js';
import { findSnap, invalidateSnapGrid } from '../js/snap.js';
import { CoincidentTool } from '../js/tools/CoincidentTool.js';
import { SelectTool } from '../js/tools/SelectTool.js';
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

function approx(actual, expected, tolerance = 1e-3, label = 'value') {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected}, got ${actual}`);
}

console.log('Sketch Solver Regressions');

test('connected distance and axis constraints propagate through shared points', () => {
  const scene = new Scene();
  const ab = scene.addSegment(0, 0, 8, 2, { merge: false });
  const bc = scene.addSegment(8, 2, 12, 7, { merge: true });

  scene.addConstraint(new Fixed(ab.p1, 0, 0));
  scene.addConstraint(new Distance(ab.p1, ab.p2, 10));
  scene.addConstraint(new Horizontal(ab));
  scene.addConstraint(new Distance(bc.p1, bc.p2, 5));
  scene.addConstraint(new Vertical(bc));

  const result = scene.solve({ maxIter: 1200, relaxation: 1, tolerance: 1e-4 });
  assert.ok(result.maxError <= 1e-4, `expected converged shared-point solve, got maxError=${result.maxError}`);
  approx(ab.p2.x, 10, 1e-3, 'ab.p2.x');
  approx(ab.p2.y, 0, 1e-3, 'ab.p2.y');
  approx(bc.p2.x, ab.p2.x, 1e-3, 'bc vertical x');
  approx(bc.p2.y - bc.p1.y, 5, 1e-3, 'bc length direction');
});

test('adding perpendicular to a skewed connected corner resolves immediately', () => {
  const scene = new Scene();
  const base = scene.addSegment(0, 0, 10, 0, { merge: false });
  const side = scene.addSegment(0, 0, 2, 6, { merge: true });
  const sideLength = Math.hypot(side.p2.x - side.p1.x, side.p2.y - side.p1.y);

  scene.addConstraint(new Fixed(base.p1, 0, 0));
  scene.addConstraint(new Fixed(base.p2, 10, 0));
  scene.addConstraint(new Distance(side.p1, side.p2, sideLength));
  scene.addConstraint(new Perpendicular(base, side));

  approx(side.p2.x, 0, 1e-3, 'side.p2.x');
  approx(side.p2.y, sideLength, 1e-3, 'side.p2.y');
  const result = scene.solve({ maxIter: 1200, relaxation: 1, tolerance: 1e-4 });
  assert.ok(result.maxError <= 1e-4, `expected perpendicular corner solve, got maxError=${result.maxError}`);
});

test('connected perpendicular corner is order-independent for lower-motion solve', () => {
  const buildScene = () => {
    const scene = new Scene();
    const left = scene.addSegment(0, 0, 3, 8, { merge: false });
    const top = scene.addSegment(3, 8, 11, 8, { merge: true });
    const right = scene.addSegment(11, 8, 12, 2, { merge: true });
    const bottom = scene.addSegment(12, 2, 1, 0, { merge: true });
    scene.addConstraint(new Horizontal(top));
    return { scene, left, top, right, bottom };
  };

  const leftFirst = buildScene();
  leftFirst.scene.addConstraint(new Perpendicular(leftFirst.left, leftFirst.top));

  const topFirst = buildScene();
  topFirst.scene.addConstraint(new Perpendicular(topFirst.top, topFirst.left));

  approx(leftFirst.left.p1.x, topFirst.left.p1.x, 1e-3, 'left.p1.x');
  approx(leftFirst.left.p1.y, topFirst.left.p1.y, 1e-3, 'left.p1.y');
  approx(leftFirst.left.p2.x, topFirst.left.p2.x, 1e-3, 'left.p2.x');
  approx(leftFirst.left.p2.y, topFirst.left.p2.y, 1e-3, 'left.p2.y');
  approx(leftFirst.top.p1.y, leftFirst.top.p2.y, 1e-6, 'left-first horizontal top');
  approx(topFirst.top.p1.y, topFirst.top.p2.y, 1e-6, 'top-first horizontal top');
  approx(leftFirst.top.p1.x, 3, 1e-6, 'left-first top.p1.x');
  approx(leftFirst.top.p1.y, 8, 1e-6, 'left-first top.p1.y');
  approx(leftFirst.top.p2.x, 11, 1e-6, 'left-first top.p2.x');
  approx(leftFirst.top.p2.y, 8, 1e-6, 'left-first top.p2.y');
  approx(leftFirst.left.p2.x, 3, 1e-6, 'left-first left.p2.x');
  approx(leftFirst.left.p2.y, 8, 1e-6, 'left-first left.p2.y');
  approx(leftFirst.left.p1.x, 3, 1e-6, 'left-first left.p1.x');
});

test('length constraint scales from a fixed endpoint', () => {
  const scene = new Scene();
  const seg = scene.addSegment(0, 0, 0, 10, { merge: false });

  scene.addConstraint(new Fixed(seg.p1, 0, 0));
  scene.addConstraint(new Length(seg, 14));

  const result = scene.solve({ maxIter: 1200, relaxation: 1, tolerance: 1e-4 });
  assert.ok(result.maxError <= 1e-4, `expected fixed-endpoint length solve, got maxError=${result.maxError}`);
  approx(seg.p1.x, 0, 1e-6, 'fixed-endpoint seg.p1.x');
  approx(seg.p1.y, 0, 1e-6, 'fixed-endpoint seg.p1.y');
  approx(seg.p2.x, 0, 1e-6, 'fixed-endpoint seg.p2.x');
  approx(seg.p2.y, 14, 1e-6, 'fixed-endpoint seg.p2.y');
});

test('horizontal drag stabilization preserves orthogonal free edge position', () => {
  const originalScene = state.scene;
  try {
    const scene = new Scene();
    const bottomLeft = scene.addPoint(0, 0);
    const topLeft = scene.addPoint(0, 10);
    const topRight = scene.addPoint(10, 10);
    const bottomRight = scene.addPoint(10, 0);

    const left = {
      type: 'segment',
      p1: bottomLeft,
      p2: topLeft,
      get x1() { return this.p1.x; },
      get y1() { return this.p1.y; },
      get x2() { return this.p2.x; },
      get y2() { return this.p2.y; },
      get midX() { return (this.p1.x + this.p2.x) / 2; },
      get midY() { return (this.p1.y + this.p2.y) / 2; },
      get length() { return Math.hypot(this.x2 - this.x1, this.y2 - this.y1); },
    };
    const top = {
      type: 'segment',
      p1: topLeft,
      p2: topRight,
      get x1() { return this.p1.x; },
      get y1() { return this.p1.y; },
      get x2() { return this.p2.x; },
      get y2() { return this.p2.y; },
      get midX() { return (this.p1.x + this.p2.x) / 2; },
      get midY() { return (this.p1.y + this.p2.y) / 2; },
      get length() { return Math.hypot(this.x2 - this.x1, this.y2 - this.y1); },
    };
    const right = {
      type: 'segment',
      p1: topRight,
      p2: bottomRight,
      get x1() { return this.p1.x; },
      get y1() { return this.p1.y; },
      get x2() { return this.p2.x; },
      get y2() { return this.p2.y; },
      get midX() { return (this.p1.x + this.p2.x) / 2; },
      get midY() { return (this.p1.y + this.p2.y) / 2; },
      get length() { return Math.hypot(this.x2 - this.x1, this.y2 - this.y1); },
    };
    const bottom = {
      type: 'segment',
      p1: bottomRight,
      p2: bottomLeft,
      get x1() { return this.p1.x; },
      get y1() { return this.p1.y; },
      get x2() { return this.p2.x; },
      get y2() { return this.p2.y; },
      get midX() { return (this.p1.x + this.p2.x) / 2; },
      get midY() { return (this.p1.y + this.p2.y) / 2; },
      get length() { return Math.hypot(this.x2 - this.x1, this.y2 - this.y1); },
    };

    scene.points = [bottomLeft, topLeft, topRight, bottomRight];
    scene.segments = [left, top, right, bottom];
    scene.addConstraint(new Fixed(bottomLeft, 0, 0));
    scene.addConstraint(new Horizontal(top));
    scene.addConstraint(new Horizontal(bottom));
    scene.addConstraint(new EqualLength(left, right));
    scene.addConstraint(new OnLine(topLeft, scene._yAxisLine));
    scene.addConstraint(new OnLine(bottomRight, scene._xAxisLine));

    state.scene = scene;

    const tool = new SelectTool({ renderer: { previewEntities: [] }, setStatus() {}, viewport: { zoom: 1 } });
    tool._dragPoint = bottomRight;
    tool._dragSolvedPointState = tool._snapshotScenePointPositions();

    bottomRight.x = 14;
    bottomRight.y = 0;
    bottomRight.fixed = true;

    const result = scene.solve({ maxIter: 800, relaxation: 1, tolerance: 1e-4 });
    tool._stabilizeDraggedSolve(result);

    approx(topLeft.y, 10, 1e-6, 'stabilized topLeft.y');
    approx(topRight.y, 10, 1e-6, 'stabilized topRight.y');
    assert.ok(result.maxError <= 0.015, `expected stabilized residual to stay bounded, got maxError=${result.maxError}`);
  } finally {
    if (state.scene?.points?.some((point) => point?.fixed)) {
      for (const point of state.scene.points) {
        if (point) point.fixed = false;
      }
    }
    state.scene = originalScene;
  }
});

test('idle drag settle replays the last drag target for five extra frames', () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const frameQueue = [];

  globalThis.requestAnimationFrame = (callback) => {
    frameQueue.push(callback);
    return frameQueue.length;
  };
  globalThis.cancelAnimationFrame = () => {};

  try {
    let renderCount = 0;
    let replayCount = 0;
    const tool = new SelectTool({
      renderer: { previewEntities: [] },
      setStatus() {},
      viewport: { zoom: 1 },
      _scheduleRender() { renderCount++; },
    });

    tool._isDragging = true;
    tool._dragStart = { wx: 0, wy: 0 };
    tool._dragPoint = { x: 0, y: 0, fixed: false };
    tool._applyDraggedPointTarget = (wx, wy) => {
      replayCount++;
      approx(wx, 12, 1e-12, 'settle wx');
      approx(wy, -4, 1e-12, 'settle wy');
      return true;
    };

    tool._queueIdleDragSettle(12, -4);

    while (frameQueue.length > 0) {
      const callback = frameQueue.shift();
      callback();
    }

    assert.equal(replayCount, 5, `expected 5 idle settle replays, got ${replayCount}`);
    assert.equal(renderCount, 5, `expected 5 idle settle renders, got ${renderCount}`);
    assert.equal(tool._dragSettleRemaining, 0, `expected settle countdown to finish, got ${tool._dragSettleRemaining}`);
  } finally {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  }
});

test('arcs expose draggable start and end points through scene serialization', () => {
  const scene = new Scene();
  const arc = scene.addArc(0, 0, 5, 0, Math.PI / 2, { merge: false });

  assert.ok(arc.startPoint, 'arc start point should exist');
  assert.ok(arc.endPoint, 'arc end point should exist');
  approx(arc.startPoint.x, 5, 1e-6, 'arc start point x');
  approx(arc.endPoint.y, 5, 1e-6, 'arc end point y');

  arc.endPoint.x = -5;
  arc.endPoint.y = 0;
  approx(arc.endAngle, Math.PI, 1e-6, 'dragged arc end angle');

  const restored = Scene.deserialize(scene.serialize());
  const restoredArc = restored.arcs[0];
  assert.ok(restored.points.includes(restoredArc.startPoint), 'restored start point is registered');
  assert.ok(restored.points.includes(restoredArc.endPoint), 'restored end point is registered');
  approx(restoredArc.endAngle, Math.PI, 1e-6, 'restored arc end angle');
});

test('clockwise arcs preserve negative sweep across the angle wrap boundary', () => {
  const scene = new Scene();
  const start = -170 * Math.PI / 180;
  const end = -190 * Math.PI / 180;
  const arc = scene.addArc(0, 0, 5, start, end, { merge: false });

  approx(arc.startAngle, start, 1e-12, 'wrapped clockwise arc start angle');
  approx(arc.endAngle, end, 1e-12, 'wrapped clockwise arc end angle');
  approx(arc.sweepAngle, -20 * Math.PI / 180, 1e-12, 'wrapped clockwise arc keeps short negative sweep');
});

test('equal and tangent constraints support circle-like arc/circle pairs', () => {
  const scene = new Scene();
  const arc = scene.addArc(0, 0, 3, 0, Math.PI / 2, { merge: false });
  const circle = scene.addCircle(10, 0, 5, { merge: false });

  scene.addConstraint(new EqualLength(arc, circle));
  approx(arc.radius, circle.radius, 1e-6, 'equal circle-like radius');

  scene.addConstraint(new Tangent(arc, circle));
  const result = scene.solve({ maxIter: 1200, relaxation: 1, tolerance: 1e-4 });
  assert.ok(result.maxError <= 1e-3, `expected arc/circle tangent solve, got maxError=${result.maxError}`);
  approx(
    Math.hypot(circle.cx - arc.cx, circle.cy - arc.cy),
    arc.radius + circle.radius,
    1e-3,
    'arc/circle tangent distance'
  );
});

test('on-circle constraint can keep standalone points on arc and circle edges', () => {
  const scene = new Scene();
  const circle = scene.addCircle(0, 0, 5, { merge: false });
  const point = scene.addPoint(3, 4);
  point.standalone = true;

  scene.addConstraint(new OnCircle(point, circle));
  point.x = 10;
  point.y = 0;
  scene.solve({ maxIter: 400, relaxation: 1, tolerance: 1e-4 });
  approx(Math.hypot(point.x - circle.cx, point.y - circle.cy), 5, 1e-6, 'standalone point on circle');
});

test('circle and arc quadrant snaps carry targets and only expose arc quadrants on the arc span', () => {
  const originalScene = state.scene;
  const originalSnapEnabled = state.snapEnabled;
  const originalGridSize = state.gridSize;
  try {
    const scene = new Scene();
    const circle = scene.addCircle(0, 0, 5, { merge: false });
    const arc = scene.addArc(20, 0, 5, Math.PI / 4, 3 * Math.PI / 4, { merge: false });
    state.scene = scene;
    state.snapEnabled = true;
    state.gridSize = 1000;
    invalidateSnapGrid();

    const viewport = {
      zoom: 10,
      worldToScreen: (x, y) => ({ x: x * 10, y: y * 10 }),
      screenToWorld: (x, y) => ({ x: x / 10, y: y / 10 }),
    };

    const circleSnap = findSnap(50, 0, viewport, { ignoreGridSnap: true });
    assert.equal(circleSnap?.type, 'quadrant', 'circle right quadrant should snap');
    assert.equal(circleSnap?.target, circle, 'circle quadrant snap carries target');

    const arcIncludedSnap = findSnap(200, 50, viewport, { ignoreGridSnap: true });
    assert.equal(arcIncludedSnap?.type, 'quadrant', 'arc top quadrant should snap');
    assert.equal(arcIncludedSnap?.target, arc, 'arc quadrant snap carries target');

    const arcExcludedSnap = findSnap(250, 0, viewport, { ignoreGridSnap: true });
    assert.equal(arcExcludedSnap, null, 'arc right quadrant outside the sweep should not snap');
  } finally {
    state.scene = originalScene;
    state.snapEnabled = originalSnapEnabled;
    state.gridSize = originalGridSize;
    invalidateSnapGrid();
  }
});

test('coincident tool projects points to the clicked circle or arc edge location', () => {
  const originalScene = state.scene;
  try {
    const scene = new Scene();
    const circle = scene.addCircle(0, 0, 5, { merge: false });
    const point = scene.addPoint(0, 5);
    point.standalone = true;
    state.scene = scene;

    const tool = new CoincidentTool({ renderer: { hoverEntity: null }, setStatus() {}, viewport: { zoom: 10 } });
    tool._firstPt = point;
    tool.step = 1;
    tool.onClick(5, 0);

    approx(point.x, 5, 1e-9, 'point projected to clicked circle edge x');
    approx(point.y, 0, 1e-9, 'point projected to clicked circle edge y');
    assert.equal(scene.constraints.some(c => c.type === 'on_circle' && c.pt === point && c.circle === circle), true, 'on-circle constraint added');

    const arc = scene.addArc(20, 0, 5, 0, Math.PI / 2, { merge: false });
    const arcPoint = scene.addPoint(20, 5);
    arcPoint.standalone = true;
    tool._firstPt = arcPoint;
    tool.step = 1;
    const arcClickX = 20 + 5 / Math.sqrt(2);
    const arcClickY = 5 / Math.sqrt(2);
    tool.onClick(arcClickX, arcClickY);

    approx(arcPoint.x, arcClickX, 1e-9, 'point projected to clicked arc edge x');
    approx(arcPoint.y, arcClickY, 1e-9, 'point projected to clicked arc edge y');
    assert.equal(scene.constraints.some(c => c.type === 'on_circle' && c.pt === arcPoint && c.circle === arc), true, 'on-arc constraint added');
  } finally {
    state.scene = originalScene;
  }
});

test('circle and arc edge drags edit radius without moving center', () => {
  const originalScene = state.scene;
  try {
    const scene = new Scene();
    const circle = scene.addCircle(1, 2, 5, { merge: false });
    state.scene = scene;

    const tool = new SelectTool({ renderer: { previewEntities: [] }, setStatus() {}, viewport: { zoom: 1 } });
    tool._dragRadiusShape = circle;
    tool._dragStart = { wx: circle.cx + circle.radius, wy: circle.cy };
    tool._dragSolvedPointState = tool._snapshotScenePointPositions();

    tool._applyDraggedRadiusTarget(circle.cx, circle.cy + 8);

    approx(circle.cx, 1, 1e-9, 'circle center x remains fixed during edge radius drag');
    approx(circle.cy, 2, 1e-9, 'circle center y remains fixed during edge radius drag');
    approx(circle.radius, 8, 1e-9, 'circle radius follows edge drag distance');

    const arc = scene.addArc(0, 0, 5, 0, Math.PI, { merge: false });
    tool._dragRadiusShape = arc;
    tool._dragSolvedPointState = tool._snapshotScenePointPositions();

    tool._applyDraggedRadiusTarget(0, 7);

    approx(arc.radius, 7, 1e-9, 'arc radius follows edge drag distance');
    approx(arc.startPoint.x, 7, 1e-9, 'arc start keeps angle at new radius');
    approx(arc.endPoint.x, -7, 1e-9, 'arc end keeps angle at new radius');
  } finally {
    state.scene = originalScene;
  }
});

test('arc endpoint and center point drags preserve expected edit modes', () => {
  const originalScene = state.scene;
  try {
    const scene = new Scene();
    const arc = scene.addArc(0, 0, 5, 0, Math.PI, { merge: false });
    state.scene = scene;

    const tool = new SelectTool({ renderer: { previewEntities: [] }, setStatus() {}, viewport: { zoom: 1 } });
    tool._dragPoint = arc.startPoint;
    tool._dragArcEndpoint = { arc, which: 'start' };
    tool._dragSolvedPointState = tool._snapshotScenePointPositions();

    tool._applyDraggedArcEndpointTarget(0, 10);

    approx(arc.radius, 10, 1e-9, 'arc endpoint drag changes radius');
    approx(arc.startAngle, Math.PI / 2, 1e-9, 'arc endpoint drag changes selected endpoint angle');
    approx(arc.endPoint.x, -10, 1e-9, 'opposite endpoint keeps angle at edited radius');
    approx(arc.endPoint.y, 0, 1e-9, 'opposite endpoint keeps angle at edited radius y');

    const startBefore = { x: arc.startPoint.x, y: arc.startPoint.y };
    const endBefore = { x: arc.endPoint.x, y: arc.endPoint.y };
    tool._dragPoint = arc.center;
    tool._dragArcEndpoint = null;
    tool._dragSolvedPointState = tool._snapshotScenePointPositions();
    tool._applyDraggedPointTarget(2, 3);

    approx(arc.center.x, 2, 1e-9, 'arc center point drag moves center x');
    approx(arc.center.y, 3, 1e-9, 'arc center point drag moves center y');
    approx(arc.startPoint.x, startBefore.x, 1e-9, 'arc center point drag leaves start x');
    approx(arc.startPoint.y, startBefore.y, 1e-9, 'arc center point drag leaves start y');
    approx(arc.endPoint.x, endBefore.x, 1e-9, 'arc center point drag leaves end x');
    approx(arc.endPoint.y, endBefore.y, 1e-9, 'arc center point drag leaves end y');
  } finally {
    state.scene = originalScene;
  }
});

test('fully constrained analysis includes circle radius and all arc defining points', () => {
  const scene = new Scene();
  const circle = scene.addCircle(0, 0, 5, { merge: false });

  scene.addConstraint(new Fixed(circle.center, 0, 0));
  assert.equal(computeFullyConstrained(scene).entities.has(circle), false, 'fixed center alone does not fully constrain circle radius');

  scene.addConstraint(new RadiusConstraint(circle, 5));
  assert.equal(computeFullyConstrained(scene).entities.has(circle), true, 'fixed center plus radius fully constrains circle');

  const arc = scene.addArc(10, 0, 4, 0, Math.PI / 2, { merge: false });
  scene.addConstraint(new Fixed(arc.center, 10, 0));
  scene.addConstraint(new RadiusConstraint(arc, 4));
  assert.equal(computeFullyConstrained(scene).entities.has(arc), false, 'arc still needs start/end angles constrained');

  scene.addConstraint(new Fixed(arc.startPoint, arc.startPoint.x, arc.startPoint.y));
  scene.addConstraint(new Fixed(arc.endPoint, arc.endPoint.x, arc.endPoint.y));
  assert.equal(computeFullyConstrained(scene).entities.has(arc), true, 'arc is fully constrained when center and endpoints are constrained');
});

test('sketch chamfer replaces a coincident segment corner and preserves endpoint constraints', () => {
  const scene = new Scene();
  const horizontal = scene.addSegment(0, 0, 10, 0, { merge: false });
  const vertical = scene.addSegment(10, 0, 10, 10, { merge: true });
  const corner = horizontal.p2;

  scene.addConstraint(new Horizontal(horizontal));
  scene.addConstraint(new Vertical(vertical));
  scene.addConstraint(new Fixed(corner, corner.x, corner.y));

  const result = chamferSketchCorner(scene, [corner], 2);

  assert.ok(result?.segment, 'chamfer segment should be created');
  assert.equal(scene.segments.length, 3, 'two original segments plus chamfer segment');
  approx(horizontal.p2.x, 8, 1e-6, 'horizontal segment trimmed from corner');
  approx(horizontal.p2.y, 0, 1e-6, 'horizontal segment remains horizontal');
  approx(vertical.p1.x, 10, 1e-6, 'vertical segment remains vertical');
  approx(vertical.p1.y, 2, 1e-6, 'vertical segment trimmed from corner');
  assert.equal(scene.constraints.some(c => c.type === 'horizontal' && c.seg === horizontal), true, 'horizontal constraint remains attached');
  assert.equal(scene.constraints.some(c => c.type === 'vertical' && c.seg === vertical), true, 'vertical constraint remains attached');
  assert.equal(scene.constraints.filter(c => c.type === 'fixed' && (c.pt === horizontal.p2 || c.pt === vertical.p1)).length, 2, 'corner fixed constraint duplicated to replacement endpoints');
});

test('sketch arc replaces a selected two-segment corner', () => {
  const scene = new Scene();
  const horizontal = scene.addSegment(0, 0, 10, 0, { merge: false });
  const vertical = scene.addSegment(10, 0, 10, 10, { merge: true });

  scene.addConstraint(new Horizontal(horizontal));
  scene.addConstraint(new Vertical(vertical));

  const result = filletSketchCorner(scene, [horizontal, vertical], 2);

  assert.ok(result?.arc, 'fillet arc should be created');
  assert.equal(scene.arcs.length, 1, 'one arc created');
  approx(horizontal.p2.x, 8, 1e-6, 'horizontal segment trimmed by tangent distance');
  approx(horizontal.p2.y, 0, 1e-6, 'horizontal tangent point y');
  approx(vertical.p1.x, 10, 1e-6, 'vertical tangent point x');
  approx(vertical.p1.y, 2, 1e-6, 'vertical segment trimmed by tangent distance');
  approx(result.arc.radius, 2, 1e-6, 'fillet arc radius');
  assert.equal(result.arc.startPoint, horizontal.p2, 'arc starts at first replacement endpoint');
  assert.equal(result.arc.endPoint, vertical.p1, 'arc ends at second replacement endpoint');
});

console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) {
  process.exit(1);
}
