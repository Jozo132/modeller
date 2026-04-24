import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { resetFeatureIds } from '../js/cad/Feature.js';
import { resetTopoIds } from '../js/cad/BRepTopology.js';
import { edgeKeyFromVerts } from '../js/cad/toolkit/Vec3Utils.js';

const W=10,H=8,D=6,R=0.6,SEG=3;
function makeBox() {
  resetFeatureIds(); resetTopoIds();
  const p = new Part('Box');
  const s = new Sketch();
  s.addSegment(0,0,W,0); s.addSegment(W,0,W,H); s.addSegment(W,H,0,H); s.addSegment(0,H,0,0);
  p.addSketch(s, {origin:{x:0,y:0,z:0},normal:{x:0,y:0,z:1},xAxis:{x:1,y:0,z:0},yAxis:{x:0,y:1,z:0}});
  p.extrude(p.getSketches()[0].id, D);
  return p;
}
function topOf(p) { return p.getFinalGeometry().geometry; }
function axisEdge(topo, axis) {
  const seen = new Set();
  for (const f of topo.faces()) for (const ce of f.outerLoop.coedges) {
    const e = ce.edge; if (seen.has(e.id)) continue; seen.add(e.id);
    const a = e.startVertex.point, b = e.endVertex.point;
    const m = {x:(a.x+b.x)/2,y:(a.y+b.y)/2,z:(a.z+b.z)/2};
    const dx=b.x-a.x,dy=b.y-a.y,dz=b.z-a.z,L=Math.hypot(dx,dy,dz);
    if (L<1e-4) continue;
    const EPS=0.25;
    if (axis==='X' && Math.abs(dx)/L>=0.9 && Math.abs(m.y-H)<=EPS && Math.abs(m.z-D)<=EPS) return edgeKeyFromVerts(a,b);
    if (axis==='Y' && Math.abs(dy)/L>=0.9 && Math.abs(m.x-W)<=EPS && Math.abs(m.z-D)<=EPS) return edgeKeyFromVerts(a,b);
    if (axis==='Z' && Math.abs(dz)/L>=0.9 && Math.abs(m.x-W)<=EPS && Math.abs(m.y-H)<=EPS) return edgeKeyFromVerts(a,b);
  }
  return null;
}

const part = makeBox();
for (const ax of ['X','Y','Z']) {
  const k = axisEdge(topOf(part).topoBody, ax);
  if (k) part.fillet([k], R, {segments:SEG});
}
const g = topOf(part);
const fmt = (n) => (Math.abs(n) < 5e-6 ? 0 : n).toFixed(5);
const vk = (v) => `${fmt(v.x)},${fmt(v.y)},${fmt(v.z)}`;
const edgeMap = new Map();
for (let fi = 0; fi < g.faces.length; fi++) {
  const verts = g.faces[fi].vertices;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i], b = verts[(i + 1) % verts.length];
    const ka = vk(a), kb = vk(b);
    const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    if (!edgeMap.has(key)) edgeMap.set(key, []);
    edgeMap.get(key).push({ fi });
  }
}
const boundary = [];
for (const [key, entries] of edgeMap) {
  if (entries.length === 1) {
    boundary.push({ key, tfid: g.faces[entries[0].fi].topoFaceId });
  }
}
console.log(`Total boundary edges: ${boundary.length}`);
for (const e of boundary.slice(0,40)) console.log(`  ${e.key}  tf=${e.tfid}`);

// For each boundary edge endpoint, check presence in other topoFaces
const coordsPerTF = new Map();
for (const f of g.faces) {
  const tf = f.topoFaceId;
  if (!coordsPerTF.has(tf)) coordsPerTF.set(tf, new Set());
  for (const v of f.vertices) coordsPerTF.get(tf).add(vk(v));
}
console.log('\nPresence of boundary endpoints in all topoFaces:');
const seenPt = new Set();
for (const e of boundary) {
  for (const p of e.key.split('|')) {
    if (seenPt.has(p)) continue;
    seenPt.add(p);
    const tfs = [];
    for (const [tf, set] of coordsPerTF) if (set.has(p)) tfs.push(tf);
    console.log(`  ${p} -> tf=[${tfs.join(',')}]`);
  }
}

// What does F29 have in the region around E64 (arcs from 9.4,7.4,6 to 10,7.4,5.4)?
console.log('\nF29 mesh points with x>9.3, y>7.4 (at corner end):');
const f29 = [...coordsPerTF.get(29)].filter(k => {
  const [x,y] = k.split(',').map(Number);
  return x > 9.3 && y > 7.405;
}).sort();
for (const p of f29) console.log(`  ${p}`);
console.log(`  (${f29.length} total)`);
