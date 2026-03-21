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
  const vk = (v) => `${v.x.toFixed(PREC)},${v.y.toFixed(PREC)},${v.z.toFixed(PREC)}`;
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
