// tests/test-step-export.js — Tests for STEP file export
//
// Validates:
// 1. STEP file structure (header, data section)
// 2. Entity generation for planes, edges, vertices
// 3. B-spline surface/curve export
// 4. Export of a complete box body

import assert from 'assert';
import { exportSTEP } from '../js/cad/StepExport.js';
import {
  TopoBody, TopoShell, TopoFace, TopoLoop, TopoCoEdge, TopoEdge, TopoVertex,
  SurfaceType, buildTopoBody, resetTopoIds,
} from '../js/cad/BRepTopology.js';
import { NurbsCurve } from '../js/cad/NurbsCurve.js';
import { NurbsSurface } from '../js/cad/NurbsSurface.js';

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

// ============================================================
console.log('\n=== Results ===\n');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
