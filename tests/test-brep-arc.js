// tests/test-brep-arc.js — Verify BRep edge sharing between caps and cylindrical sides
import { Part } from '../js/cad/Part.js';
import { Sketch } from '../js/cad/Sketch.js';
import { resetFeatureIds } from '../js/cad/Feature.js';
import { resetTopoIds } from '../js/cad/BRepTopology.js';
import { tessellateBody } from '../js/cad/Tessellation.js';

resetFeatureIds();
resetTopoIds();

// Rectangle with semicircular bulge on right side
const part = new Part('ArcTest');
const sketch = new Sketch();
sketch.addSegment(-10, -10, -10, 10);
sketch.addSegment(-10, 10, 10, 10);
// Semicircular arc: c=(10,0), r=10, from 90° to -90° (π/2 to -π/2)
sketch.addArc(10, 0, 10, Math.PI / 2, -Math.PI / 2);
sketch.addSegment(10, -10, -10, -10);

const plane = {
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  xAxis: { x: 1, y: 0, z: 0 },
  yAxis: { x: 0, y: 1, z: 0 },
};
part.addSketch(sketch, plane);
part.extrude(part.getSketches()[0].id, 10);

const geom = part.featureTree.features.find(f => f.type === 'extrude').result.geometry;
const tb = geom.topoBody;
if (!tb) { console.log('No topoBody'); process.exit(1); }

const faces = tb.shells[0].faces;
console.log('TopoFaces:', faces.length);
for (const f of faces) {
  console.log('  Face', f.id, f.surfaceType, 'edges:', f.outerLoop.coedges.length);
}

// Count unique edges and check sharing
const edgeRefCount = new Map();
for (const f of faces) {
  for (const ce of f.outerLoop.coedges) {
    const eid = ce.edge.id;
    edgeRefCount.set(eid, (edgeRefCount.get(eid) || 0) + 1);
  }
}
let boundary = 0;
for (const [eid, count] of edgeRefCount) {
  if (count < 2) boundary++;
}
console.log('Unique edges:', edgeRefCount.size);
console.log('Boundary edges:', boundary);

// Tessellate and validate
try {
  const result = tessellateBody(tb, { validate: true });
  console.log('Tessellation faces:', result.faces.length, 'verts:', result.vertices.length);
  console.log('isClean:', result.isClean);
  if (result.boundaryEdges) console.log('Boundary edges in tess:', result.boundaryEdges);
  if (result.nonManifoldEdges) console.log('Non-manifold edges in tess:', result.nonManifoldEdges);
} catch(e) {
  console.log('Tessellation error:', e.message);
  console.log(e.stack);
}
