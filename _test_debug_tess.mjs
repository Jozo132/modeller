import fs from 'fs';
import { Part } from './js/cad/Part.js';
import { parseCMOD } from './js/cmod.js';
import { resetFeatureIds } from './js/cad/Feature.js';
import { resetTopoIds } from './js/cad/BRepTopology.js';
import { NurbsSurface } from './js/cad/NurbsSurface.js';

resetFeatureIds();
resetTopoIds();
const raw = fs.readFileSync('tests/samples/puzzle-extrude-cc.cmod', 'utf-8');
const parsed = parseCMOD(raw);
const part = Part.deserialize(parsed.data.part);

const result = part.getFinalGeometry();
const geom = result?.geometry || result;
const topoBody = geom.topoBody;
const shell = topoBody.shells[0];

// Examine face 32 in detail
const face = shell.faces.find(f => f.id === 32);
if (!face) { console.log('Face 32 not found'); process.exit(1); }

const surface = face.surface;
console.log('Surface type:', face.surfaceType);
console.log('sameSense:', face.sameSense);
console.log('Surface uMin:', surface.uMin, 'uMax:', surface.uMax);
console.log('Surface vMin:', surface.vMin, 'vMax:', surface.vMax);

// Evaluate surface at parametric midpoint
const uMid = (surface.uMin + surface.uMax) / 2;
const vMid = (surface.vMin + surface.vMax) / 2;
const ptMid = surface.evaluate(uMid, vMid);
const nMid = surface.normal(uMid, vMid);
console.log('Eval at mid:', ptMid);
console.log('Normal at mid:', nMid);

// Now check the boundary and compute the UVs
const coedges = face.outerLoop.coedges;
const allPts = [];
for (const coedge of coedges) {
  const edge = coedge.edge;
  if (edge.curve && typeof edge.curve.evaluate === 'function') {
    const N = 8;
    let samples = [];
    for (let i = 0; i <= N; i++) {
      samples.push(edge.curve.evaluate(i / N));
    }
    if (coedge.sameSense === false) samples.reverse();
    if (allPts.length > 0) samples = samples.slice(1);
    allPts.push(...samples);
  }
}
// Close
if (allPts.length > 1) {
  const d = Math.sqrt(
    (allPts[0].x - allPts[allPts.length-1].x)**2 +
    (allPts[0].y - allPts[allPts.length-1].y)**2 +
    (allPts[0].z - allPts[allPts.length-1].z)**2);
  if (d < 1e-8) allPts.pop();
}

console.log('\nBoundary points:', allPts.length);
for (let i = 0; i < Math.min(allPts.length, 40); i++) {
  const p = allPts[i];
  const uv = surface.closestPointUV(p);
  console.log(`  [${i}] (${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)}) -> UV(${uv.u.toFixed(4)}, ${uv.v.toFixed(4)})`);
}

// Check UV centroid
let cu = 0, cv = 0;
for (const p of allPts) {
  const uv = surface.closestPointUV(p);
  cu += uv.u;
  cv += uv.v;
}
cu /= allPts.length;
cv /= allPts.length;
console.log('\nUV centroid:', cu.toFixed(4), cv.toFixed(4));
const centroidN = surface.normal(cu, cv);
console.log('Surface normal at UV centroid:', centroidN);

// Check if periodic
try {
  const pv0 = surface.evaluate(uMid, surface.vMin);
  const pv1 = surface.evaluate(uMid, surface.vMax);
  const dvClose = Math.sqrt((pv0.x-pv1.x)**2 + (pv0.y-pv1.y)**2 + (pv0.z-pv1.z)**2);
  const pu0 = surface.evaluate(surface.uMin, vMid);
  const pu1 = surface.evaluate(surface.uMax, vMid);
  const duClose = Math.sqrt((pu0.x-pu1.x)**2 + (pu0.y-pu1.y)**2 + (pu0.z-pu1.z)**2);
  console.log('\ndvClose:', dvClose.toFixed(6), 'duClose:', duClose.toFixed(6));
  console.log('periodic:', dvClose < 1e-6 || duClose < 1e-6);
  console.log('eval(uMin, vMid):', pu0);
  console.log('eval(uMax, vMid):', pu1);
  console.log('eval(uMid, vMin):', pv0);
  console.log('eval(uMid, vMax):', pv1);
} catch(e) { console.log('periodic check error:', e.message); }

// Show surface control points
console.log('\nSurface degreeU:', surface.degreeU, 'degreeV:', surface.degreeV);
console.log('numRowsU:', surface.numRowsU, 'numColsV:', surface.numColsV);
console.log('knotsU:', surface.knotsU);
console.log('knotsV:', surface.knotsV);
if (surface.controlPoints) {
  for (let i = 0; i < surface.controlPoints.length; i++) {
    const cp = surface.controlPoints[i];
    console.log(`  cp[${i}] (${cp.x.toFixed(3)}, ${cp.y.toFixed(3)}, ${cp.z.toFixed(3)}) w=${surface.weights[i].toFixed(4)}`);
  }
}
