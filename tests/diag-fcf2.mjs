// Diagnose F,C,F — what is topoFace 24 in the final body?
import '../tests/_watchdog.mjs';
import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { resetFeatureIds } from '../js/cad/Feature.js';
import { resetTopoIds } from '../js/cad/BRepTopology.js';
import { edgeKeyFromVerts } from '../js/cad/toolkit/Vec3Utils.js';

function makePlane() {
  return { origin: {x:0,y:0,z:0}, normal: {x:0,y:0,z:1}, xAxis: {x:1,y:0,z:0}, yAxis: {x:0,y:1,z:0} };
}

const BOX_W = 10, BOX_H = 8, BOX_D = 6;

function makeBoxPart() {
  resetFeatureIds(); resetTopoIds();
  const part = new Part('B');
  const s = new Sketch();
  s.addSegment(0,0,BOX_W,0); s.addSegment(BOX_W,0,BOX_W,BOX_H);
  s.addSegment(BOX_W,BOX_H,0,BOX_H); s.addSegment(0,BOX_H,0,0);
  part.addSketch(s, makePlane());
  part.extrude(part.getSketches()[0].id, BOX_D);
  return part;
}

function resolveAxisKey(topo, axis) {
  const EPS = 0.25;
  const seen = new Set();
  let best = null, bestScore = Infinity;
  for (const face of topo.faces()) {
    if (!face.outerLoop) continue;
    for (const ce of face.outerLoop.coedges) {
      const e = ce.edge;
      if (seen.has(e.id)) continue; seen.add(e.id);
      const a = e.startVertex.point, b = e.endVertex.point;
      const dx = b.x-a.x, dy = b.y-a.y, dz = b.z-a.z;
      const len = Math.hypot(dx,dy,dz);
      if (len < 1e-4) continue;
      const mid = { x:(a.x+b.x)/2, y:(a.y+b.y)/2, z:(a.z+b.z)/2 };
      let score = Infinity;
      if (axis==='X' && Math.abs(dx)/len>0.9 && Math.abs(mid.y-BOX_H)<EPS && Math.abs(mid.z-BOX_D)<EPS) score = Math.abs(mid.y-BOX_H)+Math.abs(mid.z-BOX_D);
      if (axis==='Y' && Math.abs(dy)/len>0.9 && Math.abs(mid.x-BOX_W)<EPS && Math.abs(mid.z-BOX_D)<EPS) score = Math.abs(mid.x-BOX_W)+Math.abs(mid.z-BOX_D);
      if (axis==='Z' && Math.abs(dz)/len>0.9 && Math.abs(mid.x-BOX_W)<EPS && Math.abs(mid.y-BOX_H)<EPS) score = Math.abs(mid.x-BOX_W)+Math.abs(mid.y-BOX_H);
      if (score < bestScore) { best = e; bestScore = score; }
    }
  }
  return best ? edgeKeyFromVerts(best.startVertex.point, best.endVertex.point) : null;
}

function dumpTopo(topo, tag) {
  console.log(`\n=== ${tag} ===`);
  const faces = [...topo.faces()];
  console.log(`topoFaces: ${faces.length}`);
  for (const face of faces) {
    if (!face.outerLoop) { console.log(`  face id=${face.id} type=${face.surfaceType} — NO outerLoop`); continue; }
    const coedges = face.outerLoop.coedges;
    const verts = coedges.map(ce => ce.startVertex().point).filter(Boolean);
    const vs = verts.slice(0, 8).map(v => `(${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)})`).join(' ');
    console.log(`  face id=${face.id} type=${face.surfaceType} coedges=${coedges.length} verts[${verts.length}]: ${vs}${verts.length>8?'...':''}`);
  }
}

const part = makeBoxPart();
let topo = part.getFinalGeometry().geometry.topoBody;
part.fillet([resolveAxisKey(topo, 'X')], 0.6, { segments: 3 });
topo = part.getFinalGeometry().geometry.topoBody;
part.chamfer([resolveAxisKey(topo, 'Y')], 0.6);
topo = part.getFinalGeometry().geometry.topoBody;
dumpTopo(topo, 'BEFORE Z-fillet');

try {
  part.fillet([resolveAxisKey(topo, 'Z')], 0.6, { segments: 3 });
} catch(e) { console.log('Z ERR:', e.message); }
topo = part.getFinalGeometry().geometry.topoBody;
dumpTopo(topo, 'AFTER Z-fillet');

// Identify any triangular faces
for (const face of topo.faces()) {
  if (!face.outerLoop) continue;
  const n = face.outerLoop.coedges.length;
  if (n === 3) {
    console.log(`\n*** TRIANGULAR face id=${face.id} type=${face.surfaceType} ***`);
    for (const ce of face.outerLoop.coedges) {
      const s = ce.startVertex().point, e = ce.endVertex().point;
      console.log(`  (${s.x.toFixed(3)},${s.y.toFixed(3)},${s.z.toFixed(3)}) → (${e.x.toFixed(3)},${e.y.toFixed(3)},${e.z.toFixed(3)}) edge.id=${ce.edge.id} sameSense=${ce.sameSense} curve.deg=${ce.edge.curve?.degree} cps=${ce.edge.curve?.controlPoints?.length}`);
    }
  }
}
