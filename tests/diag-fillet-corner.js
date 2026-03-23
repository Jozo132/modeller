// Diagnostic script for 3-edge fillet corner
import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { calculateMeshVolume, makeEdgeKey, computeFeatureEdges } from '../js/cad/CSG.js';

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
const ek1 = makeEdgeKey({ x: 0, y: 10, z: 10 }, { x: 10, y: 10, z: 10 }); // top-back
const ek2 = makeEdgeKey({ x: 10, y: 0, z: 10 }, { x: 10, y: 10, z: 10 }); // top-right
const ek3 = makeEdgeKey({ x: 10, y: 10, z: 0 }, { x: 10, y: 10, z: 10 }); // vertical
part.fillet([ek1, ek2, ek3], 1, { segments: 8 });
const r = part.getFinalGeometry();
const geom = r.geometry;

// Count face groups
const groups = {};
for (let fi = 0; fi < geom.faces.length; fi++) {
  const f = geom.faces[fi];
  const g = f.faceGroup !== undefined ? f.faceGroup : -1;
  if (!groups[g]) groups[g] = { count: 0, isFillet: false, isCurved: false };
  groups[g].count++;
  if (f.isFillet) groups[g].isFillet = true;
  if (f.isCurved) groups[g].isCurved = true;
}
const groupKeys = Object.keys(groups);
console.log('Face groups:', groupKeys.length);
for (const g of groupKeys) {
  const info = groups[g];
  const type = info.isFillet ? '(fillet)' : (info.isCurved ? '(curved)' : '(flat)');
  console.log(`  Group ${g}: ${info.count} faces ${type}`);
}

console.log('\nPaths (feature lines):', geom.paths.length);
let curvedPaths = 0;
for (let i = 0; i < geom.paths.length; i++) {
  const p = geom.paths[i];
  const isCurved = p.edgeIndices.length > 2;
  if (isCurved) curvedPaths++;
  // Find which face groups this path borders
  const groupPairs = new Set();
  for (const ei of p.edgeIndices) {
    const e = geom.edges[ei];
    if (e && e.faces) {
      const gs = e.faces.map(fi => geom.faces[fi] ? geom.faces[fi].faceGroup : '?');
      groupPairs.add(gs.sort().join('-'));
    }
  }
  // Show first/last vertex of path for spatial identification
  const e0 = geom.edges[p.edgeIndices[0]];
  const eLast = geom.edges[p.edgeIndices[p.edgeIndices.length - 1]];
  const v0 = (e0 && e0.a) ? `(${e0.a.x.toFixed(1)},${e0.a.y.toFixed(1)},${e0.a.z.toFixed(1)})` : '?';
  const v1 = (eLast && eLast.b) ? `(${eLast.b.x.toFixed(1)},${eLast.b.y.toFixed(1)},${eLast.b.z.toFixed(1)})` : '?';
  console.log(`  Path ${i}: ${p.edgeIndices.length} edges, groups:[${[...groupPairs].join(',')}] ${v0}→${v1}${isCurved ? ' (curved)' : ''}`);
}
console.log(`\nCurved paths: ${curvedPaths}`);

// Manifold check
const PREC = 5;
const fmt = (n) => (Math.abs(n) < 5e-6 ? 0 : n).toFixed(PREC);
const vk = (v) => `${fmt(v.x)},${fmt(v.y)},${fmt(v.z)}`;
const edgeMap = {};
for (let fi = 0; fi < geom.faces.length; fi++) {
  const verts = geom.faces[fi].vertices;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i], b = verts[(i + 1) % verts.length];
    const ka = vk(a), kb = vk(b);
    const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    const fwd = ka < kb;
    if (!edgeMap[key]) edgeMap[key] = [];
    edgeMap[key].push({ fi, fwd });
  }
}
let boundary = 0, nonManifold = 0, winding = 0;
const windingEdges = [];
for (const key of Object.keys(edgeMap)) {
  const entries = edgeMap[key];
  if (entries.length === 1) boundary++;
  else if (entries.length === 2) {
    if (entries[0].fwd === entries[1].fwd) {
      winding++;
      windingEdges.push({ key, fi0: entries[0].fi, fi1: entries[1].fi });
    }
  }
  else nonManifold++;
}
console.log(`\nManifold: boundary=${boundary} nonManifold=${nonManifold} winding=${winding}`);
console.log('Total mesh faces:', geom.faces.length);
console.log('Total feature edges:', geom.edges.length);

// Check BRep data
if (r.geometry.brep) {
  const brep = r.geometry.brep;
  console.log(`\nBRep: ${brep.faces ? brep.faces.length : 0} faces, ${brep.edges ? brep.edges.length : 0} edges`);
  if (brep.faces) {
    for (const f of brep.faces) {
      if (f.surfaceType === 'spherical') {
        const hasNurbs = f.surface ? `NURBS deg=(${f.surface.degreeU},${f.surface.degreeV}) ${f.surface.numRowsU}x${f.surface.numColsV}` : 'no NURBS';
        console.log(`  Spherical face: center=(${f.sphereCenter.x.toFixed(3)},${f.sphereCenter.y.toFixed(3)},${f.sphereCenter.z.toFixed(3)}) r=${f.sphereRadius.toFixed(3)} [${hasNurbs}]`);
        if (f.surface) {
          console.log(`    Weights: [${f.surface.weights.map(w => w.toFixed(4)).join(', ')}]`);
        }
      } else if (f.surfaceType === 'fillet' && f.surface) {
        console.log(`  Fillet face: NURBS deg=(${f.surface.degreeU},${f.surface.degreeV}) ${f.surface.numRowsU}x${f.surface.numColsV}`);
      }
    }
  }
}

// Show details about singleton/unusual groups
for (const g of groupKeys) {
  const info = groups[g];
  if (info.count <= 2 && !info.isFillet) {
    for (let fi = 0; fi < geom.faces.length; fi++) {
      const f = geom.faces[fi];
      if (String(f.faceGroup) === g) {
        console.log(`\nFace ${fi} in singleton group ${g}:`, {
          nVerts: f.vertices.length,
          isFillet: !!f.isFillet,
          isCorner: !!f.isCorner,
          isCurved: !!f.isCurved,
          normal: f.normal ? `${f.normal.x.toFixed(3)},${f.normal.y.toFixed(3)},${f.normal.z.toFixed(3)}` : 'none',
          verts: f.vertices.map(v => `(${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)})`)
        });
      }
    }
  }
}

if (winding > 0) {
  console.log('\nFirst 5 winding errors:');
  for (let i = 0; i < Math.min(5, windingEdges.length); i++) {
    const w = windingEdges[i];
    const f0 = geom.faces[w.fi0];
    const f1 = geom.faces[w.fi1];
    console.log(`  Edge: ${w.key}`);
    console.log(`    Face ${w.fi0}: isFillet=${f0.isFillet||false} nVerts=${f0.vertices.length}`);
    console.log(`    Face ${w.fi1}: isFillet=${f1.isFillet||false} nVerts=${f1.vertices.length}`);
  }
}
