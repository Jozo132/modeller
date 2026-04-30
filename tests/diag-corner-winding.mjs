import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { resetFeatureIds } from '../js/cad/Feature.js';
import { resetTopoIds } from '../js/cad/BRepTopology.js';
import { edgeKeyFromVerts } from '../js/cad/toolkit/Vec3Utils.js';

const BOX_W = 10, BOX_H = 8, BOX_D = 6;
const CORNER_PARAM = 0.6;
const FILLET_SEG = 3;

function makeBox() {
  resetFeatureIds(); resetTopoIds();
  const part = new Part('Box');
  const s = new Sketch();
  s.addSegment(0, 0, BOX_W, 0);
  s.addSegment(BOX_W, 0, BOX_W, BOX_H);
  s.addSegment(BOX_W, BOX_H, 0, BOX_H);
  s.addSegment(0, BOX_H, 0, 0);
  part.addSketch(s, { origin: {x:0,y:0,z:0}, normal:{x:0,y:0,z:1}, xAxis:{x:1,y:0,z:0}, yAxis:{x:0,y:1,z:0} });
  part.extrude(part.getSketches()[0].id, BOX_D);
  return part;
}
function topOf(p) { return p.getFinalGeometry().geometry; }
function resolveAxisEdge(topo, axis) {
  const EPS = 0.25;
  const seen = new Set();
  const candidates = [];
  for (const face of topo.faces()) {
    for (const ce of face.outerLoop.coedges) {
      const e = ce.edge;
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      const a = e.startVertex.point, b = e.endVertex.point;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-4) continue;
      if (axis === 'X' && Math.abs(dx) / len >= 0.9
        && Math.abs(mid.y - BOX_H) <= EPS && Math.abs(mid.z - BOX_D) <= EPS) {
        candidates.push({ e, score: 0 });
      } else if (axis === 'Y' && Math.abs(dy) / len >= 0.9
        && Math.abs(mid.x - BOX_W) <= EPS && Math.abs(mid.z - BOX_D) <= EPS) {
        candidates.push({ e, score: 0 });
      } else if (axis === 'Z' && Math.abs(dz) / len >= 0.9
        && Math.abs(mid.x - BOX_W) <= EPS && Math.abs(mid.y - BOX_H) <= EPS) {
        candidates.push({ e, score: 0 });
      }
    }
  }
  if (!candidates.length) return null;
  return edgeKeyFromVerts(candidates[0].e.startVertex.point, candidates[0].e.endVertex.point);
}

const part = makeBox();
const k1 = resolveAxisEdge(topOf(part).topoBody, 'X');
part.fillet([k1], CORNER_PARAM, { segments: FILLET_SEG });
const k2 = resolveAxisEdge(topOf(part).topoBody, 'Y');
part.chamfer([k2], CORNER_PARAM);

const g = topOf(part);
const byTopo = new Map();
for (const f of g.faces) {
  const id = f.topoFaceId ?? -1;
  byTopo.set(id, (byTopo.get(id) || 0) + 1);
}
console.log('Triangles per topoFace:');
for (const [id, n] of [...byTopo].sort((a,b)=>a[0]-b[0])) {
  console.log(`  topoFace=${id}: ${n} tris`);
}

const tb = g.topoBody;
for (const face of tb.faces()) {
  if (face.id !== 19 && face.id !== 20) continue;
  console.log(`\ntopoFace ${face.id}: surface=${face.surface?.constructor?.name} sameSense=${face.sameSense} coedges=${face.outerLoop.coedges.length}`);
  const srf = face.surface;
  if (srf && srf.uMin !== undefined) {
    console.log(`  u=[${srf.uMin},${srf.uMax}] v=[${srf.vMin},${srf.vMax}] periodicU=${srf.periodicU||false} periodicV=${srf.periodicV||false}`);
  }
  for (const ce of face.outerLoop.coedges) {
    const e = ce.edge;
    const a = e.startVertex.point, b = e.endVertex.point;
    console.log(`    outerCE sameSense=${ce.sameSense} edge=${e.id} curve=${e.curve?.constructor?.name} start=(${a.x.toFixed(3)},${a.y.toFixed(3)},${a.z.toFixed(3)}) end=(${b.x.toFixed(3)},${b.y.toFixed(3)},${b.z.toFixed(3)})`);
  }
  if (face.innerLoops && face.innerLoops.length) {
    console.log(`  innerLoops: ${face.innerLoops.length}`);
    for (const loop of face.innerLoops) {
      for (const ce of loop.coedges) {
        const e = ce.edge;
        const a = e.startVertex.point, b = e.endVertex.point;
        console.log(`    innerCE sameSense=${ce.sameSense} edge=${e.id} start=(${a.x.toFixed(3)},${a.y.toFixed(3)},${a.z.toFixed(3)}) end=(${b.x.toFixed(3)},${b.y.toFixed(3)},${b.z.toFixed(3)})`);
      }
    }
  }
}
