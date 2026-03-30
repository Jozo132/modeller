// tools/diag-face-inventory.js — List all 60 B-Rep faces with their
// type, location, triangle count, boundary edges, and whether they
// are fully tessellated or have zero/few triangles.

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
const precision = 5;
const vKey = (v) => `${v.x.toFixed(precision)},${v.y.toFixed(precision)},${v.z.toFixed(precision)}`;
const eKey = (a, b) => {
  const ka = vKey(a), kb = vKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
};

// Count edges per triangle
const edgeCounts = new Map();
for (const face of faces) {
  const verts = face.vertices || [];
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i], b = verts[(i + 1) % verts.length];
    const key = eKey(a, b);
    edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
  }
}

// Group by topoFaceId
const groups = new Map();
for (const f of faces) {
  const fid = f.topoFaceId ?? -1;
  if (!groups.has(fid)) groups.set(fid, []);
  groups.get(fid).push(f);
}

console.log(`Total: ${faces.length} triangles, ${groups.size} topological faces\n`);
console.log('ID  | Type               | Tris | BndEdges | Center (x, y, z)         | BBox diag');
console.log('----|--------------------+------+----------+--------------------------+----------');

const sortedGroups = [...groups.entries()].sort((a, b) => a[0] - b[0]);
for (const [fid, tris] of sortedGroups) {
  const ftype = tris[0]?.faceType || '?';
  
  // Compute centroid and bbox
  let sx = 0, sy = 0, sz = 0, count = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const tri of tris) {
    for (const v of tri.vertices || []) {
      sx += v.x; sy += v.y; sz += v.z; count++;
      if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
      if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
      if (v.z < minZ) minZ = v.z; if (v.z > maxZ) maxZ = v.z;
    }
  }
  const cx = (sx / count).toFixed(1);
  const cy = (sy / count).toFixed(1);
  const cz = (sz / count).toFixed(1);
  const diag = Math.sqrt((maxX-minX)**2 + (maxY-minY)**2 + (maxZ-minZ)**2).toFixed(2);
  
  // Count boundary edges for this face
  let bndCount = 0;
  for (const tri of tris) {
    const verts = tri.vertices || [];
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      const key = eKey(a, b);
      if (edgeCounts.get(key) === 1) bndCount++;
    }
  }
  
  const pad = (s, n) => String(s).padStart(n);
  const padR = (s, n) => String(s).padEnd(n);
  console.log(`${pad(fid, 3)} | ${padR(ftype, 18)}| ${pad(tris.length, 4)} | ${pad(bndCount, 8)} | (${pad(cx, 6)}, ${pad(cy, 6)}, ${pad(cz, 6)}) | ${pad(diag, 8)}`);
}

// Find faces with 0 triangles in the B-Rep but present in topology
// (by checking the input STEP face count vs tessellation output)
console.log(`\n--- Faces with many boundary edges (>10) ---`);
for (const [fid, tris] of sortedGroups) {
  let bndCount = 0;
  for (const tri of tris) {
    const verts = tri.vertices || [];
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      const key = eKey(a, b);
      if (edgeCounts.get(key) === 1) bndCount++;
    }
  }
  if (bndCount > 10) {
    const ftype = tris[0]?.faceType || '?';
    console.log(`  Face ${fid} (${ftype}): ${tris.length} tris, ${bndCount} boundary edges`);
  }
}

// Check for cylinder faces specifically
console.log(`\n--- All cylinder faces ---`);
for (const [fid, tris] of sortedGroups) {
  const ftype = tris[0]?.faceType || '?';
  if (!ftype.includes('cylinder')) continue;
  let bndCount = 0;
  for (const tri of tris) {
    const verts = tri.vertices || [];
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      const key = eKey(a, b);
      if (edgeCounts.get(key) === 1) bndCount++;
    }
  }
  let sx = 0, sy = 0, sz = 0, count = 0;
  let minZ = Infinity, maxZ = -Infinity;
  for (const tri of tris) {
    for (const v of tri.vertices || []) {
      sx += v.x; sy += v.y; sz += v.z; count++;
      if (v.z < minZ) minZ = v.z;
      if (v.z > maxZ) maxZ = v.z;
    }
  }
  const cx = (sx/count).toFixed(2);
  const cy = (sy/count).toFixed(2);
  const cz = (sz/count).toFixed(2);
  console.log(`  Face ${fid}: ${tris.length} tris, ${bndCount} bnd, center=(${cx}, ${cy}, ${cz}), Z=[${minZ.toFixed(2)}, ${maxZ.toFixed(2)}]`);
}
