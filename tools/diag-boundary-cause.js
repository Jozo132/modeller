// tools/diag-boundary-cause.js — Diagnose WHY boundary edges exist.
// For each face, track the pre-filter and post-filter triangle counts,
// and identify which boundary-edge segments are unmatched.

import fs from 'node:fs';
import path from 'node:path';
import { Part } from '../js/cad/Part.js';

const cmodPath = path.resolve('tests', 'samples', 'Unnamed-Body.cmod');
const raw = fs.readFileSync(cmodPath, 'utf8');
const data = JSON.parse(raw);
const partData = data.part || data;
const part = Part.deserialize(partData);
const geo = part.getFinalGeometry();
if (!geo?.geometry) { console.error('No geometry'); process.exit(1); }

const faces = geo.geometry.faces || [];
console.log(`Total triangles: ${faces.length}`);

// Gather all vertices per face (by topoFaceId)
const faceGroups = new Map(); // topoFaceId -> [{vertices, ...}]
for (const f of faces) {
  const fid = f.topoFaceId ?? -1;
  if (!faceGroups.has(fid)) faceGroups.set(fid, []);
  faceGroups.get(fid).push(f);
}

// Build the boundary edge map
const precision = 5;
const p10 = 10;
const vKey5 = (v) => `${v.x.toFixed(precision)},${v.y.toFixed(precision)},${v.z.toFixed(precision)}`;
const vKey10 = (v) => `${v.x.toFixed(p10)},${v.y.toFixed(p10)},${v.z.toFixed(p10)}`;
const eKey = (a, b) => {
  const ka = vKey5(a), kb = vKey5(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
};

// Build a set of all unique vertex positions across all faces
const allVertsByKey10 = new Map(); // vKey10 -> {x,y,z, faceIds: Set}
for (const f of faces) {
  const fid = f.topoFaceId ?? -1;
  for (const v of f.vertices || []) {
    const k = vKey10(v);
    if (!allVertsByKey10.has(k)) allVertsByKey10.set(k, { v, faceIds: new Set() });
    allVertsByKey10.get(k).faceIds.add(fid);
  }
}

// Count how many faces each vertex appears in
const vertexSharing = new Map(); // vKey5 -> Set of topoFaceIds
for (const f of faces) {
  const fid = f.topoFaceId ?? -1;
  for (const v of f.vertices || []) {
    const k = vKey5(v);
    if (!vertexSharing.has(k)) vertexSharing.set(k, new Set());
    vertexSharing.get(k).add(fid);
  }
}

// Find boundary edges
const edgeCounts = new Map();
for (const f of faces) {
  const verts = f.vertices || [];
  const fid = f.topoFaceId ?? -1;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    const key = eKey(a, b);
    if (!edgeCounts.has(key)) edgeCounts.set(key, { a, b, count: 0, faceIds: new Set() });
    const info = edgeCounts.get(key);
    info.count++;
    info.faceIds.add(fid);
  }
}

let boundary = 0, internal = 0, nonManifold = 0;

const boundaryEdges = [];
for (const [key, info] of edgeCounts) {
  if (info.count === 1) {
    boundary++;
    boundaryEdges.push(info);
  } else if (info.count === 2) {
    internal++;
  } else {
    nonManifold++;
  }
}
console.log(`Edge summary: ${internal} internal, ${boundary} boundary, ${nonManifold} non-manifold`);

// For each boundary edge, check:
// 1. Do both endpoints exist in multiple faces? (vertex is shared, but edge is not)
// 2. Is one endpoint exclusive to this face? (vertex not shared → missing from adjacent face)
let bothShared = 0;
let oneExclusive = 0;
let bothExclusive = 0;
let vertexPositionMismatch = 0;

for (const info of boundaryEdges) {
  const fid = [...info.faceIds][0];
  const kA = vKey5(info.a);
  const kB = vKey5(info.b);
  const sharingA = vertexSharing.get(kA) || new Set();
  const sharingB = vertexSharing.get(kB) || new Set();
  const aShared = sharingA.size > 1;
  const bShared = sharingB.size > 1;

  if (aShared && bShared) {
    bothShared++;
  } else if (!aShared && !bShared) {
    bothExclusive++;
  } else {
    oneExclusive++;
  }
}

console.log(`\nBoundary edge vertex analysis (precision=${precision}):`);
console.log(`  Both endpoints shared with other faces: ${bothShared} (topology mismatch or triangle filter)`);
console.log(`  One endpoint exclusive to face: ${oneExclusive} (vertex mismatch or missing)`);
console.log(`  Both endpoints exclusive to face: ${bothExclusive} (completely unmatched)`);

// Now check at higher precision: are "exclusive" vertices actually close to vertices
// in other faces but not matching at precision=5?
console.log(`\nChecking if "exclusive" vertices have near-matches at precision=10:`);
let mismatchAt10 = 0;
for (const info of boundaryEdges) {
  const fid = [...info.faceIds][0];
  for (const v of [info.a, info.b]) {
    const k5 = vKey5(v);
    const sharing5 = vertexSharing.get(k5) || new Set();
    if (sharing5.size <= 1) {
      // This vertex exists only in this face at precision=5
      // Check if there's a near-match at precision=10 in other faces
      const k10 = vKey10(v);
      const info10 = allVertsByKey10.get(k10);
      if (info10 && info10.faceIds.size > 1) {
        mismatchAt10++;
      }
    }
  }
}
console.log(`  Vertices exclusive at prec=5 but shared at prec=10: ${mismatchAt10}`);

// Now look specifically at the top boundary-edge faces
console.log(`\n--- Detailed per-face analysis (top offenders) ---`);
const boundaryByFace = new Map();
for (const info of boundaryEdges) {
  const fid = [...info.faceIds][0];
  if (!boundaryByFace.has(fid)) boundaryByFace.set(fid, []);
  boundaryByFace.get(fid).push(info);
}

const sortedFaces = [...boundaryByFace.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [fid, edges] of sortedFaces.slice(0, 8)) {
  const sample = faces.find(f => f.topoFaceId === fid);
  const ftype = sample?.faceType || '?';
  const totalTris = faceGroups.get(fid)?.length || 0;

  let bothS = 0, oneE = 0, bothE = 0;
  for (const info of edges) {
    const kA = vKey5(info.a);
    const kB = vKey5(info.b);
    const aS = (vertexSharing.get(kA) || new Set()).size > 1;
    const bS = (vertexSharing.get(kB) || new Set()).size > 1;
    if (aS && bS) bothS++;
    else if (!aS && !bS) bothE++;
    else oneE++;
  }

  console.log(`\n  Face ${fid} (${ftype}, ${totalTris} tris, ${edges.length} boundary edges):`);
  console.log(`    both-shared: ${bothS}, one-exclusive: ${oneE}, both-exclusive: ${bothE}`);

  // Show a few example boundary edges
  for (const e of edges.slice(0, 3)) {
    const kA = vKey5(e.a);
    const kB = vKey5(e.b);
    const aFaces = [...(vertexSharing.get(kA) || [])].join(',');
    const bFaces = [...(vertexSharing.get(kB) || [])].join(',');
    console.log(`    edge: (${e.a.x.toFixed(3)}, ${e.a.y.toFixed(3)}, ${e.a.z.toFixed(3)})→(${e.b.x.toFixed(3)}, ${e.b.y.toFixed(3)}, ${e.b.z.toFixed(3)})`);
    console.log(`      vertex A in faces [${aFaces}], vertex B in faces [${bFaces}]`);
  }
}
