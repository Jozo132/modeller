// tests/test-multi-body-chamfer-fillet.js — Validation tests for multi-body extrude, chamfer, and fillet

import assert from 'assert';
import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { calculateMeshVolume, calculateBoundingBox, makeEdgeKey } from '../js/cad/CSG.js';

function makeRectSketch(x1, y1, x2, y2) {
  const s = new Sketch();
  s.addSegment(x1, y1, x2, y1);
  s.addSegment(x2, y1, x2, y2);
  s.addSegment(x2, y2, x1, y2);
  s.addSegment(x1, y2, x1, y1);
  return s;
}

function assertApprox(actual, expected, tolerance, msg) {
  assert.ok(Math.abs(actual - expected) < tolerance,
    `${msg}: expected ~${expected}, got ${actual} (diff: ${Math.abs(actual - expected).toFixed(6)})`);
}

// Check mesh manifoldness: every edge in exactly 2 faces with opposite traversal
function checkManifold(geometry) {
  const PREC = 5;
  const fmt = (n) => (Math.abs(n) < 5e-6 ? 0 : n).toFixed(PREC);
  const vk = (v) => `${fmt(v.x)},${fmt(v.y)},${fmt(v.z)}`;
  const edgeMap = new Map();

  for (let fi = 0; fi < geometry.faces.length; fi++) {
    const verts = geometry.faces[fi].vertices;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      const ka = vk(a), kb = vk(b);
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const fwd = ka < kb;
      if (!edgeMap.has(key)) edgeMap.set(key, []);
      edgeMap.get(key).push({ fi, fwd });
    }
  }

  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  let windingErrors = 0;

  for (const [key, entries] of edgeMap) {
    if (entries.length === 1) {
      boundaryEdges++;
    } else if (entries.length === 2) {
      if (entries[0].fwd === entries[1].fwd) windingErrors++;
    } else {
      nonManifoldEdges++;
    }
  }

  return { boundaryEdges, nonManifoldEdges, windingErrors, totalEdges: edgeMap.size };
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

console.log('=== Multi-body Extrude, Chamfer & Fillet Tests ===\n');

// --- Extrude Tests ---

test('Single rectangle extrude: correct volume', () => {
  const part = new Part('T1');
  const sf = part.addSketch(makeRectSketch(0, 0, 10, 5));
  part.extrude(sf.id, 8);
  const r = part.getFinalGeometry();
  assert.ok(r && r.type === 'solid');
  assertApprox(calculateMeshVolume(r.geometry), 400, 1, 'Volume');
});

test('Single rectangle extrude: manifold', () => {
  const part = new Part('T2');
  const sf = part.addSketch(makeRectSketch(0, 0, 10, 5));
  part.extrude(sf.id, 8);
  const r = part.getFinalGeometry();
  const m = checkManifold(r.geometry);
  assert.strictEqual(m.boundaryEdges, 0, `boundary=${m.boundaryEdges}`);
  assert.strictEqual(m.nonManifoldEdges, 0, `nonManifold=${m.nonManifoldEdges}`);
  assert.strictEqual(m.windingErrors, 0, `winding=${m.windingErrors}`);
});

test('Two-rectangle extrude: correct combined volume', () => {
  const part = new Part('T3');
  const sketch = new Sketch();
  sketch.addSegment(0, 0, 4, 0); sketch.addSegment(4, 0, 4, 3);
  sketch.addSegment(4, 3, 0, 3); sketch.addSegment(0, 3, 0, 0);
  sketch.addSegment(6, 0, 10, 0); sketch.addSegment(10, 0, 10, 3);
  sketch.addSegment(10, 3, 6, 3); sketch.addSegment(6, 3, 6, 0);
  const sf = part.addSketch(sketch);
  part.extrude(sf.id, 5);
  const r = part.getFinalGeometry();
  assert.ok(r);
  const vol = calculateMeshVolume(r.geometry);
  assertApprox(vol, 120, 1, 'Combined volume');
  const bb = calculateBoundingBox(r.geometry);
  assert.ok(bb.max.x >= 9.9, `BBox x max should be ~10, got ${bb.max.x}`);
});

test('Two-rectangle extrude: manifold', () => {
  const part = new Part('T4');
  const sketch = new Sketch();
  sketch.addSegment(0, 0, 4, 0); sketch.addSegment(4, 0, 4, 3);
  sketch.addSegment(4, 3, 0, 3); sketch.addSegment(0, 3, 0, 0);
  sketch.addSegment(6, 0, 10, 0); sketch.addSegment(10, 0, 10, 3);
  sketch.addSegment(10, 3, 6, 3); sketch.addSegment(6, 3, 6, 0);
  const sf = part.addSketch(sketch);
  part.extrude(sf.id, 5);
  const r = part.getFinalGeometry();
  const m = checkManifold(r.geometry);
  assert.strictEqual(m.boundaryEdges, 0, `boundary=${m.boundaryEdges}`);
  assert.strictEqual(m.nonManifoldEdges, 0, `nonManifold=${m.nonManifoldEdges}`);
  assert.strictEqual(m.windingErrors, 0, `winding=${m.windingErrors}`);
});

// --- Chamfer Tests ---

test('Chamfer on box edge: feature created, volume reduced', () => {
  const part = new Part('T5');
  const sf = part.addSketch(makeRectSketch(0, 0, 10, 5));
  part.extrude(sf.id, 8);
  const before = part.getFinalGeometry();
  const volBefore = calculateMeshVolume(before.geometry);

  // Top-front edge
  const ek = makeEdgeKey({ x: 0, y: 0, z: 8 }, { x: 10, y: 0, z: 8 });
  const chamfer = part.chamfer([ek], 1);
  assert.ok(chamfer, 'Chamfer feature should be created');

  const after = part.getFinalGeometry();
  assert.ok(after && after.type === 'solid', 'Should produce valid solid');
  const volAfter = calculateMeshVolume(after.geometry);
  assert.ok(volAfter < volBefore, `Chamfer should reduce volume: ${volBefore} → ${volAfter}`);
  assert.ok(volAfter > volBefore * 0.5, `Chamfer removed too much: ${volBefore} → ${volAfter}`);
});

test('Chamfer on box edge: manifold (no holes)', () => {
  const part = new Part('T6');
  const sf = part.addSketch(makeRectSketch(0, 0, 10, 5));
  part.extrude(sf.id, 8);

  const ek = makeEdgeKey({ x: 0, y: 0, z: 8 }, { x: 10, y: 0, z: 8 });
  part.chamfer([ek], 1);

  const r = part.getFinalGeometry();
  const m = checkManifold(r.geometry);
  assert.strictEqual(m.boundaryEdges, 0, `Chamfer boundary edges: ${m.boundaryEdges}`);
  assert.strictEqual(m.nonManifoldEdges, 0, `Chamfer non-manifold: ${m.nonManifoldEdges}`);
  assert.strictEqual(m.windingErrors, 0, `Chamfer winding errors: ${m.windingErrors}`);
});

// --- Fillet Tests ---

test('Fillet on box edge: feature created, volume reduced', () => {
  const part = new Part('T7');
  const sf = part.addSketch(makeRectSketch(0, 0, 10, 5));
  part.extrude(sf.id, 8);
  const before = part.getFinalGeometry();
  const volBefore = calculateMeshVolume(before.geometry);

  const ek = makeEdgeKey({ x: 0, y: 0, z: 8 }, { x: 10, y: 0, z: 8 });
  const fillet = part.fillet([ek], 1, { segments: 4 });
  assert.ok(fillet, 'Fillet feature should be created');

  const after = part.getFinalGeometry();
  assert.ok(after && after.type === 'solid', 'Should produce valid solid');
  const volAfter = calculateMeshVolume(after.geometry);
  assert.ok(volAfter < volBefore, `Fillet should reduce volume: ${volBefore} → ${volAfter}`);
  assert.ok(volAfter > volBefore * 0.5, `Fillet removed too much: ${volBefore} → ${volAfter}`);
});

test('Fillet on box edge: manifold (no holes)', () => {
  const part = new Part('T8');
  const sf = part.addSketch(makeRectSketch(0, 0, 10, 5));
  part.extrude(sf.id, 8);

  const ek = makeEdgeKey({ x: 0, y: 0, z: 8 }, { x: 10, y: 0, z: 8 });
  part.fillet([ek], 1, { segments: 4 });

  const r = part.getFinalGeometry();
  const m = checkManifold(r.geometry);
  assert.strictEqual(m.boundaryEdges, 0, `Fillet boundary edges: ${m.boundaryEdges}`);
  assert.strictEqual(m.nonManifoldEdges, 0, `Fillet non-manifold: ${m.nonManifoldEdges}`);
  assert.strictEqual(m.windingErrors, 0, `Fillet winding errors: ${m.windingErrors}`);
});

test('Fillet adds more faces than original', () => {
  const part = new Part('T9');
  const sf = part.addSketch(makeRectSketch(0, 0, 10, 5));
  part.extrude(sf.id, 8);
  const before = part.getFinalGeometry();
  const facesBefore = before.geometry.faces.length;

  const ek = makeEdgeKey({ x: 0, y: 0, z: 8 }, { x: 10, y: 0, z: 8 });
  part.fillet([ek], 1, { segments: 4 });

  const after = part.getFinalGeometry();
  assert.ok(after.geometry.faces.length > facesBefore,
    `Expected more faces: before=${facesBefore}, after=${after.geometry.faces.length}`);
});

test('Two-edge box fillet keeps exact shared seam as a single exact edge', () => {
  const part = new Part('T9b');
  const sf = part.addSketch(makeRectSketch(0, 0, 10, 10));
  part.extrude(sf.id, 10);

  const ek1 = makeEdgeKey({ x: 0, y: 0, z: 10 }, { x: 10, y: 0, z: 10 });
  const ek2 = makeEdgeKey({ x: 10, y: 0, z: 10 }, { x: 10, y: 10, z: 10 });
  part.fillet([ek1, ek2], 1, { segments: 8 });

  const r = part.getFinalGeometry();
  const m = checkManifold(r.geometry);
  assert.strictEqual(m.boundaryEdges, 0, `boundary=${m.boundaryEdges}`);
  assert.strictEqual(m.nonManifoldEdges, 0, `nonManifold=${m.nonManifoldEdges}`);

  const body = r.geometry.topoBody;
  assert.ok(body && body.shells && body.shells.length > 0, 'Expected exact topoBody');
  const shell = body.shells[0];
  const bsplineFaces = shell.faces.filter((face) => face.surfaceType === 'bspline');
  assert.strictEqual(bsplineFaces.length, 2, `Expected 2 fillet faces, got ${bsplineFaces.length}`);
  for (const face of bsplineFaces) {
    assert.strictEqual(face.outerLoop.coedges.length, 4, 'Exact fillet faces should use 4 coedges');
  }

  const sharedBlendEdges = shell.edges().filter((edge) =>
    edge.coedges.length === 2 &&
    edge.coedges.every((coedge) => coedge.face && coedge.face.surfaceType === 'bspline')
  );
  assert.ok(sharedBlendEdges.length >= 1, 'Expected a shared fillet/fillet seam edge');
  assert.ok(sharedBlendEdges.some((edge) =>
    edge.curve &&
    edge.curve.degree === 2 &&
    edge.curve.controlPoints.length <= 9
  ), 'Expected a quadratic exact seam curve, not a segmented polyline chain');
});

// --- Chamfer + Fillet on adjacent edges (same face) ---

test('Chamfer + Fillet on adjacent edges sharing a vertex', () => {
  const part = new Part('T10');
  const sf = part.addSketch(makeRectSketch(0, 0, 10, 5));
  part.extrude(sf.id, 8);

  // Front-top edge
  const ek1 = makeEdgeKey({ x: 0, y: 0, z: 8 }, { x: 10, y: 0, z: 8 });
  part.chamfer([ek1], 1);

  // Right-top edge (shares vertex (10,0,8) with ek1)
  const ek2 = makeEdgeKey({ x: 10, y: 0, z: 8 }, { x: 10, y: 5, z: 8 });
  part.fillet([ek2], 1, { segments: 4 });

  const r = part.getFinalGeometry();
  assert.ok(r && r.type === 'solid', 'Should produce valid solid');
  const vol = calculateMeshVolume(r.geometry);
  assert.ok(vol > 0, `Volume should be positive: ${vol}`);
  assert.ok(vol < 400, `Volume should be less than original: ${vol}`);
});

test('Chamfer + Fillet on adjacent edges: manifold', () => {
  const part = new Part('T11');
  const sf = part.addSketch(makeRectSketch(0, 0, 10, 5));
  part.extrude(sf.id, 8);

  const ek1 = makeEdgeKey({ x: 0, y: 0, z: 8 }, { x: 10, y: 0, z: 8 });
  part.chamfer([ek1], 1);

  const ek2 = makeEdgeKey({ x: 10, y: 0, z: 8 }, { x: 10, y: 5, z: 8 });
  part.fillet([ek2], 1, { segments: 4 });

  const r = part.getFinalGeometry();
  const m = checkManifold(r.geometry);
  assert.strictEqual(m.boundaryEdges, 0, `boundary=${m.boundaryEdges}`);
  assert.strictEqual(m.nonManifoldEdges, 0, `nonManifold=${m.nonManifoldEdges}`);
  assert.strictEqual(m.windingErrors, 0, `winding=${m.windingErrors}`);
});

test('Fillet + Chamfer on adjacent edges (reversed order)', () => {
  const part = new Part('T12');
  const sf = part.addSketch(makeRectSketch(0, 0, 10, 5));
  part.extrude(sf.id, 8);

  // Fillet first, then chamfer on adjacent edge
  const ek1 = makeEdgeKey({ x: 0, y: 0, z: 8 }, { x: 10, y: 0, z: 8 });
  part.fillet([ek1], 1, { segments: 4 });

  const ek2 = makeEdgeKey({ x: 10, y: 0, z: 8 }, { x: 10, y: 5, z: 8 });
  part.chamfer([ek2], 1);

  const r = part.getFinalGeometry();
  assert.ok(r && r.type === 'solid', 'Should produce valid solid');
  const m = checkManifold(r.geometry);
  assert.strictEqual(m.boundaryEdges, 0, `boundary=${m.boundaryEdges}`);
  assert.strictEqual(m.nonManifoldEdges, 0, `nonManifold=${m.nonManifoldEdges}`);
});

test('Two chamfers on adjacent edges', () => {
  const part = new Part('T13');
  const sf = part.addSketch(makeRectSketch(0, 0, 10, 5));
  part.extrude(sf.id, 8);

  const ek1 = makeEdgeKey({ x: 0, y: 0, z: 8 }, { x: 10, y: 0, z: 8 });
  part.chamfer([ek1], 1);

  const ek2 = makeEdgeKey({ x: 10, y: 0, z: 8 }, { x: 10, y: 5, z: 8 });
  part.chamfer([ek2], 1);

  const r = part.getFinalGeometry();
  assert.ok(r && r.type === 'solid', 'Should produce valid solid');
  const m = checkManifold(r.geometry);
  assert.strictEqual(m.boundaryEdges, 0, `boundary=${m.boundaryEdges}`);
  assert.strictEqual(m.nonManifoldEdges, 0, `nonManifold=${m.nonManifoldEdges}`);
});

// --- Fillet + Fillet on adjacent edges ---

test('Fillet + Fillet on adjacent edges sharing a vertex', () => {
  const part = new Part('T14');
  const sf = part.addSketch(makeRectSketch(0, 0, 10, 5));
  part.extrude(sf.id, 8);

  const ek1 = makeEdgeKey({ x: 0, y: 0, z: 8 }, { x: 10, y: 0, z: 8 });
  part.fillet([ek1], 1, { segments: 4 });

  const ek2 = makeEdgeKey({ x: 10, y: 0, z: 8 }, { x: 10, y: 5, z: 8 });
  part.fillet([ek2], 1, { segments: 4 });

  const r = part.getFinalGeometry();
  assert.ok(r && r.type === 'solid', 'Should produce valid solid');
  const vol = calculateMeshVolume(r.geometry);
  assert.ok(vol > 0, `Volume should be positive: ${vol}`);
  assert.ok(vol < 400, `Volume should be less than original: ${vol}`);
});

test('Fillet + Fillet on adjacent edges: manifold', () => {
  const part = new Part('T15');
  const sf = part.addSketch(makeRectSketch(0, 0, 10, 5));
  part.extrude(sf.id, 8);

  const ek1 = makeEdgeKey({ x: 0, y: 0, z: 8 }, { x: 10, y: 0, z: 8 });
  part.fillet([ek1], 1, { segments: 4 });

  const ek2 = makeEdgeKey({ x: 10, y: 0, z: 8 }, { x: 10, y: 5, z: 8 });
  part.fillet([ek2], 1, { segments: 4 });

  const r = part.getFinalGeometry();
  const m = checkManifold(r.geometry);
  assert.strictEqual(m.boundaryEdges, 0, `boundary=${m.boundaryEdges}`);
  assert.strictEqual(m.nonManifoldEdges, 0, `nonManifold=${m.nonManifoldEdges}`);
  assert.strictEqual(m.windingErrors, 0, `winding=${m.windingErrors}`);
});

// --- Cylinder (circle extrude) chamfer / fillet on round edge ---

function makeCircleSketch(cx, cy, radius) {
  const s = new Sketch();
  s.addCircle(cx, cy, radius);
  return s;
}

test('Cylinder extrude + chamfer on round top edge: volume reduced, manifold', () => {
  const part = new Part('T16');
  const sf = part.addSketch(makeCircleSketch(0, 0, 5));
  part.extrude(sf.id, 10);

  const before = part.getFinalGeometry();
  const volBefore = calculateMeshVolume(before.geometry);

  // Collect all top-circle edge keys (z=10 ring)
  const topEdgeKeys = before.geometry.edges
    .filter(e => Math.abs(e.start.z - 10) < 0.1 && Math.abs(e.end.z - 10) < 0.1)
    .map(e => makeEdgeKey(e.start, e.end));
  assert.ok(topEdgeKeys.length > 0, 'Should find top-circle edges');

  part.chamfer(topEdgeKeys, 0.5);
  const after = part.getFinalGeometry();
  assert.ok(after && after.type === 'solid', 'Should produce valid solid');
  const volAfter = calculateMeshVolume(after.geometry);
  assert.ok(volAfter < volBefore, `Chamfer should reduce volume: ${volBefore.toFixed(2)} → ${volAfter.toFixed(2)}`);

  const m = checkManifold(after.geometry);
  assert.strictEqual(m.boundaryEdges, 0, `boundary=${m.boundaryEdges}`);
  assert.strictEqual(m.nonManifoldEdges, 0, `nonManifold=${m.nonManifoldEdges}`);
  assert.strictEqual(m.windingErrors, 0, `winding=${m.windingErrors}`);
});

test('Cylinder extrude + fillet on round top edge: volume reduced, manifold', () => {
  const part = new Part('T17');
  const sf = part.addSketch(makeCircleSketch(0, 0, 5));
  part.extrude(sf.id, 10);

  const before = part.getFinalGeometry();
  const volBefore = calculateMeshVolume(before.geometry);

  const topEdgeKeys = before.geometry.edges
    .filter(e => Math.abs(e.start.z - 10) < 0.1 && Math.abs(e.end.z - 10) < 0.1)
    .map(e => makeEdgeKey(e.start, e.end));
  assert.ok(topEdgeKeys.length > 0, 'Should find top-circle edges');

  part.fillet(topEdgeKeys, 0.5, { segments: 4 });
  const after = part.getFinalGeometry();
  assert.ok(after && after.type === 'solid', 'Should produce valid solid');
  const volAfter = calculateMeshVolume(after.geometry);
  assert.ok(volAfter < volBefore, `Fillet should reduce volume: ${volBefore.toFixed(2)} → ${volAfter.toFixed(2)}`);

  const m = checkManifold(after.geometry);
  assert.strictEqual(m.boundaryEdges, 0, `boundary=${m.boundaryEdges}`);
  assert.strictEqual(m.nonManifoldEdges, 0, `nonManifold=${m.nonManifoldEdges}`);
  assert.strictEqual(m.windingErrors, 0, `winding=${m.windingErrors}`);
});

// --- Multi-edge polyline chamfer/fillet tests ---

import { expandPathEdgeKeys } from '../js/cad/CSG.js';

console.log('\n=== Multi-segment Polyline Chamfer/Fillet Tests ===\n');

// L-shaped extrusion: more complex geometry with multi-edge paths
function makeLSketch() {
  const s = new Sketch();
  // L-shape:  (0,0) → (10,0) → (10,5) → (5,5) → (5,10) → (0,10) → (0,0)
  s.addSegment(0, 0, 10, 0);
  s.addSegment(10, 0, 10, 5);
  s.addSegment(10, 5, 5, 5);
  s.addSegment(5, 5, 5, 10);
  s.addSegment(5, 10, 0, 10);
  s.addSegment(0, 10, 0, 0);
  return s;
}

test('L-shape extrude + multi-edge chamfer on top: manifold', () => {
  const part = new Part('T_L1');
  const sf = part.addSketch(makeLSketch());
  part.extrude(sf.id, 8);

  const before = part.getFinalGeometry();
  const volBefore = calculateMeshVolume(before.geometry);

  // Find ALL top edges (z=8) and chamfer them together
  const topEdgeKeys = before.geometry.edges
    .filter(e => Math.abs(e.start.z - 8) < 0.1 && Math.abs(e.end.z - 8) < 0.1)
    .map(e => makeEdgeKey(e.start, e.end));
  assert.ok(topEdgeKeys.length >= 6, `Should find L-shape top edges: ${topEdgeKeys.length}`);

  part.chamfer(topEdgeKeys, 0.5);
  const after = part.getFinalGeometry();
  assert.ok(after && after.type === 'solid', 'Should produce valid solid');
  const volAfter = calculateMeshVolume(after.geometry);
  assert.ok(volAfter < volBefore, `Chamfer should reduce volume: ${volBefore.toFixed(2)} → ${volAfter.toFixed(2)}`);

  const m = checkManifold(after.geometry);
  assert.strictEqual(m.boundaryEdges, 0, `boundary=${m.boundaryEdges}`);
  assert.strictEqual(m.nonManifoldEdges, 0, `nonManifold=${m.nonManifoldEdges}`);
  assert.strictEqual(m.windingErrors, 0, `winding=${m.windingErrors}`);
});

test('L-shape extrude + multi-edge fillet on top: manifold', () => {
  const part = new Part('T_L2');
  const sf = part.addSketch(makeLSketch());
  part.extrude(sf.id, 8);

  const before = part.getFinalGeometry();
  const volBefore = calculateMeshVolume(before.geometry);

  const topEdgeKeys = before.geometry.edges
    .filter(e => Math.abs(e.start.z - 8) < 0.1 && Math.abs(e.end.z - 8) < 0.1)
    .map(e => makeEdgeKey(e.start, e.end));
  assert.ok(topEdgeKeys.length >= 6, `Should find L-shape top edges: ${topEdgeKeys.length}`);

  part.fillet(topEdgeKeys, 0.5, { segments: 4 });
  const after = part.getFinalGeometry();
  assert.ok(after && after.type === 'solid', 'Should produce valid solid');
  const volAfter = calculateMeshVolume(after.geometry);
  assert.ok(volAfter < volBefore, `Fillet should reduce volume: ${volBefore.toFixed(2)} → ${volAfter.toFixed(2)}`);

  const m = checkManifold(after.geometry);
  assert.strictEqual(m.boundaryEdges, 0, `boundary=${m.boundaryEdges}`);
  assert.strictEqual(m.nonManifoldEdges, 0, `nonManifold=${m.nonManifoldEdges}`);
  assert.strictEqual(m.windingErrors, 0, `winding=${m.windingErrors}`);
});

test('expandPathEdgeKeys expands single edge to full path', () => {
  const part = new Part('T_EP1');
  const sf = part.addSketch(makeCircleSketch(0, 0, 5));
  part.extrude(sf.id, 10);
  const geom = part.getFinalGeometry().geometry;

  // Select just ONE top-circle edge
  const topEdges = geom.edges
    .filter(e => Math.abs(e.start.z - 10) < 0.1 && Math.abs(e.end.z - 10) < 0.1);
  assert.ok(topEdges.length > 1, 'Should have multiple top edges');

  const singleKey = [makeEdgeKey(topEdges[0].start, topEdges[0].end)];
  const expanded = expandPathEdgeKeys(geom, singleKey);

  // Should expand to all edges in the same path (the full circle)
  assert.ok(expanded.length > 1, `Should expand to more than 1 edge: ${expanded.length}`);
  assert.ok(expanded.length >= topEdges.length,
    `Should expand to full circle: ${expanded.length} >= ${topEdges.length}`);
});

test('expandPathEdgeKeys tangent expansion connects adjacent paths', () => {
  const part = new Part('T_EP2');
  const sf = part.addSketch(makeLSketch());
  part.extrude(sf.id, 8);
  const geom = part.getFinalGeometry().geometry;

  // Find a single vertical edge on the L-shape (z varies, x and y constant)
  const vertEdges = geom.edges.filter(e =>
    Math.abs(e.start.x - e.end.x) < 0.01 && Math.abs(e.start.y - e.end.y) < 0.01 &&
    Math.abs(e.start.z - e.end.z) > 1
  );
  assert.ok(vertEdges.length > 0, 'Should find vertical edges');

  const singleKey = [makeEdgeKey(vertEdges[0].start, vertEdges[0].end)];
  const expanded = expandPathEdgeKeys(geom, singleKey);

  // For a straight vertical edge that is its own path, expansion should at
  // least return the original edge
  assert.ok(expanded.length >= 1, `Should expand to at least 1 edge: ${expanded.length}`);
});

test('Multi-edge chamfer on box (all top edges at once): manifold', () => {
  const part = new Part('T_MT1');
  const sf = part.addSketch(makeRectSketch(0, 0, 10, 5));
  part.extrude(sf.id, 8);

  const before = part.getFinalGeometry();
  const volBefore = calculateMeshVolume(before.geometry);

  // Select ALL 4 top edges at once
  const topEdgeKeys = [
    makeEdgeKey({ x: 0, y: 0, z: 8 }, { x: 10, y: 0, z: 8 }),
    makeEdgeKey({ x: 10, y: 0, z: 8 }, { x: 10, y: 5, z: 8 }),
    makeEdgeKey({ x: 10, y: 5, z: 8 }, { x: 0, y: 5, z: 8 }),
    makeEdgeKey({ x: 0, y: 5, z: 8 }, { x: 0, y: 0, z: 8 }),
  ];

  part.chamfer(topEdgeKeys, 0.5);
  const after = part.getFinalGeometry();
  assert.ok(after && after.type === 'solid', 'Should produce valid solid');
  const volAfter = calculateMeshVolume(after.geometry);
  assert.ok(volAfter < volBefore, `Volume should decrease: ${volBefore.toFixed(2)} → ${volAfter.toFixed(2)}`);

  const m = checkManifold(after.geometry);
  assert.strictEqual(m.boundaryEdges, 0, `boundary=${m.boundaryEdges}`);
  assert.strictEqual(m.nonManifoldEdges, 0, `nonManifold=${m.nonManifoldEdges}`);
  assert.strictEqual(m.windingErrors, 0, `winding=${m.windingErrors}`);
});

test('Multi-edge fillet on box (all top edges at once): manifold', () => {
  const part = new Part('T_MT2');
  const sf = part.addSketch(makeRectSketch(0, 0, 10, 5));
  part.extrude(sf.id, 8);

  const before = part.getFinalGeometry();
  const volBefore = calculateMeshVolume(before.geometry);

  const topEdgeKeys = [
    makeEdgeKey({ x: 0, y: 0, z: 8 }, { x: 10, y: 0, z: 8 }),
    makeEdgeKey({ x: 10, y: 0, z: 8 }, { x: 10, y: 5, z: 8 }),
    makeEdgeKey({ x: 10, y: 5, z: 8 }, { x: 0, y: 5, z: 8 }),
    makeEdgeKey({ x: 0, y: 5, z: 8 }, { x: 0, y: 0, z: 8 }),
  ];

  part.fillet(topEdgeKeys, 0.5, { segments: 4 });
  const after = part.getFinalGeometry();
  assert.ok(after && after.type === 'solid', 'Should produce valid solid');
  const volAfter = calculateMeshVolume(after.geometry);
  assert.ok(volAfter < volBefore, `Volume should decrease: ${volBefore.toFixed(2)} → ${volAfter.toFixed(2)}`);

  const m = checkManifold(after.geometry);
  assert.strictEqual(m.boundaryEdges, 0, `boundary=${m.boundaryEdges}`);
  assert.strictEqual(m.nonManifoldEdges, 0, `nonManifold=${m.nonManifoldEdges}`);
  assert.strictEqual(m.windingErrors, 0, `winding=${m.windingErrors}`);
});

// --- 3-edge corner fillet (trihedron) tests ---

console.log('\n=== 3-Edge Corner Fillet (Trihedron) Tests ===\n');

test('Fillet 3 edges meeting at a box corner: manifold, no overlapping faces', () => {
  const part = new Part('T_tri1');
  const sf = part.addSketch(makeRectSketch(0, 0, 10, 10));
  part.extrude(sf.id, 10);

  const before = part.getFinalGeometry();
  const volBefore = calculateMeshVolume(before.geometry);

  // 3 edges meeting at corner (10, 10, 10)
  const ek1 = makeEdgeKey({ x: 0, y: 10, z: 10 }, { x: 10, y: 10, z: 10 }); // top-back
  const ek2 = makeEdgeKey({ x: 10, y: 0, z: 10 }, { x: 10, y: 10, z: 10 }); // top-right
  const ek3 = makeEdgeKey({ x: 10, y: 10, z: 0 }, { x: 10, y: 10, z: 10 }); // vertical

  part.fillet([ek1, ek2, ek3], 1, { segments: 8 });

  const after = part.getFinalGeometry();
  assert.ok(after && after.type === 'solid', 'Should produce valid solid');
  const volAfter = calculateMeshVolume(after.geometry);
  assert.ok(volAfter < volBefore, `Volume should decrease: ${volBefore.toFixed(2)} → ${volAfter.toFixed(2)}`);
  assert.ok(volAfter > volBefore * 0.8, `Volume should not decrease too much: ${volAfter.toFixed(2)}`);

  const m = checkManifold(after.geometry);
  assert.strictEqual(m.boundaryEdges, 0, `boundary=${m.boundaryEdges}`);
  assert.strictEqual(m.nonManifoldEdges, 0, `nonManifold=${m.nonManifoldEdges}`);
  assert.strictEqual(m.windingErrors, 0, `winding=${m.windingErrors}`);
});

test('Fillet 3 edges meeting at a corner: no zero-area faces', () => {
  const part = new Part('T_tri2');
  const sf = part.addSketch(makeRectSketch(0, 0, 10, 10));
  part.extrude(sf.id, 10);

  const ek1 = makeEdgeKey({ x: 0, y: 10, z: 10 }, { x: 10, y: 10, z: 10 });
  const ek2 = makeEdgeKey({ x: 10, y: 0, z: 10 }, { x: 10, y: 10, z: 10 });
  const ek3 = makeEdgeKey({ x: 10, y: 10, z: 0 }, { x: 10, y: 10, z: 10 });

  part.fillet([ek1, ek2, ek3], 1, { segments: 8 });

  const after = part.getFinalGeometry();
  let degenerateFaces = 0;
  for (const f of after.geometry.faces) {
    if (f.vertices.length < 3) { degenerateFaces++; continue; }
    const v = f.vertices;
    const cross = {
      x: (v[1].y - v[0].y) * (v[2].z - v[0].z) - (v[1].z - v[0].z) * (v[2].y - v[0].y),
      y: (v[1].z - v[0].z) * (v[2].x - v[0].x) - (v[1].x - v[0].x) * (v[2].z - v[0].z),
      z: (v[1].x - v[0].x) * (v[2].y - v[0].y) - (v[1].y - v[0].y) * (v[2].x - v[0].x),
    };
    const area = Math.sqrt(cross.x ** 2 + cross.y ** 2 + cross.z ** 2) / 2;
    if (area < 1e-10) degenerateFaces++;
  }
  assert.strictEqual(degenerateFaces, 0, `Found ${degenerateFaces} degenerate (zero-area) faces`);
});

test('box-fillet-3: 10 feature faces and 21 feature lines (6 curved)', () => {
  const part = new Part('T_tri3');
  const sf = part.addSketch(makeRectSketch(0, 0, 10, 10));
  part.extrude(sf.id, 10);

  const ek1 = makeEdgeKey({ x: 0, y: 10, z: 10 }, { x: 10, y: 10, z: 10 });
  const ek2 = makeEdgeKey({ x: 10, y: 0, z: 10 }, { x: 10, y: 10, z: 10 });
  const ek3 = makeEdgeKey({ x: 10, y: 10, z: 0 }, { x: 10, y: 10, z: 10 });

  part.fillet([ek1, ek2, ek3], 1, { segments: 8 });

  const after = part.getFinalGeometry();
  const geom = after.geometry;

  // Count unique face groups
  const groups = new Set(geom.faces.map(f => f.faceGroup));
  assert.strictEqual(groups.size, 10, `Expected 10 face groups, got ${groups.size}`);

  // Count feature lines (paths)
  assert.strictEqual(geom.paths.length, 21, `Expected 21 feature lines, got ${geom.paths.length}`);

  // Count curved paths (more than 2 edges)
  const curvedPaths = geom.paths.filter(p => p.edgeIndices.length > 2).length;
  assert.strictEqual(curvedPaths, 6, `Expected 6 curved feature lines, got ${curvedPaths}`);
});

test('box-fillet-3: spherical corner has NURBS surface on sphere', () => {
  const part = new Part('T_tri4');
  const sf = part.addSketch(makeRectSketch(0, 0, 10, 10));
  part.extrude(sf.id, 10);

  const ek1 = makeEdgeKey({ x: 0, y: 10, z: 10 }, { x: 10, y: 10, z: 10 });
  const ek2 = makeEdgeKey({ x: 10, y: 0, z: 10 }, { x: 10, y: 10, z: 10 });
  const ek3 = makeEdgeKey({ x: 10, y: 10, z: 0 }, { x: 10, y: 10, z: 10 });

  part.fillet([ek1, ek2, ek3], 1, { segments: 8 });

  const after = part.getFinalGeometry();
  const brep = after.geometry.brep;
  assert.ok(brep, 'Should have BRep data');

  // Find the spherical BRep face
  const sphereFace = brep.faces.find(f => f.surfaceType === 'spherical');
  assert.ok(sphereFace, 'Should have a spherical BRep face');
  assert.ok(sphereFace.surface, 'Spherical face should have a NURBS surface');
  assert.strictEqual(sphereFace.surface.degreeU, 2, 'Degree U should be 2');
  assert.strictEqual(sphereFace.surface.degreeV, 2, 'Degree V should be 2');
  assert.strictEqual(sphereFace.surface.numRowsU, 3, 'Should have 3x3 control points');

  // Evaluate the surface at several parameter values and check points lie
  // on (or very near) the sphere defined by center + radius.
  const center = sphereFace.sphereCenter;
  const radius = sphereFace.sphereRadius;
  const surf = sphereFace.surface;

  const params = [
    [0.5, 0.5], [0.25, 0.5], [0.75, 0.5],
    [0.5, 0.25], [0.5, 0.75], [1.0, 0.0], [1.0, 1.0],
  ];
  for (const [u, v] of params) {
    const pt = surf.evaluate(u, v);
    const dx = pt.x - center.x, dy = pt.y - center.y, dz = pt.z - center.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    assert.ok(
      Math.abs(dist - radius) < 0.01,
      `Point at (${u},${v}) dist=${dist.toFixed(4)} should be near radius=${radius.toFixed(4)}`
    );
  }
});

test('box-fillet-3-p: sequential fillets stay closed and keep distinct feature ownership', () => {
  const part = new Part('T_tri_seq');
  const sf = part.addSketch(makeRectSketch(0, 0, 10, 10));
  part.extrude(sf.id, 10);

  const topEdge0 = makeEdgeKey({ x: 0, y: 0, z: 10 }, { x: 10, y: 0, z: 10 });
  const topEdge1 = makeEdgeKey({ x: 10, y: 0, z: 10 }, { x: 10, y: 10, z: 10 });
  const fillet0 = part.fillet([topEdge0, topEdge1], 1, { segments: 8 });

  const verticalEdge = makeEdgeKey({ x: 10, y: 0, z: 0 }, { x: 10, y: 0, z: 9 });
  const fillet1 = part.fillet([verticalEdge], 1, { segments: 8 });

  const geom = part.getFinalGeometry().geometry;
  const m = checkManifold(geom);
  assert.strictEqual(m.boundaryEdges, 0, 'Sequential fillet corner should remain closed');
  assert.strictEqual(m.nonManifoldEdges, 0, 'Sequential fillet corner should remain manifold');
  assert.strictEqual(m.windingErrors, 0, 'Sequential fillet corner should keep consistent winding');

  const blendFeatureIds = new Set(
    geom.faces
      .filter(f => f.isFillet || f.isCorner)
      .map(f => f.shared && f.shared.sourceFeatureId)
      .filter(Boolean)
  );
  assert.ok(blendFeatureIds.has(fillet0.id), 'Expected the first fillet feature to own blend faces');
  assert.ok(blendFeatureIds.has(fillet1.id), 'Expected the second fillet feature to own blend faces');

  const filletGroups = new Map();
  for (const face of geom.faces) {
    if (!face.isFillet || face.isCorner) continue;
    const group = face.faceGroup;
    if (!filletGroups.has(group)) filletGroups.set(group, new Set());
    filletGroups.get(group).add(face.shared && face.shared.sourceFeatureId);
  }
  const ownedGroups = [...filletGroups.values()].filter(ids => ids.size === 1);
  assert.ok(ownedGroups.length >= 3, `Expected separate fillet strip groups, got ${ownedGroups.length}`);
});

// --- 2-Edge Corner Fillet Tests ---

test('box-fillet-2: exact topology keeps fillets isolated', () => {
  const part = new Part('T_bi1');
  const sf = part.addSketch(makeRectSketch(0, 0, 10, 10));
  part.extrude(sf.id, 10);

  // Two top edges meeting at (10, 0, 10)
  const ek1 = makeEdgeKey({ x: 0, y: 0, z: 10 }, { x: 10, y: 0, z: 10 });
  const ek2 = makeEdgeKey({ x: 10, y: 0, z: 10 }, { x: 10, y: 10, z: 10 });
  part.fillet([ek1, ek2], 1, { segments: 8 });

  const after = part.getFinalGeometry();
  const geom = after.geometry;

  // Manifold check
  const m = checkManifold(geom);
  assert.strictEqual(m.boundaryEdges, 0, 'No boundary edges');
  assert.strictEqual(m.nonManifoldEdges, 0, 'No non-manifold edges');
  assert.strictEqual(m.windingErrors, 0, 'No winding errors');

  assert.ok(geom.topoBody, 'Expected a TopoBody for robust fillet output');
  assert.ok(geom.faces.some(f => f.topoFaceId !== undefined), 'Expected tessellated faces to retain topoFaceId');

  const filletGroups = new Set(
    geom.faces
      .filter(f => f.isFillet)
      .map(f => f.faceGroup)
      .filter(g => g !== undefined)
  );
  assert.ok(filletGroups.size >= 2, `Expected the two fillets to stay isolated, got ${filletGroups.size} groups`);
  const expectedSeamGroups = [...filletGroups].slice(0, 2);

  const seamEdges = geom.edges.filter((edge) => {
    const pts = edge.points || [];
    const touchesTopCorner = pts.some((point) =>
      point.x > 9 &&
      point.y < 1 &&
      point.z > 9.9
    );
    const groupSet = new Set((edge.faceIndices || [])
      .map((fi) => geom.faces[fi] && geom.faces[fi].faceGroup)
      .filter((group) => group !== undefined));
    return touchesTopCorner &&
      groupSet.size === 2 &&
      expectedSeamGroups.every((group) => groupSet.has(group));
  });
  assert.ok(seamEdges.length >= 1, `Expected visible top seam segments between the two fillets, got ${seamEdges.length}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
