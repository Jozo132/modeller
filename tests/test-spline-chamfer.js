import './_watchdog.mjs';
/**
 * Tests for chamfering edges on extruded spline/bezier profiles.
 *
 * Validates that:
 * 1. Spline/bezier extrusions split into multiple NURBS sub-faces
 * 2. Chamfer succeeds on spline sub-edges (PLANE + BSPLINE adjacent)
 * 3. Chamfer succeeds on straight edges adjacent to BSPLINE faces
 * 4. Chamfer succeeds on vertical edges between BSPLINE faces
 * 5. Lens-shaped profiles (all curves) can be chamfered
 * 6. Bezier profiles chamfer correctly
 */

import { strict as assert } from 'node:assert';
import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { resetFeatureIds } from '../js/cad/Feature.js';
import { resetTopoIds } from '../js/cad/BRepTopology.js';
import { applyBRepChamfer } from '../js/cad/BRepChamfer.js';
import { edgeKeyFromVerts } from '../js/cad/toolkit/Vec3Utils.js';
import { formatTimingSuffix, startTiming } from './test-timing.js';

let passed = 0, failed = 0;
function test(name, fn) {
  const startedAt = startTiming();
  try { fn(); console.log(`  ✓ ${name}${formatTimingSuffix(startedAt)}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}${formatTimingSuffix(startedAt)}`); console.error(`    ${e.message}`); failed++; }
}

function buildPart(sketchSetup) {
  resetFeatureIds();
  resetTopoIds();
  const part = new Part('Test');
  const sketch = new Sketch();
  sketchSetup(sketch);
  const plane = {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
  };
  part.addSketch(sketch, plane);
  part.extrude(part.getSketches()[0].id, 5);
  return part;
}

function getGeomAndTopo(part) {
  const geom = part.featureTree.features.find(f => f.type === 'extrude').result.geometry;
  return { geom, topo: geom.topoBody };
}

function findEdge(edges, pred) {
  return edges.find(pred);
}

function chamferEdge(geom, edge, distance = 0.5) {
  const key = edgeKeyFromVerts(edge.startVertex.point, edge.endVertex.point);
  return applyBRepChamfer(geom, [key], distance);
}

// ======================================================================
// Mixed profile: segments + spline
// ======================================================================

const mixedSetup = (sketch) => {
  sketch.addSegment(0, 0, 10, 0);
  sketch.addSegment(10, 0, 10, 10);
  sketch.addSpline([{ x: 10, y: 10 }, { x: 8, y: 14 }, { x: 2, y: 14 }, { x: 0, y: 10 }]);
  sketch.addSegment(0, 10, 0, 0);
};

test('Mixed profile: spline splits into N = max(3, 4) = 4 BSPLINE sub-faces', () => {
  const part = buildPart(mixedSetup);
  const { topo } = getGeomAndTopo(part);
  const bsplineFaces = topo.faces().filter(f => f.surfaceType === 'bspline');
  assert.strictEqual(bsplineFaces.length, 4, `Expected 4 BSPLINE sub-faces, got ${bsplineFaces.length}`);
});

test('Mixed profile: total face count = 2 caps + 3 planar + 4 bspline = 9', () => {
  const part = buildPart(mixedSetup);
  const { topo } = getGeomAndTopo(part);
  assert.strictEqual(topo.faces().length, 9);
});

test('Mixed profile: chamfer bottom spline sub-edge (PLANE + BSPLINE)', () => {
  const part = buildPart(mixedSetup);
  const { geom, topo } = getGeomAndTopo(part);
  const edge = findEdge(topo.edges(), e => {
    const sp = e.startVertex.point, ep = e.endVertex.point;
    return Math.abs(sp.z) < 0.01 && Math.abs(ep.z) < 0.01 && e.curve && e.curve.degree >= 2;
  });
  assert.ok(edge, 'Should find a bottom spline sub-edge');
  const result = chamferEdge(geom, edge);
  assert.ok(result, 'Chamfer should succeed on bottom spline sub-edge');
});

test('Mixed profile: chamfer straight bottom edge (PLANE + PLANE)', () => {
  const part = buildPart(mixedSetup);
  const { geom, topo } = getGeomAndTopo(part);
  const edge = findEdge(topo.edges(), e => {
    const adj = e.coedges.map(ce => ce.loop?.face?.surfaceType);
    return !adj.includes('bspline') && e.curve?.degree === 1
      && Math.abs(e.startVertex.point.z) < 0.01 && Math.abs(e.endVertex.point.z) < 0.01;
  });
  assert.ok(edge, 'Should find a straight bottom edge');
  const result = chamferEdge(geom, edge);
  assert.ok(result, 'Chamfer should succeed on straight bottom edge');
});

test('Mixed profile: chamfer vertical edge at PLANE/BSPLINE junction', () => {
  const part = buildPart(mixedSetup);
  const { geom, topo } = getGeomAndTopo(part);
  const edge = findEdge(topo.edges(), e => {
    const adj = e.coedges.map(ce => ce.loop?.face?.surfaceType);
    return adj.includes('bspline') && adj.includes('plane') && e.curve?.degree === 1;
  });
  assert.ok(edge, 'Should find a vertical PLANE/BSPLINE edge');
  const result = chamferEdge(geom, edge);
  assert.ok(result, 'Chamfer should succeed on vertical PLANE/BSPLINE edge');
});

test('Mixed profile: chamfer top spline sub-edge (PLANE + BSPLINE)', () => {
  const part = buildPart(mixedSetup);
  const { geom, topo } = getGeomAndTopo(part);
  const edge = findEdge(topo.edges(), e => {
    const sp = e.startVertex.point, ep = e.endVertex.point;
    return Math.abs(sp.z - 5) < 0.01 && Math.abs(ep.z - 5) < 0.01 && e.curve && e.curve.degree >= 2;
  });
  assert.ok(edge, 'Should find a top spline sub-edge');
  const result = chamferEdge(geom, edge);
  assert.ok(result, 'Chamfer should succeed on top spline sub-edge');
});

// ======================================================================
// Lens profile: two opposing splines
// ======================================================================

const lensSetup = (sketch) => {
  sketch.addSpline([{ x: 0, y: 0 }, { x: 5, y: 3 }, { x: 10, y: 0 }]);
  sketch.addSpline([{ x: 10, y: 0 }, { x: 5, y: -3 }, { x: 0, y: 0 }]);
};

test('Lens profile: each spline splits into N = max(3, 3) = 3 sub-faces, total 6 BSPLINE', () => {
  const part = buildPart(lensSetup);
  const { topo } = getGeomAndTopo(part);
  const bsplineFaces = topo.faces().filter(f => f.surfaceType === 'bspline');
  assert.strictEqual(bsplineFaces.length, 6, `Expected 6 BSPLINE sub-faces, got ${bsplineFaces.length}`);
});

test('Lens profile: cap faces have 6 edges each (from 6 sub-curves)', () => {
  const part = buildPart(lensSetup);
  const { topo } = getGeomAndTopo(part);
  const capFaces = topo.faces().filter(f => f.surfaceType === 'plane');
  assert.strictEqual(capFaces.length, 2, 'Should have 2 cap faces');
  for (const cap of capFaces) {
    assert.strictEqual(cap.outerLoop.coedges.length, 6, `Cap should have 6 coedges, got ${cap.outerLoop.coedges.length}`);
  }
});

test('Lens profile: chamfer vertical edge between two BSPLINE faces', () => {
  const part = buildPart(lensSetup);
  const { geom, topo } = getGeomAndTopo(part);
  const edge = findEdge(topo.edges(), e => {
    const adj = e.coedges.map(ce => ce.loop?.face?.surfaceType);
    return adj.every(t => t === 'bspline') && e.curve?.degree === 1;
  });
  assert.ok(edge, 'Should find vertical BSPLINE/BSPLINE edge');
  const result = chamferEdge(geom, edge);
  assert.ok(result, 'Chamfer should succeed on vertical BSPLINE/BSPLINE edge');
});

test('Lens profile: chamfer bottom curve sub-edge', () => {
  const part = buildPart(lensSetup);
  const { geom, topo } = getGeomAndTopo(part);
  const edge = findEdge(topo.edges(), e => {
    const sp = e.startVertex.point, ep = e.endVertex.point;
    return Math.abs(sp.z) < 0.01 && Math.abs(ep.z) < 0.01 && e.curve?.degree >= 2;
  });
  assert.ok(edge, 'Should find a bottom curve sub-edge');
  const result = chamferEdge(geom, edge);
  assert.ok(result, 'Chamfer should succeed on lens bottom curve sub-edge');
});

// ======================================================================
// Bezier profile: segments + bezier
// ======================================================================

const bezierSetup = (sketch) => {
  sketch.addSegment(0, 0, 10, 0);
  sketch.addSegment(10, 0, 10, 10);
  sketch.addBezier([
    { x: 10, y: 10, handleOut: { dx: -2, dy: 5 } },
    { x: 0, y: 10, handleIn: { dx: 2, dy: 5 } },
  ]);
  sketch.addSegment(0, 10, 0, 0);
};

test('Bezier profile: bezier splits into N = max(3, 2) = 3 BSPLINE sub-faces', () => {
  const part = buildPart(bezierSetup);
  const { topo } = getGeomAndTopo(part);
  const bsplineFaces = topo.faces().filter(f => f.surfaceType === 'bspline');
  assert.strictEqual(bsplineFaces.length, 3, `Expected 3 BSPLINE sub-faces, got ${bsplineFaces.length}`);
});

test('Bezier profile: chamfer bottom bezier sub-edge', () => {
  const part = buildPart(bezierSetup);
  const { geom, topo } = getGeomAndTopo(part);
  const edge = findEdge(topo.edges(), e => {
    const sp = e.startVertex.point, ep = e.endVertex.point;
    return Math.abs(sp.z) < 0.01 && Math.abs(ep.z) < 0.01 && e.curve?.degree >= 2;
  });
  assert.ok(edge, 'Should find a bottom bezier sub-edge');
  const result = chamferEdge(geom, edge);
  assert.ok(result, 'Chamfer should succeed on bezier sub-edge');
});

test('Bezier profile: chamfer vertical edge at bezier junction', () => {
  const part = buildPart(bezierSetup);
  const { geom, topo } = getGeomAndTopo(part);
  const edge = findEdge(topo.edges(), e => {
    const adj = e.coedges.map(ce => ce.loop?.face?.surfaceType);
    return adj.includes('bspline') && adj.includes('plane') && e.curve?.degree === 1;
  });
  assert.ok(edge, 'Should find a vertical PLANE/BSPLINE edge');
  const result = chamferEdge(geom, edge);
  assert.ok(result, 'Chamfer should succeed on vertical PLANE/BSPLINE edge at bezier junction');
});

// ======================================================================
// NurbsCurve.splitAt / splitUniform
// ======================================================================

import { NurbsCurve } from '../js/cad/NurbsCurve.js';

test('NurbsCurve.splitAt: degree-2 spline splits at midpoint with continuity', () => {
  const curve = new NurbsCurve(2,
    [{ x: 0, y: 0, z: 0 }, { x: 5, y: 3, z: 0 }, { x: 10, y: 0, z: 0 }],
    [0, 0, 0, 1, 1, 1]);
  const [left, right] = curve.splitAt(0.5);
  assert.ok(left && right, 'splitAt should return two curves');
  const le = left.evaluate(left.uMax);
  const rs = right.evaluate(right.uMin);
  const gap = Math.sqrt((le.x-rs.x)**2 + (le.y-rs.y)**2 + (le.z-rs.z)**2);
  assert.ok(gap < 1e-10, `C0 gap should be < 1e-10, got ${gap}`);
});

test('NurbsCurve.splitAt: degree-3 spline splits preserving geometry', () => {
  const curve = new NurbsCurve(3,
    [{ x: 0, y: 0, z: 0 }, { x: 3, y: 5, z: 0 }, { x: 7, y: 5, z: 0 }, { x: 10, y: 0, z: 0 }],
    [0, 0, 0, 0, 1, 1, 1, 1]);
  const [left, right] = curve.splitAt(0.5);
  assert.ok(left && right);
  // Check start and end match original
  const origStart = curve.evaluate(0);
  const origEnd = curve.evaluate(1);
  const leftStart = left.evaluate(left.uMin);
  const rightEnd = right.evaluate(right.uMax);
  assert.ok(Math.abs(origStart.x - leftStart.x) < 1e-10);
  assert.ok(Math.abs(origEnd.x - rightEnd.x) < 1e-10);
});

test('NurbsCurve.splitUniform: splits into N parts with correct count', () => {
  const curve = new NurbsCurve(3,
    [{ x: 0, y: 0, z: 0 }, { x: 3, y: 5, z: 0 }, { x: 7, y: 5, z: 0 }, { x: 10, y: 0, z: 0 }],
    [0, 0, 0, 0, 1, 1, 1, 1]);
  const parts = curve.splitUniform(4);
  assert.ok(parts, 'splitUniform should not return null');
  assert.strictEqual(parts.length, 4, 'Should produce 4 sub-curves');
  // Check continuity between all parts
  for (let i = 0; i < parts.length - 1; i++) {
    const end = parts[i].evaluate(parts[i].uMax);
    const start = parts[i+1].evaluate(parts[i+1].uMin);
    const gap = Math.sqrt((end.x-start.x)**2 + (end.y-start.y)**2 + (end.z-start.z)**2);
    assert.ok(gap < 1e-10, `Gap between parts ${i} and ${i+1} should be < 1e-10, got ${gap}`);
  }
});

test('NurbsCurve.splitAt: weighted (rational) curve preserves arc shape', () => {
  const w = Math.cos(Math.PI/4);
  const curve = new NurbsCurve(2,
    [{ x: 1, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }],
    [0, 0, 0, 1, 1, 1], [1, w, 1]);
  const [left, right] = curve.splitAt(0.5);
  assert.ok(left && right);
  // All points on the arc should be at unit distance from origin
  for (const part of [left, right]) {
    for (let t = 0; t <= 1; t += 0.25) {
      const u = part.uMin + t * (part.uMax - part.uMin);
      const p = part.evaluate(u);
      const dist = Math.sqrt(p.x**2 + p.y**2 + p.z**2);
      assert.ok(Math.abs(dist - 1) < 1e-6, `Arc point at t=${t} should be on unit circle, dist=${dist}`);
    }
  }
});

// ======================================================================

console.log(`\nSpline/Bezier Chamfer Tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
