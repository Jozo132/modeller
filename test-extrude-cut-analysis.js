import { readFileSync } from 'fs';
import { Part } from './js/cad/Part.js';
import { parseCMOD } from './js/cmod.js';

function loadCMOD(filename) {
  const raw = readFileSync(`tests/samples/${filename}`, 'utf-8');
  const parsed = parseCMOD(raw);
  if (!parsed.ok) { console.log('PARSE FAIL'); return null; }
  return Part.deserialize(parsed.data.part);
}

function faceNormal(face) {
  const pts = face.outerLoop?.points();
  if (!pts || pts.length < 3) return { x: 0, y: 0, z: 0 };
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const curr = pts[i];
    const next = pts[(i + 1) % pts.length];
    nx += (curr.y - next.y) * (curr.z + next.z);
    ny += (curr.z - next.z) * (curr.x + next.x);
    nz += (curr.x - next.x) * (curr.y + next.y);
  }
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len > 1e-10) { nx /= len; ny /= len; nz /= len; }
  if (face.sameSense === false) { nx = -nx; ny = -ny; nz = -nz; }
  return { x: nx, y: ny, z: nz };
}

function dumpBody(label, body) {
  if (!body) { console.log(`${label}: no body`); return; }
  const faces = body.faces();
  console.log(`${label}: ${faces.length} BRep faces`);
  
  // Find coincident face pairs (same location, opposite normals)
  for (let i = 0; i < faces.length; i++) {
    const fi = faces[i];
    const ni = faceNormal(fi);
    const pi = fi.outerLoop?.points();
    if (!pi) continue;
    const xi = pi.map(p => p.x), yi = pi.map(p => p.y), zi = pi.map(p => p.z);
    const bi = { minX: Math.min(...xi), maxX: Math.max(...xi), minY: Math.min(...yi), maxY: Math.max(...yi), minZ: Math.min(...zi), maxZ: Math.max(...zi) };
    
    for (let j = i + 1; j < faces.length; j++) {
      const fj = faces[j];
      const nj = faceNormal(fj);
      const pj = fj.outerLoop?.points();
      if (!pj) continue;
      const xj = pj.map(p => p.x), yj = pj.map(p => p.y), zj = pj.map(p => p.z);
      const bj = { minX: Math.min(...xj), maxX: Math.max(...xj), minY: Math.min(...yj), maxY: Math.max(...yj), minZ: Math.min(...zj), maxZ: Math.max(...zj) };
      
      // Check if faces overlap in space and have opposite normals
      const dot = ni.x*nj.x + ni.y*nj.y + ni.z*nj.z;
      const overlapX = Math.max(bi.minX, bj.minX) < Math.max(bi.maxX, bj.maxX);
      const overlapY = Math.max(bi.minY, bj.minY) < Math.max(bi.maxY, bj.maxY);
      const overlapZ = Math.max(bi.minZ, bj.minZ) < Math.max(bi.maxZ, bj.maxZ);
      
      if (Math.abs(dot + 1) < 0.01) { // opposite normals
        // Check if they're coplanar (same plane)
        const samePlane = 
          Math.abs(bi.minX - bj.minX) < 0.1 && Math.abs(bi.maxX - bj.maxX) < 0.1 &&
          Math.abs(bi.minY - bj.minY) < 0.1 && Math.abs(bi.maxY - bj.maxY) < 0.1 &&
          Math.abs(bi.minZ - bj.minZ) < 0.1 && Math.abs(bi.maxZ - bj.maxZ) < 0.1;
        if (samePlane) {
          console.log(`  *** COINCIDENT PAIR: F${i} vs F${j}`);
          console.log(`    F${i}: N=(${ni.x.toFixed(3)},${ni.y.toFixed(3)},${ni.z.toFixed(3)}) bounds=[${bi.minX.toFixed(2)},${bi.maxX.toFixed(2)}]x[${bi.minY.toFixed(2)},${bi.maxY.toFixed(2)}]x[${bi.minZ.toFixed(2)},${bi.maxZ.toFixed(2)}]`);
          console.log(`    F${j}: N=(${nj.x.toFixed(3)},${nj.y.toFixed(3)},${nj.z.toFixed(3)}) bounds=[${bj.minX.toFixed(2)},${bj.maxX.toFixed(2)}]x[${bj.minY.toFixed(2)},${bj.maxY.toFixed(2)}]x[${bj.minZ.toFixed(2)},${bj.maxZ.toFixed(2)}]`);
        }
      }
    }
  }
}

// Check extrude-on-extrude-dual WITHOUT cut
console.log('=== extrude-on-extrude-dual (NO cut) ===');
const part1 = loadCMOD('extrude-on-extrude-dual.cmod');
const result1 = part1.getFinalGeometry();
const geom1 = result1?.geometry || result1;
dumpBody('dual-no-cut', geom1?.topoBody);

console.log('\n=== extrude-on-extrude-dual-with-cut ===');
const part2 = loadCMOD('extrude-on-extrude-dual-with-cut.cmod');
const result2 = part2.getFinalGeometry();
const geom2 = result2?.geometry || result2;
dumpBody('dual-with-cut', geom2?.topoBody);

console.log('\n=== simple-extrude-cut ===');
const part3 = loadCMOD('simple-extrude-cut.cmod');
const result3 = part3.getFinalGeometry();
const geom3 = result3?.geometry || result3;
dumpBody('simple-cut', geom3?.topoBody);
