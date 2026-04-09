import { Part } from './js/cad/Part.js';
import { Sketch } from './js/cad/Sketch.js';
import { resetFeatureIds } from './js/cad/Feature.js';
import { resetTopoIds } from './js/cad/BRepTopology.js';

// Create a parallelogram extrusion where side faces meet at non-90° angles
resetFeatureIds();
resetTopoIds();
const part = new Part('T');
const s = new Sketch();
// Simple parallelogram: slanted top and bottom edges
s.addSegment(0, 0, 10, 0);   // bottom
s.addSegment(10, 0, 15, 10);  // right side (slanted)  
s.addSegment(15, 10, 5, 10);  // top
s.addSegment(5, 10, 0, 0);    // left side (slanted)
const sf = part.addSketch(s);
part.extrude(sf.id, 10);

let result = part.getFinalGeometry();
const geom = result.geometry;

console.log('=== Face normals ===');
for (let fi = 0; fi < geom.faces.length; fi++) {
  const f = geom.faces[fi];
  console.log(`Face ${fi}: normal=(${f.normal.x.toFixed(4)}, ${f.normal.y.toFixed(4)}, ${f.normal.z.toFixed(4)})`);
  if (fi < 4) { // side faces
    const verts = f.vertices;
    for (const v of verts) {
      console.log(`  v=(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`);
    }
  }
}

// Find the vertical edge at the non-90° corner (10, 0, 0)→(10, 0, 10)
// This edge is between the bottom face (normal -Y) and the right-slanted face
const fmt = n => (Math.abs(n) < 5e-6 ? 0 : n).toFixed(5);
const vk = v => `${fmt(v.x)},${fmt(v.y)},${fmt(v.z)}`;

// Find the vertical edge at vertex (10,0): between bottom side and right-slanted side
// Bottom side: from (0,0) to (10,0), normal should be (0,-1,0)
// Right side: from (10,0) to (15,10), normal depends on slope

// The edge from (10,0,0) to (10,0,10) is between bottom face and right face
const ek1 = `${fmt(10)},${fmt(0)},${fmt(0)}|${fmt(10)},${fmt(0)},${fmt(10)}`;
console.log(`\nFillet edge key: ${ek1}`);

// Compute dihedral angle at this edge
// Bottom face normal: (0, -1, 0)
// Right face: from (10,0) to (15,10), edge dir = (5,10), normal = cross(edge2D, Z) rotated
// Right face vertices: (10,0,0),(15,10,0),(15,10,10),(10,0,10), normal = ...
// Edge dir: from (10,0,z) → right face perpendicular 
const rightDir = {x: 15-10, y: 10-0, z: 0}; // (5, 10, 0) 
const rightLen = Math.sqrt(25+100);
const rightNorm = {x: 10/rightLen, y: -5/rightLen, z: 0}; // cross(edgeDir2D, Z)  
// Actually: outward normal for face with verts (10,0),(15,10) going rightward
// Normal = cross(up, edgeDir) = cross((0,0,1), (5/len, 10/len, 0)) = (-10/len, 5/len, 0)
// hmm, let me just check the dot product
console.log(`\nBottom face normal: (0, -1, 0)`);
console.log(`Right face normal: (${rightNorm.x.toFixed(4)}, ${rightNorm.y.toFixed(4)}, 0)`);
const dihedralCos = 0 * rightNorm.x + (-1) * rightNorm.y;
console.log(`cos(dihedral angle between normals) = ${dihedralCos.toFixed(4)}`);
console.log(`Dihedral angle between normals = ${(Math.acos(dihedralCos) * 180 / Math.PI).toFixed(1)}°`);

// Apply fillet to this non-90° edge
part.fillet([ek1], 1, { segments: 8 });
result = part.getFinalGeometry();
const geomF = result.geometry;
console.log(`\nAfter fillet: faces = ${geomF.faces?.length}`);

const topoF = geomF.topoBody;
if (topoF?.shells?.[0]) {
  for (const face of topoF.shells[0].faces) {
    if (face.surfaceType !== 'plane' && face.surface) {
      const surf = face.surface;
      console.log(`\nFillet surface (Face ${face.id}): degU=${surf.degreeU}, degV=${surf.degreeV}, rows=${surf.numRowsU}, cols=${surf.numColsV}`);
      for (let r = 0; r < surf.numRowsU; r++) {
        for (let c = 0; c < surf.numColsV; c++) {
          const cp = surf.controlPoints[r * surf.numColsV + c];
          const w = surf.weights ? surf.weights[r * surf.numColsV + c] : 1;
          console.log(`  [${r},${c}]: (${cp.x.toFixed(5)}, ${cp.y.toFixed(5)}, ${cp.z.toFixed(5)}) w=${w.toFixed(6)}`);
        }
      }
      
      // Check tangency at boundaries
      const uMid = (surf.uMin + surf.uMax) / 2;
      const n_v0 = surf.normal(uMid, surf.vMin);
      const n_v1 = surf.normal(uMid, surf.vMax);
      console.log(`  Normal at v=0: (${n_v0.x.toFixed(5)}, ${n_v0.y.toFixed(5)}, ${n_v0.z.toFixed(5)})`);
      console.log(`  Normal at v=1: (${n_v1.x.toFixed(5)}, ${n_v1.y.toFixed(5)}, ${n_v1.z.toFixed(5)})`);

      // Check edge curves
      for (const coedge of face.outerLoop?.coedges || []) {
        const e = coedge.edge;
        const sp = e.startVertex.point;
        const ep = e.endVertex.point;
        console.log(`  Edge: (${sp.x.toFixed(4)}, ${sp.y.toFixed(4)}, ${sp.z.toFixed(4)}) -> (${ep.x.toFixed(4)}, ${ep.y.toFixed(4)}, ${ep.z.toFixed(4)})`);
      }
    }
  }
}

// Also apply chamfer to same edge for comparison
resetFeatureIds();
resetTopoIds();
const part2 = new Part('T2');
const s2 = new Sketch();
s2.addSegment(0, 0, 10, 0);
s2.addSegment(10, 0, 15, 10);
s2.addSegment(15, 10, 5, 10);
s2.addSegment(5, 10, 0, 0);
const sf2 = part2.addSketch(s2);
part2.extrude(sf2.id, 10);
part2.chamfer([ek1], 1);
result = part2.getFinalGeometry();
const geomC = result.geometry;
console.log(`\n=== Chamfer comparison ===`);
const topoC = geomC.topoBody;
if (topoC?.shells?.[0]) {
  for (const face of topoC.shells[0].faces) {
    if (face.surfaceType !== 'plane' && face.surface) {
      const surf = face.surface;
      console.log(`\nChamfer surface (Face ${face.id}): degU=${surf.degreeU}, degV=${surf.degreeV}`);
      for (let r = 0; r < surf.numRowsU; r++) {
        for (let c = 0; c < surf.numColsV; c++) {
          const cp = surf.controlPoints[r * surf.numColsV + c];
          console.log(`  [${r},${c}]: (${cp.x.toFixed(5)}, ${cp.y.toFixed(5)}, ${cp.z.toFixed(5)})`);
        }
      }
    }
  }
}
