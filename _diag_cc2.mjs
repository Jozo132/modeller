import { Part } from './js/cad/Part.js';
import { parseCMOD } from './js/cmod.js';
import fs from 'fs';

const raw = fs.readFileSync('./tests/samples/puzzle-extrude-cc2.cmod', 'utf-8');
const parsed = parseCMOD(raw);
if (!parsed.ok) throw new Error(parsed.error);
const part = Part.deserialize(parsed.data.part);

const result = part.getFinalGeometry();
const topo = result?.geometry?.topoBody;

// Inspect the cylinder faces in detail
for (const shell of topo.shells) {
  for (const face of shell.faces) {
    if (face.surfaceType !== 'plane') {
      const surf = face.surface;
      console.log(`\nFace ${face.id}: surfaceType=${face.surfaceType}, sameSense=${face.sameSense}`);
      console.log('  surface degree:', surf?.degreeU, '×', surf?.degreeV);
      console.log('  surface CP rows×cols:', surf?.rows, '×', surf?.cols);
      console.log('  surface knots U:', surf?.knotsU?.join(','));
      console.log('  surface knots V:', surf?.knotsV?.join(','));
      
      // Try to understand the UV domain
      if (surf?.closestPointUV) {
        const coedges = face.outerLoop?.coedges || [];
        let allPts = [];
        for (const ce of coedges) {
          const pts = ce.edge.tessellate(16);
          allPts.push(...pts);
        }
        // Map to UV
        let prevUv = null;
        const uvs = [];
        for (const p of allPts) {
          try {
            const uv = surf.closestPointUV(p);
            uvs.push(uv);
            prevUv = uv;
          } catch {}
        }
        let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
        for (const uv of uvs) {
          if (uv.u < uMin) uMin = uv.u;
          if (uv.u > uMax) uMax = uv.u;
          if (uv.v < vMin) vMin = uv.v;
          if (uv.v > vMax) vMax = uv.v;
        }
        console.log(`  UV range: u=[${uMin.toFixed(4)}, ${uMax.toFixed(4)}], v=[${vMin.toFixed(4)}, ${vMax.toFixed(4)}]`);
        // Show UV values in order to see if they wrap
        console.log('  UV sequence (u values):', uvs.slice(0, 20).map(uv => uv.u.toFixed(3)).join(', '));
      }
      
      // Check if it has surfaceInfo
      console.log('  surfaceInfo:', face.surfaceInfo ? JSON.stringify(face.surfaceInfo) : 'null');
      
      // Check the NURBS surface control points to understand shape
      if (surf?.controlPoints) {
        console.log('  Control points (first 6):');
        for (let i = 0; i < Math.min(6, surf.controlPoints.length); i++) {
          const cp = surf.controlPoints[i];
          console.log(`    [${i}]: (${cp.x?.toFixed(3)}, ${cp.y?.toFixed(3)}, ${cp.z?.toFixed(3)}) w=${cp.w?.toFixed(3)}`);
        }
      }
    }
  }
}
