import './_watchdog.mjs';
import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { resetFeatureIds } from '../js/cad/Feature.js';
import { resetTopoIds } from '../js/cad/BRepTopology.js';
import { edgeKeyFromVerts } from '../js/cad/toolkit/Vec3Utils.js';

process.env.DEBUG_FCF = '1';

resetFeatureIds();
resetTopoIds();
const BOX_W = 10, BOX_H = 8, BOX_D = 6;
const part = new Part('FCF');
const sketch = new Sketch();
sketch.addSegment(0, 0, BOX_W, 0);
sketch.addSegment(BOX_W, 0, BOX_W, BOX_H);
sketch.addSegment(BOX_W, BOX_H, 0, BOX_H);
sketch.addSegment(0, BOX_H, 0, 0);
part.addSketch(sketch, { origin:{x:0,y:0,z:0}, normal:{x:0,y:0,z:1}, uDirection:{x:1,y:0,z:0}, vDirection:{x:0,y:1,z:0} });
part.extrude(part.getSketches()[0].id, BOX_D);

function findEdge(part, axis) {
  const topo = part.getFinalGeometry().geometry.topoBody;
  const seen = new Set();
  for (const face of topo.faces()) {
    for (const ce of face.outerLoop.coedges) {
      const e = ce.edge;
      if (seen.has(e.id)) continue; seen.add(e.id);
      const a = e.startVertex.point, b = e.endVertex.point;
      const mid = { x:(a.x+b.x)/2, y:(a.y+b.y)/2, z:(a.z+b.z)/2 };
      const EPS = 0.25;
      if (axis==='x' && Math.abs(mid.y-BOX_H)<EPS && Math.abs(mid.z-BOX_D)<EPS && Math.abs(b.x-a.x)>0.1) return [a,b];
      if (axis==='y' && Math.abs(mid.x-BOX_W)<EPS && Math.abs(mid.z-BOX_D)<EPS && Math.abs(b.y-a.y)>0.1) return [a,b];
      if (axis==='z' && Math.abs(mid.x-BOX_W)<EPS && Math.abs(mid.y-BOX_H)<EPS && Math.abs(b.z-a.z)>0.1) return [a,b];
    }
  }
  return null;
}

const xE = findEdge(part,'x');
part.fillet([edgeKeyFromVerts(xE[0],xE[1])], 0.6, { segments: 8 });
console.log('=== after fillet X ===');
const yE = findEdge(part,'y');
console.log('yEdge verts:', yE);
part.chamfer([edgeKeyFromVerts(yE[0],yE[1])], 0.6);
console.log('=== after chamfer Y ===');
const zE = findEdge(part,'z');
console.log('zEdge verts:', zE);
try { part.fillet([edgeKeyFromVerts(zE[0],zE[1])], 0.6, { segments: 8 }); console.log('=== fillet Z OK ==='); }
catch(e){ console.log('fillet Z ERROR:', e.message); }

// Check mesh of intermediate (F,C) result
// Just check counts via getFinalGeometry
const gFinal = part.getFinalGeometry().geometry;
console.log('FINAL face count:', gFinal.topoBody.faces.length);

