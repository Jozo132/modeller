/**
 * Tests for CSG T-junction repair and chamfer/fillet sort key fixes.
 * Validates that CSG boolean results produce manifold meshes and that
 * chamfer/fillet operations on CSG-result edges work correctly.
 */
import assert from 'assert';
import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { makeEdgeKey, calculateMeshVolume } from '../js/cad/CSG.js';

const PREC = 5;
const fmt = (n) => (Math.abs(n) < 5e-6 ? 0 : n).toFixed(PREC);
const vk = (v) => `${fmt(v.x)},${fmt(v.y)},${fmt(v.z)}`;

function checkManifold(geometry) {
  const edgeMap = new Map();
  for (let fi = 0; fi < geometry.faces.length; fi++) {
    const verts = geometry.faces[fi].vertices;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      const ka = vk(a), kb = vk(b);
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      if (!edgeMap.has(key)) edgeMap.set(key, []);
      edgeMap.get(key).push(fi);
    }
  }
  let boundary = 0, nonManifold = 0;
  for (const [, entries] of edgeMap) {
    if (entries.length === 1) boundary++;
    else if (entries.length > 2) nonManifold++;
  }
  return { boundary, nonManifold };
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n    ${err.message}\n`); failed++; }
}

console.log('=== CSG T-junction Repair Tests ===\n');

test('Cube + Cylinder union produces manifold mesh', () => {
  const part = new Part('T1');
  const s1 = new Sketch();
  s1.addSegment(-10, -10, 10, -10);
  s1.addSegment(10, -10, 10, 10);
  s1.addSegment(10, 10, -10, 10);
  s1.addSegment(-10, 10, -10, -10);
  const sf1 = part.addSketch(s1);
  part.extrude(sf1.id, 5);

  const s2 = new Sketch();
  s2.addCircle(0, 0, 5);
  const sf2 = part.addSketch(s2, { plane: 'XY', offset: 5 });
  part.extrude(sf2.id, 10);

  const g = part.getFinalGeometry().geometry;
  const m = checkManifold(g);
  assert.strictEqual(m.boundary, 0, `Expected 0 boundary edges, got ${m.boundary}`);
  assert.strictEqual(m.nonManifold, 0, `Expected 0 non-manifold edges, got ${m.nonManifold}`);
});

test('Two cubes (smaller on larger) union produces manifold mesh', () => {
  const part = new Part('T2');
  const s1 = new Sketch();
  s1.addSegment(0, 0, 10, 0);
  s1.addSegment(10, 0, 10, 10);
  s1.addSegment(10, 10, 0, 10);
  s1.addSegment(0, 10, 0, 0);
  const sf1 = part.addSketch(s1);
  part.extrude(sf1.id, 5);

  const s2 = new Sketch();
  s2.addSegment(2, 2, 8, 2);
  s2.addSegment(8, 2, 8, 8);
  s2.addSegment(8, 8, 2, 8);
  s2.addSegment(2, 8, 2, 2);
  const sf2 = part.addSketch(s2, { plane: 'XY', offset: 5 });
  part.extrude(sf2.id, 5);

  const g = part.getFinalGeometry().geometry;
  const m = checkManifold(g);
  assert.strictEqual(m.boundary, 0, `Expected 0 boundary edges, got ${m.boundary}`);
  assert.strictEqual(m.nonManifold, 0, `Expected 0 non-manifold edges, got ${m.nonManifold}`);
});

test('Two cubes chamfer on z=5 edges: positive volume', () => {
  const part = new Part('T3');
  const s1 = new Sketch();
  s1.addSegment(0, 0, 10, 0);
  s1.addSegment(10, 0, 10, 10);
  s1.addSegment(10, 10, 0, 10);
  s1.addSegment(0, 10, 0, 0);
  const sf1 = part.addSketch(s1);
  part.extrude(sf1.id, 5);

  const s2 = new Sketch();
  s2.addSegment(2, 2, 8, 2);
  s2.addSegment(8, 2, 8, 8);
  s2.addSegment(8, 8, 2, 8);
  s2.addSegment(2, 8, 2, 2);
  const sf2 = part.addSketch(s2, { plane: 'XY', offset: 5 });
  part.extrude(sf2.id, 5);

  const before = part.getFinalGeometry();
  const z5Edges = before.geometry.edges.filter(e =>
    Math.abs(e.start.z - 5) < 0.2 && Math.abs(e.end.z - 5) < 0.2
  );
  assert.ok(z5Edges.length > 0, 'Should find edges at z=5');

  const z5Keys = z5Edges.map(e => makeEdgeKey(e.start, e.end));
  part.chamfer(z5Keys, 0.5);
  const after = part.getFinalGeometry();
  assert.ok(after && after.type === 'solid', 'Should produce valid solid');
  const vol = calculateMeshVolume(after.geometry);
  assert.ok(vol > 0, `Volume should be positive, got ${vol}`);
});

test('Cube + Cylinder fillet on circle edge: positive volume', () => {
  const part = new Part('T4');
  const s1 = new Sketch();
  s1.addSegment(-10, -10, 10, -10);
  s1.addSegment(10, -10, 10, 10);
  s1.addSegment(10, 10, -10, 10);
  s1.addSegment(-10, 10, -10, -10);
  const sf1 = part.addSketch(s1);
  part.extrude(sf1.id, 5);

  const s2 = new Sketch();
  s2.addCircle(0, 0, 5);
  const sf2 = part.addSketch(s2, { plane: 'XY', offset: 5 });
  part.extrude(sf2.id, 10);

  const before = part.getFinalGeometry();
  const volBefore = calculateMeshVolume(before.geometry);

  const circEdge = before.geometry.edges.find(e => {
    if (Math.abs(e.start.z - 5) > 0.2 || Math.abs(e.end.z - 5) > 0.2) return false;
    const r1 = Math.sqrt(e.start.x ** 2 + e.start.y ** 2);
    const r2 = Math.sqrt(e.end.x ** 2 + e.end.y ** 2);
    return r1 > 3 && r1 < 7 && r2 > 3 && r2 < 7;
  });
  assert.ok(circEdge, 'Should find a circle edge at z=5');

  const ek = makeEdgeKey(circEdge.start, circEdge.end);
  part.fillet([ek], 0.5, { segments: 4 });
  const after = part.getFinalGeometry();
  assert.ok(after && after.type === 'solid', 'Should produce valid solid');
  const volAfter = calculateMeshVolume(after.geometry);
  assert.ok(volAfter > 0, `Volume should be positive, got ${volAfter}`);
  assert.ok(Math.abs(volAfter - volBefore) / volBefore < 0.2, 'Volume should not change drastically');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
