// tests/test-step-export.js — Tests for STEP file export
//
// Validates:
// 1. STEP file structure (header, data section)
// 2. Entity generation for planes, edges, vertices
// 3. B-spline surface/curve export
// 4. Export of a complete box body

import assert from 'assert';
import { exportSTEP, exportSTEPDetailed } from '../js/cad/StepExport.js';
import { importSTEP, parseSTEPTopology } from '../js/cad/StepImport.js';
import { validateFull } from '../js/cad/BRepValidator.js';
import {
  TopoBody, TopoShell, TopoFace, TopoLoop, TopoCoEdge, TopoEdge, TopoVertex,
  SurfaceType, buildTopoBody, resetTopoIds,
} from '../js/cad/BRepTopology.js';
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

function buildBoxBody({ size = 10, useNurbsEdges = false, topAsBSpline = false } = {}) {
  const corners = [
    { x: 0, y: 0, z: 0 }, { x: size, y: 0, z: 0 },
    { x: size, y: size, z: 0 }, { x: 0, y: size, z: 0 },
    { x: 0, y: 0, z: size }, { x: size, y: 0, z: size },
    { x: size, y: size, z: size }, { x: 0, y: size, z: size },
  ];

  const faceCornerIndices = [
    [3, 2, 1, 0],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
    [1, 2, 6, 5],
  ];

  const faceDescs = faceCornerIndices.map((indices, faceIndex) => {
    const vertices = indices.map(index => corners[index]);
    const edgeCurves = useNurbsEdges
      ? vertices.map((vertex, i) => NurbsCurve.createLine(vertex, vertices[(i + 1) % vertices.length]))
      : null;

    return {
      surfaceType: topAsBSpline && faceIndex === 1 ? SurfaceType.BSPLINE : SurfaceType.PLANE,
      vertices,
      surface: NurbsSurface.createPlane(vertices[0], vertices[1], vertices[3]),
      edgeCurves,
      shared: null,
    };
  });

  return buildTopoBody(faceDescs);
}

function summarizeBody(body) {
  return {
    shells: body.shells.length,
    faces: body.faces().length,
    edges: body.edges().length,
    vertices: body.vertices().length,
    loops: body.faces().reduce((count, face) => count + face.allLoops().length, 0),
    coedges: body.faces().reduce(
      (count, face) => count + face.allLoops().reduce((loopCount, loop) => loopCount + loop.coedges.length, 0),
      0,
    ),
  };
}

function sortedPointKeys(points, digits = 6) {
  return points
    .map(point => `${point.x.toFixed(digits)},${point.y.toFixed(digits)},${point.z.toFixed(digits)}`)
    .sort();
}

function boundsOfPoints(points) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.z < minZ) minZ = point.z;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
    if (point.z > maxZ) maxZ = point.z;
  }
  return {
    minX, minY, minZ,
    maxX, maxY, maxZ,
    sizeX: maxX - minX,
    sizeY: maxY - minY,
    sizeZ: maxZ - minZ,
  };
}

// ============================================================
console.log('=== STEP Export Tests ===\n');
// ============================================================

test('exportSTEP: produces valid STEP structure', () => {
  resetTopoIds();
  const body = buildTopoBody([
    {
      surfaceType: SurfaceType.PLANE,
      vertices: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 5, y: 10, z: 0 }],
      surface: NurbsSurface.createPlane(
        { x: 0, y: 0, z: 0 },
        { x: 10, y: 0, z: 0 },
        { x: 0, y: 10, z: 0 },
      ),
      edgeCurves: null,
      shared: null,
    },
  ]);

  const step = exportSTEP(body);
  assert.ok(step.includes('ISO-10303-21;'), 'Should start with ISO header');
  assert.ok(step.includes('HEADER;'), 'Should have HEADER section');
  assert.ok(step.includes('DATA;'), 'Should have DATA section');
  assert.ok(step.includes('ENDSEC;'), 'Should have ENDSEC');
  assert.ok(step.includes('END-ISO-10303-21;'), 'Should end with END marker');
});

test('exportSTEP: contains required STEP entities', () => {
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
  const step = exportSTEP(body);

  assert.ok(step.includes('MANIFOLD_SOLID_BREP'), 'Should contain MANIFOLD_SOLID_BREP');
  assert.ok(step.includes('CLOSED_SHELL'), 'Should contain CLOSED_SHELL');
  assert.ok(step.includes('ADVANCED_FACE'), 'Should contain ADVANCED_FACE');
  assert.ok(step.includes('EDGE_LOOP'), 'Should contain EDGE_LOOP');
  assert.ok(step.includes('ORIENTED_EDGE'), 'Should contain ORIENTED_EDGE');
  assert.ok(step.includes('EDGE_CURVE'), 'Should contain EDGE_CURVE');
  assert.ok(step.includes('VERTEX_POINT'), 'Should contain VERTEX_POINT');
  assert.ok(step.includes('CARTESIAN_POINT'), 'Should contain CARTESIAN_POINT');
});

test('exportSTEP: plane faces produce PLANE entity', () => {
  resetTopoIds();
  const body = buildTopoBody([
    {
      surfaceType: SurfaceType.PLANE,
      vertices: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 5, y: 10, z: 0 }],
      surface: NurbsSurface.createPlane(
        { x: 0, y: 0, z: 0 },
        { x: 10, y: 0, z: 0 },
        { x: 0, y: 10, z: 0 },
      ),
      edgeCurves: null,
      shared: null,
    },
  ]);

  const step = exportSTEP(body);
  assert.ok(step.includes('PLANE('), 'Should contain PLANE entity');
  assert.ok(step.includes('AXIS2_PLACEMENT_3D'), 'Should contain axis placement');
});

test('exportSTEP: B-spline surface export', () => {
  resetTopoIds();
  const surf = NurbsSurface.createPlane(
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 0, y: 10, z: 0 },
  );

  // Use unknown type to force B-spline export
  const body = buildTopoBody([
    {
      surfaceType: SurfaceType.BSPLINE,
      vertices: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 5, y: 10, z: 0 }],
      surface: surf,
      edgeCurves: null,
      shared: null,
    },
  ]);

  const step = exportSTEP(body);
  assert.ok(step.includes('B_SPLINE_SURFACE_WITH_KNOTS'), 'Should contain B-spline surface');
});

test('exportSTEP: rational revolved surfaces and arcs export rational B-splines', () => {
  resetTopoIds();
  const axisOrigin = { x: 0, y: 0, z: 0 };
  const axis = { x: 0, y: 0, z: 1 };
  const xDir = { x: 1, y: 0, z: 0 };
  const yDir = { x: 0, y: 1, z: 0 };
  const crossSection = NurbsCurve.createLine(
    { x: 6, y: 0, z: -1 },
    { x: 6, y: 0, z: 1 },
  );
  const surface = NurbsSurface.createRevolvedSurface(
    crossSection,
    axisOrigin,
    axis,
    xDir,
    yDir,
    0,
    Math.PI / 2,
  );

  const body = buildTopoBody([
    {
      surfaceType: SurfaceType.BSPLINE,
      vertices: [
        { x: 6, y: 0, z: -1 },
        { x: 6, y: 0, z: 1 },
        { x: 0, y: 6, z: 1 },
        { x: 0, y: 6, z: -1 },
      ],
      surface,
      edgeCurves: [
        NurbsCurve.createLine({ x: 6, y: 0, z: -1 }, { x: 6, y: 0, z: 1 }),
        NurbsCurve.createArc({ x: 0, y: 0, z: 1 }, 6, xDir, yDir, 0, Math.PI / 2),
        NurbsCurve.createLine({ x: 0, y: 6, z: 1 }, { x: 0, y: 6, z: -1 }),
        NurbsCurve.createArc({ x: 0, y: 0, z: -1 }, 6, xDir, yDir, Math.PI / 2, -Math.PI / 2),
      ],
      shared: null,
    },
  ]);

  const step = exportSTEP(body);
  assert.ok(step.includes('RATIONAL_B_SPLINE_SURFACE'), 'Rational revolved surfaces should export rational surface weights');
  assert.ok(step.includes('RATIONAL_B_SPLINE_CURVE'), 'Arc edge curves should export rational curve weights');
});

test('exportSTEP: edge curves produce LINE entities', () => {
  resetTopoIds();
  const body = buildTopoBody([
    {
      surfaceType: SurfaceType.PLANE,
      vertices: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 5, y: 10, z: 0 }],
      surface: null,
      edgeCurves: null, // Straight line edges
      shared: null,
    },
  ]);

  const step = exportSTEP(body);
  assert.ok(step.includes('LINE('), 'Should contain LINE entities for straight edges');
  assert.ok(step.includes('VECTOR('), 'Should contain VECTOR entities');
});

test('exportSTEP: custom options', () => {
  resetTopoIds();
  const body = buildTopoBody([
    {
      surfaceType: SurfaceType.PLANE,
      vertices: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 5, y: 10, z: 0 }],
      surface: null, edgeCurves: null, shared: null,
    },
  ]);

  const step = exportSTEP(body, { filename: 'test-part', author: 'Test Author' });
  assert.ok(step.includes('test-part.step'), 'Should use custom filename');
  assert.ok(step.includes('Test Author'), 'Should use custom author');
});

test('exportSTEPDetailed: reports phase timings and counts', () => {
  resetTopoIds();
  const body = buildBoxBody();
  const result = exportSTEPDetailed(body, { filename: 'timed-export' });

  assert.ok(result.stepString.includes('timed-export.step'), 'Detailed export should return the STEP string');
  assert.ok(result.timings, 'Detailed export should report timings');
  assert.ok(result.timings.headerMs >= 0, 'Should record header timing');
  assert.ok(result.timings.writeBodyMs >= 0, 'Should record body serialization timing');
  assert.ok(result.timings.stringifyMs >= 0, 'Should record stringify timing');
  assert.ok(result.timings.totalMs >= 0, 'Should record total timing');
  assert.strictEqual(result.timings.faceCount, 6, 'Should report face count');
  assert.strictEqual(result.timings.shellCount, 1, 'Should report shell count');
  assert.ok(result.timings.entityCount > 0, 'Should report STEP entity count');
});

test('exportSTEP: null body produces valid empty STEP', () => {
  const step = exportSTEP(null);
  assert.ok(step.includes('ISO-10303-21;'), 'Should still have valid header');
  assert.ok(step.includes('END-ISO-10303-21;'), 'Should still have valid footer');
});

test('exportSTEP: unit definitions present', () => {
  resetTopoIds();
  const body = buildTopoBody([
    {
      surfaceType: SurfaceType.PLANE,
      vertices: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 5, y: 10, z: 0 }],
      surface: null, edgeCurves: null, shared: null,
    },
  ]);

  const step = exportSTEP(body);
  assert.ok(step.includes('LENGTH_UNIT'), 'Should define length unit');
  assert.ok(step.includes('PLANE_ANGLE_UNIT'), 'Should define angle unit');
  assert.ok(step.includes('SI_UNIT'), 'Should use SI units');
});

test('exportSTEP: NURBS edge curves produce B_SPLINE_CURVE_WITH_KNOTS', () => {
  resetTopoIds();
  const body = buildTopoBody([
    {
      surfaceType: SurfaceType.PLANE,
      vertices: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 5, y: 10, z: 0 }],
      surface: null,
      edgeCurves: [
        NurbsCurve.createLine({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }),
        NurbsCurve.createLine({ x: 10, y: 0, z: 0 }, { x: 5, y: 10, z: 0 }),
        NurbsCurve.createLine({ x: 5, y: 10, z: 0 }, { x: 0, y: 0, z: 0 }),
      ],
      shared: null,
    },
  ]);

  const step = exportSTEP(body);
  assert.ok(step.includes('B_SPLINE_CURVE_WITH_KNOTS'), 'NURBS edges should produce B-spline curves');
});

test('exportSTEP: analytic cylinder surfaceInfo exports the correct radius', () => {
  resetTopoIds();
  const body = buildTopoBody([
    {
      surfaceType: SurfaceType.CYLINDER,
      vertices: [{ x: 7.5, y: 0, z: 0 }, { x: 0, y: 7.5, z: 0 }, { x: -7.5, y: 0, z: 0 }],
      surface: null,
      surfaceInfo: {
        type: 'cylinder',
        origin: { x: 0, y: 0, z: 0 },
        axis: { x: 0, y: 0, z: 1 },
        xDir: { x: 1, y: 0, z: 0 },
        yDir: { x: 0, y: 1, z: 0 },
        radius: 7.5,
      },
      edgeCurves: null,
      shared: null,
    },
  ]);

  const step = exportSTEP(body);
  assert.match(step, /CYLINDRICAL_SURFACE\('',#\d+,7\.5000000000E0\)/,
    'Analytic cylinder radius should come from surfaceInfo');
});

test('exportSTEP: analytic torus surfaceInfo exports TOROIDAL_SURFACE', () => {
  resetTopoIds();
  const body = buildTopoBody([
    {
      surfaceType: SurfaceType.TORUS,
      vertices: [{ x: 7, y: 0, z: 0 }, { x: 0, y: 7, z: 0 }, { x: -7, y: 0, z: 0 }],
      surface: null,
      surfaceInfo: {
        type: 'torus',
        origin: { x: 1, y: 2, z: 3 },
        axis: { x: 0, y: 0, z: 1 },
        xDir: { x: 1, y: 0, z: 0 },
        yDir: { x: 0, y: 1, z: 0 },
        majorR: 6,
        minorR: 1.5,
      },
      edgeCurves: null,
      shared: null,
    },
  ]);

  const step = exportSTEP(body);
  assert.match(step, /TOROIDAL_SURFACE\('',#\d+,6\.,1\.5000000000E0\)/,
    'Analytic torus should export as TOROIDAL_SURFACE with the correct radii');
});

test('exportSTEP: round-trips a surfaced box as valid exact topology', () => {
  resetTopoIds();
  const sourceBody = buildBoxBody();

  const step = exportSTEP(sourceBody, { filename: 'roundtrip-box' });
  const roundTrippedBody = parseSTEPTopology(step);
  const validation = validateFull(roundTrippedBody);

  assert.deepStrictEqual(
    summarizeBody(roundTrippedBody),
    summarizeBody(sourceBody),
    'Round-tripped body should preserve shell/face/edge/vertex topology counts',
  );
  assert.deepStrictEqual(
    sortedPointKeys(roundTrippedBody.vertices().map(vertex => vertex.point)),
    sortedPointKeys(sourceBody.vertices().map(vertex => vertex.point)),
    'Round-tripped body should preserve exact vertex positions',
  );
  assert.deepStrictEqual(validation.errors, [], validation.toString());
  assert.deepStrictEqual(validation.warnings, [], validation.toString());
});

test('exportSTEP: round-tripped box imports as a tessellated solid with correct extents', () => {
  resetTopoIds();
  const body = buildBoxBody();

  const step = exportSTEP(body, { filename: 'roundtrip-box-mesh' });
  const mesh = importSTEP(step, { curveSegments: 8, surfaceSegments: 8 });
  const bounds = boundsOfPoints(mesh.vertices);
  const faceGroups = new Set(mesh.faces.map(face => face.faceGroup));

  assert.ok(mesh.body, 'Round-tripped STEP should still yield an exact body');
  assert.ok(mesh.faces.length > 0, 'Round-tripped STEP should tessellate into display triangles');
  assert.strictEqual(faceGroups.size, 6, `Expected 6 face groups for the box (got ${faceGroups.size})`);
  assert.ok(Math.abs(bounds.sizeX - 10) < 1e-4, `X extent should stay 10 (got ${bounds.sizeX})`);
  assert.ok(Math.abs(bounds.sizeY - 10) < 1e-4, `Y extent should stay 10 (got ${bounds.sizeY})`);
  assert.ok(Math.abs(bounds.sizeZ - 10) < 1e-4, `Z extent should stay 10 (got ${bounds.sizeZ})`);
});

test('exportSTEP: preserves B-spline faces and NURBS edges on round-trip', () => {
  resetTopoIds();
  const sourceBody = buildBoxBody({ useNurbsEdges: true, topAsBSpline: true });

  const step = exportSTEP(sourceBody, { filename: 'roundtrip-bspline-box' });
  const roundTrippedBody = parseSTEPTopology(step);
  const validation = validateFull(roundTrippedBody);
  const roundTrippedFaces = roundTrippedBody.faces();
  const roundTrippedEdges = roundTrippedBody.edges();

  assert.ok(step.includes('B_SPLINE_SURFACE_WITH_KNOTS'), 'STEP should contain a B-spline surface entity');
  assert.ok(step.includes('B_SPLINE_CURVE_WITH_KNOTS'), 'STEP should contain B-spline curve entities');
  assert.deepStrictEqual(
    summarizeBody(roundTrippedBody),
    summarizeBody(sourceBody),
    'Round-tripped B-spline body should preserve topology counts',
  );
  assert.strictEqual(
    roundTrippedFaces.filter(face => face.surfaceType === SurfaceType.BSPLINE).length,
    1,
    'Expected exactly one B-spline support face after round-trip',
  );
  assert.strictEqual(
    roundTrippedEdges.filter(edge => edge.curve).length,
    12,
    'Expected every box edge to round-trip as an exact curve',
  );
  assert.ok(
    roundTrippedEdges.every(edge => edge.curve && edge.curve.degree === 1),
    'Round-tripped NURBS line edges should remain degree-1 curves',
  );
  assert.deepStrictEqual(validation.errors, [], validation.toString());
  assert.deepStrictEqual(validation.warnings, [], validation.toString());
});

// ============================================================
console.log('\n=== Results ===\n');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
