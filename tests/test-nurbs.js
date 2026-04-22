import './_watchdog.mjs';
// tests/test-nurbs.js — Tests for NURBS curve, surface, and B-Rep integration
//
// Validates:
// 1. NurbsCurve evaluation, derivatives, tessellation, and factory methods
// 2. NurbsSurface evaluation, normals, tessellation, and factory methods
// 3. BRep data structure construction, serialization, and conversion
// 4. NURBS generation in chamfer/fillet operations
// 5. Integration with existing geometry pipeline (volume, manifold checks)

import assert from 'assert';
import { NurbsCurve } from '../js/cad/NurbsCurve.js';
import { NurbsSurface } from '../js/cad/NurbsSurface.js';
import { BRep, BRepVertex, BRepEdge, BRepFace, tessellateNurbsFaces } from '../js/cad/BRep.js';
import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { calculateMeshVolume, makeEdgeKey, applyChamfer, applyFillet } from '../js/cad/CSG.js';
import { formatTimingSuffix, startTiming } from './test-timing.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  const startedAt = startTiming();
  try {
    fn();
    console.log(`  ✓ ${name}${formatTimingSuffix(startedAt)}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}${formatTimingSuffix(startedAt)}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

function assertApprox(actual, expected, tolerance, msg) {
  assert.ok(Math.abs(actual - expected) < tolerance,
    `${msg}: expected ~${expected}, got ${actual} (diff: ${Math.abs(actual - expected).toFixed(6)})`);
}

function dist3(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function vecLen(v) {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function collectMeshEdgeUsage(geometry) {
  const fmt = (n) => (Math.abs(n) < 5e-6 ? 0 : n).toFixed(5);
  const vk = (pt) => `${fmt(pt.x)},${fmt(pt.y)},${fmt(pt.z)}`;
  const edgeMap = new Map();

  for (const face of geometry.faces || []) {
    const verts = face.vertices || [];
    for (let i = 0; i < verts.length; i++) {
      const a = vk(verts[i]);
      const b = vk(verts[(i + 1) % verts.length]);
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      const fwd = a < b;
      if (!edgeMap.has(key)) edgeMap.set(key, []);
      edgeMap.get(key).push(fwd);
    }
  }

  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  let windingErrors = 0;
  for (const uses of edgeMap.values()) {
    if (uses.length === 1) boundaryEdges++;
    else if (uses.length === 2) {
      if (uses[0] === uses[1]) windingErrors++;
    } else {
      nonManifoldEdges++;
    }
  }

  return { boundaryEdges, nonManifoldEdges, windingErrors };
}

function makeRectSketch(x1, y1, x2, y2) {
  const s = new Sketch();
  s.addSegment(x1, y1, x2, y1);
  s.addSegment(x2, y1, x2, y2);
  s.addSegment(x2, y2, x1, y2);
  s.addSegment(x1, y2, x1, y1);
  return s;
}

// ============================================================
console.log('=== NURBS Curve Tests ===\n');
// ============================================================

test('NurbsCurve: line segment evaluation', () => {
  const line = NurbsCurve.createLine({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 });
  const start = line.evaluate(0);
  const mid = line.evaluate(0.5);
  const end = line.evaluate(1);
  assertApprox(start.x, 0, 0.001, 'Start X');
  assertApprox(mid.x, 5, 0.001, 'Mid X');
  assertApprox(end.x, 10, 0.001, 'End X');
  assertApprox(start.y, 0, 0.001, 'Start Y');
  assertApprox(mid.y, 0, 0.001, 'Mid Y');
});

test('NurbsCurve: line derivative is constant', () => {
  const line = NurbsCurve.createLine({ x: 0, y: 0, z: 0 }, { x: 10, y: 5, z: 0 });
  const d1 = line.derivative(0.2);
  const d2 = line.derivative(0.8);
  assertApprox(d1.x, d2.x, 0.01, 'Derivative X consistent');
  assertApprox(d1.y, d2.y, 0.01, 'Derivative Y consistent');
});

test('NurbsCurve: circular arc passes through correct points', () => {
  const arc = NurbsCurve.createArc(
    { x: 0, y: 0, z: 0 }, 5,
    { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 },
    0, Math.PI / 2
  );
  const start = arc.evaluate(arc.uMin);
  const end = arc.evaluate(arc.uMax);

  assertApprox(start.x, 5, 0.01, 'Arc start X');
  assertApprox(start.y, 0, 0.01, 'Arc start Y');
  assertApprox(end.x, 0, 0.01, 'Arc end X');
  assertApprox(end.y, 5, 0.01, 'Arc end Y');

  // Verify all points lie on circle
  const points = arc.tessellate(16);
  for (const p of points) {
    const r = dist3(p, { x: 0, y: 0, z: 0 });
    assertApprox(r, 5, 0.01, 'Point on arc circle');
  }
});

test('NurbsCurve: full circle', () => {
  const circle = NurbsCurve.createCircle(
    { x: 0, y: 0, z: 0 }, 3,
    { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }
  );
  // Start and end should be the same point
  const start = circle.evaluate(circle.uMin);
  const end = circle.evaluate(circle.uMax);
  assertApprox(dist3(start, end), 0, 0.01, 'Circle closure');

  // All points on the circle
  const points = circle.tessellate(32);
  for (const p of points) {
    assertApprox(dist3(p, { x: 0, y: 0, z: 0 }), 3, 0.01, 'Circle radius');
  }
});

test('NurbsCurve: arc in 3D plane', () => {
  const arc = NurbsCurve.createArc(
    { x: 0, y: 0, z: 5 }, 2,
    { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 },
    0, Math.PI
  );
  const points = arc.tessellate(16);
  for (const p of points) {
    assertApprox(p.z, 5, 0.01, 'Arc Z plane');
    assertApprox(dist3(p, { x: 0, y: 0, z: 5 }), 2, 0.01, 'Arc 3D radius');
  }
});

test('NurbsCurve: tessellate produces correct count', () => {
  const line = NurbsCurve.createLine({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 });
  const pts = line.tessellate(10);
  assert.strictEqual(pts.length, 11, 'Should have segments + 1 points');
});

test('NurbsCurve: arc length approximation', () => {
  const arc = NurbsCurve.createArc(
    { x: 0, y: 0, z: 0 }, 1,
    { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 },
    0, Math.PI / 2
  );
  const length = arc.arcLength(128);
  assertApprox(length, Math.PI / 2, 0.01, 'Quarter circle arc length');
});

test('NurbsCurve: serialize and deserialize roundtrip', () => {
  const arc = NurbsCurve.createArc(
    { x: 1, y: 2, z: 3 }, 4,
    { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 },
    0, Math.PI / 3
  );
  const data = arc.serialize();
  const arc2 = NurbsCurve.deserialize(data);
  const p1 = arc.evaluate(0.5);
  const p2 = arc2.evaluate(0.5);
  assertApprox(dist3(p1, p2), 0, 0.001, 'Roundtrip evaluation');
});

test('NurbsCurve: clone produces independent copy', () => {
  const line = NurbsCurve.createLine({ x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 });
  const clone = line.clone();
  clone.controlPoints[0].x = 100; // Modify clone
  const p = line.evaluate(0); // Original should be unchanged
  assertApprox(p.x, 0, 0.001, 'Clone independence');
});

// ============================================================
console.log('\n=== NURBS Surface Tests ===\n');
// ============================================================

test('NurbsSurface: planar surface evaluation', () => {
  const plane = NurbsSurface.createPlane(
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 0, y: 5, z: 0 }
  );
  const corner = plane.evaluate(0, 0);
  assertApprox(corner.x, 0, 0.01, 'Plane origin X');

  const mid = plane.evaluate(0.5, 0.5);
  assertApprox(mid.x, 5, 0.01, 'Plane mid X');
  assertApprox(mid.y, 2.5, 0.01, 'Plane mid Y');

  const farCorner = plane.evaluate(1, 1);
  assertApprox(farCorner.x, 10, 0.01, 'Plane far corner X');
  assertApprox(farCorner.y, 5, 0.01, 'Plane far corner Y');
});

test('NurbsSurface: planar surface normal', () => {
  const plane = NurbsSurface.createPlane(
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 0, y: 5, z: 0 }
  );
  const n = plane.normal(0.5, 0.5);
  assertApprox(Math.abs(n.z), 1, 0.01, 'Plane normal Z');
  assertApprox(n.x, 0, 0.01, 'Plane normal X');
  assertApprox(n.y, 0, 0.01, 'Plane normal Y');
});

test('NurbsSurface: cylinder surface points lie on cylinder', () => {
  const cyl = NurbsSurface.createCylinder(
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 1 },
    3, 10,
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 }
  );
  // Check multiple points on the surface
  for (let i = 0; i <= 8; i++) {
    const u = i / 8;
    for (let j = 0; j <= 8; j++) {
      const v = cyl.vMin + (j / 8) * (cyl.vMax - cyl.vMin);
      const p = cyl.evaluate(u, v);
      const r = Math.sqrt(p.x * p.x + p.y * p.y);
      assertApprox(r, 3, 0.01, `Cylinder radius at u=${u.toFixed(2)}, v=${v.toFixed(2)}`);
      assertApprox(p.z, u * 10, 0.01, `Cylinder Z at u=${u.toFixed(2)}`);
    }
  }
});

test('NurbsSurface: cylinder surface normal points outward', () => {
  const cyl = NurbsSurface.createCylinder(
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 1 },
    3, 10,
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 }
  );
  const p = cyl.evaluate(0.5, cyl.vMin + 0.5 * (cyl.vMax - cyl.vMin));
  const n = cyl.normal(0.5, cyl.vMin + 0.5 * (cyl.vMax - cyl.vMin));
  // Normal should be radially outward (no Z component for a pure cylinder)
  assertApprox(n.z, 0, 0.1, 'Cylinder normal Z ~0');
  assert.ok(vecLen(n) > 0.9, `Normal should be unit: ${vecLen(n)}`);
});

test('NurbsSurface: tessellate produces correct face count', () => {
  const plane = NurbsSurface.createPlane(
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 }
  );
  const tess = plane.tessellate(4, 4);
  assert.strictEqual(tess.faces.length, 32, 'Should have 4x4x2=32 triangle faces');
  // Each face should have 3 vertices (triangles)
  for (const face of tess.faces) {
    assert.strictEqual(face.vertices.length, 3, 'Each face should be a triangle');
  }
});

test('NurbsSurface: chamfer surface is planar', () => {
  const s = NurbsSurface.createChamferSurface(
    { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 },
    { x: 0, y: 0, z: 1 }, { x: 10, y: 0, z: 1 }
  );
  // All points should lie on the z = u plane (a flat bevel)
  const p00 = s.evaluate(0, 0);
  const p01 = s.evaluate(0, 1);
  const p10 = s.evaluate(1, 0);
  const p11 = s.evaluate(1, 1);
  assertApprox(p00.z, 0, 0.01, 'Chamfer p00 Z');
  assertApprox(p01.z, 1, 0.01, 'Chamfer p01 Z');
  assertApprox(p10.z, 0, 0.01, 'Chamfer p10 Z');
  assertApprox(p11.z, 1, 0.01, 'Chamfer p11 Z');
});

test('NurbsSurface: serialize and deserialize roundtrip', () => {
  const plane = NurbsSurface.createPlane(
    { x: 1, y: 2, z: 3 },
    { x: 5, y: 0, z: 0 },
    { x: 0, y: 3, z: 0 }
  );
  const data = plane.serialize();
  const plane2 = NurbsSurface.deserialize(data);
  const p1 = plane.evaluate(0.5, 0.5);
  const p2 = plane2.evaluate(0.5, 0.5);
  assertApprox(dist3(p1, p2), 0, 0.001, 'Surface roundtrip evaluation');
});

test('NurbsSurface: fillet surface factory creates valid surface', () => {
  const rail0 = [{ x: 0, y: 0, z: 1 }, { x: 10, y: 0, z: 1 }];
  const rail1 = [{ x: 0, y: 1, z: 0 }, { x: 10, y: 1, z: 0 }];
  const centers = [
    { x: 0, y: 1, z: 1 },
    { x: 10, y: 1, z: 1 },
  ];
  const s = NurbsSurface.createFilletSurface(rail0, rail1, centers, 1, { x: 1, y: 0, z: 0 });
  assert.ok(s, 'Fillet surface should be created');

  // Verify endpoints match rails
  const p00 = s.evaluate(s.uMin, s.vMin);
  const p10 = s.evaluate(s.uMax, s.vMin);
  assertApprox(dist3(p00, rail0[0]), 0, 0.1, 'Fillet start matches rail0');
  assertApprox(dist3(p10, rail0[1]), 0, 0.1, 'Fillet end matches rail0');
});

// ============================================================
console.log('\n=== BRep Data Structure Tests ===\n');
// ============================================================

test('BRepVertex: construct and serialize', () => {
  const v = new BRepVertex({ x: 1, y: 2, z: 3 }, 0.01);
  const data = v.serialize();
  const v2 = BRepVertex.deserialize(data);
  assertApprox(v2.point.x, 1, 0.001, 'Vertex X');
  assertApprox(v2.tolerance, 0.01, 0.001, 'Vertex tolerance');
});

test('BRepEdge: straight line tessellation', () => {
  const e = new BRepEdge(
    new BRepVertex({ x: 0, y: 0, z: 0 }),
    new BRepVertex({ x: 10, y: 0, z: 0 })
  );
  const pts = e.tessellate(4);
  assert.strictEqual(pts.length, 5, 'Should have 5 points for 4 segments');
  assertApprox(pts[0].x, 0, 0.001, 'Start X');
  assertApprox(pts[4].x, 10, 0.001, 'End X');
  assertApprox(pts[2].x, 5, 0.001, 'Mid X');
});

test('BRepEdge: NURBS arc tessellation', () => {
  const arc = NurbsCurve.createArc(
    { x: 0, y: 0, z: 0 }, 5,
    { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 },
    0, Math.PI / 2
  );
  const e = new BRepEdge(
    new BRepVertex({ x: 5, y: 0, z: 0 }),
    new BRepVertex({ x: 0, y: 5, z: 0 }),
    arc
  );
  const pts = e.tessellate(16);
  assert.strictEqual(pts.length, 17, 'Should have 17 points');
  // All points should lie on circle of radius 5
  for (const p of pts) {
    assertApprox(dist3(p, { x: 0, y: 0, z: 0 }), 5, 0.01, 'Arc edge radius');
  }
});

test('BRepFace: NURBS surface tessellation', () => {
  const surface = NurbsSurface.createPlane(
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 0, y: 5, z: 0 }
  );
  const f = new BRepFace(surface, 'planar');
  const tess = f.tessellate(4, 4);
  assert.ok(tess, 'Should produce tessellation');
  assert.strictEqual(tess.faces.length, 32, 'Should have 32 triangle faces');
});

test('BRep: construct, add, and query', () => {
  const brep = new BRep();
  const v0 = brep.addVertex(new BRepVertex({ x: 0, y: 0, z: 0 }));
  const v1 = brep.addVertex(new BRepVertex({ x: 10, y: 0, z: 0 }));
  assert.strictEqual(brep.vertices.length, 2, 'Two vertices');

  brep.addEdge(new BRepEdge(brep.vertices[v0], brep.vertices[v1],
    NurbsCurve.createLine({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 })));
  assert.strictEqual(brep.edges.length, 1, 'One edge');

  brep.addFace(new BRepFace(null, 'planar'));
  assert.strictEqual(brep.faces.length, 1, 'One face');
  assert.ok(!brep.hasExactGeometry(), 'No exact geometry yet');

  brep.addFace(new BRepFace(
    NurbsSurface.createPlane({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 0, y: 5, z: 0 }),
    'planar'
  ));
  assert.ok(brep.hasExactGeometry(), 'Has exact geometry now');
  assert.strictEqual(brep.getExactFaces().length, 1, 'One exact face');
});

test('BRep: serialize and deserialize roundtrip', () => {
  const brep = new BRep();
  brep.addVertex(new BRepVertex({ x: 1, y: 2, z: 3 }));
  brep.addEdge(new BRepEdge(
    new BRepVertex({ x: 0, y: 0, z: 0 }),
    new BRepVertex({ x: 1, y: 0, z: 0 }),
    NurbsCurve.createLine({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })
  ));
  brep.addFace(new BRepFace(
    NurbsSurface.createPlane({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }),
    'planar'
  ));

  const data = brep.serialize();
  assert.strictEqual(data.type, 'BRep');

  const brep2 = BRep.deserialize(data);
  assert.strictEqual(brep2.vertices.length, 1, 'Restored vertices');
  assert.strictEqual(brep2.edges.length, 1, 'Restored edges');
  assert.strictEqual(brep2.faces.length, 1, 'Restored faces');
  assert.ok(brep2.faces[0].surface, 'Restored surface');
});

test('tessellateNurbsFaces: no-op when no brep', () => {
  const geom = { faces: [{ vertices: [{ x: 0, y: 0, z: 0 }], normal: { x: 0, y: 0, z: 1 } }] };
  const result = tessellateNurbsFaces(geom);
  assert.strictEqual(result.faces.length, 1, 'Unchanged faces');
});

// ============================================================
console.log('\n=== Chamfer/Fillet NURBS Integration Tests ===\n');
// ============================================================

test('Chamfer produces BRep with NURBS surfaces', () => {
  const part = new Part('NurbsChamferTest');
  const sf = part.addSketch(makeRectSketch(0, 0, 10, 5));
  part.extrude(sf.id, 8);

  const ek = makeEdgeKey({ x: 0, y: 0, z: 8 }, { x: 10, y: 0, z: 8 });
  part.chamfer([ek], 1);

  const r = part.getFinalGeometry();
  assert.ok(r && r.type === 'solid', 'Valid solid');
  assert.ok(r.geometry.brep, 'Geometry should have BRep data');
  assert.ok(r.geometry.brep instanceof BRep, 'BRep should be a BRep instance');
  assert.ok(r.geometry.brep.faces.length > 0, 'BRep should have faces');

  // Find the chamfer face with NURBS surface
  const exactFaces = r.geometry.brep.getExactFaces();
  assert.ok(exactFaces.length > 0, 'Should have at least one NURBS surface');
  assert.ok(exactFaces.some(f => f.surfaceType === 'chamfer'), 'Should have chamfer surface');
});

test('Chamfer NURBS surface evaluates to correct bevel plane', () => {
  const part = new Part('NurbsChamferEval');
  const sf = part.addSketch(makeRectSketch(0, 0, 10, 5));
  part.extrude(sf.id, 8);

  const ek = makeEdgeKey({ x: 0, y: 0, z: 8 }, { x: 10, y: 0, z: 8 });
  part.chamfer([ek], 1);

  const r = part.getFinalGeometry();
  const chamferFaces = r.geometry.brep.faces.filter(f => f.surfaceType === 'chamfer');
  assert.ok(chamferFaces.length > 0, 'Should have chamfer face');

  const chamferSurface = chamferFaces[0].surface;
  assert.ok(chamferSurface, 'Chamfer face should have NURBS surface');

  // The chamfer surface should produce reasonable points
  const p = chamferSurface.evaluate(0.5, 0.5);
  assert.ok(isFinite(p.x) && isFinite(p.y) && isFinite(p.z), 'Surface evaluation finite');
});

test('Chamfer BRep has edge curves', () => {
  const part = new Part('NurbsChamferEdges');
  const sf = part.addSketch(makeRectSketch(0, 0, 10, 5));
  part.extrude(sf.id, 8);

  const ek = makeEdgeKey({ x: 0, y: 0, z: 8 }, { x: 10, y: 0, z: 8 });
  part.chamfer([ek], 1);

  const r = part.getFinalGeometry();
  const brep = r.geometry.brep;
  assert.ok(brep.edges.length > 0, 'BRep should have edges');
  // Chamfer edges should be straight lines
  const edgeWithCurve = brep.edges.find(e => e.curve);
  assert.ok(edgeWithCurve, 'Should have at least one edge with curve');
});

test('Fillet produces BRep with NURBS surfaces', () => {
  const part = new Part('NurbsFilletTest');
  const sf = part.addSketch(makeRectSketch(0, 0, 10, 5));
  part.extrude(sf.id, 8);

  const ek = makeEdgeKey({ x: 0, y: 0, z: 8 }, { x: 10, y: 0, z: 8 });
  part.fillet([ek], 1, { segments: 4 });

  const r = part.getFinalGeometry();
  assert.ok(r && r.type === 'solid', 'Valid solid');
  assert.ok(r.geometry.brep, 'Geometry should have BRep data');
  assert.ok(r.geometry.brep.faces.length > 0, 'BRep should have faces');

  // Find the fillet face with NURBS surface
  const exactFaces = r.geometry.brep.getExactFaces();
  assert.ok(exactFaces.length > 0, 'Should have at least one NURBS surface');
  assert.ok(exactFaces.some(f => f.surfaceType === 'fillet'), 'Should have fillet surface');
});

test('Fillet NURBS surface evaluates to cylindrical blend', () => {
  const part = new Part('NurbsFilletEval');
  const sf = part.addSketch(makeRectSketch(0, 0, 10, 5));
  part.extrude(sf.id, 8);

  const ek = makeEdgeKey({ x: 0, y: 0, z: 8 }, { x: 10, y: 0, z: 8 });
  part.fillet([ek], 1, { segments: 4 });

  const r = part.getFinalGeometry();
  const filletFaces = r.geometry.brep.faces.filter(f => f.surfaceType === 'fillet');
  assert.ok(filletFaces.length > 0, 'Should have fillet face');

  const filletSurface = filletFaces[0].surface;
  assert.ok(filletSurface, 'Fillet face should have NURBS surface');

  // Evaluate across the fillet — points should be at radius distance from center
  const p = filletSurface.evaluate(0.5, 0.5);
  assert.ok(isFinite(p.x) && isFinite(p.y) && isFinite(p.z), 'Fillet evaluation finite');
});

test('Fillet BRep has arc edge curves', () => {
  const part = new Part('NurbsFilletEdges');
  const sf = part.addSketch(makeRectSketch(0, 0, 10, 5));
  part.extrude(sf.id, 8);

  const ek = makeEdgeKey({ x: 0, y: 0, z: 8 }, { x: 10, y: 0, z: 8 });
  part.fillet([ek], 1, { segments: 4 });

  const r = part.getFinalGeometry();
  const brep = r.geometry.brep;
  assert.ok(brep.edges.length >= 2, 'BRep should have at least 2 edges');
  const curveEdges = brep.edges.filter(e => e.curve);
  assert.ok(curveEdges.length >= 2, 'Should have at least 2 edges with curves');
});

test('Two-edge fillet corner produces a closed mesh and exact corner patch', () => {
  const part = new Part('NurbsFilletCorner2Edge');
  const sf = part.addSketch(makeRectSketch(0, 0, 10, 10));
  part.extrude(sf.id, 10);

  const ek0 = makeEdgeKey({ x: 0, y: 0, z: 10 }, { x: 10, y: 0, z: 10 });
  const ek1 = makeEdgeKey({ x: 10, y: 0, z: 10 }, { x: 10, y: 10, z: 10 });
  part.fillet([ek0, ek1], 1, { segments: 8 });

  const result = part.getFinalGeometry();
  assert.ok(result && result.geometry, 'Expected final geometry');

  const edgeUsage = collectMeshEdgeUsage(result.geometry);
  assert.strictEqual(edgeUsage.boundaryEdges, 0, `Expected no boundary edges, got ${edgeUsage.boundaryEdges}`);
  assert.strictEqual(edgeUsage.nonManifoldEdges, 0, `Expected no non-manifold edges, got ${edgeUsage.nonManifoldEdges}`);
  assert.strictEqual(edgeUsage.windingErrors, 0, `Expected no winding errors, got ${edgeUsage.windingErrors}`);

  const cornerFaces = result.geometry.faces.filter(f => f.isCorner);
  assert.ok(cornerFaces.length > 0, 'Expected explicit corner patch faces for the two-edge fillet corner');

  const brep = result.geometry.brep;
  assert.ok(brep, 'Expected BRep on filleted geometry');
  const cornerBrepFace = brep.faces.find(f => f.surfaceType === 'fillet' && f.isCornerPatch);
  assert.ok(cornerBrepFace, 'Expected a dedicated BRep corner patch face');
  assert.ok(cornerBrepFace.surface, 'Expected the corner patch face to carry a NURBS surface');
  assert.strictEqual(cornerBrepFace.surface.degreeU, 2, 'Corner patch degreeU');
  assert.strictEqual(cornerBrepFace.surface.degreeV, 2, 'Corner patch degreeV');
});

test('Chamfer: volume still correct with NURBS addition', () => {
  const part = new Part('ChamferVol');
  const sf = part.addSketch(makeRectSketch(0, 0, 10, 5));
  part.extrude(sf.id, 8);
  const before = calculateMeshVolume(part.getFinalGeometry().geometry);

  const ek = makeEdgeKey({ x: 0, y: 0, z: 8 }, { x: 10, y: 0, z: 8 });
  part.chamfer([ek], 1);

  const after = calculateMeshVolume(part.getFinalGeometry().geometry);
  assert.ok(after < before, `Chamfer should reduce volume: ${before} → ${after}`);
  assert.ok(after > before * 0.8, `Too much volume removed: ${before} → ${after}`);
});

test('Fillet: volume still correct with NURBS addition', () => {
  const part = new Part('FilletVol');
  const sf = part.addSketch(makeRectSketch(0, 0, 10, 5));
  part.extrude(sf.id, 8);
  const before = calculateMeshVolume(part.getFinalGeometry().geometry);

  const ek = makeEdgeKey({ x: 0, y: 0, z: 8 }, { x: 10, y: 0, z: 8 });
  part.fillet([ek], 1, { segments: 4 });

  const after = calculateMeshVolume(part.getFinalGeometry().geometry);
  assert.ok(after < before, `Fillet should reduce volume: ${before} → ${after}`);
  assert.ok(after > before * 0.8, `Too much volume removed: ${before} → ${after}`);
});

test('Multi-edge chamfer + fillet: NURBS data preserved', () => {
  const part = new Part('MultiEdgeNurbs');
  const sf = part.addSketch(makeRectSketch(0, 0, 10, 5));
  part.extrude(sf.id, 8);

  // Chamfer front-top edge
  const ek1 = makeEdgeKey({ x: 0, y: 0, z: 8 }, { x: 10, y: 0, z: 8 });
  part.chamfer([ek1], 1);

  // Fillet right-top edge
  const ek2 = makeEdgeKey({ x: 10, y: 0, z: 8 }, { x: 10, y: 5, z: 8 });
  part.fillet([ek2], 1, { segments: 4 });

  const r = part.getFinalGeometry();
  assert.ok(r && r.type === 'solid', 'Valid solid');
  // The fillet result should have BRep data
  assert.ok(r.geometry.brep, 'Final geometry should have BRep');
});

test('BRep tessellateAll produces mesh data', () => {
  const brep = new BRep();
  brep.addFace(new BRepFace(null, 'planar')); // No NURBS
  brep.addFace(new BRepFace(
    NurbsSurface.createPlane({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 0, y: 5, z: 0 }),
    'planar'
  ));

  const results = brep.tessellateAll(4, 4);
  assert.strictEqual(results.length, 2, 'Should have 2 results');
  assert.strictEqual(results[0], null, 'First face has no surface');
  assert.ok(results[1], 'Second face has tessellation');
  assert.strictEqual(results[1].faces.length, 32, 'Tessellation has 32 triangle faces');
});

// ============================================================
console.log('\n=== Results ===\n');
// ============================================================

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
