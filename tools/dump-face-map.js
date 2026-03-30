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

// Count boundary edges (shared by exactly 1 triangle)
const precision = 5;
const vKey = (v) => `${v.x.toFixed(precision)},${v.y.toFixed(precision)},${v.z.toFixed(precision)}`;
const eKey = (a, b) => {
  const ka = vKey(a);
  const kb = vKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
};

const edgeCounts = new Map();
for (const face of faces) {
  const verts = face.vertices || [];
  const fid = face.topoFaceId ?? -1;
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

let boundary = 0;
let nonManifold = 0;
let internal = 0;
const boundaryByFace = new Map(); // topoFaceId -> count of boundary edges

for (const [, info] of edgeCounts) {
  if (info.count === 1) {
    boundary++;
    for (const fid of info.faceIds) {
      boundaryByFace.set(fid, (boundaryByFace.get(fid) || 0) + 1);
    }
  } else if (info.count === 2) {
    internal++;
  } else {
    nonManifold++;
  }
}

console.log(`\nEdge summary: ${internal} internal, ${boundary} boundary (holes), ${nonManifold} non-manifold`);
console.log(`\nBoundary edges by topoFaceId:`);
const sorted = [...boundaryByFace.entries()].sort((a, b) => b[1] - a[1]);
for (const [fid, count] of sorted) {
  // Find face type
  const sample = faces.find(f => f.topoFaceId === fid);
  const ftype = sample?.faceType || '?';
  console.log(`  face ${fid}: ${count} boundary edges (${ftype})`);
}

// Also check for cross-face boundary edges (edges between faces that don't stitch)
console.log(`\nCross-face boundary analysis:`);
const crossFaceEdges = new Map();
for (const [, info] of edgeCounts) {
  if (info.count === 1 && info.faceIds.size === 1) {
    // This boundary edge belongs to only 1 face.
    // Check if a nearby vertex exists in another face.
    const fid = [...info.faceIds][0];
    const key = vKey(info.a);
    if (!crossFaceEdges.has(fid)) crossFaceEdges.set(fid, []);
    crossFaceEdges.get(fid).push(info);
  }
}
