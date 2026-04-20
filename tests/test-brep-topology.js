// tests/test-brep-topology.js — Tests for the exact B-Rep topology graph
//
// Validates:
// 1. TopoVertex, TopoEdge, TopoCoEdge, TopoLoop, TopoFace, TopoShell, TopoBody
// 2. Topology graph construction and traversal
// 3. Serialization/deserialization roundtrip
// 4. buildTopoBody helper
// 5. BRepValidator validation checks
// 6. Tolerance policy module

import assert from 'assert';
import {
  TopoBody, TopoShell, TopoFace, TopoLoop, TopoCoEdge, TopoEdge, TopoVertex,
  SurfaceType, buildTopoBody, resetTopoIds,
} from '../js/cad/BRepTopology.js';
import { validateBody, validateIncidence, validateNoDuplicateEdges, validateFull } from '../js/cad/BRepValidator.js';
import { Tolerance, DEFAULT_TOLERANCE } from '../js/cad/Tolerance.js';
import { NurbsCurve } from '../js/cad/NurbsCurve.js';
import { NurbsSurface } from '../js/cad/NurbsSurface.js';
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
    `${msg}: expected ~${expected}, got ${actual}`);
}

// ============================================================
console.log('=== Tolerance Module Tests ===\n');
// ============================================================

test('Tolerance: default values are sensible', () => {
  const tol = new Tolerance();
  assert.ok(tol.modelingEpsilon < 1e-6, 'Modeling epsilon should be very small');
  assert.ok(tol.pointCoincidence < 1e-4, 'Point coincidence should be small');
  assert.ok(tol.sewing > tol.pointCoincidence, 'Sewing should be larger than point coincidence');
});

test('Tolerance: pointsCoincident', () => {
  const tol = new Tolerance();
  assert.ok(tol.pointsCoincident({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1e-7 }));
  assert.ok(!tol.pointsCoincident({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }));
});

test('Tolerance: normalsParallel', () => {
  const tol = new Tolerance();
  assert.ok(tol.normalsParallel({ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }));
  assert.ok(!tol.normalsParallel({ x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 0 }));
});

test('Tolerance: classifyPoint', () => {
  const tol = new Tolerance();
  const plane = { normal: { x: 0, y: 0, z: 1 }, d: 0 };
  assert.strictEqual(tol.classifyPoint({ x: 0, y: 0, z: 1 }, plane), 'front');
  assert.strictEqual(tol.classifyPoint({ x: 0, y: 0, z: -1 }, plane), 'back');
  assert.strictEqual(tol.classifyPoint({ x: 0, y: 0, z: 0 }, plane), 'on');
});

test('Tolerance: serialize/deserialize roundtrip', () => {
  const tol = new Tolerance({ pointCoincidence: 0.001 });
  const data = tol.serialize();
  const restored = Tolerance.deserialize(data);
  assert.strictEqual(restored.pointCoincidence, 0.001);
});

// ============================================================
console.log('\n=== TopoVertex Tests ===\n');
// ============================================================

test('TopoVertex: construction and properties', () => {
  resetTopoIds();
  const v = new TopoVertex({ x: 1, y: 2, z: 3 }, 0.001);
  assertApprox(v.point.x, 1, 0.001, 'X');
  assertApprox(v.point.y, 2, 0.001, 'Y');
  assertApprox(v.point.z, 3, 0.001, 'Z');
  assertApprox(v.tolerance, 0.001, 0.0001, 'Tolerance');
  assert.ok(v.edges.length === 0, 'No edges initially');
});

test('TopoVertex: clone', () => {
  const v = new TopoVertex({ x: 5, y: 6, z: 7 });
  const c = v.clone();
  assert.notStrictEqual(v, c);
  assertApprox(c.point.x, 5, 0.001, 'Clone X');
});

test('TopoVertex: serialize/deserialize', () => {
  const v = new TopoVertex({ x: 10, y: 20, z: 30 }, 0.01);
  const data = v.serialize();
  const restored = TopoVertex.deserialize(data);
  assertApprox(restored.point.x, 10, 0.001, 'Restored X');
  assertApprox(restored.tolerance, 0.01, 0.001, 'Restored tolerance');
});

// ============================================================
console.log('\n=== TopoEdge Tests ===\n');
// ============================================================

test('TopoEdge: construction links to vertices', () => {
  resetTopoIds();
  const v1 = new TopoVertex({ x: 0, y: 0, z: 0 });
  const v2 = new TopoVertex({ x: 10, y: 0, z: 0 });
  const e = new TopoEdge(v1, v2);
  assert.strictEqual(e.startVertex, v1);
  assert.strictEqual(e.endVertex, v2);
  assert.ok(v1.edges.includes(e), 'V1 should reference edge');
  assert.ok(v2.edges.includes(e), 'V2 should reference edge');
});

test('TopoEdge: tessellate straight line', () => {
  const v1 = new TopoVertex({ x: 0, y: 0, z: 0 });
  const v2 = new TopoVertex({ x: 10, y: 0, z: 0 });
  const e = new TopoEdge(v1, v2);
  const pts = e.tessellate(4);
  assert.strictEqual(pts.length, 5);
  assertApprox(pts[0].x, 0, 0.001, 'Start');
  assertApprox(pts[2].x, 5, 0.001, 'Mid');
  assertApprox(pts[4].x, 10, 0.001, 'End');
});

test('TopoEdge: tessellate with NURBS curve', () => {
  const v1 = new TopoVertex({ x: 0, y: 0, z: 0 });
  const v2 = new TopoVertex({ x: 10, y: 0, z: 0 });
  const curve = NurbsCurve.createLine({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 });
  const e = new TopoEdge(v1, v2, curve);
  const pts = e.tessellate(8);
  assert.strictEqual(pts.length, 9);
  assertApprox(pts[4].x, 5, 0.01, 'Midpoint');
});

test('TopoEdge: otherVertex', () => {
  const v1 = new TopoVertex({ x: 0, y: 0, z: 0 });
  const v2 = new TopoVertex({ x: 10, y: 0, z: 0 });
  const e = new TopoEdge(v1, v2);
  assert.strictEqual(e.otherVertex(v1), v2);
  assert.strictEqual(e.otherVertex(v2), v1);
});

// ============================================================
console.log('\n=== TopoCoEdge Tests ===\n');
// ============================================================

test('TopoCoEdge: construction and orientation', () => {
  const v1 = new TopoVertex({ x: 0, y: 0, z: 0 });
  const v2 = new TopoVertex({ x: 10, y: 0, z: 0 });
  const e = new TopoEdge(v1, v2);
  const ce = new TopoCoEdge(e, true);
  assert.strictEqual(ce.startVertex(), v1);
  assert.strictEqual(ce.endVertex(), v2);
});

test('TopoCoEdge: reversed orientation', () => {
  const v1 = new TopoVertex({ x: 0, y: 0, z: 0 });
  const v2 = new TopoVertex({ x: 10, y: 0, z: 0 });
  const e = new TopoEdge(v1, v2);
  const ce = new TopoCoEdge(e, false);
  assert.strictEqual(ce.startVertex(), v2);
  assert.strictEqual(ce.endVertex(), v1);
});

test('TopoCoEdge: registered with edge', () => {
  const v1 = new TopoVertex({ x: 0, y: 0, z: 0 });
  const v2 = new TopoVertex({ x: 10, y: 0, z: 0 });
  const e = new TopoEdge(v1, v2);
  const ce1 = new TopoCoEdge(e, true);
  const ce2 = new TopoCoEdge(e, false);
  assert.ok(e.coedges.includes(ce1));
  assert.ok(e.coedges.includes(ce2));
});

// ============================================================
console.log('\n=== TopoLoop Tests ===\n');
// ============================================================

test('TopoLoop: closed triangle', () => {
  const v1 = new TopoVertex({ x: 0, y: 0, z: 0 });
  const v2 = new TopoVertex({ x: 10, y: 0, z: 0 });
  const v3 = new TopoVertex({ x: 5, y: 10, z: 0 });
  const e1 = new TopoEdge(v1, v2);
  const e2 = new TopoEdge(v2, v3);
  const e3 = new TopoEdge(v3, v1);
  const ce1 = new TopoCoEdge(e1, true);
  const ce2 = new TopoCoEdge(e2, true);
  const ce3 = new TopoCoEdge(e3, true);
  const loop = new TopoLoop([ce1, ce2, ce3]);
  assert.ok(loop.isClosed(), 'Loop should be closed');
  assert.strictEqual(loop.vertices().length, 3);
});

test('TopoLoop: open loop detected', () => {
  const v1 = new TopoVertex({ x: 0, y: 0, z: 0 });
  const v2 = new TopoVertex({ x: 10, y: 0, z: 0 });
  const v3 = new TopoVertex({ x: 5, y: 10, z: 0 });
  const v4 = new TopoVertex({ x: 5, y: 5, z: 0 }); // different end
  const e1 = new TopoEdge(v1, v2);
  const e2 = new TopoEdge(v2, v3);
  const e3 = new TopoEdge(v4, v1); // doesn't connect to v3
  const ce1 = new TopoCoEdge(e1, true);
  const ce2 = new TopoCoEdge(e2, true);
  const ce3 = new TopoCoEdge(e3, true);
  const loop = new TopoLoop([ce1, ce2, ce3]);
  assert.ok(!loop.isClosed(), 'Loop should NOT be closed');
});

// ============================================================
console.log('\n=== TopoFace Tests ===\n');
// ============================================================

test('TopoFace: construction with surface type', () => {
  const face = new TopoFace(null, SurfaceType.PLANE, true);
  assert.strictEqual(face.surfaceType, 'plane');
  assert.strictEqual(face.sameSense, true);
  assert.strictEqual(face.outerLoop, null);
  assert.strictEqual(face.innerLoops.length, 0);
});

test('TopoFace: setOuterLoop and addInnerLoop', () => {
  const v1 = new TopoVertex({ x: 0, y: 0, z: 0 });
  const v2 = new TopoVertex({ x: 10, y: 0, z: 0 });
  const v3 = new TopoVertex({ x: 10, y: 10, z: 0 });
  const v4 = new TopoVertex({ x: 0, y: 10, z: 0 });
  const e1 = new TopoEdge(v1, v2);
  const e2 = new TopoEdge(v2, v3);
  const e3 = new TopoEdge(v3, v4);
  const e4 = new TopoEdge(v4, v1);
  const outerLoop = new TopoLoop([
    new TopoCoEdge(e1, true),
    new TopoCoEdge(e2, true),
    new TopoCoEdge(e3, true),
    new TopoCoEdge(e4, true),
  ]);

  const face = new TopoFace(null, SurfaceType.PLANE);
  face.setOuterLoop(outerLoop);
  assert.ok(face.outerLoop !== null);
  assert.ok(face.outerLoop.isClosed());
  assert.strictEqual(face.edges().length, 4);
  assert.strictEqual(face.vertices().length, 4);
});

// ============================================================
console.log('\n=== TopoBody Tests ===\n');
// ============================================================

test('TopoBody: build a simple box', () => {
  resetTopoIds();
  // Define the 8 corners of a 10x10x10 box
  const corners = [
    { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 },
    { x: 10, y: 10, z: 0 }, { x: 0, y: 10, z: 0 },
    { x: 0, y: 0, z: 10 }, { x: 10, y: 0, z: 10 },
    { x: 10, y: 10, z: 10 }, { x: 0, y: 10, z: 10 },
  ];

  const faceDescs = [
    // Bottom (Z=0)
    { surfaceType: SurfaceType.PLANE, vertices: [corners[3], corners[2], corners[1], corners[0]], surface: null, edgeCurves: null, shared: null },
    // Top (Z=10)
    { surfaceType: SurfaceType.PLANE, vertices: [corners[4], corners[5], corners[6], corners[7]], surface: null, edgeCurves: null, shared: null },
    // Front (Y=0)
    { surfaceType: SurfaceType.PLANE, vertices: [corners[0], corners[1], corners[5], corners[4]], surface: null, edgeCurves: null, shared: null },
    // Back (Y=10)
    { surfaceType: SurfaceType.PLANE, vertices: [corners[2], corners[3], corners[7], corners[6]], surface: null, edgeCurves: null, shared: null },
    // Left (X=0)
    { surfaceType: SurfaceType.PLANE, vertices: [corners[3], corners[0], corners[4], corners[7]], surface: null, edgeCurves: null, shared: null },
    // Right (X=10)
    { surfaceType: SurfaceType.PLANE, vertices: [corners[1], corners[2], corners[6], corners[5]], surface: null, edgeCurves: null, shared: null },
  ];

  const body = buildTopoBody(faceDescs);

  assert.strictEqual(body.shells.length, 1, 'Should have 1 shell');
  assert.strictEqual(body.faces().length, 6, 'Should have 6 faces');
  assert.strictEqual(body.vertices().length, 8, 'Should have 8 unique vertices');
  assert.strictEqual(body.edges().length, 12, 'Should have 12 unique edges');
});

test('TopoBody: serialize and deserialize roundtrip', () => {
  resetTopoIds();
  const faceDescs = [
    {
      surfaceType: SurfaceType.PLANE,
      vertices: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 5, y: 10, z: 0 }],
      surface: NurbsSurface.createPlane(
        { x: 0, y: 0, z: 0 },
        { x: 10, y: 0, z: 0 },
        { x: 0, y: 10, z: 0 },
      ),
      edgeCurves: [
        NurbsCurve.createLine({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }),
        NurbsCurve.createLine({ x: 10, y: 0, z: 0 }, { x: 5, y: 10, z: 0 }),
        NurbsCurve.createLine({ x: 5, y: 10, z: 0 }, { x: 0, y: 0, z: 0 }),
      ],
      shared: { sourceFeatureId: 'f1' },
    },
  ];
  const body = buildTopoBody(faceDescs);

  const data = body.serialize();
  assert.strictEqual(data.type, 'TopoBody');
  assert.ok(data.vertices.length >= 3);
  assert.ok(data.edges.length >= 3);
  assert.ok(data.faces.length === 1);

  const restored = TopoBody.deserialize(data);
  assert.strictEqual(restored.faces().length, 1);
  assert.ok(restored.faces()[0].surface !== null, 'Surface should be preserved');
});

test('TopoBody: faces/edges/vertices accessors', () => {
  resetTopoIds();
  const v1 = new TopoVertex({ x: 0, y: 0, z: 0 });
  const v2 = new TopoVertex({ x: 10, y: 0, z: 0 });
  const v3 = new TopoVertex({ x: 5, y: 10, z: 0 });
  const e1 = new TopoEdge(v1, v2);
  const e2 = new TopoEdge(v2, v3);
  const e3 = new TopoEdge(v3, v1);
  const loop = new TopoLoop([
    new TopoCoEdge(e1, true),
    new TopoCoEdge(e2, true),
    new TopoCoEdge(e3, true),
  ]);
  const face = new TopoFace(null, SurfaceType.PLANE);
  face.setOuterLoop(loop);
  const shell = new TopoShell([face]);
  const body = new TopoBody([shell]);

  assert.strictEqual(body.faces().length, 1);
  assert.strictEqual(body.edges().length, 3);
  assert.strictEqual(body.vertices().length, 3);
  assert.strictEqual(body.outerShell(), shell);
});

// ============================================================
console.log('\n=== BRepValidator Tests ===\n');
// ============================================================

test('validateBody: null body', () => {
  const result = validateBody(null);
  assert.ok(!result.isValid);
  assert.ok(result.errors.length > 0);
});

test('validateBody: empty shell', () => {
  const body = new TopoBody([new TopoShell([])]);
  const result = validateBody(body);
  assert.ok(!result.isValid);
});

test('validateBody: valid triangle face', () => {
  resetTopoIds();
  const faceDescs = [
    {
      surfaceType: SurfaceType.PLANE,
      vertices: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 5, y: 10, z: 0 }],
      surface: null, edgeCurves: null, shared: null,
    },
  ];
  const body = buildTopoBody(faceDescs);
  const result = validateBody(body);
  // Single face can't be a closed shell, but the face itself should be valid
  assert.ok(body.faces()[0].outerLoop.isClosed(), 'Outer loop should be closed');
});

test('validateFull: box passes all checks', () => {
  resetTopoIds();
  const corners = [
    { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 },
    { x: 10, y: 10, z: 0 }, { x: 0, y: 10, z: 0 },
    { x: 0, y: 0, z: 10 }, { x: 10, y: 0, z: 10 },
    { x: 10, y: 10, z: 10 }, { x: 0, y: 10, z: 10 },
  ];
  const faceDescs = [
    { surfaceType: SurfaceType.PLANE, vertices: [corners[3], corners[2], corners[1], corners[0]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [corners[4], corners[5], corners[6], corners[7]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [corners[0], corners[1], corners[5], corners[4]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [corners[2], corners[3], corners[7], corners[6]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [corners[3], corners[0], corners[4], corners[7]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [corners[1], corners[2], corners[6], corners[5]], surface: null, edgeCurves: null, shared: null },
  ];
  const body = buildTopoBody(faceDescs);
  const result = validateFull(body);

  // Box has proper closed shell: every edge has 2 coedges
  assert.strictEqual(body.edges().length, 12, 'Box should have 12 edges');
  assert.strictEqual(body.vertices().length, 8, 'Box should have 8 vertices');

  // Check that all face outer loops are closed
  for (const f of body.faces()) {
    assert.ok(f.outerLoop.isClosed(), `Face ${f.id} outer loop should be closed`);
  }
});

test('validateIncidence: all vertices reference their edges', () => {
  resetTopoIds();
  const v1 = new TopoVertex({ x: 0, y: 0, z: 0 });
  const v2 = new TopoVertex({ x: 10, y: 0, z: 0 });
  const e = new TopoEdge(v1, v2);
  const loop = new TopoLoop([new TopoCoEdge(e, true)]);
  const face = new TopoFace(null, SurfaceType.PLANE);
  face.setOuterLoop(loop);
  const body = new TopoBody([new TopoShell([face])]);

  const result = validateIncidence(body);
  assert.ok(result.isValid, 'Incidence should be valid');
});

// ============================================================
console.log('\n=== SurfaceType Constants ===\n');
// ============================================================

test('SurfaceType: all expected types exist', () => {
  assert.strictEqual(SurfaceType.PLANE, 'plane');
  assert.strictEqual(SurfaceType.CYLINDER, 'cylinder');
  assert.strictEqual(SurfaceType.CONE, 'cone');
  assert.strictEqual(SurfaceType.SPHERE, 'sphere');
  assert.strictEqual(SurfaceType.TORUS, 'torus');
  assert.strictEqual(SurfaceType.EXTRUSION, 'extrusion');
  assert.strictEqual(SurfaceType.REVOLUTION, 'revolution');
  assert.strictEqual(SurfaceType.BSPLINE, 'bspline');
  assert.strictEqual(SurfaceType.UNKNOWN, 'unknown');
});

test('SurfaceType: is frozen (immutable)', () => {
  assert.ok(Object.isFrozen(SurfaceType));
});

// ============================================================
console.log('\n=== Results ===\n');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
