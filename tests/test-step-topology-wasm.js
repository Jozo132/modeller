// tests/test-step-topology-wasm.js — Phase 1 smoke + parity for the
// native STEP→WASM topology builder.  Runs the pipeline on the corpus
// and compares vertex/edge/face counts against the existing JS path.

import './_watchdog.mjs';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import {
  ensureStepTopologyReady,
  buildStepTopologySync,
  importStepNativeSync,
} from '../js/cad/StepTopologyWasm.js';
import { parseSTEPTopology } from '../js/cad/StepImport.js';
import { formatTimingSuffix, startTiming } from './test-timing.js';

let passed = 0, failed = 0;

function test(name, fn) {
  const startedAt = startTiming();
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => { console.log(`  ✓ ${name}${formatTimingSuffix(startedAt)}`); passed++; },
        (err) => {
          console.log(`  ✗ ${name}${formatTimingSuffix(startedAt)}`);
          console.log(`    ${err.message}`);
          if (err.stack) for (const l of err.stack.split('\n').slice(1, 4)) console.log(`    ${l.trim()}`);
          failed++;
        },
      );
    }
    console.log(`  ✓ ${name}${formatTimingSuffix(startedAt)}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}${formatTimingSuffix(startedAt)}`);
    console.log(`    ${err.message}`);
    if (err.stack) {
      for (const l of err.stack.split('\n').slice(1, 4)) console.log(`    ${l.trim()}`);
    }
    failed++;
  }
}

await ensureStepTopologyReady();

console.log('Running test-step-topology-wasm.js');

const boxStep = fileURLToPath(new URL('./step/box-fillet-3.step', import.meta.url));
const unnamedStep = fileURLToPath(new URL('./step/Unnamed-Body.step', import.meta.url));

function summariseJs(src) {
  const body = parseSTEPTopology(src);
  const faces = body.faces();
  let coedges = 0, loops = 0;
  const verts = new Set(), edges = new Set();
  for (const f of faces) {
    const loopsList = [f.outerLoop, ...(f.innerLoops || [])].filter(Boolean);
    loops += loopsList.length;
    for (const loop of loopsList) {
      for (const ce of loop.coedges) {
        coedges++;
        if (ce.edge) {
          edges.add(ce.edge);
          if (ce.edge.startVertex) verts.add(ce.edge.startVertex);
          if (ce.edge.endVertex) verts.add(ce.edge.endVertex);
        }
      }
    }
  }
  return {
    faceCount: faces.length,
    loopCount: loops,
    coedgeCount: coedges,
    vertexCount: verts.size,
    edgeCount: edges.size,
  };
}

test('box-fillet-3.step — native build returns ok', () => {
  const src = readFileSync(boxStep, 'utf-8');
  const res = buildStepTopologySync(src);
  if (!res.ok) throw new Error(`build failed: ${JSON.stringify(res)}`);
  console.log('    ', JSON.stringify({
    v: res.vertexCount, e: res.edgeCount, ce: res.coedgeCount,
    l: res.loopCount, f: res.faceCount, s: res.shellCount,
    skipped: res.skippedFaceCount,
  }));
  if (res.shellCount !== 1) throw new Error(`expected 1 shell, got ${res.shellCount}`);
  if (res.faceCount < 6) throw new Error(`expected >=6 faces for a box, got ${res.faceCount}`);
});

test('box-fillet-3.step — counts match JS pipeline', () => {
  const src = readFileSync(boxStep, 'utf-8');
  const wasm = buildStepTopologySync(src);
  if (!wasm.ok) throw new Error(`wasm build failed: ${JSON.stringify(wasm)}`);
  const js = summariseJs(src);
  console.log(`    JS  : v=${js.vertexCount} e=${js.edgeCount} ce=${js.coedgeCount} l=${js.loopCount} f=${js.faceCount}`);
  console.log(`    WASM: v=${wasm.vertexCount} e=${wasm.edgeCount} ce=${wasm.coedgeCount} l=${wasm.loopCount} f=${wasm.faceCount}`);
  // Face counts must match (surfaces all supported in Phase 1 for this file).
  if (wasm.faceCount !== js.faceCount) {
    throw new Error(`faceCount mismatch JS=${js.faceCount} WASM=${wasm.faceCount}`);
  }
  if (wasm.vertexCount !== js.vertexCount) {
    throw new Error(`vertexCount mismatch JS=${js.vertexCount} WASM=${wasm.vertexCount}`);
  }
  if (wasm.edgeCount !== js.edgeCount) {
    throw new Error(`edgeCount mismatch JS=${js.edgeCount} WASM=${wasm.edgeCount}`);
  }
});

test('Unnamed-Body.step — native build attempts (b-splines expected to skip)', () => {
  const src = readFileSync(unnamedStep, 'utf-8');
  const res = buildStepTopologySync(src, { maxSkippedFaces: Number.MAX_SAFE_INTEGER });
  // Unnamed-Body.step contains B_SPLINE_SURFACE_WITH_KNOTS + RATIONAL_B_SPLINE_SURFACE
  // which Phase 1 does not handle: those faces should be skipped but the
  // call itself should succeed when maxSkippedFaces is unbounded.
  if (!res.ok) throw new Error(`build failed: ${JSON.stringify(res)}`);
  console.log(`    built: f=${res.faceCount} skipped=${res.skippedFaceCount}`);
  if (res.skippedFaceCount === 0 && res.faceCount === 0) {
    throw new Error('expected at least some faces built or skipped');
  }
});

await test('Unnamed-Body.step — Phase 2 B-spline surfaces all build & tessellate', async () => {
  const src = readFileSync(unnamedStep, 'utf-8');
  const res = buildStepTopologySync(src);
  if (!res.ok) throw new Error(`native build failed: ${JSON.stringify(res)}`);
  if (res.skippedFaceCount !== 0) {
    throw new Error(`expected 0 skipped faces in Phase 2, got ${res.skippedFaceCount}`);
  }
  const mod = await import('../build/release.js');
  const rc = mod.tessBuildAllFaces(24, 24);
  if (rc < 0) throw new Error(`tessBuildAllFaces overflow rc=${rc}`);
  const verts = mod.getTessOutVertCount() >>> 0;
  const tris = mod.getTessOutTriCount() >>> 0;
  console.log(`    faces=${res.faceCount} verts=${verts} tris=${tris}`);
  if (tris < 100) throw new Error(`tri count too low for a ${res.faceCount}-face body: ${tris}`);
});

test('importStepNativeSync — end-to-end mesh assembly works', () => {
  const src = readFileSync(boxStep, 'utf-8');
  const out = importStepNativeSync(src, { surfaceSegments: 24 });
  if (!out.ok) throw new Error(`importStepNativeSync failed: ${JSON.stringify(out)}`);
  console.log(`    build=${out.timings.buildMs.toFixed(1)}ms tess=${out.timings.tessMs.toFixed(1)}ms` +
    ` verts=${out.vertices.length} tris=${out.faces.length}`);
  if (out.vertices.length === 0) throw new Error('no vertices');
  if (out.faces.length === 0) throw new Error('no triangles');
  // Mesh shape sanity: first triangle should have 3 points w/ finite coords.
  const f0 = out.faces[0];
  if (!f0.vertices || f0.vertices.length !== 3) throw new Error('tri has !=3 verts');
  for (const v of f0.vertices) {
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) {
      throw new Error('non-finite vertex coord');
    }
  }
  if (!Number.isFinite(f0.normal.x)) throw new Error('non-finite normal');
});

test('importStepNativeSync — B-spline body produces dense mesh', () => {
  const src = readFileSync(unnamedStep, 'utf-8');
  const out = importStepNativeSync(src, { surfaceSegments: 24 });
  if (!out.ok) throw new Error(`importStepNativeSync failed: ${JSON.stringify(out)}`);
  console.log(`    faces=${out.faceCount} build=${out.timings.buildMs.toFixed(1)}ms` +
    ` tess=${out.timings.tessMs.toFixed(1)}ms` +
    ` verts=${out.vertices.length} tris=${out.faces.length} skipped=${out.skippedFaceCount}`);
  if (out.skippedFaceCount > 0) throw new Error(`expected 0 skipped faces, got ${out.skippedFaceCount}`);
  if (out.faces.length < 1000) throw new Error(`tri count too low: ${out.faces.length}`);
});

// ─────────────────────────── Tessellation sanity ───────────────────
// The native builder uses a different visit-order for vertices/edges
// than the JS pipeline, so CBREP byte-level parity is not a meaningful
// invariant.  What matters is that the resulting WASM kernel state is
// *tessellatable* and produces the expected face/triangle coverage.

await test('box-fillet-3.step — native build tessellates cleanly', async () => {
  const src = readFileSync(boxStep, 'utf-8');
  const res = buildStepTopologySync(src);
  if (!res.ok) throw new Error(`native build failed: ${JSON.stringify(res)}`);

  const mod = await import('../build/release.js');
  const rc = mod.tessBuildAllFaces(32, 32);
  if (rc < 0) throw new Error(`tessBuildAllFaces overflow rc=${rc}`);

  const vertCount = mod.getTessOutVertCount() >>> 0;
  const triCount = mod.getTessOutTriCount() >>> 0;
  console.log(`    tess: verts=${vertCount} tris=${triCount} (rc=${rc})`);
  if (vertCount === 0 || triCount === 0) {
    throw new Error(`tessellation produced no mesh (verts=${vertCount}, tris=${triCount})`);
  }
  // A 10-face fillet-box with 32 segments: expect well over 100 tris.
  if (triCount < 100) throw new Error(`triangle count suspiciously low: ${triCount}`);
});



console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
