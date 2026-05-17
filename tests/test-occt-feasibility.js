import './_watchdog.mjs';

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  TopoVertex, TopoEdge, TopoCoEdge, TopoLoop, TopoFace, TopoShell, TopoBody,
  SurfaceType, buildTopoBody, resetTopoIds,
} from '../js/cad/BRepTopology.js';
import { NurbsCurve } from '../js/cad/NurbsCurve.js';
import { NurbsSurface } from '../js/cad/NurbsSurface.js';
import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { resetFeatureIds } from '../js/cad/Feature.js';
import { resetPrimitiveIds } from '../js/cad/Primitive.js';
import { importSTEP } from '../js/cad/StepImport.js';
import { exportSTEPDetailed } from '../js/cad/StepExport.js';
import { tessellateBody } from '../js/cad/Tessellation.js';
import { computeFeatureEdges } from '../js/cad/EdgeAnalysis.js';
import { makeEdgeKey } from '../js/cad/EdgeAnalysis.js';
import { calculateMeshVolume, calculateBoundingBox } from '../js/cad/toolkit/MeshAnalysis.js';
import { resetFlags, setFlag } from '../js/featureFlags.js';
import { StepImportFeature } from '../js/cad/StepImportFeature.js';
import {
  OcctKernelAdapter,
  getOcctKernelStatus,
  invalidateOcctKernelModuleCache,
  loadOcctKernelModule,
} from '../js/cad/occt/index.js';
import {
  disposeOcctSketchModelingShape,
  invalidateOcctSketchModelingSession,
} from '../js/cad/occt/OcctSketchModeling.js';
import { readCbrep, setTopoDeps } from '../packages/ir/reader.js';

setTopoDeps({
  TopoVertex, TopoEdge, TopoCoEdge, TopoLoop, TopoFace, TopoShell, TopoBody,
  NurbsCurve, NurbsSurface, SurfaceType,
});

const LOCAL_DIST_CANDIDATES = [
  process.env.OCCT_KERNEL_DIST,
  process.env.CAD_OCCT_KERNEL_DIST,
  path.resolve('vendor/occt-kernel/dist'),
  path.resolve('vendor/occt-kernel'),
  path.resolve('external/occt-kernel/dist'),
  path.resolve('external/occt-kernel'),
].filter(Boolean);

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (error) {
    console.error(`  FAIL  ${name}\n    ${error?.message || error}`);
    failed++;
  }
}

function resolveDistPath() {
  for (const candidate of LOCAL_DIST_CANDIDATES) {
    if (existsSync(path.join(candidate, 'occt-kernel.js')) &&
        existsSync(path.join(candidate, 'occt-kernel.wasm'))) {
      return candidate;
    }
  }
  return null;
}

function makeExactBox(x, y, z, w, h, d) {
  const c = [
    { x: x, y: y, z: z },
    { x: x + w, y: y, z: z },
    { x: x + w, y: y + h, z: z },
    { x: x, y: y + h, z: z },
    { x: x, y: y, z: z + d },
    { x: x + w, y: y, z: z + d },
    { x: x + w, y: y + h, z: z + d },
    { x: x, y: y + h, z: z + d },
  ];
  return buildTopoBody([
    { surfaceType: SurfaceType.PLANE, vertices: [c[3], c[2], c[1], c[0]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [c[4], c[5], c[6], c[7]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [c[0], c[1], c[5], c[4]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [c[2], c[3], c[7], c[6]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [c[3], c[0], c[4], c[7]], surface: null, edgeCurves: null, shared: null },
    { surfaceType: SurfaceType.PLANE, vertices: [c[1], c[2], c[6], c[5]], surface: null, edgeCurves: null, shared: null },
  ]);
}

function makeXYPlane() {
  return {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
  };
}

function makeRectSketch(x1, y1, x2, y2) {
  const sketch = new Sketch();
  sketch.addSegment(x1, y1, x2, y1);
  sketch.addSegment(x2, y1, x2, y2);
  sketch.addSegment(x2, y2, x1, y2);
  sketch.addSegment(x1, y2, x1, y1);
  return sketch;
}

function makePolylineSketch(points) {
  const sketch = new Sketch();
  for (let index = 1; index < points.length; index++) {
    const start = points[index - 1];
    const end = points[index];
    sketch.addSegment(start.x, start.y, end.x, end.y);
  }
  return sketch;
}

function makeXYPlaneAtZ(z) {
  return {
    origin: { x: 0, y: 0, z },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
  };
}

function makeXZPlane() {
  return {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 1, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 0, z: 1 },
  };
}

function makeExactRevolvedCylinderBody() {
  resetFeatureIds();
  resetTopoIds();
  resetPrimitiveIds();

  const part = new Part('RevolveCylinder');
  part.addSketch(makeRectSketch(5, -5, 10, 5), makeXYPlane());
  const revolveFeature = part.revolve(part.getSketches()[0].id, Math.PI * 2);
  const body = revolveFeature?.result?.geometry?.topoBody;
  assert.ok(body, 'revolved cylinder should produce an exact topoBody');
  return body;
}

function fastRestoreDeps() {
  return {
    readCbrep,
    tessellateBody,
    computeFeatureEdges,
    calculateMeshVolume,
    calculateBoundingBox,
  };
}

function assertFiniteMesh(mesh) {
  assert.ok(mesh.vertices.length > 0, 'expected vertices');
  assert.ok(mesh.faces.length > 0, 'expected triangle faces');
  for (const vertex of mesh.vertices) {
    assert.equal(Number.isFinite(vertex.x), true, 'vertex.x must be finite');
    assert.equal(Number.isFinite(vertex.y), true, 'vertex.y must be finite');
    assert.equal(Number.isFinite(vertex.z), true, 'vertex.z must be finite');
  }
  for (const face of mesh.faces) {
    assert.equal(face.vertices.length, 3, 'OCCT adapter emits triangle faces');
    assert.equal(Number.isFinite(face.normal.x), true, 'normal.x must be finite');
    assert.equal(Number.isFinite(face.normal.y), true, 'normal.y must be finite');
    assert.equal(Number.isFinite(face.normal.z), true, 'normal.z must be finite');
  }
}

function assertOcctBooleanGeometry(geometry, operation) {
  assert.ok(geometry, `${operation} should produce geometry`);
  assert.equal(geometry._tessellator, 'occt', `${operation} should use OCCT tessellation as the primary display mesh`);
  assert.ok(Array.isArray(geometry.faces) && geometry.faces.length > 0, `${operation} should produce faces`);
  assert.ok(Array.isArray(geometry.edges) && geometry.edges.length > 0, `${operation} should preserve OCCT edge segments`);
  assert.ok(Array.isArray(geometry.paths) && geometry.paths.length > 0, `${operation} should build edge paths from OCCT edges`);
  assert.ok(geometry.occtShapeHandle > 0, `${operation} should retain a resident OCCT handle`);
  assert.equal(geometry._occtModeling?.authoritative, true, `${operation} should stay authoritative in OCCT`);
  assert.equal(geometry._occtModeling?.operation, operation, `${operation} seam should report the OCCT operation`);
  assert.equal(geometry._occtModeling?.source, 'resident-boolean', `${operation} seam should come from resident OCCT boolean`);
  const topology = geometry._occtModeling?.topology;
  assert.ok(topology?.faceCount > 0, `${operation} seam should capture OCCT topology`);
  assert.ok(Array.isArray(topology?.faces) && topology.faces.length > 0, `${operation} seam should expose OCCT face metadata`);
  assert.ok(topology.faces.some((face) => typeof face?.stableHash === 'string' && face.stableHash.length > 0), `${operation} seam should expose stable face hashes from OCCT`);
  assert.ok(Array.isArray(topology?.edges) && topology.edges.length > 0, `${operation} seam should expose OCCT edge metadata`);
  assert.ok(Array.isArray(topology?.vertices) && topology.vertices.length > 0, `${operation} seam should expose OCCT vertex metadata`);
  assert.ok(geometry.faces.some((face) => typeof face?.stableHash === 'string' && face.stableHash.length > 0), `${operation} display mesh should carry stable face hashes`);
  assert.ok(geometry.paths.some((path) => typeof path?.stableHash === 'string' && path.stableHash.length > 0), `${operation} feature-edge chains should carry stable edge hashes`);
  assert.equal(geometry.topoBody ?? null, null, `${operation} seam should no longer require a JS topoBody compatibility shadow`);
}

function assertOcctStructuredSketchGeometry(geometry, operation) {
  assert.ok(geometry, `${operation} should produce geometry`);
  assert.equal(geometry._tessellator, 'occt', `${operation} should tessellate through OCCT`);
  assert.equal(geometry._occtModeling?.authoritative, true, `${operation} should mark OCCT authority`);
  assert.equal(geometry._occtModeling?.operation, operation, `${operation} seam should report the operation name`);
  assert.ok(geometry.occtShapeHandle > 0, `${operation} should retain an OCCT handle`);
  assert.ok(Array.isArray(geometry.faces) && geometry.faces.length > 0, `${operation} should produce display faces`);
  assert.ok(Array.isArray(geometry.edges) && geometry.edges.length > 0, `${operation} should preserve edge segments`);
  assert.ok(Array.isArray(geometry.paths) && geometry.paths.length > 0, `${operation} should preserve feature-edge paths`);
  assert.ok(geometry._occtModeling?.topology?.faceCount > 0, `${operation} should surface OCCT topology`);
}

console.log('OCCT WASM feasibility smoke\n');

const distPath = resolveDistPath();
if (!distPath) {
  console.log('  skip  OCCT_KERNEL_DIST is unset and no ignored local OCCT dist was found');
  process.exit(0);
}

let loaded = null;
let adapter = null;
let boxHandle = 0;
let exportedStep = '';

await check('loads local Emscripten module', async () => {
  loaded = await loadOcctKernelModule({ distPath, fresh: true });
  const status = getOcctKernelStatus(loaded.module);
  console.log('    ', JSON.stringify({
    memoryBytes: status.memoryBytes,
    methodNames: status.methodNames,
  }));
  assert.equal(status.available, true, 'OcctKernel class should be exported');
  assert.equal(status.hasCcall, true, 'ccall should be available');
  assert.ok(status.methodNames.includes('createBox'), 'createBox should be exposed');
  assert.ok(status.methodNames.includes('tessellate'), 'tessellate should be exposed');
});

await check('constructs adapter and box handle', async () => {
  adapter = await OcctKernelAdapter.create({ distPath, fresh: true });
  boxHandle = adapter.createBox(10, 20, 30);
  assert.ok(boxHandle > 0, 'createBox should return a positive handle');
  const topology = adapter.getTopology(boxHandle);
  assert.equal(topology.faceCount, 6, 'box should have 6 faces');
  assert.equal(topology.edgeCount, 12, 'box should have 12 edges');
  assert.equal(topology.vertexCount, 8, 'box should have 8 vertices');
  assert.equal(adapter.checkValidity(boxHandle), true, 'box should be valid');
});

await check('surfaces OCCT revision and checkpoint APIs through the adapter', async () => {
  const capabilities = adapter.getCapabilities();
  assert.equal(capabilities.historyV1, true, 'historyV1 capability should be advertised');
  assert.equal(capabilities.revisionInfoV1, true, 'revisionInfoV1 capability should be advertised');
  assert.equal(capabilities.entityResolutionV1, true, 'entityResolutionV1 capability should be advertised');
  assert.equal(capabilities.entityRemapV1, true, 'entityRemapV1 capability should be advertised');
  assert.equal(capabilities.checkpointV1, true, 'checkpointV1 capability should be advertised');

  const topology = adapter.getTopology(boxHandle);
  const stableHash = topology.faces?.[0]?.stableHash;
  assert.ok(typeof stableHash === 'string' && stableHash.length > 0, 'box topology should expose a stable face hash');

  const revisionInfo = adapter.getRevisionInfo(boxHandle);
  assert.equal(revisionInfo.revisionId, topology.revisionId, 'revision info should match the topology revision id');
  assert.equal(revisionInfo.topologyHash, topology.topologyHash, 'revision info should report the same topology hash');

  const resolved = adapter.resolveStableEntity(boxHandle, stableHash);
  assert.equal(resolved?.found, true, 'resolveStableEntity should find the queried face');
  assert.equal(resolved?.stableHash, stableHash, 'resolveStableEntity should return the same stable hash');

  const mapped = adapter.mapEntitiesAcrossRevisions(topology.revisionId, topology.revisionId, [stableHash]);
  assert.ok(Array.isArray(mapped?.mappings) && mapped.mappings.length === 1, 'mapEntitiesAcrossRevisions should return one mapping');
  assert.equal(mapped.mappings[0]?.mappedStableHash, stableHash, 'identity remap should preserve the stable hash');

  const checkpoint = adapter.createCheckpoint(boxHandle);
  assert.equal(checkpoint?.checkpointSchemaVersion, 1, 'checkpoint should advertise schema version 1');
  assert.ok(typeof checkpoint?.brep === 'string' && checkpoint.brep.length > 0, 'checkpoint should contain serialized exact geometry');

  const revivedHandle = adapter.hydrateCheckpoint(checkpoint);
  assert.ok(revivedHandle > 0, 'hydrateCheckpoint should restore a positive OCCT handle');
  try {
    const revivedTopology = adapter.getTopology(revivedHandle);
    assert.equal(revivedTopology.revisionId, topology.revisionId, 'checkpoint restore should preserve revision id');
    assert.equal(revivedTopology.faces?.[0]?.stableHash, stableHash, 'checkpoint restore should preserve stable face hashes');
    adapter.retainRevision(revivedHandle);
    assert.equal(adapter.releaseRevision(revivedHandle), false, 'first release should keep a retained revision alive');
    assert.equal(adapter.releaseRevision(revivedHandle), true, 'second release should drop the final revision reference');
  } finally {
    adapter.disposeShape(revivedHandle);
  }
});

await check('normalizes OCCT tessellation into modeller mesh shape', async () => {
  const mesh = adapter.tessellate(boxHandle, { linearDeflection: 0.1, angularDeflection: 0.5 });
  console.log('    ', JSON.stringify({
    vertices: mesh.vertices.length,
    faces: mesh.faces.length,
    edges: mesh.edges.length,
    occt: mesh._occt,
  }));
  assertFiniteMesh(mesh);
  assert.equal(mesh._tessellator, 'occt');
  assert.equal(mesh.faces.length, 12, 'box should tessellate to 12 triangles');
});

await check('exports and reimports STEP through OCCT', async () => {
  exportedStep = adapter.exportStep(boxHandle);
  assert.ok(exportedStep.startsWith('ISO-10303-21;'), 'STEP export should have ISO header');
  const importedHandle = adapter.importStep(exportedStep);
  try {
    assert.ok(importedHandle > 0, 'importStep should return a positive handle');
    const importedTopology = adapter.getTopology(importedHandle);
    assert.equal(importedTopology.faceCount, 6, 'imported box should preserve face count');
    assert.equal(adapter.checkValidity(importedHandle), true, 'imported box should be valid');
  } finally {
    adapter.disposeShape(importedHandle);
  }
});

await check('revolves profile through adapter using radians contract', async () => {
  const profile = {
    segments: [
      { type: 'line', start: [5, -5], end: [10, -5] },
      { type: 'line', start: [10, -5], end: [10, 5] },
      { type: 'line', start: [10, 5], end: [5, 5] },
      { type: 'line', start: [5, 5], end: [5, -5] },
    ],
  };
  const handle = adapter.revolveProfile(profile, Math.PI * 2);
  try {
    assert.ok(handle > 0, 'revolveProfile should return a positive handle');
    const topology = adapter.getTopology(handle);
    assert.equal(topology.faceCount, 4, 'full revolve should produce the expected cylindrical topology');
    assert.ok(topology.boundingBox.xMin < -9.9, 'revolved solid should reach the opposite side of the axis');
    assert.ok(topology.boundingBox.zMin < -9.9, 'revolved solid should span around the axis in Z');
    assert.equal(adapter.checkValidity(handle), true, 'revolved solid should be valid');
  } finally {
    adapter.disposeShape(handle);
  }
});

await check('imports modeller STEP export as a valid exact box', async () => {
  const step = exportSTEPDetailed(makeExactBox(0, 0, 0, 10, 20, 30), { filename: 'exact-box.step' });
  const imported = adapter.importStepDetailed(step.stepString, {
    heal: true,
    sew: true,
    fixSameParameter: true,
    fixSolid: true,
  });
  assert.equal(imported.transferStatus, 'DONE', 'modeller STEP should transfer into OCCT');
  assert.ok(imported.shapeHandle > 0, 'modeller STEP should yield a shape handle');
  try {
    assert.equal(imported.isValid, true, 'modeller STEP import should now validate in OCCT');
    const topology = adapter.getTopology(imported.shapeHandle);
    assert.equal(topology.faceCount, 6, 'imported exact box should preserve face count');
    assert.equal(adapter.checkValidity(imported.shapeHandle), true, 'imported exact box should be valid');
  } finally {
    adapter.disposeShape(imported.shapeHandle);
  }
});

await check('imports revolved cylindrical STEP export without illegal edge geometry', async () => {
  const step = exportSTEPDetailed(makeExactRevolvedCylinderBody(), { filename: 'revolve-cylinder.step' });
  const imported = adapter.importStepDetailed(step.stepString, {
    heal: true,
    sew: true,
    fixSameParameter: true,
    fixSolid: true,
  });
  assert.equal(imported.transferStatus, 'DONE', 'revolved STEP should transfer into OCCT');
  assert.ok(imported.shapeHandle > 0, 'revolved STEP should yield a shape handle');
  try {
    assert.equal(imported.isValid, true, 'revolved STEP import should validate in OCCT');
    assert.equal(
      imported.messageList?.some((message) =>
        message.phase === 'load' && /illegal type|edge_geometry|Complex Type incorrect/i.test(message.text)
      ),
      false,
      'revolved STEP export should not emit illegal edge geometry load diagnostics',
    );
  } finally {
    adapter.disposeShape(imported.shapeHandle);
  }
});

await check('performs primitive boolean and dispose loop', async () => {
  const first = adapter.createBox(10, 10, 10);
  const second = adapter.createSphere(4);
  const union = adapter.booleanUnion(first, second);
  try {
    assert.ok(union > 0, 'booleanUnion should return a shape handle');
    assert.equal(adapter.checkValidity(union), true, 'union should be valid');
    const topology = adapter.getTopology(union);
    assert.ok(topology.faceCount >= 6, 'union should have topology');
  } finally {
    adapter.disposeShape(union);
    adapter.disposeShape(second);
    adapter.disposeShape(first);
  }

  for (let index = 0; index < 20; index++) {
    const handle = adapter.createCylinder(2 + index * 0.01, 5);
    assert.equal(adapter.checkValidity(handle), true, 'created cylinder should be valid');
    adapter.disposeShape(handle);
  }
});

await check('builds supported sketch extrude through OCCT modeling seam', async () => {
  const previousOcctDist = process.env.OCCT_KERNEL_DIST;
  process.env.OCCT_KERNEL_DIST = distPath;
  setFlag('CAD_USE_OCCT_SKETCH_SOLIDS', true);
  invalidateOcctKernelModuleCache();
  invalidateOcctSketchModelingSession();
  await loadOcctKernelModule({ fresh: true });

  const part = new Part('OcctSketchExtrude');
  const sketchFeature = part.addSketch(makeRectSketch(-5, -5, 5, 5), makeXYPlane());
  const extrudeFeature = part.extrude(sketchFeature.id, 10, { operation: 'new' });
  const geometry = extrudeFeature.result?.geometry;

  try {
    assert.ok(geometry, 'extrude should produce geometry');
    assert.equal(geometry._tessellator, 'occt', 'supported extrude should tessellate through OCCT');
    assert.equal(geometry._occtModeling?.authoritative, true, 'supported extrude should mark OCCT authority');
    assert.ok(geometry.occtShapeHandle > 0, 'supported extrude should retain an OCCT handle');
    assert.ok(geometry.topoBody, 'supported extrude should preserve topoBody compatibility shadow');
  } finally {
    disposeOcctSketchModelingShape(geometry?.occtShapeHandle || 0);
    resetFlags();
    invalidateOcctSketchModelingSession();
    invalidateOcctKernelModuleCache();
    if (previousOcctDist == null) delete process.env.OCCT_KERNEL_DIST;
    else process.env.OCCT_KERNEL_DIST = previousOcctDist;
  }
});

await check('builds supported sketch revolve through OCCT modeling seam', async () => {
  const previousOcctDist = process.env.OCCT_KERNEL_DIST;
  process.env.OCCT_KERNEL_DIST = distPath;
  setFlag('CAD_USE_OCCT_SKETCH_SOLIDS', true);
  invalidateOcctKernelModuleCache();
  invalidateOcctSketchModelingSession();
  await loadOcctKernelModule({ fresh: true });

  const part = new Part('OcctSketchRevolve');
  const sketchFeature = part.addSketch(makeRectSketch(5, -5, 10, 5), makeXYPlane());
  const revolveFeature = part.revolve(sketchFeature.id, Math.PI * 2, { operation: 'new' });
  const geometry = revolveFeature.result?.geometry;

  try {
    assert.ok(geometry, 'revolve should produce geometry');
    assert.equal(geometry._tessellator, 'occt', 'supported revolve should tessellate through OCCT');
    assert.equal(geometry._occtModeling?.authoritative, true, 'supported revolve should mark OCCT authority');
    assert.ok(geometry.occtShapeHandle > 0, 'supported revolve should retain an OCCT handle');
    assert.ok(geometry.topoBody, 'supported revolve should preserve topoBody compatibility shadow');
  } finally {
    disposeOcctSketchModelingShape(geometry?.occtShapeHandle || 0);
    resetFlags();
    invalidateOcctSketchModelingSession();
    invalidateOcctKernelModuleCache();
    if (previousOcctDist == null) delete process.env.OCCT_KERNEL_DIST;
    else process.env.OCCT_KERNEL_DIST = previousOcctDist;
  }
});

await check('builds supported sketch sweep through OCCT modeling seam', async () => {
  const previousOcctDist = process.env.OCCT_KERNEL_DIST;
  process.env.OCCT_KERNEL_DIST = distPath;
  setFlag('CAD_USE_OCCT_SKETCH_SOLIDS', true);
  invalidateOcctKernelModuleCache();
  invalidateOcctSketchModelingSession();
  await loadOcctKernelModule({ fresh: true });

  const part = new Part('OcctSketchSweep');
  const baseSketch = part.addSketch(makeRectSketch(-6, -6, 6, 6), makeXYPlane());
  const baseExtrude = part.extrude(baseSketch.id, 8, { operation: 'new' });
  const profileSketch = part.addSketch(makeRectSketch(-2, -2, 2, 2), makeXYPlane());
  const pathSketch = part.addSketch(makePolylineSketch([
    { x: 0, y: 0 },
    { x: 0, y: 20 },
  ]), makeXZPlane());
  const sweepFeature = part.sweep(profileSketch.id, pathSketch.id, { operation: 'add' });
  const geometry = sweepFeature.result?.geometry;

  try {
    assert.ok(baseExtrude.result?.geometry?.occtShapeHandle > 0, 'base body should carry an OCCT handle');
    assertOcctStructuredSketchGeometry(geometry, 'sweep');
  } finally {
    disposeOcctSketchModelingShape(geometry?.occtShapeHandle || 0);
    resetFlags();
    invalidateOcctSketchModelingSession();
    invalidateOcctKernelModuleCache();
    if (previousOcctDist == null) delete process.env.OCCT_KERNEL_DIST;
    else process.env.OCCT_KERNEL_DIST = previousOcctDist;
  }
});

await check('builds supported sketch loft through OCCT modeling seam', async () => {
  const previousOcctDist = process.env.OCCT_KERNEL_DIST;
  process.env.OCCT_KERNEL_DIST = distPath;
  setFlag('CAD_USE_OCCT_SKETCH_SOLIDS', true);
  invalidateOcctKernelModuleCache();
  invalidateOcctSketchModelingSession();
  await loadOcctKernelModule({ fresh: true });

  const part = new Part('OcctSketchLoft');
  const baseSketch = part.addSketch(makeRectSketch(-6, -6, 6, 6), makeXYPlane());
  const baseExtrude = part.extrude(baseSketch.id, 8, { operation: 'new' });
  const firstSection = part.addSketch(makeRectSketch(-4, -4, 4, 4), makeXYPlaneAtZ(8));
  const secondSection = part.addSketch(makeRectSketch(-2, -2, 2, 2), makeXYPlaneAtZ(20));
  const loftFeature = part.loft([firstSection.id, secondSection.id], { operation: 'add' });
  const geometry = loftFeature.result?.geometry;

  try {
    assert.ok(baseExtrude.result?.geometry?.occtShapeHandle > 0, 'base body should carry an OCCT handle');
    assertOcctStructuredSketchGeometry(geometry, 'loft');
  } finally {
    disposeOcctSketchModelingShape(geometry?.occtShapeHandle || 0);
    resetFlags();
    invalidateOcctSketchModelingSession();
    invalidateOcctKernelModuleCache();
    if (previousOcctDist == null) delete process.env.OCCT_KERNEL_DIST;
    else process.env.OCCT_KERNEL_DIST = previousOcctDist;
  }
});

await check('keeps OCCT authority across supported fillet seam', async () => {
  const previousOcctDist = process.env.OCCT_KERNEL_DIST;
  process.env.OCCT_KERNEL_DIST = distPath;
  setFlag('CAD_USE_OCCT_SKETCH_SOLIDS', true);
  invalidateOcctKernelModuleCache();
  invalidateOcctSketchModelingSession();
  await loadOcctKernelModule({ fresh: true });

  const part = new Part('OcctSketchFillet');
  const sketchFeature = part.addSketch(makeRectSketch(0, 0, 10, 10), makeXYPlane());
  const extrudeFeature = part.extrude(sketchFeature.id, 10, { operation: 'new' });
  const baseGeometry = extrudeFeature.result?.geometry;
  const edgeKey = baseGeometry?.edges?.[0]
    ? makeEdgeKey(baseGeometry.edges[0].start, baseGeometry.edges[0].end)
    : null;
  assert.ok(edgeKey, 'base OCCT extrude should expose a selectable edge');
  const filletFeature = part.fillet([edgeKey], 0.5);
  const geometry = filletFeature.result?.geometry;

  try {
    assert.ok(extrudeFeature.result?.geometry?.occtShapeHandle > 0, 'base body should carry an OCCT handle');
    assert.ok(geometry, 'fillet should produce geometry');
    assert.equal(geometry._tessellator, 'occt', 'fillet should tessellate through OCCT');
    assert.equal(geometry._occtModeling?.authoritative, true, 'fillet should mark OCCT authority');
    assert.ok(geometry.occtShapeHandle > 0, 'fillet should retain an OCCT handle');
    assert.ok(Array.isArray(geometry.paths) && geometry.paths.length > 0, 'fillet should keep OCCT feature-edge chains');
  } finally {
    disposeOcctSketchModelingShape(geometry?.occtShapeHandle || 0);
    resetFlags();
    invalidateOcctSketchModelingSession();
    invalidateOcctKernelModuleCache();
    if (previousOcctDist == null) delete process.env.OCCT_KERNEL_DIST;
    else process.env.OCCT_KERNEL_DIST = previousOcctDist;
  }
});

await check('keeps OCCT authority across supported chamfer seam', async () => {
  const previousOcctDist = process.env.OCCT_KERNEL_DIST;
  process.env.OCCT_KERNEL_DIST = distPath;
  setFlag('CAD_USE_OCCT_SKETCH_SOLIDS', true);
  invalidateOcctKernelModuleCache();
  invalidateOcctSketchModelingSession();
  await loadOcctKernelModule({ fresh: true });

  const part = new Part('OcctSketchChamfer');
  const sketchFeature = part.addSketch(makeRectSketch(0, 0, 10, 10), makeXYPlane());
  const extrudeFeature = part.extrude(sketchFeature.id, 10, { operation: 'new' });
  const baseGeometry = extrudeFeature.result?.geometry;
  const edgeKey = baseGeometry?.edges?.[0]
    ? makeEdgeKey(baseGeometry.edges[0].start, baseGeometry.edges[0].end)
    : null;
  assert.ok(edgeKey, 'base OCCT extrude should expose a selectable edge');
  const chamferFeature = part.chamfer([edgeKey], 0.5);
  const geometry = chamferFeature.result?.geometry;

  try {
    assert.ok(extrudeFeature.result?.geometry?.occtShapeHandle > 0, 'base body should carry an OCCT handle');
    assert.ok(geometry, 'chamfer should produce geometry');
    assert.equal(geometry._tessellator, 'occt', 'chamfer should tessellate through OCCT');
    assert.equal(geometry._occtModeling?.authoritative, true, 'chamfer should mark OCCT authority');
    assert.ok(geometry.occtShapeHandle > 0, 'chamfer should retain an OCCT handle');
    assert.ok(Array.isArray(geometry.paths) && geometry.paths.length > 0, 'chamfer should keep OCCT feature-edge chains');
  } finally {
    disposeOcctSketchModelingShape(geometry?.occtShapeHandle || 0);
    resetFlags();
    invalidateOcctSketchModelingSession();
    invalidateOcctKernelModuleCache();
    if (previousOcctDist == null) delete process.env.OCCT_KERNEL_DIST;
    else process.env.OCCT_KERNEL_DIST = previousOcctDist;
  }
});

await check('keeps OCCT authority across supported union boolean seam', async () => {
  const previousOcctDist = process.env.OCCT_KERNEL_DIST;
  process.env.OCCT_KERNEL_DIST = distPath;
  setFlag('CAD_USE_OCCT_SKETCH_SOLIDS', true);
  invalidateOcctKernelModuleCache();
  invalidateOcctSketchModelingSession();
  await loadOcctKernelModule({ fresh: true });

  const part = new Part('OcctSketchUnion');
  const firstSketch = part.addSketch(makeRectSketch(0, 0, 10, 10), makeXYPlane());
  const firstExtrude = part.extrude(firstSketch.id, 10, { operation: 'new' });
  const secondSketch = part.addSketch(makeRectSketch(5, 0, 15, 10), makeXYPlane());
  const secondExtrude = part.extrude(secondSketch.id, 10, { operation: 'add' });
  const geometry = secondExtrude.result?.geometry;

  try {
    assert.ok(firstExtrude.result?.geometry?.occtShapeHandle > 0, 'first body should carry an OCCT handle');
    assertOcctBooleanGeometry(geometry, 'union');
  } finally {
    disposeOcctSketchModelingShape(geometry?.occtShapeHandle || 0);
    resetFlags();
    invalidateOcctSketchModelingSession();
    invalidateOcctKernelModuleCache();
    if (previousOcctDist == null) delete process.env.OCCT_KERNEL_DIST;
    else process.env.OCCT_KERNEL_DIST = previousOcctDist;
  }
});

await check('keeps OCCT authority across supported subtract boolean seam', async () => {
  const previousOcctDist = process.env.OCCT_KERNEL_DIST;
  process.env.OCCT_KERNEL_DIST = distPath;
  setFlag('CAD_USE_OCCT_SKETCH_SOLIDS', true);
  invalidateOcctKernelModuleCache();
  invalidateOcctSketchModelingSession();
  await loadOcctKernelModule({ fresh: true });

  const part = new Part('OcctSketchSubtract');
  const firstSketch = part.addSketch(makeRectSketch(0, 0, 15, 15), makeXYPlane());
  const firstExtrude = part.extrude(firstSketch.id, 10, { operation: 'new' });
  const cutSketch = part.addSketch(makeRectSketch(5, 0, 10, 15), makeXYPlane());
  const cutExtrude = part.extrude(cutSketch.id, 10, { operation: 'subtract' });
  const geometry = cutExtrude.result?.geometry;

  try {
    assert.ok(firstExtrude.result?.geometry?.occtShapeHandle > 0, 'base body should carry an OCCT handle');
    assertOcctBooleanGeometry(geometry, 'subtract');
  } finally {
    disposeOcctSketchModelingShape(geometry?.occtShapeHandle || 0);
    resetFlags();
    invalidateOcctSketchModelingSession();
    invalidateOcctKernelModuleCache();
    if (previousOcctDist == null) delete process.env.OCCT_KERNEL_DIST;
    else process.env.OCCT_KERNEL_DIST = previousOcctDist;
  }
});

await check('keeps OCCT authority across supported intersect boolean seam', async () => {
  const previousOcctDist = process.env.OCCT_KERNEL_DIST;
  process.env.OCCT_KERNEL_DIST = distPath;
  setFlag('CAD_USE_OCCT_SKETCH_SOLIDS', true);
  invalidateOcctKernelModuleCache();
  invalidateOcctSketchModelingSession();
  await loadOcctKernelModule({ fresh: true });

  const part = new Part('OcctSketchIntersect');
  const firstSketch = part.addSketch(makeRectSketch(0, 0, 10, 10), makeXYPlane());
  const firstExtrude = part.extrude(firstSketch.id, 10, { operation: 'new' });
  const secondSketch = part.addSketch(makeRectSketch(5, 0, 15, 10), makeXYPlane());
  const secondExtrude = part.extrude(secondSketch.id, 10, { operation: 'intersect' });
  const geometry = secondExtrude.result?.geometry;

  try {
    assert.ok(firstExtrude.result?.geometry?.occtShapeHandle > 0, 'base body should carry an OCCT handle');
    assertOcctBooleanGeometry(geometry, 'intersect');
  } finally {
    disposeOcctSketchModelingShape(geometry?.occtShapeHandle || 0);
    resetFlags();
    invalidateOcctSketchModelingSession();
    invalidateOcctKernelModuleCache();
    if (previousOcctDist == null) delete process.env.OCCT_KERNEL_DIST;
    else process.env.OCCT_KERNEL_DIST = previousOcctDist;
  }
});

await check('serializes and fast-restores OCCT resident boolean checkpoints', async () => {
  const previousOcctDist = process.env.OCCT_KERNEL_DIST;
  process.env.OCCT_KERNEL_DIST = distPath;
  setFlag('CAD_USE_OCCT_SKETCH_SOLIDS', true);
  invalidateOcctKernelModuleCache();
  invalidateOcctSketchModelingSession();
  await loadOcctKernelModule({ fresh: true });

  const part = new Part('OcctCheckpointRestore');
  const firstSketch = part.addSketch(makeRectSketch(0, 0, 10, 10), makeXYPlane());
  part.extrude(firstSketch.id, 10, { operation: 'new' });
  const secondSketch = part.addSketch(makeRectSketch(5, 0, 15, 10), makeXYPlane());
  const secondExtrude = part.extrude(secondSketch.id, 10, { operation: 'add' });
  const geometry = secondExtrude.result?.geometry;
  const serialized = part.serialize();
  const checkpoint = serialized.featureTree?.checkpoints?.[secondExtrude.id];

  try {
    assertOcctBooleanGeometry(geometry, 'union');
    assert.ok(checkpoint?.occt, 'serialized boolean result should include an OCCT checkpoint');
    assert.equal(typeof checkpoint?.occt?.brep, 'string', 'serialized OCCT checkpoint should include a BREP payload');
    assert.equal(checkpoint?.payload ?? null, null, 'resident OCCT boolean should not require a CBREP fallback payload');

    const restoredPart = Part.deserialize(serialized, { fastRestoreDeps: fastRestoreDeps() });
    const restoredResult = restoredPart.featureTree?.results?.[secondExtrude.id];
    const restoredGeometry = restoredResult?.geometry;

    assert.equal(restoredResult?._restoredFromCheckpoint, true, 'deserialize should fast-restore the OCCT boolean from checkpoint');
    assert.ok(restoredGeometry?.occtShapeHandle > 0, 'restored OCCT boolean should retain a resident handle');
    assert.equal(restoredGeometry?._tessellator, 'occt', 'restored OCCT boolean should keep OCCT tessellation');
    assert.equal(restoredGeometry?.topoBody ?? null, null, 'restored OCCT boolean should not materialize a JS topoBody shadow');
    assert.equal(restoredGeometry?._occtModeling?.source, 'checkpoint-restore', 'restored OCCT boolean should report checkpoint restore provenance');
    assert.equal(restoredGeometry?._occtModeling?.topology?.revisionId, checkpoint.occt.revision?.revisionId, 'restored OCCT boolean should preserve revision identity');
    assert.ok(Array.isArray(restoredGeometry?.paths) && restoredGeometry.paths.length > 0, 'restored OCCT boolean should keep feature-edge chains');
  } finally {
    disposeOcctSketchModelingShape(geometry?.occtShapeHandle || 0);
    resetFlags();
    invalidateOcctSketchModelingSession();
    invalidateOcctKernelModuleCache();
    if (previousOcctDist == null) delete process.env.OCCT_KERNEL_DIST;
    else process.env.OCCT_KERNEL_DIST = previousOcctDist;
  }
});

await check('rollback rehydrates active OCCT boolean results from resident checkpoints', async () => {
  const previousOcctDist = process.env.OCCT_KERNEL_DIST;
  process.env.OCCT_KERNEL_DIST = distPath;
  setFlag('CAD_USE_OCCT_SKETCH_SOLIDS', true);
  invalidateOcctKernelModuleCache();
  invalidateOcctSketchModelingSession();
  await loadOcctKernelModule({ fresh: true });

  const part = new Part('OcctCheckpointRollback');
  const baseSketch = part.addSketch(makeRectSketch(0, 0, 10, 10), makeXYPlane());
  part.extrude(baseSketch.id, 10, { operation: 'new' });
  const unionSketch = part.addSketch(makeRectSketch(5, 0, 15, 10), makeXYPlane());
  const unionExtrude = part.extrude(unionSketch.id, 10, { operation: 'add' });
  const trailingSketch = part.addSketch(makeRectSketch(12, 0, 18, 6), makeXYPlane());
  part.extrude(trailingSketch.id, 8, { operation: 'add' });

  const tree = part.featureTree;
  const initialRevisionId = unionExtrude.result?.geometry?._occtModeling?.topology?.revisionId;

  try {
    assert.ok(unionExtrude.result?.occtCheckpoint, 'union result should capture an OCCT checkpoint during stamping');

    const firstRollback = tree.applyRollbackSuppression(5, fastRestoreDeps());
    const firstResult = tree.results[unionExtrude.id];
    assert.equal(firstRollback.replayed, false, 'rollback should reuse checkpointed OCCT results without replay');
    assert.ok(firstRollback.restored >= 2, 'rollback should restore active solid checkpoints');
    assert.equal(firstResult?._restoredFromCheckpoint, true, 'active OCCT boolean should be restored from checkpoint during rollback');
    assert.equal(firstResult?.geometry?._occtModeling?.source, 'checkpoint-restore', 'rollback should hydrate the OCCT checkpoint restore path');
    assert.equal(firstResult?.geometry?._occtModeling?.topology?.revisionId, initialRevisionId, 'rollback should preserve the OCCT revision identity');

    const rollForward = tree.applyRollbackSuppression(6, fastRestoreDeps());
    assert.equal(rollForward.replayed, false, 'roll-forward should reuse cached OCCT results');

    const secondRollback = tree.applyRollbackSuppression(5, fastRestoreDeps());
    const secondResult = tree.results[unionExtrude.id];
    assert.equal(secondRollback.replayed, false, 'second rollback should still avoid full replay');
    assert.ok(secondRollback.restored >= 2, 'second rollback should restore checkpoints again');
    assert.equal(secondResult?._restoredFromCheckpoint, true, 'second rollback should restore the OCCT boolean from checkpoint again');
    assert.equal(secondResult?.geometry?._occtModeling?.topology?.revisionId, initialRevisionId, 'repeated rollback should keep the same OCCT revision id');
  } finally {
    resetFlags();
    invalidateOcctSketchModelingSession();
    invalidateOcctKernelModuleCache();
    if (previousOcctDist == null) delete process.env.OCCT_KERNEL_DIST;
    else process.env.OCCT_KERNEL_DIST = previousOcctDist;
  }
});

await check('exports resident OCCT boolean result through STEP seam', async () => {
  const previousOcctDist = process.env.OCCT_KERNEL_DIST;
  process.env.OCCT_KERNEL_DIST = distPath;
  setFlag('CAD_USE_OCCT_SKETCH_SOLIDS', true);
  invalidateOcctKernelModuleCache();
  invalidateOcctSketchModelingSession();
  await loadOcctKernelModule({ fresh: true });

  const part = new Part('OcctStepExport');
  const firstSketch = part.addSketch(makeRectSketch(0, 0, 10, 10), makeXYPlane());
  part.extrude(firstSketch.id, 10, { operation: 'new' });
  const secondSketch = part.addSketch(makeRectSketch(5, 0, 15, 10), makeXYPlane());
  const secondExtrude = part.extrude(secondSketch.id, 10, { operation: 'add' });
  const result = secondExtrude.result;

  try {
    assert.ok(result?.geometry?.occtShapeHandle > 0, 'resident OCCT boolean result should keep an OCCT handle');
    const exported = exportSTEPDetailed(result, { filename: 'occt-resident-boolean' });
    assert.ok(exported.stepString.startsWith('ISO-10303-21;'), 'resident OCCT export should produce STEP content');
    assert.equal(exported.timings.exporter, 'occt', 'resident OCCT export should prefer the OCCT export path');

    const imported = adapter.importStepDetailed(exported.stepString, {
      heal: true,
      sew: true,
      fixSameParameter: true,
      fixSolid: true,
    });
    assert.equal(imported.transferStatus, 'DONE', 'resident OCCT STEP should transfer back into OCCT');
    assert.ok(imported.shapeHandle > 0, 'resident OCCT STEP should yield a shape handle');
    try {
      assert.equal(imported.isValid, true, 'resident OCCT STEP export should validate on re-import');
    } finally {
      adapter.disposeShape(imported.shapeHandle);
    }
  } finally {
    disposeOcctSketchModelingShape(result?.geometry?.occtShapeHandle || 0);
    resetFlags();
    invalidateOcctSketchModelingSession();
    invalidateOcctKernelModuleCache();
    if (previousOcctDist == null) delete process.env.OCCT_KERNEL_DIST;
    else process.env.OCCT_KERNEL_DIST = previousOcctDist;
  }
});

await check('keeps STEP import feature resident in OCCT for downstream export', async () => {
  const previousOcctDist = process.env.OCCT_KERNEL_DIST;
  process.env.OCCT_KERNEL_DIST = distPath;
  setFlag('CAD_USE_OCCT_SKETCH_SOLIDS', true);
  invalidateOcctKernelModuleCache();
  invalidateOcctSketchModelingSession();
  await loadOcctKernelModule({ fresh: true });

  const sourceStep = exportSTEPDetailed(makeExactBox(0, 0, 0, 10, 20, 30), {
    filename: 'step-import-residency-source',
  });
  const feature = new StepImportFeature('OcctStepImportResidency', sourceStep.stepString);
  const result = feature.execute({ results: {}, tree: { getFeatureIndex: () => 0, features: [] } });

  try {
    assert.ok(result.geometry.occtShapeHandle > 0, 'STEP import result should attach a resident OCCT handle');
    assert.equal(result.geometry.occtShapeResident, true, 'STEP import result should mark resident OCCT ownership');
    assert.equal(result.geometry._tessellator, 'occt', 'STEP import result should now use OCCT tessellation for display');
    assert.equal(result.geometry._occtModeling?.authoritative, true, 'STEP import result should mark OCCT as authoritative for display geometry');
    assert.equal(result.geometry._occtModeling?.source, 'step-import', 'STEP import result should record its OCCT residency source');
    assert.equal(result.timings.occtResidency?.transferStatus, 'DONE', 'STEP import OCCT residency should report a successful transfer');
    assert.equal(result.timings.import?.tessellator, 'occt', 'STEP import timing metadata should record the OCCT tessellator');

    const exported = exportSTEPDetailed(result, { filename: 'step-import-resident-export' });
    assert.equal(exported.timings.exporter, 'occt', 'resident STEP import export should prefer the OCCT exporter');

    const imported = adapter.importStepDetailed(exported.stepString, {
      heal: true,
      sew: true,
      fixSameParameter: true,
      fixSolid: true,
    });
    assert.equal(imported.transferStatus, 'DONE', 'resident STEP-import export should transfer back into OCCT');
    assert.equal(imported.isValid, true, 'resident STEP-import export should validate on re-import');
    if (imported.shapeHandle > 0) adapter.disposeShape(imported.shapeHandle);
  } finally {
    disposeOcctSketchModelingShape(result.geometry.occtShapeHandle || 0);
    resetFlags();
    invalidateOcctSketchModelingSession();
    invalidateOcctKernelModuleCache();
    if (previousOcctDist == null) delete process.env.OCCT_KERNEL_DIST;
    else process.env.OCCT_KERNEL_DIST = previousOcctDist;
  }
});

await check('uses OCCT tessellation for direct importSTEP when OCCT path is enabled', async () => {
  const previousOcctDist = process.env.OCCT_KERNEL_DIST;
  process.env.OCCT_KERNEL_DIST = distPath;
  setFlag('CAD_USE_OCCT_SKETCH_SOLIDS', true);
  invalidateOcctKernelModuleCache();
  invalidateOcctSketchModelingSession();
  await loadOcctKernelModule({ fresh: true });

  try {
    const sourceStep = exportSTEPDetailed(makeExactBox(0, 0, 0, 10, 20, 30), {
      filename: 'direct-import-occt-source',
    });
    const result = importSTEP(sourceStep.stepString, { edgeSegments: 32, surfaceSegments: 12 });
    assert.equal(result._tessellator, 'occt', 'direct importSTEP should now use OCCT tessellation');
    assert.equal(result.timings?.tessellator, 'occt', 'direct importSTEP timings should report the OCCT tessellator');
    assert.ok(Array.isArray(result.faces) && result.faces.length > 0, 'direct importSTEP should still return display faces');
    assert.ok(result.body, 'direct importSTEP should still return the exact TopoBody shadow');
  } finally {
    resetFlags();
    invalidateOcctSketchModelingSession();
    invalidateOcctKernelModuleCache();
    if (previousOcctDist == null) delete process.env.OCCT_KERNEL_DIST;
    else process.env.OCCT_KERNEL_DIST = previousOcctDist;
  }
});

adapter?.dispose();
resetFlags();
invalidateOcctSketchModelingSession();

console.log(`\nOCCT feasibility: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);