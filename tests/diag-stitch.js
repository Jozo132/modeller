// Diagnose cross-face mesh stitching. For every shared edge, sample both
// adjacent faces' mesh boundary along that edge and compare 3D positions.
// Gaps indicate tessellation inconsistency -> visible holes.

import './_watchdog.mjs';
import fs from 'node:fs';
import { Part } from '../js/cad/Part.js';
import { parseCMOD } from '../js/cmod.js';
import { robustTessellateBody } from '../js/cad/Tessellator2/index.js';

const raw = fs.readFileSync('tests/samples/Unnamed-Body.cmod', 'utf-8');
const parsed = parseCMOD(raw);
const part = Part.deserialize(parsed.data.part);
const body = part.getFinalGeometry().body;

const tess = robustTessellateBody(body);

// Group tris by face id
const trisByFace = new Map();
for (const t of tess.faces) {
  if (t.topoFaceId == null) continue;
  if (!trisByFace.has(t.topoFaceId)) trisByFace.set(t.topoFaceId, []);
  trisByFace.get(t.topoFaceId).push(t);
}

// Build face->edges map and edge->faces map
const edgeFaces = new Map(); // edgeId -> [faceId, faceId]
for (const shell of body.shells) {
  for (const face of shell.faces) {
    for (const loop of [face.outerLoop, ...(face.innerLoops || [])].filter(Boolean)) {
      for (const ce of loop.coedges) {
        const eid = ce.edge.id;
        if (!edgeFaces.has(eid)) edgeFaces.set(eid, []);
        if (!edgeFaces.get(eid).includes(face.id)) edgeFaces.get(eid).push(face.id);
      }
    }
  }
}

// Extract boundary vertices per face: any vertex used by exactly 1 triangle edge
// in this face's mesh is a mesh-boundary vertex.
function faceMeshBoundaryVerts(fid) {
  const tris = trisByFace.get(fid) || [];
  // Build edge->count within this face's mesh
  const edgeMap = new Map(); // "i-j" -> count, i<j
  const verts = [];
  const vMap = new Map(); // hash -> index
  function keyV(v) { return `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`; }
  function addV(v) { const k = keyV(v); let idx = vMap.get(k); if (idx == null) { idx = verts.length; vMap.set(k, idx); verts.push({ x: v.x, y: v.y, z: v.z }); } return idx; }
  for (const t of tris) {
    if (!t.vertices || t.vertices.length !== 3) continue;
    const a = addV(t.vertices[0]), b = addV(t.vertices[1]), c = addV(t.vertices[2]);
    const addE = (i, j) => { const k = i < j ? `${i}-${j}` : `${j}-${i}`; edgeMap.set(k, (edgeMap.get(k) || 0) + 1); };
    addE(a, b); addE(b, c); addE(c, a);
  }
  const boundarySet = new Set();
  for (const [k, cnt] of edgeMap) if (cnt === 1) {
    const [i, j] = k.split('-').map(Number);
    boundarySet.add(i); boundarySet.add(j);
  }
  return [...boundarySet].map(i => verts[i]);
}

// For each edge shared by 2 faces, check that every mesh-boundary point of
// face A lies close to the edge's curve AND to the set of mesh-boundary
// points of face B (within tol).
let sharedChecked = 0;
let sharedMismatched = 0;
const mismatches = [];

for (const [eid, faces] of edgeFaces) {
  if (faces.length !== 2) continue;
  const [fa, fb] = faces;
  // Find the edge object
  let edge = null;
  for (const shell of body.shells) {
    for (const face of shell.faces) {
      for (const loop of [face.outerLoop, ...(face.innerLoops || [])].filter(Boolean)) {
        for (const ce of loop.coedges) if (ce.edge.id === eid) edge = ce.edge;
      }
    }
  }
  if (!edge || !edge.curve) continue;
  sharedChecked++;

  // Sample edge curve
  const curve = edge.curve;
  const u0 = curve.uMin ?? 0, u1 = curve.uMax ?? 1;
  const N = 32;
  const edgeSamples = [];
  for (let k = 0; k <= N; k++) edgeSamples.push(curve.evaluate(u0 + (u1 - u0) * (k / N)));

  const baVerts = faceMeshBoundaryVerts(fa);
  const bbVerts = faceMeshBoundaryVerts(fb);

  // For each edge-sample, find closest boundary vert on each face
  let maxGap = 0;
  for (const p of edgeSamples) {
    const distA = baVerts.length ? Math.min(...baVerts.map(v => Math.hypot(v.x - p.x, v.y - p.y, v.z - p.z))) : Infinity;
    const distB = bbVerts.length ? Math.min(...bbVerts.map(v => Math.hypot(v.x - p.x, v.y - p.y, v.z - p.z))) : Infinity;
    const g = Math.max(distA, distB);
    if (g > maxGap) maxGap = g;
  }

  // Tolerance: 1% of edge length or 0.01 absolute
  const edgeLen = Math.hypot(edgeSamples[0].x - edgeSamples[N].x, edgeSamples[0].y - edgeSamples[N].y, edgeSamples[0].z - edgeSamples[N].z) || 1;
  const tol = Math.max(0.01, edgeLen * 0.02);
  if (maxGap > tol) {
    sharedMismatched++;
    mismatches.push({ edgeId: eid, faces: [fa, fb], maxGap, edgeLen, tol });
  }
}

console.log(`SHARED-EDGE STITCH CHECK`);
console.log(`  shared edges tested  = ${sharedChecked}`);
console.log(`  edges with gap > tol = ${sharedMismatched}`);
mismatches.sort((a, b) => b.maxGap - a.maxGap);
for (let i = 0; i < Math.min(15, mismatches.length); i++) {
  const m = mismatches[i];
  console.log(`  [${i}] edge#${m.edgeId}: faces ${m.faces.join(' ↔ ')}  gap=${m.maxGap.toFixed(4)}  edgeLen=${m.edgeLen.toFixed(3)}  tol=${m.tol.toFixed(3)}`);
  // Surface types
  for (const fid of m.faces) {
    for (const shell of body.shells) for (const face of shell.faces) if (face.id === fid) {
      console.log(`       face ${fid}: ${face.surfaceType}`);
    }
  }
}

console.log('\nDONE.');
