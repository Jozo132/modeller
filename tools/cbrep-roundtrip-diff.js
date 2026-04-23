#!/usr/bin/env node
// tools/cbrep-roundtrip-diff.js — STEP → tess → CBREP → tess diagnostic
//
// Purpose: rapid round-trip verification for CBREP fidelity / tessellator
// parity. Loads a STEP file (or reads an existing CBREP), tessellates the
// live TopoBody, roundtrips through CBREP, tessellates the restored body,
// and prints a per-face diff: triangle count, surface area, centroid drift,
// and mean normal drift. The summary surfaces which faces the CBREP roundtrip
// is perturbing so the BRep/tess fidelity work has a concrete, fast feedback
// signal instead of "reload shows garbage".
//
// Usage:
//   node tools/cbrep-roundtrip-diff.js tests/step/box-fillet-3.step
//   node tools/cbrep-roundtrip-diff.js path/to/file.step --verbose
//   node tools/cbrep-roundtrip-diff.js path/to/file.cbrep    # .cbrep treated as pre-serialized
//
// Exit code: 0 on run-success (regardless of diffs); 1 only on load/parse error.

import { readFileSync } from 'node:fs';
import { resolve, extname, basename } from 'node:path';

import { canonicalize } from '../packages/ir/canonicalize.js';
import { writeCbrep } from '../packages/ir/writer.js';
import { readCbrep, setTopoDeps } from '../packages/ir/reader.js';

import {
  TopoVertex, TopoEdge, TopoCoEdge, TopoLoop, TopoFace, TopoShell, TopoBody,
  SurfaceType, resetTopoIds,
} from '../js/cad/BRepTopology.js';
import { NurbsCurve } from '../js/cad/NurbsCurve.js';
import { NurbsSurface } from '../js/cad/NurbsSurface.js';
import { parseSTEPTopology } from '../js/cad/StepImport.js';
import { tessellateBody } from '../js/cad/Tessellation.js';

setTopoDeps({
  TopoVertex, TopoEdge, TopoCoEdge, TopoLoop, TopoFace, TopoShell, TopoBody,
  NurbsCurve, NurbsSurface, SurfaceType,
});

const args = process.argv.slice(2);
const verbose = args.includes('--verbose') || args.includes('-v');
const inputPath = args.find(a => !a.startsWith('-'));
if (!inputPath) {
  console.error('Usage: cbrep-roundtrip-diff <file.step|file.cbrep> [--verbose]');
  process.exit(2);
}

const abs = resolve(inputPath);
const ext = extname(abs).toLowerCase();

function now() { return Number(process.hrtime.bigint()) / 1e6; }

function loadBody() {
  if (ext === '.cbrep') {
    const buf = readFileSync(abs);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    resetTopoIds();
    return readCbrep(ab);
  }
  const stepText = readFileSync(abs, 'utf-8');
  resetTopoIds();
  return parseSTEPTopology(stepText);
}

function triangleArea(a, b, c) {
  const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
  const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  return 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
}

// Group tess output triangles by their source BRep face index. Each mesh
// "face" in tess output is a single triangle stamped with `topoFaceId`. We
// remap to a body-face index because topoFaceIds differ between live and
// restored bodies (resetTopoIds causes autoincrement reset, but the id
// sequences still diverge depending on allocation order).
function aggregateByBrepFace(mesh, body) {
  const faceList = body.faces();
  const idToIdx = new Map();
  for (let i = 0; i < faceList.length; i++) {
    idToIdx.set(faceList[i].id, i);
  }
  const buckets = new Array(faceList.length).fill(null).map((_, i) => ({
    idx: i,
    surfaceType: faceList[i].surfaceType,
    triCount: 0,
    area: 0,
    cx: 0, cy: 0, cz: 0, // area-weighted centroid accumulator
    nx: 0, ny: 0, nz: 0, // area-weighted normal accumulator
  }));
  for (const tri of mesh.faces) {
    const faceIdx = idToIdx.get(tri.topoFaceId);
    if (faceIdx == null) continue;
    const verts = tri.vertices || [];
    if (verts.length < 3) continue;
    const a = verts[0], b = verts[1], c = verts[2];
    const ta = triangleArea(a, b, c);
    const bucket = buckets[faceIdx];
    bucket.triCount += 1;
    bucket.area += ta;
    const ccx = (a.x + b.x + c.x) / 3;
    const ccy = (a.y + b.y + c.y) / 3;
    const ccz = (a.z + b.z + c.z) / 3;
    bucket.cx += ta * ccx; bucket.cy += ta * ccy; bucket.cz += ta * ccz;
    if (tri.normal) {
      bucket.nx += ta * tri.normal.x;
      bucket.ny += ta * tri.normal.y;
      bucket.nz += ta * tri.normal.z;
    }
  }
  return buckets.map(b => {
    const area = b.area || 0;
    const cx = area > 0 ? b.cx / area : 0;
    const cy = area > 0 ? b.cy / area : 0;
    const cz = area > 0 ? b.cz / area : 0;
    let nx = b.nx, ny = b.ny, nz = b.nz;
    const nl = Math.hypot(nx, ny, nz);
    if (nl > 1e-12) { nx /= nl; ny /= nl; nz /= nl; }
    return {
      idx: b.idx,
      surfaceType: b.surfaceType,
      triCount: b.triCount,
      area,
      centroid: { x: cx, y: cy, z: cz },
      normal: { x: nx, y: ny, z: nz },
    };
  });
}

function meshStats(mesh, body) {
  const stats = aggregateByBrepFace(mesh, body);
  const totalTris = stats.reduce((s, f) => s + f.triCount, 0);
  const totalArea = stats.reduce((s, f) => s + f.area, 0);
  return { stats, totalTris, totalArea, tessellator: mesh._tessellator };
}

function fmt(n, d = 4) {
  if (Number.isNaN(n) || !Number.isFinite(n)) return String(n);
  return n.toFixed(d);
}

function diff(liveStats, restStats) {
  const rows = [];
  const n = Math.max(liveStats.length, restStats.length);
  let worstAreaDelta = 0;
  let worstCentroidDelta = 0;
  let worstNormalDot = 1;
  let divergentFaces = 0;
  for (let i = 0; i < n; i++) {
    const L = liveStats[i] || {};
    const R = restStats[i] || {};
    const areaL = L.area || 0, areaR = R.area || 0;
    const areaDelta = Math.abs(areaL - areaR);
    const areaRel = areaL > 1e-9 ? areaDelta / areaL : areaDelta;
    const cL = L.centroid || { x: 0, y: 0, z: 0 };
    const cR = R.centroid || { x: 0, y: 0, z: 0 };
    const dx = cL.x - cR.x, dy = cL.y - cR.y, dz = cL.z - cR.z;
    const centroidDelta = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const nL = L.normal || { x: 0, y: 0, z: 0 };
    const nR = R.normal || { x: 0, y: 0, z: 0 };
    const normalDot = nL.x * nR.x + nL.y * nR.y + nL.z * nR.z;
    const triDelta = (L.triCount || 0) - (R.triCount || 0);
    const divergent = areaRel > 0.01 || centroidDelta > 1e-3 || normalDot < 0.999 || Math.abs(triDelta) > 0;
    if (divergent) divergentFaces++;
    if (areaRel > worstAreaDelta) worstAreaDelta = areaRel;
    if (centroidDelta > worstCentroidDelta) worstCentroidDelta = centroidDelta;
    if (normalDot < worstNormalDot) worstNormalDot = normalDot;
    rows.push({
      idx: i,
      surfL: L.surfaceType, surfR: R.surfaceType,
      triL: L.triCount || 0, triR: R.triCount || 0, triDelta,
      areaL, areaR, areaRel,
      centroidDelta, normalDot, divergent,
    });
  }
  return { rows, worstAreaDelta, worstCentroidDelta, worstNormalDot, divergentFaces };
}

// ── Run ──

console.log(`\n== CBREP roundtrip diff — ${basename(abs)} ==\n`);

let body;
try {
  const t = now();
  body = loadBody();
  console.log(`  load:               ${fmt(now() - t, 1)} ms  (${body.faces().length} faces, ${body.shells.length} shells)`);
} catch (err) {
  console.error(`Failed to load ${abs}: ${err.message}`);
  process.exit(1);
}

let liveMesh;
{
  const t = now();
  liveMesh = tessellateBody(body, { validate: false });
  console.log(`  tess (live):        ${fmt(now() - t, 1)} ms  (${liveMesh.faces.length} faces, tessellator=${liveMesh._tessellator})`);
}

let cbrepBuf;
{
  const t = now();
  const canon = canonicalize(body);
  cbrepBuf = writeCbrep(canon);
  console.log(`  serialize CBREP:    ${fmt(now() - t, 1)} ms  (${cbrepBuf.byteLength} bytes)`);
}

let restored;
{
  const t = now();
  resetTopoIds();
  restored = readCbrep(cbrepBuf);
  console.log(`  parse CBREP:        ${fmt(now() - t, 1)} ms  (${restored.faces().length} faces)`);
}

let restMesh;
{
  const t = now();
  restMesh = tessellateBody(restored, { validate: false });
  console.log(`  tess (restored):    ${fmt(now() - t, 1)} ms  (${restMesh.faces.length} faces, tessellator=${restMesh._tessellator})`);
}

const live = meshStats(liveMesh, body);
const rest = meshStats(restMesh, restored);
const d = diff(live.stats, rest.stats);

console.log(`\n== Totals ==`);
console.log(`  triangles:     live=${live.totalTris}   restored=${rest.totalTris}   delta=${live.totalTris - rest.totalTris}`);
console.log(`  surface area:  live=${fmt(live.totalArea)}   restored=${fmt(rest.totalArea)}   delta=${fmt(Math.abs(live.totalArea - rest.totalArea))}`);
console.log(`  worst face area relative delta:   ${fmt(d.worstAreaDelta * 100, 3)}%`);
console.log(`  worst face centroid drift (mm):   ${fmt(d.worstCentroidDelta, 6)}`);
console.log(`  worst face normal dot (1.0=aligned): ${fmt(d.worstNormalDot, 6)}`);
console.log(`  divergent faces:  ${d.divergentFaces}/${d.rows.length}`);

if (verbose || d.divergentFaces > 0) {
  console.log(`\n== Per-face (${verbose ? 'all' : 'divergent only'}) ==`);
  console.log(`  idx  surfL     surfR     triL  triR  dTri   areaL      areaR      relΔ%   centroidΔ   normal·   status`);
  for (const r of d.rows) {
    if (!verbose && !r.divergent) continue;
    const sL = (r.surfL || '-').padEnd(9);
    const sR = (r.surfR || '-').padEnd(9);
    const status = r.divergent ? 'DIVERGE' : 'ok';
    console.log(`  ${String(r.idx).padStart(3)}  ${sL} ${sR} ${String(r.triL).padStart(4)}  ${String(r.triR).padStart(4)}  ${String(r.triDelta).padStart(4)}   ${fmt(r.areaL).padStart(8)}   ${fmt(r.areaR).padStart(8)}   ${fmt(r.areaRel * 100, 2).padStart(5)}   ${fmt(r.centroidDelta, 6).padStart(8)}   ${fmt(r.normalDot, 4).padStart(6)}   ${status}`);
  }
}

console.log('');
