import { Part } from './js/cad/Part.js';
import { Sketch } from './js/cad/Sketch.js';
import { resetFeatureIds } from './js/cad/Feature.js';
import { resetTopoIds } from './js/cad/BRepTopology.js';

// Create a parallelogram-like extrusion similar to custom-part-1
resetFeatureIds();
resetTopoIds();
const part = new Part('T');
const s = new Sketch();
s.addSegment(11.945649653607544, 21.939717330576602, 31.715091265628416, 18.911645945553072);
s.addSegment(31.715091265628416, 18.911645945553072, 23.14796415375031, 0.8394487083918707);
s.addSegment(23.14796415375031, 0.8394487083918707, 3.3785222027752795, 3.8675210148073678);
s.addSegment(3.3785222027752795, 3.8675210148073678, 11.945649653607544, 21.939717330576602);
const sf = part.addSketch(s);
part.extrude(sf.id, 17);

let result = part.getFinalGeometry();
const geom = result.geometry;
console.log('After extrude: faces =', geom.faces?.length);

// List all face normals
for (let fi = 0; fi < geom.faces.length; fi++) {
  const f = geom.faces[fi];
  console.log(`Face ${fi}: normal=(${f.normal.x.toFixed(4)}, ${f.normal.y.toFixed(4)}, ${f.normal.z.toFixed(4)}), verts=${f.vertices.length}`);
}

// Apply fillet to the top edge (same as custom-part-1.cmod)
const fek = '11.94565,21.93972,17.00000|31.71509,18.91165,17.00000';
part.fillet([fek], 1, { segments: 8 });

result = part.getFinalGeometry();
const geomF = result.geometry;
console.log('\nAfter fillet: faces =', geomF.faces?.length);

// Check fillet TopoBody surface details
const topoF = geomF.topoBody;
if (topoF?.shells?.[0]) {
  const shell = topoF.shells[0];
  console.log('Fillet TopoBody faces:', shell.faces.length);
  for (const face of shell.faces) {
    const sType = face.surfaceType;
    const nEdges = face.outerLoop?.coedges?.length || 0;
    if (sType !== 'plane') {
      console.log(`\n  Face ${face.id}: type=${sType}, edges=${nEdges}`);
      if (face.surface) {
        const surf = face.surface;
        console.log(`    surface: degU=${surf.degreeU}, degV=${surf.degreeV}, rows=${surf.numRowsU}, cols=${surf.numColsV}`);
        console.log('    control points:');
        for (let r = 0; r < surf.numRowsU; r++) {
          for (let c = 0; c < surf.numColsV; c++) {
            const cp = surf.controlPoints[r * surf.numColsV + c];
            const w = surf.weights ? surf.weights[r * surf.numColsV + c] : 1;
            console.log(`      [${r},${c}]: (${cp.x.toFixed(5)}, ${cp.y.toFixed(5)}, ${cp.z.toFixed(5)}) w=${w.toFixed(6)}`);
          }
        }
      }
      // Print edge info
      for (const coedge of face.outerLoop?.coedges || []) {
        const e = coedge.edge;
        const sp = e.startVertex.point;
        const ep = e.endVertex.point;
        console.log(`    Edge: (${sp.x.toFixed(4)}, ${sp.y.toFixed(4)}, ${sp.z.toFixed(4)}) -> (${ep.x.toFixed(4)}, ${ep.y.toFixed(4)}, ${ep.z.toFixed(4)}), deg=${e.curve?.degree || '?'}, cps=${e.curve?.controlPoints?.length || '?'}`);
      }
    }
  }
}

// Now check the fillet arc: the arc should sweep from face0 to face1
// For a 90-degree edge, the arc is a quarter circle.
// Print the fillet surface normals at the boundary to verify tangency
console.log('\n=== Fillet surface tangency check ===');
if (topoF?.shells?.[0]) {
  for (const face of topoF.shells[0].faces) {
    if (face.surfaceType !== 'plane' && face.surface) {
      const surf = face.surface;
      // Check normals at v=0 (face0 side) and v=1 (face1 side)
      const uMid = (surf.uMin + surf.uMax) / 2;
      const n_v0 = surf.normal(uMid, surf.vMin);
      const n_v1 = surf.normal(uMid, surf.vMax);
      const n_mid = surf.normal(uMid, (surf.vMin + surf.vMax) / 2);
      console.log(`  Face ${face.id} (${face.surfaceType}):`);
      console.log(`    Normal at v=0 (face0 side): (${n_v0.x.toFixed(5)}, ${n_v0.y.toFixed(5)}, ${n_v0.z.toFixed(5)})`);
      console.log(`    Normal at v=mid:            (${n_mid.x.toFixed(5)}, ${n_mid.y.toFixed(5)}, ${n_mid.z.toFixed(5)})`);
      console.log(`    Normal at v=1 (face1 side): (${n_v1.x.toFixed(5)}, ${n_v1.y.toFixed(5)}, ${n_v1.z.toFixed(5)})`);
    }
  }
}

// Print the normals of the adjacent faces
console.log('\n=== Adjacent face normals ===');
if (topoF?.shells?.[0]) {
  for (const face of topoF.shells[0].faces) {
    if (face.surfaceType === 'plane') {
      const n = face.surface ? face.surface.normal(0, 0) : null;
      if (n) {
        console.log(`  Face ${face.id}: normal=(${n.x.toFixed(5)}, ${n.y.toFixed(5)}, ${n.z.toFixed(5)})`);
      }
    }
  }
}
