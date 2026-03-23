// Diagnostic script for 2-edge fillet corner (box-fillet-2-p)
import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { makeEdgeKey } from '../js/cad/CSG.js';

function makeRectSketch(x1, y1, x2, y2) {
  const s = new Sketch();
  s.addSegment(x1, y1, x2, y1);
  s.addSegment(x2, y1, x2, y2);
  s.addSegment(x2, y2, x1, y2);
  s.addSegment(x1, y2, x1, y1);
  return s;
}

const part = new Part('T');
const sf = part.addSketch(makeRectSketch(0, 0, 10, 10));
part.extrude(sf.id, 10);
// Same edges as box-fillet-2-p.cmod: top-front and top-right meeting at (10,0,10)
const ek1 = makeEdgeKey({ x: 0, y: 0, z: 10 }, { x: 10, y: 0, z: 10 });
const ek2 = makeEdgeKey({ x: 10, y: 0, z: 10 }, { x: 10, y: 10, z: 10 });
part.fillet([ek1, ek2], 1, { segments: 8 });
const r = part.getFinalGeometry();
const geom = r.geometry;

const PREC = 5;
const fmt = (n) => (Math.abs(n) < 5e-6 ? 0 : n).toFixed(PREC);
const vk = (v) => `${fmt(v.x)},${fmt(v.y)},${fmt(v.z)}`;
const edgeMap = new Map();
for (let fi = 0; fi < geom.faces.length; fi++) {
  const verts = geom.faces[fi].vertices;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i], b = verts[(i + 1) % verts.length];
    const ka = vk(a), kb = vk(b);
    const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    const fwd = ka < kb;
    if (!edgeMap.has(key)) edgeMap.set(key, []);
    edgeMap.get(key).push({ fi, fwd });
  }
}
let boundary = 0, nonManifold = 0, winding = 0;
for (const [key, entries] of edgeMap) {
  if (entries.length === 1) boundary++;
  else if (entries.length === 2) {
    if (entries[0].fwd === entries[1].fwd) winding++;
  } else nonManifold++;
}
console.log('Manifold:', { boundary, nonManifold, winding });

const groups = {};
for (const f of geom.faces) {
  const g = f.faceGroup !== undefined ? f.faceGroup : -1;
  if (!groups[g]) groups[g] = { count: 0, isFillet: false, isCorner: false, isCurved: false };
  groups[g].count++;
  if (f.isFillet) groups[g].isFillet = true;
  if (f.isCorner) groups[g].isCorner = true;
  if (f.isCurved) groups[g].isCurved = true;
}
console.log('Face groups:', Object.keys(groups).length);
for (const g of Object.keys(groups)) {
  const info = groups[g];
  const type = info.isCorner ? '(corner)' : info.isFillet ? '(fillet)' : info.isCurved ? '(curved)' : '(flat)';
  console.log(`  Group ${g}: ${info.count} faces ${type}`);
}

console.log('Feature paths:', geom.paths.length);
let curvedPaths = 0;
for (const p of geom.paths) if (p.edgeIndices.length > 2) curvedPaths++;
console.log('Curved paths:', curvedPaths);

// Find corner faces and display details
let cornerCount = 0;
for (let fi = 0; fi < geom.faces.length; fi++) {
  const f = geom.faces[fi];
  if (f.isCorner) {
    cornerCount++;
    if (cornerCount <= 10) {
      console.log(`Corner face ${fi}: ${f.vertices.length} verts, group=${f.faceGroup}`,
        f.vertices.map(v => `(${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)})`).join(' '));
    }
  }
}
console.log('Total corner faces:', cornerCount);
console.log('Total mesh faces:', geom.faces.length);

// Check boundary edges in detail
if (boundary > 0) {
  console.log('\nBoundary edges:');
  let cnt = 0;
  for (const [key, entries] of edgeMap) {
    if (entries.length === 1 && cnt < 20) {
      const f = geom.faces[entries[0].fi];
      console.log(`  ${key}  face:${entries[0].fi} isFillet=${!!f.isFillet} isCorner=${!!f.isCorner} group=${f.faceGroup}`);
      cnt++;
    }
  }
}

// Check non-manifold edges
if (nonManifold > 0) {
  console.log('\nNon-manifold edges:');
  let cnt = 0;
  for (const [key, entries] of edgeMap) {
    if (entries.length > 2 && cnt < 10) {
      console.log(`  ${key}  ${entries.length} faces: ${entries.map(e => e.fi).join(', ')}`);
      cnt++;
    }
  }
}

// Examine group 43 (curved faces near corner)
console.log('\nGroup 43 (curved) details:');
for (let fi = 0; fi < geom.faces.length; fi++) {
  const f = geom.faces[fi];
  if (f.faceGroup === 43) {
    console.log(`  Face ${fi}: ${f.vertices.length}v isFillet=${!!f.isFillet} isCorner=${!!f.isCorner} isCurved=${!!f.isCurved}`);
    console.log(`    verts: ${f.vertices.map(v => `(${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)})`).join(' ')}`);
  }
}

// Examine any faces near vertex (10, 0, 10) that look unusual
console.log('\nFaces touching vertex near (10, 0, 10):');
for (let fi = 0; fi < geom.faces.length; fi++) {
  const f = geom.faces[fi];
  let touches = false;
  for (const v of f.vertices) {
    const d = Math.sqrt((v.x - 10) ** 2 + v.y ** 2 + (v.z - 10) ** 2);
    if (d < 1.5) { touches = true; break; }
  }
  if (touches) {
    console.log(`  Face ${fi}: ${f.vertices.length}v group=${f.faceGroup} isFillet=${!!f.isFillet} isCorner=${!!f.isCorner}`);
  }
}

// Check all face groups with their spatial extent 
console.log('\nGroup extents:');
for (const g of Object.keys(groups)) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const f of geom.faces) {
    if (String(f.faceGroup) !== g) continue;
    for (const v of f.vertices) {
      minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
      minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
      minZ = Math.min(minZ, v.z); maxZ = Math.max(maxZ, v.z);
    }
  }
  console.log(`  Group ${g}: x[${minX.toFixed(2)},${maxX.toFixed(2)}] y[${minY.toFixed(2)},${maxY.toFixed(2)}] z[${minZ.toFixed(2)},${maxZ.toFixed(2)}]`);
}

// BRep info
if (r.geometry.brep) {
  const brep = r.geometry.brep;
  console.log(`\nBRep: ${brep.faces ? brep.faces.length : 0} faces, ${brep.edges ? brep.edges.length : 0} edges`);
  if (brep.faces) {
    for (const f of brep.faces) {
      if (f.surfaceType === 'spherical' || f.surfaceType === 'fillet') {
        const hasNurbs = f.surface ? `NURBS deg=(${f.surface.degreeU},${f.surface.degreeV})` : 'no NURBS';
        console.log(`  ${f.surfaceType} face [${hasNurbs}]`);
      }
    }
  }
}
