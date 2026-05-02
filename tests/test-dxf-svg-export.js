import './_watchdog.mjs';
import assert from 'node:assert';

import { state } from '../js/state.js';
import { exportDXF, exportFacesDXF, projectFacesToEdges } from '../js/dxf/export.js';
import { importDXF } from '../js/dxf/import.js';
import { exportSVG } from '../js/svg/export.js';
import { buildTopoBody, SurfaceType } from '../js/cad/BRepTopology.js';
import { NurbsCurve } from '../js/cad/NurbsCurve.js';
import { buildMeshRenderData } from '../js/render/part-render-core.js';
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

function countEntity(dxf, type) {
  const re = new RegExp(`(?:^|\\r?\\n)0\\r?\\n${type}\\r?\\n`, 'g');
  return (dxf.match(re) || []).length;
}

function makeFaceWithCircularHole() {
  const outer = [
    { x: 0, y: 0, z: 0 },
    { x: 50, y: 0, z: 0 },
    { x: 50, y: 30, z: 0 },
    { x: 0, y: 30, z: 0 },
  ];
  const center = { x: 25, y: 15, z: 0 };
  const radius = 5;
  const xAxis = { x: 1, y: 0, z: 0 };
  const yAxis = { x: 0, y: 1, z: 0 };
  const holeVerts = [
    { x: center.x + radius, y: center.y, z: 0 },
    { x: center.x, y: center.y + radius, z: 0 },
    { x: center.x - radius, y: center.y, z: 0 },
    { x: center.x, y: center.y - radius, z: 0 },
  ];
  const holeCurves = [
    NurbsCurve.createArc(center, radius, xAxis, yAxis, 0, Math.PI / 2),
    NurbsCurve.createArc(center, radius, xAxis, yAxis, Math.PI / 2, Math.PI / 2),
    NurbsCurve.createArc(center, radius, xAxis, yAxis, Math.PI, Math.PI / 2),
    NurbsCurve.createArc(center, radius, xAxis, yAxis, 3 * Math.PI / 2, Math.PI / 2),
  ];

  const body = buildTopoBody([
    {
      surfaceType: SurfaceType.PLANE,
      vertices: outer,
      edgeCurves: outer.map((point, index) => NurbsCurve.createLine(point, outer[(index + 1) % outer.length])),
      innerLoops: [
        {
          vertices: holeVerts,
          edgeCurves: holeCurves,
        },
      ],
    },
  ]);
  const faceId = body.faces()[0].id;
  const meshFaces = [
    {
      normal: { x: 0, y: 0, z: 1 },
      vertices: [outer[0], outer[1], outer[2]],
      topoFaceId: faceId,
      faceGroup: faceId,
    },
    {
      normal: { x: 0, y: 0, z: 1 },
      vertices: [outer[0], outer[2], outer[3]],
      topoFaceId: faceId,
      faceGroup: faceId,
    },
  ];
  return { body, meshFaces };
}

console.log('DXF/SVG export tests');

test('face DXF export uses exact boundary loops instead of mesh triangles', () => {
  const { body, meshFaces } = makeFaceWithCircularHole();
  const dxf = exportFacesDXF(meshFaces, undefined, { topoBody: body });
  assert.ok(dxf.includes('SECTION'), 'DXF header present');
  assert.strictEqual(countEntity(dxf, 'LINE'), 4, 'outer rectangle should export as 4 lines');
  assert.strictEqual(countEntity(dxf, 'ARC'), 4, 'circular hole should export as 4 exact arc entities');
  assert.strictEqual(countEntity(dxf, 'SPLINE'), 0, 'circular hole should not degrade into spline entities');
  assert.ok(!dxf.includes('11\r\n50\r\n21\r\n30'), 'triangulation diagonal should not be exported');
});

test('face DXF preview uses the same normalized line/arc entities as export', () => {
  const { body, meshFaces } = makeFaceWithCircularHole();
  const projection = projectFacesToEdges(meshFaces, undefined, { topoBody: body });
  assert.ok(projection, 'expected a non-null exact projection');
  assert.strictEqual(projection.curves.filter((curve) => curve.type === 'line').length, 4);
  assert.strictEqual(projection.curves.filter((curve) => curve.type === 'arc').length, 4);
  assert.strictEqual(projection.curves.filter((curve) => curve.type === 'spline').length, 0);
});

test('face DXF roundtrip preserves circular holes as arcs', () => {
  const { body, meshFaces } = makeFaceWithCircularHole();
  const dxf = exportFacesDXF(meshFaces, undefined, { topoBody: body });
  state.clearAll();
  try {
    importDXF(dxf);
    assert.strictEqual(state.entities.filter((entity) => entity.type === 'segment').length, 4, 'outer rectangle should roundtrip as line segments');
    assert.strictEqual(state.entities.filter((entity) => entity.type === 'arc').length, 4, 'circular hole should roundtrip as arcs');
    assert.strictEqual(state.entities.filter((entity) => entity.type === 'spline').length, 0, 'circular hole must not import as a spline');
  } finally {
    state.clearAll();
  }
});

test('face DXF preview does not fall back to mesh triangles when exact mapping is unavailable', () => {
  const { body, meshFaces } = makeFaceWithCircularHole();
  const unmappedFaces = meshFaces.map((face) => ({ ...face, topoFaceId: null }));
  const projected = projectFacesToEdges(unmappedFaces, undefined, { topoBody: body });
  assert.strictEqual(projected, null, 'preview should fail closed instead of exporting mesh diagonals');
});

test('render mesh faces preserve topoFaceId for exact face export', () => {
  const { meshFaces } = makeFaceWithCircularHole();
  const renderData = buildMeshRenderData({
    faces: meshFaces,
    edges: [],
  });
  assert.strictEqual(renderData._meshFaces[0].topoFaceId, meshFaces[0].topoFaceId);
  assert.strictEqual(renderData._meshFaces[1].topoFaceId, meshFaces[1].topoFaceId);
});

test('DXF sketch export preserves quadratic bezier spans as SPLINE entities', () => {
  state.clearAll();
  try {
    state.scene.addBezier([
      { x: 0, y: 0, handleOut: { dx: 10, dy: 15 } },
      { x: 20, y: 0 },
    ], { merge: false });
    const dxf = exportDXF();
    assert.strictEqual(countEntity(dxf, 'SPLINE'), 1, 'quadratic bezier should stay curved in DXF');
    assert.strictEqual(countEntity(dxf, 'LINE'), 0, 'quadratic bezier must not collapse to a line');
  } finally {
    state.clearAll();
  }
});

test('SVG sketch export writes spline paths as bezier commands instead of polyline segments', () => {
  state.clearAll();
  try {
    state.scene.addSpline([
      { x: 0, y: 0 },
      { x: 10, y: 15 },
      { x: 20, y: -5 },
      { x: 30, y: 12 },
      { x: 40, y: 0 },
    ], { merge: false });
    const svg = exportSVG();
    const match = svg.match(/<path d="([^"]+)" stroke="black" stroke-width="0\.5" fill="none"\/>/);
    assert.ok(match, 'spline path should be exported as SVG path data');
    assert.ok(/[CQ]/.test(match[1]), 'spline path should use bezier commands');
    assert.ok(!/\sL\s/.test(match[1]), 'spline path must not be flattened to line segments');
  } finally {
    state.clearAll();
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
