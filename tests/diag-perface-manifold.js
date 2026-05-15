// For each face, check its per-face mesh internal consistency:
//   - boundary edges: should count ~= outer + inner loop boundary segments
//   - interior edges: should all be used by exactly 2 triangles
//   - non-manifold (>2): PER-FACE BUG
// Diagnostic-only: intentionally uses Tessellator2 compatibility code.
//
// If per-face mesh is clean but stitched mesh has issues, the bug is in
// the stitcher / edge-sampling agreement between adjacent faces.

import fs from 'node:fs';
import { Part } from '../js/cad/Part.js';
import { parseCMOD } from '../js/cmod.js';
import { robustTessellateBody } from '../js/cad/Tessellator2/index.js';

const raw = fs.readFileSync('tests/samples/Unnamed-Body.cmod', 'utf-8');
const part = Part.deserialize(parseCMOD(raw).data.part);
const body = part.getFinalGeometry().body;
const tess = robustTessellateBody(body);

const QUANT = 1e-4;
function key(v) { return `${Math.round(v.x / QUANT)},${Math.round(v.y / QUANT)},${Math.round(v.z / QUANT)}`; }

const trisByFace = new Map();
for (const t of tess.faces) {
  if (t.topoFaceId == null) continue;
  if (!trisByFace.has(t.topoFaceId)) trisByFace.set(t.topoFaceId, []);
  trisByFace.get(t.topoFaceId).push(t);
}

let totalPerFaceNonManifold = 0;
const perFaceReport = [];
for (const [fid, tris] of trisByFace) {
  const edgeMap = new Map();
  for (const t of tris) {
    if (!t.vertices || t.vertices.length !== 3) continue;
    const ka = key(t.vertices[0]), kb = key(t.vertices[1]), kc = key(t.vertices[2]);
    for (const [x, y] of [[ka, kb], [kb, kc], [kc, ka]]) {
      const k = x < y ? `${x}|${y}` : `${y}|${x}`;
      edgeMap.set(k, (edgeMap.get(k) || 0) + 1);
    }
  }
  let boundary = 0, manifold = 0, nm = 0, maxUse = 0;
  for (const [, c] of edgeMap) {
    if (c === 1) boundary++;
    else if (c === 2) manifold++;
    else { nm++; if (c > maxUse) maxUse = c; }
  }
  if (nm > 0) {
    totalPerFaceNonManifold += nm;
    let sType = '?';
    for (const sh of body.shells) for (const f of sh.faces) if (f.id === fid) sType = f.surfaceType;
    perFaceReport.push({ fid, sType, tris: tris.length, boundary, manifold, nm, maxUse });
  }
}

perFaceReport.sort((a, b) => b.nm - a.nm);
console.log(`Per-face non-manifold summary: ${totalPerFaceNonManifold} total non-manifold edges across ${perFaceReport.length} faces`);
console.log(`(If this is > 0 then the bug is in FaceTriangulator itself, not in MeshStitcher.)`);
for (const r of perFaceReport.slice(0, 10)) {
  console.log(`  face ${r.fid} (${r.sType}): tris=${r.tris} bnd=${r.boundary} mfd=${r.manifold} nm=${r.nm} (max ${r.maxUse}x)`);
}
