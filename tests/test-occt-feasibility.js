import './_watchdog.mjs';

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { buildTopoBody, resetTopoIds, SurfaceType } from '../js/cad/BRepTopology.js';
import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { resetFeatureIds } from '../js/cad/Feature.js';
import { resetPrimitiveIds } from '../js/cad/Primitive.js';
import { exportSTEPDetailed } from '../js/cad/StepExport.js';
import { resetFlags, setFlag } from '../js/featureFlags.js';
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

adapter?.dispose();
resetFlags();
invalidateOcctSketchModelingSession();

console.log(`\nOCCT feasibility: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);