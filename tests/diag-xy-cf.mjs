// Diagnostic: X+Y chamfer→fillet — dump BRep faces, edges, and boundary
// vertices around the shared corner (10,8,6).
import assert from 'node:assert';
import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { resetFeatureIds } from '../js/cad/Feature.js';
import { resetTopoIds } from '../js/cad/BRepTopology.js';
import { checkWatertight } from '../js/cad/MeshValidator.js';

function makePlane() {
  return { origin: { x: 0, y: 0, z: 0 }, xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 } };
}

const W = 10, H = 8, D = 6;

resetFeatureIds(); resetTopoIds();
const part = new Part('p');
const sk = new Sketch();
sk.addSegment(0, 0, W, 0);
sk.addSegment(W, 0, W, H);
sk.addSegment(W, H, 0, H);
sk.addSegment(0, H, 0, 0);
part.addSketch(sk, makePlane());
part.extrude(part.getSketches()[0].id, D);

const fmt = c => (+c.toFixed(6) || 0).toFixed(6);
const vk = v => `${fmt(v.x)},${fmt(v.y)},${fmt(v.z)}`;

function findEdge(topo, predicate) {
  const seen = new Set();
  for (const f of topo.faces()) for (const ce of f.outerLoop.coedges) {
    const e = ce.edge; if (seen.has(e.id)) continue; seen.add(e.id);
    const a = e.startVertex.point, b = e.endVertex.point;
    if (predicate(a, b)) {
      return `${vk(a)}|${vk(b)}`;
    }
  }
  return null;
}

const topo0 = part.getFinalGeometry().geometry.topoBody;
const xKey = findEdge(topo0, (a, b) => Math.abs(a.y - H) < 0.01 && Math.abs(b.y - H) < 0.01 && Math.abs(a.z - D) < 0.01 && Math.abs(b.z - D) < 0.01);
console.log('chamfer X-edge:', xKey);
part.chamfer([xKey], 0.6);

const topo1 = part.getFinalGeometry().geometry.topoBody;
const yKey = findEdge(topo1, (a, b) => {
  const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  if (len < 0.01) return false;
  if (Math.abs((b.y - a.y) / len) < 0.9) return false;
  return Math.abs(a.x - W) < 0.01 && Math.abs(b.x - W) < 0.01 && Math.abs(a.z - D) < 0.01 && Math.abs(b.z - D) < 0.01;
});
console.log('fillet Y-edge:', yKey);
part.fillet([yKey], 0.6, { segments: 3 });

const finGeom = part.getFinalGeometry().geometry;
const topo2 = finGeom.topoBody;
const wt = checkWatertight(finGeom.faces);
console.log(`\nMesh boundary count: ${wt.boundaryCount}, faces (triangles): ${finGeom.faces.length}`);

console.log('\nBRep faces:');
let fi = 0;
for (const shell of topo2.shells) for (const face of shell.faces) {
  const verts = face.outerLoop.coedges.map(ce => ce.sameSense !== false ? ce.edge.startVertex.point : ce.edge.endVertex.point);
  const corner = verts.some(v => Math.abs(v.x - W) < 0.7 && Math.abs(v.y - H) < 0.7 && Math.abs(v.z - D) < 0.7);
  if (!corner) { fi++; continue; }
  console.log(`  face[${fi}] (${verts.length} coedges):`);
  for (let i = 0; i < face.outerLoop.coedges.length; i++) {
    const ce = face.outerLoop.coedges[i];
    const a = ce.sameSense !== false ? ce.edge.startVertex.point : ce.edge.endVertex.point;
    const b = ce.sameSense !== false ? ce.edge.endVertex.point : ce.edge.startVertex.point;
    const c = ce.edge.curve;
    const cps = c && c.controlPoints ? c.controlPoints.length : 0;
    const deg = c ? c.degree : '?';
    console.log(`    ce[${i}]: (${fmt(a.x)},${fmt(a.y)},${fmt(a.z)}) -> (${fmt(b.x)},${fmt(b.y)},${fmt(b.z)})  curve=deg${deg}/${cps}cp  surfaceType=${face.surface && face.surface.type}`);
  }
  fi++;
}

if (wt.boundaryCount > 0) {
  console.log('\nBoundary edges:');
  for (const e of wt.edges.slice(0, 20)) {
    console.log(`  (${fmt(e.a.x)},${fmt(e.a.y)},${fmt(e.a.z)}) -> (${fmt(e.b.x)},${fmt(e.b.y)},${fmt(e.b.z)})`);
  }
}
