// tests/test-ir-determinism.js — CBREP v0 determinism and roundtrip tests
//
// Tests:
//   1. Byte-for-byte deterministic output for the same STEP input
//   2. TopoBody → CBREP → TopoBody roundtrip preserves topology
//   3. Topology invariants (closed loops, consistent orientations, valid refs)
//   4. Graceful failure on malformed/unsupported CBREP
//   5. Content hash stability

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { canonicalize, snapFloat, snapPoint } from '../packages/ir/canonicalize.js';
import { writeCbrep } from '../packages/ir/writer.js';
import { readCbrep, readCbrepCanon, validateCbrep, setTopoDeps } from '../packages/ir/reader.js';
import { hashCbrep } from '../packages/ir/hash.js';
import {
  CBREP_MAGIC, CBREP_VERSION, SectionType, HEADER_SIZE,
} from '../packages/ir/schema.js';

import {
  TopoVertex, TopoEdge, TopoCoEdge, TopoLoop, TopoFace, TopoShell, TopoBody,
  SurfaceType, resetTopoIds, buildTopoBody,
} from '../js/cad/BRepTopology.js';
import { NurbsCurve } from '../js/cad/NurbsCurve.js';
import { NurbsSurface } from '../js/cad/NurbsSurface.js';
import { parseSTEPTopology } from '../js/cad/StepImport.js';

// Register topology deps
const topoDeps = {
  TopoVertex, TopoEdge, TopoCoEdge, TopoLoop, TopoFace, TopoShell, TopoBody,
  NurbsCurve, NurbsSurface, SurfaceType,
};
setTopoDeps(topoDeps);

// ── Test harness ──

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
    failures.push({ name, error: err.message });
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function assertEq(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${b}, got ${a}`);
}

function assertClose(a, b, eps, msg) {
  if (Math.abs(a - b) > eps) throw new Error(msg || `Expected ~${b}, got ${a} (eps=${eps})`);
}

// ── Artifact output directory ──
const ARTIFACT_DIR = join(tmpdir(), 'cbrep-test-artifacts');
try { mkdirSync(ARTIFACT_DIR, { recursive: true }); } catch {}

function writeArtifact(name, buf) {
  try {
    writeFileSync(join(ARTIFACT_DIR, name), Buffer.from(buf));
  } catch {}
}

// ── Helper: load STEP file and produce CBREP bytes ──

const STEP_DIR = join(fileURLToPath(import.meta.url), '..', 'step');

function loadStepBody(filename) {
  const stepStr = readFileSync(join(STEP_DIR, filename), 'utf-8');
  resetTopoIds();
  return parseSTEPTopology(stepStr);
}

function bodyToCbrep(body) {
  const canon = canonicalize(body);
  return writeCbrep(canon);
}

// ══════════════════════════════════════════════════════════════════
// Test suite
// ══════════════════════════════════════════════════════════════════

console.log('\n=== CBREP v0: Canonicalization Tests ===\n');

test('snapFloat: near-zero values snap to 0', () => {
  assertEq(snapFloat(0), 0);
  assertEq(snapFloat(1e-13), 0);
  assertEq(snapFloat(-1e-13), 0);
  assertEq(snapFloat(1e-12), 1e-12);
  assertEq(snapFloat(1.5), 1.5);
  assertEq(snapFloat(-2.5), -2.5);
});

test('snapPoint: snaps all components', () => {
  const p = snapPoint({ x: 1e-15, y: 3.14, z: -1e-14 });
  assertEq(p.x, 0);
  assertEq(p.y, 3.14);
  assertEq(p.z, 0);
});

console.log('\n=== CBREP v0: Synthetic Body Tests ===\n');

test('canonicalize simple box body', () => {
  resetTopoIds();
  // Build a simple 2-face body for testing
  const body = buildTopoBody([
    {
      surfaceType: 'plane',
      vertices: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }],
      edgeCurves: [null, null, null, null],
    },
    {
      surfaceType: 'plane',
      vertices: [{ x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 1 }, { x: 1, y: 1, z: 1 }, { x: 0, y: 1, z: 1 }],
      edgeCurves: [null, null, null, null],
    },
  ]);

  const canon = canonicalize(body);
  assert(canon.vertices.length >= 8, `Expected ≥8 vertices, got ${canon.vertices.length}`);
  assert(canon.edges.length >= 8, `Expected ≥8 edges, got ${canon.edges.length}`);
  assert(canon.faces.length === 2, `Expected 2 faces, got ${canon.faces.length}`);
  assert(canon.shells.length === 1, `Expected 1 shell, got ${canon.shells.length}`);
});

test('write + read roundtrip for synthetic body', () => {
  resetTopoIds();
  const body = buildTopoBody([
    {
      surfaceType: 'plane',
      vertices: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }],
      edgeCurves: [null, null, null, null],
    },
  ]);

  const buf = bodyToCbrep(body);
  writeArtifact('synthetic-1face.cbrep', buf);

  const restored = readCbrep(buf, topoDeps);
  assert(restored.shells.length === 1, 'Should have 1 shell');
  assert(restored.faces().length === 1, 'Should have 1 face');
  const face = restored.faces()[0];
  assert(face.outerLoop !== null, 'Face should have outer loop');
  assertEq(face.outerLoop.coedges.length, 4, 'Loop should have 4 coedges');
  assertEq(face.surfaceType, 'plane', 'Surface type should be plane');
});

test('deterministic: same body produces identical bytes', () => {
  resetTopoIds();
  const body = buildTopoBody([
    {
      surfaceType: 'cylinder',
      vertices: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 1 }],
      edgeCurves: [null, null, null],
    },
  ]);

  const buf1 = bodyToCbrep(body);
  const buf2 = bodyToCbrep(body);

  const a1 = new Uint8Array(buf1);
  const a2 = new Uint8Array(buf2);
  assertEq(a1.length, a2.length, 'Buffer lengths should match');
  for (let i = 0; i < a1.length; i++) {
    assertEq(a1[i], a2[i], `Byte mismatch at offset ${i}`);
  }
});

test('hash stability: same bytes produce same hash', () => {
  resetTopoIds();
  const body = buildTopoBody([
    {
      surfaceType: 'plane',
      vertices: [{ x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }, { x: 5, y: 5, z: 0 }, { x: 0, y: 5, z: 0 }],
      edgeCurves: [null, null, null, null],
    },
  ]);

  const buf = bodyToCbrep(body);
  const h1 = hashCbrep(buf);
  const h2 = hashCbrep(buf);
  assertEq(h1, h2, 'Hash should be deterministic');
  assertEq(h1.length, 16, 'Hash should be 16 hex chars');
  assert(/^[0-9a-f]{16}$/.test(h1), 'Hash should be lowercase hex');
});

console.log('\n=== CBREP v0: Validation Tests ===\n');

test('validateCbrep accepts valid buffer', () => {
  resetTopoIds();
  const body = buildTopoBody([
    {
      surfaceType: 'plane',
      vertices: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }],
      edgeCurves: [null, null, null],
    },
  ]);
  const buf = bodyToCbrep(body);
  const result = validateCbrep(buf);
  assert(result.ok, `Expected valid, got: ${result.error}`);
});

test('validateCbrep rejects empty buffer', () => {
  const result = validateCbrep(new ArrayBuffer(0));
  assert(!result.ok, 'Should reject empty buffer');
  assert(result.error.includes('too small'), `Error should mention size: ${result.error}`);
});

test('validateCbrep rejects bad magic', () => {
  const buf = new ArrayBuffer(16);
  const dv = new DataView(buf);
  dv.setUint32(0, 0xDEADBEEF, true);
  const result = validateCbrep(buf);
  assert(!result.ok, 'Should reject bad magic');
  assert(result.error.includes('magic'), `Error should mention magic: ${result.error}`);
});

test('validateCbrep rejects future version', () => {
  const buf = new ArrayBuffer(16);
  const dv = new DataView(buf);
  dv.setUint32(0, CBREP_MAGIC, true);
  dv.setUint16(4, 99, true); // future version
  dv.setUint16(6, 0, true);
  dv.setUint32(8, 16, true);
  dv.setUint32(12, 0, true);
  const result = validateCbrep(buf);
  assert(!result.ok, 'Should reject future version');
  assert(result.error.includes('version'), `Error should mention version: ${result.error}`);
});

console.log('\n=== CBREP v0: Topology Invariant Tests ===\n');

test('roundtrip preserves closed loop invariant', () => {
  resetTopoIds();
  // Build a proper closed loop body
  const body = buildTopoBody([
    {
      surfaceType: 'plane',
      vertices: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }],
      edgeCurves: [null, null, null, null],
    },
  ]);

  const buf = bodyToCbrep(body);
  const restored = readCbrep(buf, topoDeps);
  const loop = restored.faces()[0].outerLoop;
  assert(loop.isClosed(), 'Restored loop should be closed');
});

test('roundtrip preserves vertex positions', () => {
  resetTopoIds();
  const pts = [{ x: 1.5, y: 2.7, z: 3.14159 }, { x: -0.5, y: 0, z: 100 }, { x: 0, y: 0, z: 0 }];
  const body = buildTopoBody([
    { surfaceType: 'plane', vertices: pts, edgeCurves: [null, null, null] },
  ]);

  const buf = bodyToCbrep(body);
  const restored = readCbrep(buf, topoDeps);
  const verts = restored.vertices();

  for (const origPt of pts) {
    const found = verts.find(v =>
      Math.abs(v.point.x - origPt.x) < 1e-15 &&
      Math.abs(v.point.y - origPt.y) < 1e-15 &&
      Math.abs(v.point.z - origPt.z) < 1e-15
    );
    assert(found, `Vertex (${origPt.x}, ${origPt.y}, ${origPt.z}) not found in restored body`);
  }
});

test('roundtrip preserves edge-vertex references', () => {
  resetTopoIds();
  const body = buildTopoBody([
    {
      surfaceType: 'plane',
      vertices: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0.5, y: 1, z: 0 }],
      edgeCurves: [null, null, null],
    },
  ]);

  const buf = bodyToCbrep(body);
  const restored = readCbrep(buf, topoDeps);
  for (const edge of restored.edges()) {
    assert(edge.startVertex !== null, 'Edge must have start vertex');
    assert(edge.endVertex !== null, 'Edge must have end vertex');
    assert(edge.startVertex !== edge.endVertex, 'Edge vertices must be distinct');
  }
});

test('roundtrip preserves coedge orientation', () => {
  resetTopoIds();
  const body = buildTopoBody([
    {
      surfaceType: 'plane',
      vertices: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }],
      edgeCurves: [null, null, null, null],
    },
    {
      surfaceType: 'plane',
      vertices: [{ x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 2, y: 1, z: 0 }, { x: 1, y: 1, z: 0 }],
      edgeCurves: [null, null, null, null],
    },
  ]);

  const origCoedges = [];
  for (const f of body.faces()) {
    for (const l of f.allLoops()) {
      for (const ce of l.coedges) origCoedges.push(ce.sameSense);
    }
  }

  const buf = bodyToCbrep(body);
  const restored = readCbrep(buf, topoDeps);

  const restoredCoedges = [];
  for (const f of restored.faces()) {
    for (const l of f.allLoops()) {
      for (const ce of l.coedges) restoredCoedges.push(ce.sameSense);
    }
  }

  assertEq(origCoedges.length, restoredCoedges.length, 'CoEdge count mismatch');
  for (let i = 0; i < origCoedges.length; i++) {
    assertEq(origCoedges[i], restoredCoedges[i], `CoEdge sameSense mismatch at index ${i}`);
  }
});

console.log('\n=== CBREP v0: STEP File Tests ===\n');

// Test with box-fillet-3.step
test('box-fillet-3.step → CBREP roundtrip', () => {
  const body = loadStepBody('box-fillet-3.step');
  assert(body.shells.length > 0, 'Should have shells');
  const numFaces = body.faces().length;
  assert(numFaces > 0, `Should have faces, got ${numFaces}`);

  const buf = bodyToCbrep(body);
  writeArtifact('box-fillet-3.cbrep', buf);

  assert(buf.byteLength > 0, 'CBREP should not be empty');
  const result = validateCbrep(buf);
  assert(result.ok, `Validation failed: ${result.error}`);

  // Roundtrip
  resetTopoIds();
  const restored = readCbrep(buf, topoDeps);
  assertEq(restored.shells.length, body.shells.length, 'Shell count mismatch');
  assertEq(restored.faces().length, numFaces, 'Face count mismatch');
});

test('box-fillet-3.step: deterministic bytes', () => {
  const body = loadStepBody('box-fillet-3.step');
  const buf1 = bodyToCbrep(body);
  const buf2 = bodyToCbrep(body);

  const a1 = new Uint8Array(buf1);
  const a2 = new Uint8Array(buf2);
  assertEq(a1.length, a2.length, 'Buffer lengths differ');
  let mismatches = 0;
  for (let i = 0; i < a1.length; i++) {
    if (a1[i] !== a2[i]) mismatches++;
  }
  if (mismatches > 0) {
    writeArtifact('box-fillet-3-run1.cbrep', buf1);
    writeArtifact('box-fillet-3-run2.cbrep', buf2);
  }
  assertEq(mismatches, 0, `${mismatches} byte mismatches between runs`);
});

test('box-fillet-3.step: hash stability', () => {
  const body = loadStepBody('box-fillet-3.step');
  const buf = bodyToCbrep(body);
  const h1 = hashCbrep(buf);
  const h2 = hashCbrep(buf);
  assertEq(h1, h2, 'Hash should be stable');
});

// Test with Unnamed-Body.step
test('Unnamed-Body.step → CBREP roundtrip', () => {
  const body = loadStepBody('Unnamed-Body.step');
  assert(body.shells.length > 0, 'Should have shells');
  const numFaces = body.faces().length;

  const buf = bodyToCbrep(body);
  writeArtifact('Unnamed-Body.cbrep', buf);

  const result = validateCbrep(buf);
  assert(result.ok, `Validation failed: ${result.error}`);

  resetTopoIds();
  const restored = readCbrep(buf, topoDeps);
  assertEq(restored.shells.length, body.shells.length, 'Shell count mismatch');
  assertEq(restored.faces().length, numFaces, 'Face count mismatch');
});

test('Unnamed-Body.step: deterministic bytes', () => {
  const body = loadStepBody('Unnamed-Body.step');
  const buf1 = bodyToCbrep(body);
  const buf2 = bodyToCbrep(body);

  const a1 = new Uint8Array(buf1);
  const a2 = new Uint8Array(buf2);
  assertEq(a1.length, a2.length, 'Buffer lengths differ');
  let mismatches = 0;
  for (let i = 0; i < a1.length; i++) {
    if (a1[i] !== a2[i]) mismatches++;
  }
  if (mismatches > 0) {
    writeArtifact('Unnamed-Body-run1.cbrep', buf1);
    writeArtifact('Unnamed-Body-run2.cbrep', buf2);
  }
  assertEq(mismatches, 0, `${mismatches} byte mismatches between runs`);
});

console.log('\n=== CBREP v0: NURBS Geometry Roundtrip Tests ===\n');

test('roundtrip preserves NurbsCurve on edges', () => {
  resetTopoIds();
  const curve = new NurbsCurve(
    2,
    [{ x: 0, y: 0, z: 0 }, { x: 0.5, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }],
    [0, 0, 0, 1, 1, 1],
    [1, 1, 1],
  );

  const v1 = new TopoVertex({ x: 0, y: 0, z: 0 });
  const v2 = new TopoVertex({ x: 1, y: 0, z: 0 });
  const edge = new TopoEdge(v1, v2, curve);
  const ce = new TopoCoEdge(edge, true);
  const loop = new TopoLoop([ce]);
  const face = new TopoFace(null, SurfaceType.PLANE);
  face.setOuterLoop(loop);
  const shell = new TopoShell([face]);
  shell.closed = false;
  const body = new TopoBody([shell]);

  const buf = bodyToCbrep(body);
  resetTopoIds();
  const restored = readCbrep(buf, topoDeps);
  const restoredEdge = restored.edges()[0];
  assert(restoredEdge.curve !== null, 'Edge should have curve');
  assertEq(restoredEdge.curve.degree, 2, 'Curve degree should be 2');
  assertEq(restoredEdge.curve.controlPoints.length, 3, 'Should have 3 control points');

  // Evaluate at midpoint
  const origPt = curve.evaluate(0.5);
  const restPt = restoredEdge.curve.evaluate(0.5);
  assertClose(origPt.x, restPt.x, 1e-12, 'Curve evaluate x mismatch');
  assertClose(origPt.y, restPt.y, 1e-12, 'Curve evaluate y mismatch');
  assertClose(origPt.z, restPt.z, 1e-12, 'Curve evaluate z mismatch');
});

test('roundtrip preserves NurbsSurface on faces', () => {
  resetTopoIds();
  const surface = NurbsSurface.createPlane(
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
  );

  const pts = [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }];
  const verts = pts.map(p => new TopoVertex(p));
  const edges = [];
  const coedges = [];
  for (let i = 0; i < 4; i++) {
    const e = new TopoEdge(verts[i], verts[(i + 1) % 4]);
    edges.push(e);
    coedges.push(new TopoCoEdge(e, true));
  }
  const loop = new TopoLoop(coedges);
  const face = new TopoFace(surface, SurfaceType.PLANE);
  face.setOuterLoop(loop);
  const shell = new TopoShell([face]);
  const body = new TopoBody([shell]);

  const buf = bodyToCbrep(body);
  resetTopoIds();
  const restored = readCbrep(buf, topoDeps);
  const rFace = restored.faces()[0];
  assert(rFace.surface !== null, 'Face should have surface');
  assertEq(rFace.surface.degreeU, surface.degreeU, 'DegreeU mismatch');
  assertEq(rFace.surface.degreeV, surface.degreeV, 'DegreeV mismatch');

  // Evaluate at center
  const origPt = surface.evaluate(0.5, 0.5);
  const restPt = rFace.surface.evaluate(0.5, 0.5);
  assertClose(origPt.x, restPt.x, 1e-12, 'Surface evaluate x mismatch');
  assertClose(origPt.y, restPt.y, 1e-12, 'Surface evaluate y mismatch');
  assertClose(origPt.z, restPt.z, 1e-12, 'Surface evaluate z mismatch');
});

test('roundtrip preserves pCurves on coedges', () => {
  resetTopoIds();
  const pCurve = new NurbsCurve(
    1,
    [{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }],
    [0, 0, 1, 1],
  );

  const v1 = new TopoVertex({ x: 0, y: 0, z: 0 });
  const v2 = new TopoVertex({ x: 1, y: 1, z: 0 });
  const edge = new TopoEdge(v1, v2);
  const ce = new TopoCoEdge(edge, true, pCurve);
  const loop = new TopoLoop([ce]);
  const face = new TopoFace(null, SurfaceType.PLANE);
  face.setOuterLoop(loop);
  const shell = new TopoShell([face]);
  const body = new TopoBody([shell]);

  const buf = bodyToCbrep(body);
  resetTopoIds();
  const restored = readCbrep(buf, topoDeps);
  const rCe = restored.faces()[0].outerLoop.coedges[0];
  assert(rCe.pCurve !== null, 'CoEdge should have pCurve');
  assertEq(rCe.pCurve.degree, 1, 'pCurve degree should be 1');
  assertEq(rCe.pCurve.controlPoints.length, 2, 'pCurve should have 2 control points');
});

console.log('\n=== CBREP v0: readCbrepCanon Tests ===\n');

test('readCbrepCanon returns canonical structure', () => {
  resetTopoIds();
  const body = buildTopoBody([
    {
      surfaceType: 'plane',
      vertices: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }],
      edgeCurves: [null, null, null],
    },
  ]);

  const buf = bodyToCbrep(body);
  const canon = readCbrepCanon(buf);
  assert(canon.vertices.length === 3, 'Should have 3 vertices');
  assert(canon.edges.length === 3, 'Should have 3 edges');
  assert(canon.coedges.length === 3, 'Should have 3 coedges');
  assert(canon.loops.length === 1, 'Should have 1 loop');
  assert(canon.faces.length === 1, 'Should have 1 face');
  assert(canon.shells.length === 1, 'Should have 1 shell');
});

// ── Summary ──

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failures.length > 0) {
  console.log('Failures:');
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.error}`);
  }
}
process.exit(failed > 0 ? 1 : 0);
