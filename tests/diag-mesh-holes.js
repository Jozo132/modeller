// Count body-mesh boundary edges: in a watertight stitched mesh every
// triangle edge is shared by exactly 2 triangles. Any 1-use edge is a
// hole in the mesh.

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
console.log(`Mesh: ${tess.faces.length} triangles, ${tess.vertices ? tess.vertices.length : '?'} stitched vertices`);

// Build edge use-count across the full body mesh.
// Use vertex positions (quantized) rather than indices, because tess.faces
// may not share index space with tess.vertices (each tri stores its own
// vertex objects).
const edgeMap = new Map(); // "kx-ky" normalized
const QUANT = 1e-4;
function key(v) {
  return `${Math.round(v.x / QUANT)},${Math.round(v.y / QUANT)},${Math.round(v.z / QUANT)}`;
}
const faceIdByEdge = new Map(); // edge key -> Set<topoFaceId>
for (const t of tess.faces) {
  if (!t.vertices || t.vertices.length !== 3) continue;
  const ka = key(t.vertices[0]);
  const kb = key(t.vertices[1]);
  const kc = key(t.vertices[2]);
  for (const [x, y] of [[ka, kb], [kb, kc], [kc, ka]]) {
    const k = x < y ? `${x}|${y}` : `${y}|${x}`;
    edgeMap.set(k, (edgeMap.get(k) || 0) + 1);
    if (!faceIdByEdge.has(k)) faceIdByEdge.set(k, new Set());
    if (t.topoFaceId != null) faceIdByEdge.get(k).add(t.topoFaceId);
  }
}

let manifold = 0, boundary = 0, nonManifold = 0;
const boundaryEdges = [];
const nonManifoldEdges = [];
for (const [k, cnt] of edgeMap) {
  if (cnt === 1) { boundary++; boundaryEdges.push(k); }
  else if (cnt === 2) manifold++;
  else { nonManifold++; nonManifoldEdges.push({ k, cnt }); }
}
console.log(`MESH EDGES:`);
console.log(`  manifold (2 uses)    = ${manifold}`);
console.log(`  boundary (1 use)     = ${boundary}   <-- holes`);
console.log(`  non-manifold (>2)    = ${nonManifold}   <-- overlaps / duplicates`);

// Which topoFaces are on the boundary edges?
const faceBoundaryCount = new Map();
for (const k of boundaryEdges) {
  const faces = faceIdByEdge.get(k);
  if (!faces) continue;
  for (const fid of faces) faceBoundaryCount.set(fid, (faceBoundaryCount.get(fid) || 0) + 1);
}
const sorted = [...faceBoundaryCount.entries()].sort((a, b) => b[1] - a[1]);
console.log(`\nTop faces by mesh-boundary-edge count:`);
for (let i = 0; i < Math.min(20, sorted.length); i++) {
  const [fid, cnt] = sorted[i];
  let sType = '?';
  for (const shell of body.shells) for (const face of shell.faces) if (face.id === fid) sType = face.surfaceType;
  console.log(`  face ${fid} (${sType}): ${cnt} boundary edges`);
}

// Print first 5 boundary edge positions to show where the holes are
console.log(`\nFirst 5 mesh-boundary edges (3D positions):`);
for (let i = 0; i < Math.min(5, boundaryEdges.length); i++) {
  const [a, b] = boundaryEdges[i].split('|');
  const decode = s => s.split(',').map(n => Number(n) * QUANT);
  const pa = decode(a), pb = decode(b);
  console.log(`  [${i}] (${pa[0].toFixed(3)},${pa[1].toFixed(3)},${pa[2].toFixed(3)}) -> (${pb[0].toFixed(3)},${pb[1].toFixed(3)},${pb[2].toFixed(3)})  faces=${[...faceIdByEdge.get(boundaryEdges[i])].join(',')}`);
}

// Non-manifold face distribution
const nmFaceCount = new Map();
for (const { k, cnt } of nonManifoldEdges) {
  const faces = faceIdByEdge.get(k);
  if (!faces) continue;
  for (const fid of faces) {
    if (!nmFaceCount.has(fid)) nmFaceCount.set(fid, { count: 0, maxUse: 0 });
    const rec = nmFaceCount.get(fid);
    rec.count++;
    if (cnt > rec.maxUse) rec.maxUse = cnt;
  }
}
const nmSorted = [...nmFaceCount.entries()].sort((a, b) => b[1].count - a[1].count);
console.log(`\nTop faces by non-manifold-edge count (max-use shows worst overlap):`);
for (let i = 0; i < Math.min(20, nmSorted.length); i++) {
  const [fid, rec] = nmSorted[i];
  let sType = '?';
  for (const shell of body.shells) for (const face of shell.faces) if (face.id === fid) sType = face.surfaceType;
  console.log(`  face ${fid} (${sType}): ${rec.count} non-manifold edges (max uses=${rec.maxUse})`);
}
