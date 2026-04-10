import fs from 'fs';
import { Part } from './js/cad/Part.js';
import { parseCMOD } from './js/cmod.js';
import { resetFeatureIds } from './js/cad/Feature.js';
import { resetTopoIds } from './js/cad/BRepTopology.js';
import { robustTessellateBody } from './js/cad/Tessellator2/index.js';

function loadPart(filename) {
  resetFeatureIds();
  resetTopoIds();
  const raw = fs.readFileSync(`tests/samples/${filename}`, 'utf-8');
  const parsed = parseCMOD(raw);
  return Part.deserialize(parsed.data.part);
}

// Load and check
const part = loadPart('puzzle-extrude-cc.cmod');
const result = part.getFinalGeometry();
const geom = result?.geometry || result;
const topoBody = geom.topoBody;

if (!topoBody) {
  console.log('No topoBody');
  process.exit(1);
}

const shell = topoBody.shells[0];
console.log('Total topo faces:', shell.faces.length);

// Focus on face 32 and other cylinder faces
for (const face of shell.faces) {
  if (face.surfaceType !== 'cylinder') continue;
  
  const surf = face.surface;
  if (!surf) continue;
  const uMid = (surf.uMin + surf.uMax) / 2;
  const vMid = (surf.vMin + surf.vMax) / 2;
  const sn = surf.normal(uMid, vMid);
  
  // Get oriented boundary vertices (sample arcs)
  const allPts = [];
  for (const coedge of face.outerLoop.coedges) {
    const edge = coedge.edge;
    if (edge.curve && typeof edge.curve.evaluate === 'function') {
      const N = 8;
      let samples = [];
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        samples.push(edge.curve.evaluate(t));
      }
      if (coedge.sameSense === false) samples.reverse();
      if (allPts.length > 0) samples = samples.slice(1);
      allPts.push(...samples);
    } else {
      const sp = coedge.sameSense !== false ? edge.startVertex.point : edge.endVertex.point;
      const ep = coedge.sameSense !== false ? edge.endVertex.point : edge.startVertex.point;
      if (allPts.length === 0) allPts.push(sp);
      allPts.push(ep);
    }
  }
  // Close loop
  if (allPts.length > 1) {
    const d = Math.sqrt(
      (allPts[0].x - allPts[allPts.length-1].x)**2 +
      (allPts[0].y - allPts[allPts.length-1].y)**2 +
      (allPts[0].z - allPts[allPts.length-1].z)**2
    );
    if (d < 1e-8) allPts.pop();
  }
  
  // Compute Newell normal from oriented boundary
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < allPts.length; i++) {
    const vc = allPts[i];
    const vn = allPts[(i + 1) % allPts.length];
    nx += (vc.y - vn.y) * (vc.z + vn.z);
    ny += (vc.z - vn.z) * (vc.x + vn.x);
    nz += (vc.x - vn.x) * (vc.y + vn.y);
  }
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len > 0) { nx /= len; ny /= len; nz /= len; }
  
  const flip = face.sameSense !== false ? 1 : -1;
  const outward = { x: sn.x * flip, y: sn.y * flip, z: sn.z * flip };
  const dot = nx * outward.x + ny * outward.y + nz * outward.z;
  
  console.log(`Face ${face.id}: sameSense=${face.sameSense}, polyN=(${nx.toFixed(3)},${ny.toFixed(3)},${nz.toFixed(3)}), surfN=(${sn.x.toFixed(3)},${sn.y.toFixed(3)},${sn.z.toFixed(3)}), outward=(${outward.x.toFixed(3)},${outward.y.toFixed(3)},${outward.z.toFixed(3)}), dot=${dot.toFixed(4)} ${dot > 0 ? 'OK' : 'BAD'}`);
}

// Now tessellate and count inversions per face
const tess = robustTessellateBody(topoBody);
const faceStats = {};
for (const mf of tess.faces) {
  const tf = shell.faces.find(f => f.id === mf.topoFaceId);
  if (!tf || tf.surfaceType !== 'cylinder') continue;
  if (!faceStats[tf.id]) faceStats[tf.id] = { total: 0, inverted: 0 };
  faceStats[tf.id].total++;
  
  const surf = tf.surface;
  if (!surf) continue;
  const uMid = (surf.uMin + surf.uMax) / 2;
  const vMid = (surf.vMin + surf.vMax) / 2;
  const sn = surf.normal(uMid, vMid);
  if (!sn) continue;
  const flip = tf.sameSense !== false ? 1 : -1;
  const expected = { x: sn.x * flip, y: sn.y * flip, z: sn.z * flip };
  if (mf.normal) {
    const d = mf.normal.x * expected.x + mf.normal.y * expected.y + mf.normal.z * expected.z;
    if (d < 0) faceStats[tf.id].inverted++;
  }
}
console.log('\nMesh face stats:');
for (const [id, stats] of Object.entries(faceStats)) {
  console.log(`  Face ${id}: ${stats.inverted}/${stats.total} inverted`);
}
