// tests/diag-unnamed-body.js — systematic diagnosis of Unnamed-Body.cmod
//
// Goal: find which faces are mis-trimmed / mis-tessellated, and classify
// the root cause (topology missing shared edge vs tessellator ignoring
// the trim loop).
// Diagnostic-only: intentionally uses Tessellator2 compatibility code.
//
// Outputs a CSV-ish report to stdout.

import './_watchdog.mjs';
import fs from 'node:fs';
import { Part } from '../js/cad/Part.js';
import { parseCMOD } from '../js/cmod.js';
import { robustTessellateBody } from '../js/cad/Tessellator2/index.js';

const raw = fs.readFileSync('tests/samples/Unnamed-Body.cmod', 'utf-8');
const parsed = parseCMOD(raw);
if (!parsed.ok) {
  console.error('Failed to parse Unnamed-Body.cmod:', parsed.error);
  process.exit(1);
}
const part = Part.deserialize(parsed.data.part);
const finalGeom = part.getFinalGeometry();
const topoBody = finalGeom && (finalGeom.topoBody || finalGeom.body || (finalGeom.solid && finalGeom.solid.body));
if (!topoBody) {
  console.error('No topoBody on final geometry — keys:', finalGeom ? Object.keys(finalGeom) : 'null');
  process.exit(1);
}

const shells = topoBody.shells || [];
let totalFaces = 0;
let totalEdges = 0;
let totalCoedges = 0;
for (const shell of shells) {
  totalFaces += (shell.faces || []).length;
  for (const face of shell.faces || []) {
    const loops = [face.outerLoop, ...(face.innerLoops || [])].filter(Boolean);
    for (const loop of loops) {
      totalCoedges += (loop.coedges || []).length;
    }
  }
}
for (const shell of shells) {
  const seen = new Set();
  for (const face of shell.faces || []) {
    const loops = [face.outerLoop, ...(face.innerLoops || [])].filter(Boolean);
    for (const loop of loops) {
      for (const ce of loop.coedges || []) {
        if (ce.edge && !seen.has(ce.edge.id)) {
          seen.add(ce.edge.id);
          totalEdges++;
        }
      }
    }
  }
}

console.log(`TOPOLOGY`);
console.log(`  shells         = ${shells.length}`);
console.log(`  faces          = ${totalFaces}`);
console.log(`  unique edges   = ${totalEdges}`);
console.log(`  coedges        = ${totalCoedges}`);

// ── Classify edges by use-count ─────────────────────────────────────
// In a closed manifold body, every edge should be used by exactly 2
// coedges. STEP imports often have seam edges (1 use) or open boundary
// edges (1 use). Non-manifold edges (>2 uses) are bugs.
const edgeUseCount = new Map(); // edgeId -> count
const edgeFaceMap  = new Map(); // edgeId -> Set<faceId>
for (const shell of shells) {
  for (const face of shell.faces || []) {
    const loops = [face.outerLoop, ...(face.innerLoops || [])].filter(Boolean);
    for (const loop of loops) {
      for (const ce of loop.coedges || []) {
        const eid = ce.edge && ce.edge.id;
        if (eid == null) continue;
        edgeUseCount.set(eid, (edgeUseCount.get(eid) || 0) + 1);
        if (!edgeFaceMap.has(eid)) edgeFaceMap.set(eid, new Set());
        edgeFaceMap.get(eid).add(face.id);
      }
    }
  }
}
let boundary = 0, manifold = 0, nonManifold = 0;
for (const [, count] of edgeUseCount) {
  if (count === 1) boundary++;
  else if (count === 2) manifold++;
  else nonManifold++;
}
console.log(`EDGES BY USE`);
console.log(`  manifold (2 uses)    = ${manifold}`);
console.log(`  boundary (1 use)     = ${boundary}`);
console.log(`  non-manifold (>2)    = ${nonManifold}`);

// ── Find faces with suspect loops ───────────────────────────────────
//
// A face whose mesh extends past its trim has one of these signs:
// (A) outerLoop is missing or has < 3 coedges
// (B) a coedge's underlying edge has null curve
// (C) a coedge's endpoint vertices don't match its neighbors' endpoints
//     (broken loop chaining)
// (D) the 3D edge endpoints don't lie on the face's surface (within tol)
//
// We report counts and dump the first N offenders with their IDs.

let facesNoOuter = 0;
let facesShortOuter = 0;
const broken = []; // { faceId, reason, detail }

const TOL = 1e-3;

function evalSurf(surface, u, v) {
  try {
    return surface.evaluate(u, v);
  } catch {
    return null;
  }
}

function endpoint3D(coedge, which /* 'start' | 'end' */) {
  const edge = coedge.edge;
  if (!edge) return null;
  // TopoCoEdge.sameSense=false means the coedge traverses the edge in
  // reverse of its stored (startVertex → endVertex) direction.
  const sameSense = coedge.sameSense !== false;
  const useStart = (which === 'start') ? sameSense : !sameSense;
  const v = useStart ? edge.startVertex : edge.endVertex;
  return v && v.point ? v.point : null;
}

function dist3(a, b) {
  if (!a || !b) return Infinity;
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

for (const shell of shells) {
  for (const face of shell.faces || []) {
    if (!face.outerLoop) { facesNoOuter++; broken.push({ faceId: face.id, reason: 'NO_OUTER_LOOP' }); continue; }
    const coedges = face.outerLoop.coedges || [];
    if (coedges.length < 3) {
      facesShortOuter++;
      broken.push({ faceId: face.id, reason: 'SHORT_OUTER_LOOP', detail: `coedges=${coedges.length}` });
      continue;
    }

    // Check loop chaining: end of coedge[i] should equal start of coedge[i+1].
    for (let i = 0; i < coedges.length; i++) {
      const a = coedges[i];
      const b = coedges[(i + 1) % coedges.length];
      const aEnd = endpoint3D(a, 'end');
      const bStart = endpoint3D(b, 'start');
      const d = dist3(aEnd, bStart);
      if (d > TOL) {
        broken.push({ faceId: face.id, reason: 'LOOP_CHAIN_BROKEN', detail: `i=${i} gap=${d.toFixed(4)}` });
        break;
      }
    }
  }
}

console.log(`LOOP INTEGRITY`);
console.log(`  faces without outer loop  = ${facesNoOuter}`);
console.log(`  faces with <3 coedges     = ${facesShortOuter}`);
console.log(`  total reports             = ${broken.length}`);

// Dump first 10 offenders
for (let i = 0; i < Math.min(10, broken.length); i++) {
  const b = broken[i];
  console.log(`  [${i}] face ${b.faceId}: ${b.reason}${b.detail ? ' (' + b.detail + ')' : ''}`);
}

// ── Tessellate and check triangle-outside-trim ──────────────────────
//
// For each face, check whether tessellated triangles straddle far past
// the outer loop's 3D bounding box. A face whose mesh extends past its
// trim will have vertices far outside the loop bbox.

console.log(`\nTESSELLATING…`);
const t0 = Date.now();
let tessResult;
try {
  tessResult = robustTessellateBody(topoBody);
} catch (e) {
  console.error('Tessellation threw:', e.message);
  process.exit(1);
}
const t1 = Date.now();
console.log(`  took ${t1 - t0}ms`);

const perFaceMesh = new Map(); // topoFaceId -> array of {x,y,z} vertices
if (tessResult && Array.isArray(tessResult.faces)) {
  for (const tri of tessResult.faces) {
    const fid = tri.topoFaceId;
    if (fid == null || !tri.vertices) continue;
    let arr = perFaceMesh.get(fid);
    if (!arr) { arr = []; perFaceMesh.set(fid, arr); }
    for (const v of tri.vertices) arr.push(v);
  }
}
if (perFaceMesh.size === 0) {
  console.log(`  (no per-face meshes extracted — tessellation produced ${tessResult.faces.length} triangles)`);
} else {
  let overflowing = 0;
  const overflows = [];
  for (const shell of shells) {
    for (const face of shell.faces || []) {
      const verts = perFaceMesh.get(face.id);
      if (!verts || verts.length === 0) continue;
      if (!face.outerLoop) continue;

      // Build trim bbox by sampling each coedge's curve densely.
      // This gives the true boundary extent, not just endpoints.
      let lo = { x: Infinity, y: Infinity, z: Infinity };
      let hi = { x: -Infinity, y: -Infinity, z: -Infinity };
      let haveSamples = false;
      for (const ce of face.outerLoop.coedges || []) {
        const curve = ce.edge && ce.edge.curve;
        if (!curve || !curve.evaluate) continue;
        const tMin = curve.uMin != null ? curve.uMin : (curve.tMin != null ? curve.tMin : 0);
        const tMax = curve.uMax != null ? curve.uMax : (curve.tMax != null ? curve.tMax : 1);
        const N = 32;
        for (let k = 0; k <= N; k++) {
          const t = tMin + (tMax - tMin) * (k / N);
          let p;
          try { p = curve.evaluate(t); } catch { p = null; }
          if (!p) continue;
          haveSamples = true;
          if (p.x < lo.x) lo.x = p.x; if (p.x > hi.x) hi.x = p.x;
          if (p.y < lo.y) lo.y = p.y; if (p.y > hi.y) hi.y = p.y;
          if (p.z < lo.z) lo.z = p.z; if (p.z > hi.z) hi.z = p.z;
        }
      }
      if (!haveSamples) continue;
      const diag = Math.hypot(hi.x - lo.x, hi.y - lo.y, hi.z - lo.z) || 1;
      const slack = diag * 0.05; // 5% of bbox diagonal

      let worst = 0;
      for (const v of verts) {
        const dx = Math.max(0, lo.x - v.x, v.x - hi.x);
        const dy = Math.max(0, lo.y - v.y, v.y - hi.y);
        const dz = Math.max(0, lo.z - v.z, v.z - hi.z);
        const d = Math.hypot(dx, dy, dz);
        if (d > worst) worst = d;
      }
      if (worst > slack) {
        overflowing++;
        overflows.push({ faceId: face.id, surfaceType: face.surfaceType, worst, diag, ratio: worst / diag, triCount: verts.length / 3 });
      }
    }
  }
  overflows.sort((a, b) => b.ratio - a.ratio);
  console.log(`\nTESS OVERFLOW (triangles outside loop bbox by >10% loop diagonal)`);
  console.log(`  overflowing faces = ${overflowing} / ${totalFaces}`);
  for (let i = 0; i < Math.min(15, overflows.length); i++) {
    const o = overflows[i];
    console.log(`  [${i}] face ${o.faceId} (${o.surfaceType}): tris=${o.triCount} overshoot=${o.worst.toFixed(3)} diag=${o.diag.toFixed(3)} ratio=${o.ratio.toFixed(2)}`);
  }
}

console.log('\nDONE.');
