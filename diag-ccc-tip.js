// Diagnostic: dump faces near corner (10,8,6) after C+C+C to verify sharp tip.
import { Part } from './js/cad/Part.js';
import { Sketch } from './js/cad/Sketch.js';
import { resetFeatureIds } from './js/cad/Feature.js';
import { resetTopoIds } from './js/cad/BRepTopology.js';
import { edgeKeyFromVerts } from './js/cad/toolkit/Vec3Utils.js';

const BOX_W = 10, BOX_H = 8, BOX_D = 6;

function makePlane() { return { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, xAxis: { x: 1, y: 0, z: 0 } }; }
resetFeatureIds(); resetTopoIds();
const part = new Part('B');
const sk = new Sketch();
sk.addSegment(0, 0, BOX_W, 0);
sk.addSegment(BOX_W, 0, BOX_W, BOX_H);
sk.addSegment(BOX_W, BOX_H, 0, BOX_H);
sk.addSegment(0, BOX_H, 0, 0);
part.addSketch(sk, makePlane());
part.extrude(part.getSketches()[0].id, BOX_D);

function getTopo(part) { const fin = part.getFinalGeometry(); return fin.geometry.topoBody; }
function findEdge(topo, axis) {
  for (const shell of topo.shells || []) {
    for (const face of shell.faces) {
      for (const loop of face.allLoops()) {
        for (const ce of loop.coedges) {
          const e = ce.edge;
          const sp = e.startVertex.point, ep = e.endVertex.point;
          const mid = { x: (sp.x + ep.x) / 2, y: (sp.y + ep.y) / 2, z: (sp.z + ep.z) / 2 };
          const dx = Math.abs(ep.x - sp.x), dy = Math.abs(ep.y - sp.y), dz = Math.abs(ep.z - sp.z);
          const len = Math.hypot(dx, dy, dz);
          if (axis === 'X' && dx / len > 0.9 && Math.abs(mid.y - BOX_H) < 0.01 && Math.abs(mid.z - BOX_D) < 0.01)
            return edgeKeyFromVerts(sp, ep);
          if (axis === 'Y' && dy / len > 0.9 && Math.abs(mid.x - BOX_W) < 0.01 && Math.abs(mid.z - BOX_D) < 0.01)
            return edgeKeyFromVerts(sp, ep);
          if (axis === 'Z' && dz / len > 0.9 && Math.abs(mid.x - BOX_W) < 0.01 && Math.abs(mid.y - BOX_H) < 0.01)
            return edgeKeyFromVerts(sp, ep);
        }
      }
    }
  }
  return null;
}

for (const ax of ['X', 'Y', 'Z']) {
  const k = findEdge(getTopo(part), ax);
  console.log(ax, '->', k);
  part.chamfer([k], 0.6);
}

const tb = getTopo(part);
console.log('\n=== Faces near corner (10,8,6) ===');
for (const shell of tb.shells || []) {
  for (const face of shell.faces) {
    let near = false;
    const verts = new Set();
    for (const loop of face.allLoops()) {
      for (const ce of loop.coedges) {
        const sp = ce.edge.startVertex.point, ep = ce.edge.endVertex.point;
        if ((sp.x > 8.5 && sp.y > 6.5 && sp.z > 4.5) || (ep.x > 8.5 && ep.y > 6.5 && ep.z > 4.5)) near = true;
        verts.add(`${sp.x.toFixed(3)},${sp.y.toFixed(3)},${sp.z.toFixed(3)}`);
        verts.add(`${ep.x.toFixed(3)},${ep.y.toFixed(3)},${ep.z.toFixed(3)}`);
      }
    }
    if (!near) continue;
    console.log(`face ${face.id} type=${face.surfaceType} shared=${JSON.stringify(face.shared || {})} nv=${verts.size}`);
    for (const v of verts) console.log(`  v ${v}`);
  }
}
