import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startTiming, formatTimingSuffix } from './test-timing.js';
import { createCamFaceSourceResolver, depthPasses, generateToolpaths, normalizeCamConfig, offsetPolygon } from '../js/cam/index.js';
import { buildTopoBody, resetTopoIds, SurfaceType } from '../js/cad/BRepTopology.js';
import { parseCMOD } from '../js/cmod.js';
import { NurbsCurve } from '../js/cad/NurbsCurve.js';
import { NurbsSurface } from '../js/cad/NurbsSurface.js';

function test(name, fn) {
  const startedAt = startTiming();
  fn();
  console.log(`ok - ${name}${formatTimingSuffix(startedAt)}`);
}

const rect = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 5 },
  { x: 0, y: 5 },
];

function createFaceSourceResolver(overrides = {}) {
  return createCamFaceSourceResolver({
    getReferenceGeometry: overrides.getReferenceGeometry || (() => null),
    getReferenceTolerance: overrides.getReferenceTolerance || (() => 0.001),
    getRenderedFaces: overrides.getRenderedFaces || (() => []),
    getExactPlanarFaceWires: overrides.getExactPlanarFaceWires || (() => null),
    computeGroupBoundaryLoops: overrides.computeGroupBoundaryLoops || (() => []),
  });
}

function buildPlanarTopoBody(loopVerticesList) {
  resetTopoIds();
  return buildTopoBody(loopVerticesList.map((vertices) => ({
    surface: NurbsSurface.createPlane(
      vertices[0],
      {
        x: vertices[1].x - vertices[0].x,
        y: vertices[1].y - vertices[0].y,
        z: vertices[1].z - vertices[0].z,
      },
      {
        x: vertices[3].x - vertices[0].x,
        y: vertices[3].y - vertices[0].y,
        z: vertices[3].z - vertices[0].z,
      },
    ),
    surfaceType: SurfaceType.PLANE,
    sameSense: true,
    vertices,
    edgeCurves: vertices.map((vertex, index) => NurbsCurve.createLine(vertex, vertices[(index + 1) % vertices.length])),
    shared: null,
  })));
}

function assertPoint3Close(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual.x - expected.x) <= tolerance, `expected x=${expected.x}, got ${actual.x}`);
  assert.ok(Math.abs(actual.y - expected.y) <= tolerance, `expected y=${expected.y}, got ${actual.y}`);
  assert.ok(Math.abs(actual.z - expected.z) <= tolerance, `expected z=${expected.z}, got ${actual.z}`);
}

test('polygon offset grows and shrinks a rectangle by tool radius', () => {
  const outside = offsetPolygon(rect, 1);
  const inside = offsetPolygon(rect, -1);
  assert.deepEqual(outside[0], { x: -1, y: -1 });
  assert.deepEqual(inside[0], { x: 1, y: 1 });
  assert.deepEqual(offsetPolygon(rect, -6), []);
});

test('face source resolver prefers explicit multi-face selections', () => {
  const resolver = createFaceSourceResolver();
  const selectedFaces = new Map([
    [2, { faceIndex: 2 }],
    [5, { faceIndex: 5 }],
  ]);

  assert.deepEqual(
    resolver.selectedCamSourceFaceHits({ faceIndex: 5 }, selectedFaces).map((hit) => hit.faceIndex),
    [2, 5],
  );
  assert.deepEqual(
    resolver.selectedCamSourceFaceHits({ faceIndex: 9 }, selectedFaces).map((hit) => hit.faceIndex),
    [9],
  );
});

test('face source resolver keeps single-surface plane metadata', () => {
  const resolver = createFaceSourceResolver();
  const plane = {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
  };

  const source = resolver.combineCamSourceSurfaces([{
    referenceId: 'topoface-7',
    label: 'Face 7',
    faceIndex: 3,
    topoFaceId: 7,
    faceGroup: 3,
    tolerance: 0.01,
    plane,
    z: 0,
    loops: [rect],
    segmentLoops: [],
  }]);

  assert.equal(source.type, 'face');
  assert.deepEqual(source.plane, plane);
});

test('face source resolver reports unsupported source planes', () => {
  const resolver = createFaceSourceResolver();
  const horizontalPlane = {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
  };
  const tiltedPlane = {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 1, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 0, z: 1 },
  };

  assert.match(
    resolver.camFaceSourceSupportMessage({ surfaces: [{ plane: null }] }),
    /planar OCCT face/i,
  );
  assert.match(
    resolver.camFaceSourceSupportMessage({ surfaces: [{ plane: tiltedPlane }] }),
    /parallel to the XY machining plane/i,
  );
  assert.equal(
    resolver.camFaceSourceSupportMessage({ surfaces: [{ plane: horizontalPlane }] }),
    null,
  );
});

test('face source resolver uses exact OCCT plane data instead of preview mesh drift', () => {
  const rect3d = [
    { x: 0, y: 0, z: 3 },
    { x: 10, y: 0, z: 3 },
    { x: 10, y: 5, z: 3 },
    { x: 0, y: 5, z: 3 },
  ];
  const body = buildPlanarTopoBody([rect3d]);
  const topoFace = body.faces()[0];
  const resolver = createFaceSourceResolver({
    getReferenceGeometry: () => ({ topoBody: body }),
  });

  const source = resolver.faceHitToCamSource({
    faceIndex: 0,
    point: { x: 1, y: 1, z: 2.9 },
    face: {
      topoFaceId: topoFace.id,
      faceGroup: 7,
      isCurved: false,
      normal: { x: 0.12, y: -0.08, z: 0.98 },
      vertices: rect3d.map((vertex, index) => ({
        x: vertex.x + (index % 2 === 0 ? 0.02 : -0.02),
        y: vertex.y + (index < 2 ? 0.015 : -0.015),
        z: vertex.z + 0.03,
      })),
    },
  });

  assert.ok(source);
  assert.equal(source.loops.length, 1);
  assertPoint3Close(source.plane.origin, { x: 0, y: 0, z: 3 });
  assertPoint3Close(source.plane.normal, { x: 0, y: 0, z: 1 });
  assertPoint3Close(source.plane.xAxis, { x: 1, y: 0, z: 0 });
  assertPoint3Close(source.plane.yAxis, { x: 0, y: 1, z: 0 });
});

test('face source resolver prefers exact planar wire API when available', () => {
  const rect3d = [
    { x: 0, y: 0, z: 3 },
    { x: 10, y: 0, z: 3 },
    { x: 10, y: 5, z: 3 },
    { x: 0, y: 5, z: 3 },
  ];
  const body = buildPlanarTopoBody([rect3d]);
  const topoFace = body.faces()[0];
  const exactCalls = [];
  const resolver = createFaceSourceResolver({
    getReferenceGeometry: () => ({ topoBody: body, occtShapeHandle: 42 }),
    getExactPlanarFaceWires: ({ faceRef }) => {
      exactCalls.push(faceRef);
      return {
        face: faceRef,
        surfaceType: 'plane',
        plane: {
          origin: [2, 4, 7],
          normal: [0, 0, 1],
          xDirection: [1, 0, 0],
        },
        domain: { u: [0, 10], v: [0, 5] },
        wires: [{
          kind: 'outer',
          segments: [
            { planarCurve: { curveType: 'line', startPoint: [2, 4], midPoint: [7, 4], endPoint: [12, 4], line: { origin: [2, 4], direction: [1, 0] } } },
            { planarCurve: { curveType: 'line', startPoint: [12, 4], midPoint: [12, 6.5], endPoint: [12, 9], line: { origin: [12, 4], direction: [0, 1] } } },
            { planarCurve: { curveType: 'line', startPoint: [12, 9], midPoint: [7, 9], endPoint: [2, 9], line: { origin: [12, 9], direction: [-1, 0] } } },
            { planarCurve: { curveType: 'line', startPoint: [2, 9], midPoint: [2, 6.5], endPoint: [2, 4], line: { origin: [2, 9], direction: [0, -1] } } },
          ],
        }],
      };
    },
  });

  const source = resolver.faceHitToCamSource({
    faceIndex: 0,
    point: { x: 1, y: 1, z: 2.9 },
    face: {
      topoFaceId: topoFace.id,
      faceGroup: 7,
      isCurved: false,
      normal: { x: 0, y: 0, z: 1 },
      vertices: rect3d,
    },
  });

  assert.equal(exactCalls.length, 1);
  assert.deepEqual(exactCalls[0], { topoId: topoFace.id });
  assert.equal(source.loops.length, 1);
  assert.deepEqual(source.loops[0], [
    { x: 2, y: 4 },
    { x: 12, y: 4 },
    { x: 12, y: 9 },
    { x: 2, y: 9 },
  ]);
  assert.equal(source.segmentLoops.length, 1);
  assert.ok(source.segmentLoops[0].every((segment) => segment.type === 'line'));
  assertPoint3Close(source.plane.origin, { x: 2, y: 4, z: 7 });
});

test('face source resolver refuses preview-mesh-only CAM sources', () => {
  const resolver = createFaceSourceResolver();

  const source = resolver.faceHitToCamSource({
    faceIndex: 0,
    face: {
      faceGroup: 4,
      isCurved: false,
      normal: { x: 0, y: 0, z: 1 },
      vertices: [
        { x: 0, y: 0, z: 0 },
        { x: 10, y: 0, z: 0 },
        { x: 10, y: 5, z: 0 },
        { x: 0, y: 5, z: 0 },
      ],
    },
  });

  assert.equal(source, null);
});

test('grouped planar face selections are deduplicated by face group', () => {
  const leftRect3d = [
    { x: 0, y: 0, z: 0 },
    { x: 4, y: 0, z: 0 },
    { x: 4, y: 4, z: 0 },
    { x: 0, y: 4, z: 0 },
  ];
  const rightRect3d = [
    { x: 6, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 10, y: 4, z: 0 },
    { x: 6, y: 4, z: 0 },
  ];
  const body = buildPlanarTopoBody([leftRect3d, rightRect3d]);
  const topoFaces = body.faces();
  const renderedFaces = [
    { faceGroup: 55, topoFaceId: topoFaces[0].id, vertices: leftRect3d, normal: { x: 0, y: 0, z: 1 }, isCurved: false },
    { faceGroup: 55, topoFaceId: topoFaces[1].id, vertices: rightRect3d, normal: { x: 0, y: 0, z: 1 }, isCurved: false },
  ];
  const resolver = createFaceSourceResolver({
    getReferenceGeometry: () => ({ topoBody: body }),
    getRenderedFaces: () => renderedFaces,
  });

  const source = resolver.faceHitsToCamSource([
    { faceIndex: 0, face: renderedFaces[0] },
    { faceIndex: 1, face: renderedFaces[1] },
  ]);

  assert.equal(source.referenceId, 'facegroup-55');
  assert.equal(source.surfaces.length, 1);
  assert.equal(source.loops.length, 2);
  assert.equal(source.segmentLoops.length, 2);
});

test('face source resolver preserves exact OCCT segment loops during hydration', () => {
  const rect3d = [
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 10, y: 5, z: 0 },
    { x: 0, y: 5, z: 0 },
  ];
  const body = buildPlanarTopoBody([rect3d]);
  const topoFace = body.faces()[0];
  const resolver = createFaceSourceResolver({
    getReferenceGeometry: () => ({ topoBody: body }),
  });

  const source = resolver.hydrateCamFaceSource({
    type: 'face',
    referenceId: `topoface-${topoFace.id}`,
  });

  assert.equal(source.referenceId, `topoface-${topoFace.id}`);
  assert.equal(source.loops.length, 1);
  assert.equal(source.segmentLoops.length, 1);
  assert.equal(source.segmentLoops[0].length, 4);
  assert.ok(source.segmentLoops[0].every((segment) => segment.type === 'line'));
});

test('face source resolver tolerates one-based mesh topo face ids against zero-based exact topology', () => {
  const rect3d = [
    { x: 0, y: 0, z: 10 },
    { x: 10, y: 0, z: 10 },
    { x: 10, y: 10, z: 10 },
    { x: 0, y: 10, z: 10 },
  ];
  const body = buildPlanarTopoBody([rect3d]);
  const topoFace = body.faces()[0];
  assert.equal(topoFace.id, 0);
  const resolver = createFaceSourceResolver({
    getReferenceGeometry: () => ({ topoBody: body }),
  });

  const source = resolver.faceHitToCamSource({
    faceIndex: 10,
    point: { x: 5, y: 5, z: 10 },
    face: {
      topoFaceId: 1,
      faceGroup: 10,
      isCurved: false,
      normal: { x: 0, y: 0, z: 1 },
      vertices: rect3d,
    },
  });

  assert.ok(source);
  assert.equal(source.topoFaceId, 1);
  assert.equal(source.loops.length, 1);
  assertPoint3Close(source.plane.origin, { x: 0, y: 0, z: 10 });
  assertPoint3Close(source.plane.normal, { x: 0, y: 0, z: 1 });
});

test('face source fallback preserves loops for planar non-XY faces before support rejection', () => {
  const verticalRect3d = [
    { x: 4, y: 0, z: 0 },
    { x: 4, y: 10, z: 0 },
    { x: 4, y: 10, z: 6 },
    { x: 4, y: 0, z: 6 },
  ];
  const body = buildPlanarTopoBody([verticalRect3d]);
  const topoFace = body.faces()[0];
  const resolver = createFaceSourceResolver({
    getReferenceGeometry: () => ({ topoBody: body }),
    getExactPlanarFaceWires: () => null,
  });

  const source = resolver.faceHitToCamSource({
    faceIndex: 0,
    point: { x: 4, y: 5, z: 3 },
    face: {
      topoFaceId: topoFace.id,
      faceGroup: 12,
      isCurved: false,
      normal: { x: 1, y: 0, z: 0 },
      vertices: verticalRect3d,
    },
  });

  assert.ok(source);
  assert.equal(source.loops.length, 1);
  assert.match(
    resolver.camFaceSourceSupportMessage(source),
    /parallel to the XY machining plane/i,
  );
});

test('profile toolpaths offset outside contours and cut requested depth passes', () => {
  const cam = normalizeCamConfig({
    stock: { min: { x: 0, y: 0, z: -2 }, max: { x: 10, y: 5, z: 0 } },
    tools: [{ id: 'tool-a', number: 3, type: 'endmill', diameter: 2, feedRate: 300, plungeRate: 90 }],
    operations: [{ id: 'profile-a', type: 'profile', toolId: 'tool-a', side: 'outside', source: { loops: [rect] }, topZ: 0, bottomZ: -2, stepDown: 1 }],
  });
  const { toolpaths, warnings } = generateToolpaths(cam);

  assert.equal(warnings.length, 0);
  assert.equal(toolpaths.length, 1);
  const firstXYRapid = toolpaths[0].moves.find((move) => move.type === 'rapid' && move.x != null && move.y != null);
  assert.deepEqual({ x: firstXYRapid.x, y: firstXYRapid.y }, { x: -1, y: -1 });
  const plungeDepths = toolpaths[0].moves.filter((move) => move.type === 'feed' && move.z != null).map((move) => move.z);
  assert.deepEqual(plungeDepths, [-1, -2]);
});

test('rapid Z retract toggle can emit feed retracts for all toolpaths', () => {
  const cam = normalizeCamConfig({
    safeZ: 6,
    clearanceZ: 4,
    rapidZRetract: false,
    stock: { min: { x: 0, y: 0, z: -1 }, max: { x: 10, y: 5, z: 0 } },
    tools: [{ id: 'tool-a', number: 3, type: 'endmill', diameter: 2, feedRate: 300, plungeRate: 90 }],
    operations: [{ id: 'profile-a', type: 'profile', toolId: 'tool-a', side: 'outside', source: { loops: [rect] }, topZ: 0, bottomZ: -1, stepDown: 1 }],
  });
  const { toolpaths } = generateToolpaths(cam);
  const zRapids = toolpaths[0].moves.filter((move) => move.type === 'rapid' && move.z != null);
  const zFeeds = toolpaths[0].moves.filter((move) => move.type === 'feed' && move.z != null);
  const xyRapids = toolpaths[0].moves.filter((move) => move.type === 'rapid' && move.x != null && move.y != null);

  assert.equal(zRapids.length, 0);
  assert.ok(zFeeds.some((move) => move.z === 4), 'expected clearance retract to use a feed move');
  assert.ok(zFeeds.some((move) => move.z === 6), 'expected safe Z retract to use a feed move');
  assert.ok(xyRapids.length > 0, 'expected XY traverses to remain rapid');
});

test('face milling operations raster the stock outline', () => {
  const cam = normalizeCamConfig({
    stock: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 6, z: 2 } },
    tools: [{ id: 'tool-a', type: 'endmill', diameter: 2, feedRate: 300, plungeRate: 90 }],
    operations: [{ id: 'face-a', type: 'face', toolId: 'tool-a', topZ: 2, bottomZ: 1.5, stepDown: 0.5 }],
  });
  const { toolpaths, warnings } = generateToolpaths(cam);

  assert.equal(warnings.length, 0);
  assert.equal(toolpaths.length, 1);
  assert.equal(toolpaths[0].operationType, 'face');
  assert.ok(toolpaths[0].moves.some((move) => move.type === 'feed' && move.x != null && move.y != null));
  const firstXYRapid = toolpaths[0].moves.find((move) => move.type === 'rapid' && move.x != null && move.y != null);
  assert.ok(firstXYRapid.x >= 0 && firstXYRapid.x <= 10);
  assert.ok(firstXYRapid.y >= 0 && firstXYRapid.y <= 6);
});

test('pocket toolpaths create inward stepover loops', () => {
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  const cam = normalizeCamConfig({
    tools: [{ id: 'tool-a', type: 'endmill', diameter: 2 }],
    operations: [{ id: 'pocket-a', type: 'pocket', toolId: 'tool-a', source: { loops: [square] }, topZ: 0, bottomZ: -1, stepDown: 1, stepoverPercent: 75 }],
  });
  const { toolpaths } = generateToolpaths(cam);
  const xyRapids = toolpaths[0].moves.filter((move) => move.type === 'rapid' && move.x != null && move.y != null);
  const plungeMoves = toolpaths[0].moves.filter((move) => move.type === 'feed' && move.z != null);
  const xyFeeds = toolpaths[0].moves.filter((move) => move.type === 'feed' && move.x != null && move.y != null);
  const innerShellIndex = xyFeeds.findIndex((move) => Math.abs(move.x - 5) < 1e-6 && Math.abs(move.y - 5.5) < 1e-6);
  const outerShellIndex = xyFeeds.findIndex((move) => Math.abs(move.x - 5) < 1e-6 && Math.abs(move.y - 1) < 1e-6);

  assert.equal(xyRapids.length, 1);
  assert.equal(plungeMoves.length, 1);
  assert.deepEqual({ x: xyRapids[0].x, y: xyRapids[0].y }, { x: 5, y: 5 });
  assert.ok(innerShellIndex >= 0, 'expected an innermost contour shell to start from the center anchor');
  assert.ok(outerShellIndex > innerShellIndex, 'expected contour shells to expand from the center out to the wall');
  assert.ok(xyFeeds.some((move) => Math.abs(move.x - 5) < 1e-6 && Math.abs(move.y - 2.5) < 1e-6), 'expected an intermediate contour shell');
  for (const rapid of xyRapids) {
    assert.ok(rapid.x >= 0 && rapid.x <= 10);
    assert.ok(rapid.y >= 0 && rapid.y <= 10);
  }
});

test('pocket toolpaths keep islands clear and treat narrow necks as separate pockets', () => {
  const outer = [
    { x: 0, y: 0 },
    { x: 24, y: 0 },
    { x: 24, y: 20 },
    { x: 0, y: 20 },
  ];
  const island = [
    { x: 8, y: 6 },
    { x: 16, y: 6 },
    { x: 16, y: 20 },
    { x: 8, y: 20 },
  ];
  const cam = normalizeCamConfig({
    tools: [{ id: 'tool-a', type: 'endmill', diameter: 6 }],
    operations: [{
      id: 'pocket-islands',
      type: 'pocket',
      toolId: 'tool-a',
      source: { loops: [outer, island] },
      topZ: 0,
      bottomZ: -1,
      stepDown: 1,
      stepoverPercent: 100,
    }],
  });
  const { toolpaths } = generateToolpaths(cam);
  const xyRapids = toolpaths[0].moves.filter((move) => move.type === 'rapid' && move.x != null && move.y != null);

  assert.ok(xyRapids.some((move) => move.x < 8), 'left pocket should be machined');
  assert.ok(xyRapids.some((move) => move.x > 16), 'right pocket should be machined');
  assert.ok(xyRapids.every((move) => !(move.x > 8 && move.x < 16 && move.y > 6 && move.y < 20)), 'island and blocked neck should stay clear');
});

test('concave pocket surfaces split narrow bridges that are smaller than the tool diameter', () => {
  const dumbbell = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 4 },
    { x: 14, y: 4 },
    { x: 14, y: 0 },
    { x: 24, y: 0 },
    { x: 24, y: 10 },
    { x: 14, y: 10 },
    { x: 14, y: 6 },
    { x: 10, y: 6 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  const cam = normalizeCamConfig({
    tools: [{ id: 'tool-a', type: 'endmill', diameter: 6 }],
    operations: [{
      id: 'concave-pocket',
      type: 'pocket',
      toolId: 'tool-a',
      source: { loops: [dumbbell] },
      topZ: 0,
      bottomZ: -1,
      stepDown: 1,
      stepoverPercent: 100,
    }],
  });
  const { toolpaths } = generateToolpaths(cam);
  const xyRapids = toolpaths[0].moves.filter((move) => move.type === 'rapid' && move.x != null && move.y != null);

  assert.ok(xyRapids.some((move) => move.x < 10), 'left lobe should be machined');
  assert.ok(xyRapids.some((move) => move.x > 14), 'right lobe should be machined');
  assert.ok(xyRapids.every((move) => !(move.x > 10 && move.x < 14 && move.y > 4 && move.y < 6)), 'bridge smaller than the cutter should stay clear');
});

test('pocket order can finish each pocket before moving to the next depth', () => {
  const leftPocket = [
    { x: 0, y: 0 },
    { x: 6, y: 0 },
    { x: 6, y: 6 },
    { x: 0, y: 6 },
  ];
  const rightPocket = [
    { x: 12, y: 0 },
    { x: 18, y: 0 },
    { x: 18, y: 6 },
    { x: 12, y: 6 },
  ];
  const cam = normalizeCamConfig({
    tools: [{ id: 'tool-a', type: 'endmill', diameter: 2 }],
    operations: [{
      id: 'pocket-order',
      type: 'pocket',
      toolId: 'tool-a',
      source: { loops: [leftPocket, rightPocket] },
      topZ: 0,
      bottomZ: -2,
      stepDown: 1,
      stepoverPercent: 100,
      pocketOrder: 'per-pocket',
    }],
  });
  const { toolpaths } = generateToolpaths(cam);
  const plungeStarts = [];
  let pendingRapid = null;
  for (const move of toolpaths[0].moves) {
    if (move.type === 'rapid' && move.x != null && move.y != null) {
      pendingRapid = { x: move.x, y: move.y };
      continue;
    }
    if (move.type === 'feed' && move.z != null && pendingRapid) {
      plungeStarts.push({ ...pendingRapid, z: move.z });
      pendingRapid = null;
    }
  }

  assert.deepEqual(
    plungeStarts.slice(0, 4).map(({ x, z }) => ({ side: x < 10 ? 'left' : 'right', z })),
    [
      { side: 'left', z: -1 },
      { side: 'left', z: -2 },
      { side: 'right', z: -1 },
      { side: 'right', z: -2 },
    ],
  );
});

test('pocket strategies can switch raster direction', () => {
  const baseOperation = {
    id: 'op-pocket',
    name: 'Pocket',
    type: 'pocket',
    toolId: 'tool-pocket',
    topZ: 0,
    bottomZ: -1,
    stepDown: 1,
    stepoverPercent: 100,
    source: {
      loops: [[
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 12 },
        { x: 0, y: 12 },
      ]],
    },
  };

  const horizontalConfig = normalizeCamConfig({
    tools: [{ id: 'tool-pocket', type: 'flat-endmill', diameter: 2, feedRate: 500, plungeRate: 120 }],
    operations: [{ ...baseOperation, id: 'op-pocket-x', pocketStrategy: 'zigzag-x' }],
  });
  const verticalConfig = normalizeCamConfig({
    tools: [{ id: 'tool-pocket', type: 'flat-endmill', diameter: 2, feedRate: 500, plungeRate: 120 }],
    operations: [{ ...baseOperation, id: 'op-pocket-y', pocketStrategy: 'zigzag-y' }],
  });

  const horizontalMoves = generateToolpaths(horizontalConfig).toolpaths[0].moves.filter((move) => move.type === 'feed' && Number.isFinite(move.x) && Number.isFinite(move.y));
  const verticalMoves = generateToolpaths(verticalConfig).toolpaths[0].moves.filter((move) => move.type === 'feed' && Number.isFinite(move.x) && Number.isFinite(move.y));

  const longestHorizontalStep = longestFeedStep(horizontalMoves);
  const longestVerticalStep = longestFeedStep(verticalMoves);
  assert.ok(longestHorizontalStep);
  assert.ok(longestVerticalStep);

  const horizontalDx = Math.abs(longestHorizontalStep.to.x - longestHorizontalStep.from.x);
  const horizontalDy = Math.abs(longestHorizontalStep.to.y - longestHorizontalStep.from.y);
  const verticalDx = Math.abs(longestVerticalStep.to.x - longestVerticalStep.from.x);
  const verticalDy = Math.abs(longestVerticalStep.to.y - longestVerticalStep.from.y);

  assert.ok(horizontalDx > horizontalDy, `expected horizontal zig-zag pass, got dx=${horizontalDx}, dy=${horizontalDy}`);
  assert.ok(verticalDy > verticalDx, `expected vertical zig-zag pass, got dx=${verticalDx}, dy=${verticalDy}`);
});

test('zig-zag pockets stay down across connected scan lines', () => {
  const cam = normalizeCamConfig({
    tools: [{ id: 'tool-pocket', type: 'flat-endmill', diameter: 2, feedRate: 500, plungeRate: 120 }],
    operations: [{
      id: 'op-pocket-x',
      type: 'pocket',
      toolId: 'tool-pocket',
      topZ: 0,
      bottomZ: -1,
      stepDown: 1,
      stepoverPercent: 100,
      pocketStrategy: 'zigzag-x',
      source: {
        loops: [[
          { x: 0, y: 0 },
          { x: 20, y: 0 },
          { x: 20, y: 12 },
          { x: 0, y: 12 },
        ]],
      },
    }],
  });

  const moves = generateToolpaths(cam).toolpaths[0].moves;
  const plungeMoves = moves.filter((move) => move.type === 'feed' && Number.isFinite(move.z));
  const xyRapids = moves.filter((move) => move.type === 'rapid' && Number.isFinite(move.x) && Number.isFinite(move.y));

  assert.equal(plungeMoves.length, 1);
  assert.equal(xyRapids.length, 1);
});

test('one-way pockets retract between scan lines and keep one cutting direction', () => {
  const cam = normalizeCamConfig({
    tools: [{ id: 'tool-pocket', type: 'flat-endmill', diameter: 2, feedRate: 500, plungeRate: 120 }],
    operations: [{
      id: 'op-pocket-oneway',
      type: 'pocket',
      toolId: 'tool-pocket',
      topZ: 0,
      bottomZ: -1,
      stepDown: 1,
      stepoverPercent: 100,
      pocketStrategy: 'oneway-x',
      source: {
        loops: [[
          { x: 0, y: 0 },
          { x: 20, y: 0 },
          { x: 20, y: 12 },
          { x: 0, y: 12 },
        ]],
      },
    }],
  });

  const moves = generateToolpaths(cam).toolpaths[0].moves;
  const plungeMoves = moves.filter((move) => move.type === 'feed' && Number.isFinite(move.z));
  const xyRapids = moves.filter((move) => move.type === 'rapid' && Number.isFinite(move.x) && Number.isFinite(move.y));
  const passEntries = collectPassEntries(moves);

  assert.equal(plungeMoves.length, xyRapids.length);
  assert.ok(plungeMoves.length > 1, 'one-way pockets should re-enter for each scan line');
  assert.ok(passEntries.length >= 4, 'expected several one-way raster cuts');
  assert.ok(passEntries.every((entry) => entry.end.x > entry.start.x), 'one-way-x should cut in a single positive X direction');
  assert.ok(passEntries.every((entry) => Math.abs(entry.end.y - entry.start.y) <= 1e-6), 'one-way passes should stay on a single scan line');
});

test('complex contour pockets stay contour-parallel instead of rasterizing', () => {
  const outer = [
    { x: 0, y: 0 },
    { x: 24, y: 0 },
    { x: 24, y: 20 },
    { x: 0, y: 20 },
  ];
  const island = [
    { x: 8, y: 6 },
    { x: 16, y: 6 },
    { x: 16, y: 20 },
    { x: 8, y: 20 },
  ];
  const cam = normalizeCamConfig({
    tools: [{ id: 'tool-a', type: 'endmill', diameter: 4, feedRate: 300, plungeRate: 90 }],
    operations: [{
      id: 'pocket-contour-island',
      type: 'pocket',
      toolId: 'tool-a',
      source: { loops: [outer, island] },
      topZ: 0,
      bottomZ: -1,
      stepDown: 1,
      stepoverPercent: 50,
      pocketStrategy: 'contour',
    }],
  });

  const moves = generateToolpaths(cam).toolpaths[0].moves;
  const plungeMoves = moves.filter((move) => move.type === 'feed' && Number.isFinite(move.z));
  const xyRapids = moves.filter((move) => move.type === 'rapid' && Number.isFinite(move.x) && Number.isFinite(move.y));

  assert.equal(plungeMoves.length, xyRapids.length);
  assert.ok(plungeMoves.length > 2, 'complex contour pockets should create multiple contour shells, not a single raster path');
  assert.ok(xyRapids.some((move) => move.x < 8), 'left side of the pocket should be machined');
  assert.ok(xyRapids.some((move) => move.x > 16), 'right side of the pocket should be machined');
  assert.ok(xyRapids.every((move) => !(move.x > 8 && move.x < 16 && move.y > 6 && move.y < 20)), 'contour shells should keep the island clear');
});

test('face-surface pockets re-evaluate active sub-pockets at each depth', () => {
  const outer = [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 20 },
    { x: 0, y: 20 },
  ];
  const inner = [
    { x: 6, y: 6 },
    { x: 14, y: 6 },
    { x: 14, y: 14 },
    { x: 6, y: 14 },
  ];
  const cam = normalizeCamConfig({
    tools: [{ id: 'tool-a', type: 'endmill', diameter: 2, feedRate: 300, plungeRate: 90 }],
    operations: [{
      id: 'surface-pocket',
      type: 'pocket',
      toolId: 'tool-a',
      topZ: 0,
      bottomZ: -4,
      stepDown: 2,
      pocketStrategy: 'contour',
      source: {
        type: 'face',
        loops: [outer, inner],
        surfaces: [
          { referenceId: 'surface-outer', label: 'Outer shelf', z: -2, loops: [outer] },
          { referenceId: 'surface-inner', label: 'Inner relief', z: -4, loops: [inner] },
        ],
      },
    }],
  });

  const moves = generateToolpaths(cam).toolpaths[0].moves;
  const plungeStarts = collectPlungeStarts(moves);
  const shallowStarts = plungeStarts.filter((entry) => Math.abs(entry.z - (-2)) <= 1e-6);
  const deepStarts = plungeStarts.filter((entry) => Math.abs(entry.z - (-4)) <= 1e-6);

  assert.equal(shallowStarts.length, 2, 'expected the shallower depth to machine both active surface pockets');
  assert.equal(deepStarts.length, 1, 'expected only the deeper inner relief to remain active at the second depth');
});

test('face source planes are preserved for horizontal pocket sources', () => {
  const plane = {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
  };
  const cam = normalizeCamConfig({
    tools: [{ id: 'tool-a', type: 'endmill', diameter: 2 }],
    operations: [{
      id: 'face-plane-pocket',
      type: 'pocket',
      toolId: 'tool-a',
      source: { type: 'face', plane, loops: [rect] },
      topZ: 0,
      bottomZ: -1,
      stepDown: 1,
    }],
  });

  assert.deepEqual(cam.operations[0].source.plane, plane);
  const { toolpaths, warnings } = generateToolpaths(cam);
  assert.equal(warnings.length, 0);
  assert.equal(toolpaths.length, 1);
});

test('non-horizontal face source planes are rejected for current 2.5D CAM', () => {
  const cam = normalizeCamConfig({
    tools: [{ id: 'tool-a', type: 'endmill', diameter: 2 }],
    operations: [{
      id: 'tilted-face-pocket',
      type: 'pocket',
      toolId: 'tool-a',
      source: {
        type: 'face',
        plane: {
          origin: { x: 0, y: 0, z: 0 },
          normal: { x: 0, y: 1, z: 0 },
          xAxis: { x: 1, y: 0, z: 0 },
          yAxis: { x: 0, y: 0, z: 1 },
        },
        loops: [rect],
      },
      topZ: 0,
      bottomZ: -1,
      stepDown: 1,
    }],
  });

  const { toolpaths, warnings } = generateToolpaths(cam);
  assert.equal(toolpaths.length, 0);
  assert.ok(warnings.some((warning) => warning.code === 'unsupported-face-source-plane' && warning.severity === 'error'));
});

test('sample contour pocket uses contour shells when exact face geometry is available', () => {
  const samplePath = new URL('./samples/machinning-sample.cmod', import.meta.url);
  const parsed = parseCMOD(readFileSync(samplePath, 'utf8'));
  assert.equal(parsed.ok, true);

  const cam = normalizeCamConfig(parsed.data.cam);
  const operation = cam.operations.find((candidate) => candidate.type === 'pocket');
  assert.ok(operation);
  operation.source.segmentLoops = operation.source.loops.map((loop) => loop.map((start, index) => ({
    type: 'line',
    start,
    end: loop[(index + 1) % loop.length],
  })));

  const moves = generateToolpaths(cam).toolpaths[0].moves;
  const feedSegments = collectFeedSegments(moves).slice(0, 20);
  assert.ok(!hasRasterSweepPattern(feedSegments, 15, 2), 'expected contour-following opening moves instead of stepped raster sweeps');
});

test('contour pockets can plunge outside stock and feed in from an open side', () => {
  const cam = normalizeCamConfig({
    stock: { min: { x: 0, y: 0, z: -1 }, max: { x: 20, y: 20, z: 0 } },
    tools: [{ id: 'tool-pocket', type: 'flat-endmill', diameter: 2, feedRate: 500, plungeRate: 120 }],
    operations: [{
      id: 'op-pocket-side-entry',
      type: 'pocket',
      toolId: 'tool-pocket',
      topZ: 0,
      bottomZ: -1,
      stepDown: 1,
      stepoverPercent: 75,
      pocketStrategy: 'contour',
      sideEntryEnabled: true,
      leadInLength: 3,
      source: {
        loops: [[
          { x: 0, y: 4 },
          { x: 12, y: 4 },
          { x: 12, y: 16 },
          { x: 0, y: 16 },
        ]],
      },
    }],
  });

  const moves = generateToolpaths(cam).toolpaths[0].moves;
  const firstXYRapid = moves.find((move) => move.type === 'rapid' && Number.isFinite(move.x) && Number.isFinite(move.y));
  const firstPlungeIndex = moves.findIndex((move) => move.type === 'feed' && Number.isFinite(move.z));
  const firstContourFeed = moves.slice(firstPlungeIndex + 1).find((move) => move.type === 'feed' && Number.isFinite(move.x) && Number.isFinite(move.y));

  assert.deepEqual({ x: firstXYRapid.x, y: firstXYRapid.y }, { x: -3, y: 10 });
  assert.ok(firstPlungeIndex >= 0, 'expected a plunge move');
  assert.deepEqual({ x: firstContourFeed.x, y: firstContourFeed.y }, { x: 5.5, y: 10 });
});

test('contour side-entry falls back to a normal entry when the pocket is closed in stock', () => {
  const cam = normalizeCamConfig({
    stock: { min: { x: 0, y: 0, z: -1 }, max: { x: 20, y: 20, z: 0 } },
    tools: [{ id: 'tool-pocket', type: 'flat-endmill', diameter: 2, feedRate: 500, plungeRate: 120 }],
    operations: [{
      id: 'op-pocket-closed-side-entry',
      type: 'pocket',
      toolId: 'tool-pocket',
      topZ: 0,
      bottomZ: -1,
      stepDown: 1,
      stepoverPercent: 75,
      pocketStrategy: 'contour',
      sideEntryEnabled: true,
      leadInLength: 3,
      source: {
        loops: [[
          { x: 4, y: 4 },
          { x: 12, y: 4 },
          { x: 12, y: 16 },
          { x: 4, y: 16 },
        ]],
      },
    }],
  });

  const moves = generateToolpaths(cam).toolpaths[0].moves;
  const firstXYRapid = moves.find((move) => move.type === 'rapid' && Number.isFinite(move.x) && Number.isFinite(move.y));

  assert.deepEqual({ x: firstXYRapid.x, y: firstXYRapid.y }, { x: 8, y: 10 });
});

test('open contour side-entry extends outside stock by at least one tool diameter', () => {
  const cam = normalizeCamConfig({
    stock: { min: { x: 0, y: 0, z: -1 }, max: { x: 20, y: 20, z: 0 } },
    tools: [{ id: 'tool-pocket', type: 'flat-endmill', diameter: 2, feedRate: 500, plungeRate: 120 }],
    operations: [{
      id: 'op-pocket-diameter-extension',
      type: 'pocket',
      toolId: 'tool-pocket',
      topZ: 0,
      bottomZ: -1,
      stepDown: 1,
      stepoverPercent: 75,
      pocketStrategy: 'contour',
      sideEntryEnabled: true,
      leadInLength: 0,
      source: {
        loops: [[
          { x: 0, y: 4 },
          { x: 12, y: 4 },
          { x: 12, y: 16 },
          { x: 0, y: 16 },
        ]],
      },
    }],
  });

  const moves = generateToolpaths(cam).toolpaths[0].moves;
  const firstXYRapid = moves.find((move) => move.type === 'rapid' && Number.isFinite(move.x) && Number.isFinite(move.y));

  assert.deepEqual({ x: firstXYRapid.x, y: firstXYRapid.y }, { x: -2, y: 10 });
});

test('profile along exact segment loops preserves arc moves', () => {
  const camConfig = normalizeCamConfig({
    tools: [{ id: 'tool-profile', type: 'flat-endmill', diameter: 2, feedRate: 400, plungeRate: 120 }],
    operations: [{
      id: 'op-profile',
      name: 'Arc profile',
      type: 'profile',
      toolId: 'tool-profile',
      side: 'along',
      topZ: 0,
      bottomZ: -1,
      stepDown: 1,
      source: {
        loops: [[
          { x: 0, y: 0 },
          { x: 4, y: 0 },
          { x: 0, y: 4 },
        ]],
        segmentLoops: [[
          { type: 'line', start: { x: 0, y: 0 }, end: { x: 4, y: 0 } },
          { type: 'arc', start: { x: 4, y: 0 }, end: { x: 0, y: 4 }, center: { x: 0, y: 0 }, clockwise: false },
          { type: 'line', start: { x: 0, y: 4 }, end: { x: 0, y: 0 } },
        ]],
      },
    }],
  });

  const { toolpaths } = generateToolpaths(camConfig);
  assert.ok(toolpaths[0].moves.some((move) => move.type === 'arc'));
});

test('lead-in parameters add a zig-zag before the selected path start', () => {
  const cam = normalizeCamConfig({
    tools: [{ id: 'tool-a', type: 'endmill', diameter: 2 }],
    operations: [{
      id: 'profile-a',
      type: 'profile',
      toolId: 'tool-a',
      side: 'along',
      source: { loops: [rect] },
      topZ: 0,
      bottomZ: -1,
      stepDown: 1,
      leadInEnabled: true,
      leadInLength: 2,
      leadInZigZagAmplitude: 0.5,
      leadInZigZagCount: 2,
      leadInPosition: 0.5,
    }],
  });
  const { toolpaths } = generateToolpaths(cam);
  const xyFeeds = toolpaths[0].moves.filter((move) => move.type === 'feed' && move.x != null && move.y != null);
  assert.ok(xyFeeds.length > rect.length);
  assert.deepEqual({ x: xyFeeds[1].x, y: xyFeeds[1].y }, { x: 10, y: 5 });
});

test('operation order controls generated toolpath execution order', () => {
  const firstLoop = [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 4 },
    { x: 0, y: 4 },
  ];
  const secondLoop = [
    { x: 10, y: 10 },
    { x: 14, y: 10 },
    { x: 14, y: 14 },
    { x: 10, y: 14 },
  ];
  const cam = normalizeCamConfig({
    tools: [{ id: 'tool-a', type: 'endmill', diameter: 2 }],
    operations: [
      { id: 'profile-first', name: 'First op', type: 'profile', toolId: 'tool-a', source: { loops: [firstLoop] }, topZ: 0, bottomZ: -1, stepDown: 1 },
      { id: 'profile-second', name: 'Second op', type: 'profile', toolId: 'tool-a', source: { loops: [secondLoop] }, topZ: 0, bottomZ: -1, stepDown: 1 },
    ],
  });

  assert.deepEqual(generateToolpaths(cam).toolpaths.map((toolpath) => toolpath.operationId), ['profile-first', 'profile-second']);

  const reorderedCam = normalizeCamConfig({ ...cam, operations: [cam.operations[1], cam.operations[0]] });
  assert.deepEqual(generateToolpaths(reorderedCam).toolpaths.map((toolpath) => toolpath.operationId), ['profile-second', 'profile-first']);
});

test('depth pass helper includes the exact final depth', () => {
  assert.deepEqual(depthPasses(0, -2.5, 1), [-1, -2, -2.5]);
  assert.deepEqual(depthPasses(-2, 0, 1.25), [-0.75, 0]);
});

function longestFeedStep(moves) {
  let best = null;
  for (let index = 1; index < moves.length; index++) {
    const from = moves[index - 1];
    const to = moves[index];
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    if (!best || length > best.length) best = { from, to, length };
  }
  return best;
}

function collectPassEntries(moves) {
  const passes = [];
  let pendingStart = null;
  let armedAfterPlunge = false;

  for (const move of moves) {
    if (move.type === 'rapid' && Number.isFinite(move.x) && Number.isFinite(move.y)) {
      pendingStart = { x: move.x, y: move.y };
      armedAfterPlunge = false;
      continue;
    }
    if (move.type === 'feed' && Number.isFinite(move.z) && pendingStart) {
      armedAfterPlunge = true;
      continue;
    }
    if (armedAfterPlunge && move.type === 'feed' && Number.isFinite(move.x) && Number.isFinite(move.y)) {
      passes.push({ start: pendingStart, end: { x: move.x, y: move.y } });
      pendingStart = null;
      armedAfterPlunge = false;
    }
  }

  return passes;
}

function collectPlungeStarts(moves) {
  const starts = [];
  let pendingRapid = null;
  for (const move of moves) {
    if (move.type === 'rapid' && Number.isFinite(move.x) && Number.isFinite(move.y)) {
      pendingRapid = { x: move.x, y: move.y };
      continue;
    }
    if (move.type === 'feed' && Number.isFinite(move.z) && pendingRapid) {
      starts.push({ ...pendingRapid, z: move.z });
      pendingRapid = null;
    }
  }
  return starts;
}

function collectFeedSegments(moves) {
  const segments = [];
  let previous = null;
  for (const move of moves) {
    if (move.type !== 'feed' || !Number.isFinite(move.x) || !Number.isFinite(move.y)) continue;
    if (previous && Number.isFinite(previous.x) && Number.isFinite(previous.y)) {
      const dx = move.x - previous.x;
      const dy = move.y - previous.y;
      segments.push({
        from: { x: previous.x, y: previous.y },
        to: { x: move.x, y: move.y },
        axis: Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y',
        length: Math.hypot(dx, dy),
      });
    }
    previous = move;
  }
  return segments;
}

function hasRasterSweepPattern(segments, minSweepLength, maxStepOver) {
  for (let index = 0; index + 2 < segments.length; index++) {
    const first = segments[index];
    const connector = segments[index + 1];
    const second = segments[index + 2];
    const firstDx = first.to.x - first.from.x;
    const secondDx = second.to.x - second.from.x;
    if (first.axis !== 'x' || second.axis !== 'x' || connector.axis !== 'y') continue;
    if (first.length <= minSweepLength || second.length <= minSweepLength) continue;
    if (connector.length > maxStepOver) continue;
    if (Math.sign(firstDx) === 0 || Math.sign(secondDx) === 0) continue;
    if (Math.sign(firstDx) !== Math.sign(secondDx)) return true;
  }
  return false;
}
