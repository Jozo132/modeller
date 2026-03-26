// tests/debug-step-tessellation.js — Debug the actual STEP file tessellation
// Run: node tests/debug-step-tessellation.js

import { readFileSync } from 'node:fs';
import { parseSTEPTopology } from '../js/cad/StepImport.js';
import { FaceTriangulator } from '../js/cad/Tessellator2/FaceTriangulator.js';
import { EdgeSampler } from '../js/cad/Tessellator2/EdgeSampler.js';

const stepFile = 'tests/step/box-fillet-3.step';
console.log(`Loading: ${stepFile}`);
const stepString = readFileSync(stepFile, 'utf-8');

console.log('Parsing STEP topology...');
const body = parseSTEPTopology(stepString);

console.log(`Body: ${body.shells.length} shell(s)`);

for (let si = 0; si < body.shells.length; si++) {
  const shell = body.shells[si];
  console.log(`\nShell ${si}: ${shell.faces.length} faces`);

  const edgeSampler = new EdgeSampler();
  const edgeSegs = 64;
  const surfSegs = 16;

  // Sample all edges
  for (const edge of shell.edges()) {
    edgeSampler.sampleEdge(edge, edgeSegs);
  }

  for (let fi = 0; fi < shell.faces.length; fi++) {
    const face = shell.faces[fi];
    const isPlane = !face.surface || face.surfaceType === 'plane';

    if (isPlane) {
      console.log(`  Face ${fi}: PLANAR (surfaceType=${face.surfaceType}, sameSense=${face.sameSense})`);
      continue;
    }

    const surface = face.surface;
    console.log(`  Face ${fi}: ${face.surfaceType} (sameSense=${face.sameSense})`);
    console.log(`    UV domain: u=[${surface.uMin.toFixed(4)}, ${surface.uMax.toFixed(4)}], v=[${surface.vMin.toFixed(4)}, ${surface.vMax.toFixed(4)}]`);
    console.log(`    Degrees: u=${surface.degreeU}, v=${surface.degreeV}, ctrlPts: ${surface.numRowsU}x${surface.numColsV}`);
    console.log(`    KnotsU: [${surface.knotsU.map(k => k.toFixed(4)).join(', ')}]`);
    console.log(`    KnotsV: [${surface.knotsV.map(k => k.toFixed(4)).join(', ')}]`);
    
    // Evaluate corners to understand the geometry
    const corners = [
      [surface.uMin, surface.vMin],
      [surface.uMax, surface.vMin],
      [surface.uMin, surface.vMax],
      [surface.uMax, surface.vMax],
    ];
    for (const [u, v] of corners) {
      const p = surface.evaluate(u, v);
      console.log(`    eval(${u.toFixed(2)},${v.toFixed(2)}) = (${p.x.toFixed(4)}, ${p.y.toFixed(4)}, ${p.z.toFixed(4)})`);
    }

    // Collect boundary points (same as _triangulateFace does)
    const outerLoop = face.outerLoop;
    if (!outerLoop) { console.log('    No outer loop!'); continue; }

    const pts = [];
    for (const coedge of outerLoop.coedges) {
      const edgePts = edgeSampler.sampleEdge(coedge.edge, edgeSegs);
      let oriented = coedge.sameSense ? [...edgePts] : [...edgePts].reverse();
      // Skip first point if it duplicates previous last
      const start = pts.length > 0 ? 1 : 0;
      for (let i = start; i < oriented.length; i++) {
        pts.push({ ...oriented[i] });
      }
    }
    // Remove closing duplicate
    if (pts.length > 1) {
      const first = pts[0], last = pts[pts.length - 1];
      const dx = first.x - last.x, dy = first.y - last.y, dz = first.z - last.z;
      if (Math.sqrt(dx * dx + dy * dy + dz * dz) < 1e-8) pts.pop();
    }

    console.log(`    Boundary: ${pts.length} points`);

    // Now compute UVs the same way triangulateSurface does
    const uv0 = surface.closestPointUV(pts[0]);
    pts[0]._u = uv0.u; pts[0]._v = uv0.v;
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1];
      const uv = surface.closestPointUV(pts[i], 4, { u: prev._u, v: prev._v });
      pts[i]._u = uv.u; pts[i]._v = uv.v;
    }

    // Check for periodic surface: v=0 and v=1 edges map to same 3D point
    const p00 = surface.evaluate(surface.uMin, surface.vMin);
    const p01 = surface.evaluate(surface.uMin, surface.vMax);
    const dClose = Math.sqrt((p00.x-p01.x)**2 + (p00.y-p01.y)**2 + (p00.z-p01.z)**2);
    const p10 = surface.evaluate(surface.uMax, surface.vMin);
    const p11 = surface.evaluate(surface.uMax, surface.vMax);
    const dClose2 = Math.sqrt((p10.x-p11.x)**2 + (p10.y-p11.y)**2 + (p10.z-p11.z)**2);
    const vPeriodic = dClose < 1e-6 && dClose2 < 1e-6;
    
    const p00u = surface.evaluate(surface.uMin, surface.vMin);
    const p01u = surface.evaluate(surface.uMax, surface.vMin);
    const dCloseU = Math.sqrt((p00u.x-p01u.x)**2 + (p00u.y-p01u.y)**2 + (p00u.z-p01u.z)**2);
    const p10u = surface.evaluate(surface.uMin, surface.vMax);
    const p11u = surface.evaluate(surface.uMax, surface.vMax);
    const dCloseU2 = Math.sqrt((p10u.x-p11u.x)**2 + (p10u.y-p11u.y)**2 + (p10u.z-p11u.z)**2);
    const uPeriodic = dCloseU < 1e-6 && dCloseU2 < 1e-6;

    if (vPeriodic) console.log(`    *** V-PERIODIC: eval(u,0) ≡ eval(u,1) (dist=${dClose.toExponential(2)}) ***`);
    if (uPeriodic) console.log(`    *** U-PERIODIC: eval(0,v) ≡ eval(1,v) (dist=${dCloseU.toExponential(2)}) ***`);

    // Show v values around boundary to understand wrapping
    if (vPeriodic || uPeriodic) {
      // Sample the surface at v=0.25 and v=0.75 to see how the curve looks
      console.log('    Surface geometry at u=0.5:');
      for (let vi = 0; vi <= 8; vi++) {
        const v = vi / 8;
        const p = surface.evaluate(0.5, v);
        console.log(`      v=${v.toFixed(3)}: (${p.x.toFixed(4)}, ${p.y.toFixed(4)}, ${p.z.toFixed(4)})`);
      }
    }

    // Analyze UV distribution
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (const p of pts) {
      if (p._u < uMin) uMin = p._u;
      if (p._u > uMax) uMax = p._u;
      if (p._v < vMin) vMin = p._v;
      if (p._v > vMax) vMax = p._v;
    }

    // Check for UV jumps (seam crossings)
    let maxUJump = 0, maxVJump = 0, maxUJumpIdx = -1;
    for (let i = 0; i < pts.length; i++) {
      const next = (i + 1) % pts.length;
      const du = Math.abs(pts[i]._u - pts[next]._u);
      const dv = Math.abs(pts[i]._v - pts[next]._v);
      if (du > maxUJump) { maxUJump = du; maxUJumpIdx = i; }
      if (dv > maxVJump) maxVJump = dv;
    }

    console.log(`    UV range: u=[${uMin.toFixed(4)}, ${uMax.toFixed(4)}] (span=${(uMax - uMin).toFixed(4)}), v=[${vMin.toFixed(4)}, ${vMax.toFixed(4)}] (span=${(vMax - vMin).toFixed(4)})`);
    console.log(`    Max UV jumps: du=${maxUJump.toFixed(4)} at [${maxUJumpIdx}→${(maxUJumpIdx + 1) % pts.length}], dv=${maxVJump.toFixed(4)}`);

    if (maxUJump > (surface.uMax - surface.uMin) * 0.3) {
      console.log(`    *** SEAM CROSSING detected! UV jump ${maxUJump.toFixed(4)} > 30% of u-range ${(surface.uMax - surface.uMin).toFixed(4)} ***`);
      // Print the UV values around the jump
      const j = maxUJumpIdx;
      const jn = (j + 1) % pts.length;
      console.log(`    Jump: pt[${j}] u=${pts[j]._u.toFixed(4)},v=${pts[j]._v.toFixed(4)} → pt[${jn}] u=${pts[jn]._u.toFixed(4)},v=${pts[jn]._v.toFixed(4)}`);
      console.log(`    pt[${j}] 3D: (${pts[j].x.toFixed(4)}, ${pts[j].y.toFixed(4)}, ${pts[j].z.toFixed(4)})`);
      console.log(`    pt[${jn}] 3D: (${pts[jn].x.toFixed(4)}, ${pts[jn].y.toFixed(4)}, ${pts[jn].z.toFixed(4)})`);
    }

    // Now actually tessellate and report
    const ft = new FaceTriangulator();
    const result = ft.triangulateSurface(face, pts, surfSegs, face.sameSense);
    console.log(`    → ${result.faces.length} triangles`);

    // For the problematic face (>1000 tris), dump detailed edge deviation info
    if (result.faces.length > 1000) {
      console.log(`    *** PROBLEM FACE: ${result.faces.length} triangles ***`);
      
      // Dump first 10 UVs
      console.log(`    First 10 UVs:`);
      for (let i = 0; i < Math.min(10, pts.length); i++) {
        console.log(`      [${i}] u=${pts[i]._u.toFixed(6)}, v=${pts[i]._v.toFixed(6)} → 3D=(${pts[i].x.toFixed(4)}, ${pts[i].y.toFixed(4)}, ${pts[i].z.toFixed(4)})`);
      }

      // Check if naive UV midpoints across consecutive boundary pts give bad surface points
      let badMidCount = 0;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        const mu = (a._u + b._u) / 2, mv = (a._v + b._v) / 2;
        const sp = surface.evaluate(mu, mv);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, mz = (a.z + b.z) / 2;
        const dx = sp.x - mx, dy = sp.y - my, dz = sp.z - mz;
        const dev = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const edx = a.x - b.x, edy = a.y - b.y, edz = a.z - b.z;
        const edgeLen = Math.sqrt(edx * edx + edy * edy + edz * edz);
        if (dev > edgeLen * 0.5 || dev > 0.5) {
          badMidCount++;
          if (badMidCount <= 5) {
            console.log(`      BAD midpoint [${i}→${(i + 1) % pts.length}]: dev=${dev.toFixed(4)}, edgeLen=${edgeLen.toFixed(4)}, UV mid=(${mu.toFixed(4)},${mv.toFixed(4)})`);
          }
        }
      }
      console.log(`    Bad UV midpoints: ${badMidCount} / ${pts.length}`);
    }
  }
}
