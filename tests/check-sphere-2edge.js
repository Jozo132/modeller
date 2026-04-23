import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { makeEdgeKey } from '../js/cad/EdgeAnalysis.js';

const s = new Sketch();
s.addSegment(0, 0, 10, 0);
s.addSegment(10, 0, 10, 10);
s.addSegment(10, 10, 0, 10);
s.addSegment(0, 10, 0, 0);

const part = new Part('T');
const sf = part.addSketch(s);
part.extrude(sf.id, 10);
const ek1 = makeEdgeKey({ x: 0, y: 0, z: 10 }, { x: 10, y: 0, z: 10 });
const ek2 = makeEdgeKey({ x: 10, y: 0, z: 10 }, { x: 10, y: 10, z: 10 });
part.fillet([ek1, ek2], 1, { segments: 8 });
const r = part.getFinalGeometry();

// Check sphere accuracy
let maxDev = 0, count = 0;
for (const f of r.geometry.faces) {
  if (!f.isCorner || !f._sphereCenter) continue;
  const C = f._sphereCenter, R = f._sphereRadius;
  for (const v of f.vertices) {
    const d = Math.sqrt((v.x - C.x) ** 2 + (v.y - C.y) ** 2 + (v.z - C.z) ** 2);
    const dev = Math.abs(d - R);
    if (dev > maxDev) maxDev = dev;
    count++;
  }
}
console.log('Corner vertices checked:', count, 'max dev from sphere:', maxDev.toFixed(8));
const cf = r.geometry.faces.find(f => f.isCorner);
console.log('Sphere center:', cf._sphereCenter, 'radius:', cf._sphereRadius.toFixed(6));

// Check that bottom arc lies on the face plane
const topFace = r.geometry.faces.find(f => f.faceGroup === 1 || (f.vertices.length > 6 && !f.isFillet && !f.isCorner));
if (topFace) {
  const zVals = topFace.vertices.map(v => v.z);
  const minZ = Math.min(...zVals), maxZ = Math.max(...zVals);
  console.log('Top face z range:', minZ.toFixed(6), 'to', maxZ.toFixed(6), '(', topFace.vertices.length, 'verts)');
}
