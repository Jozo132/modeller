import './_watchdog.mjs';
import fs from 'node:fs';
import { Part } from '../js/cad/Part.js';
import { parseCMOD } from '../js/cmod.js';
import { robustTessellateBody } from '../js/cad/Tessellator2/index.js';

const raw = fs.readFileSync('tests/samples/Unnamed-Body.cmod', 'utf-8');
const parsed = parseCMOD(raw);
const part = Part.deserialize(parsed.data.part);
const body = part.getFinalGeometry().body;

const FACE_ID = Number(process.argv[2] || 5);
let target = null;
for (const shell of body.shells) {
  for (const face of shell.faces) if (face.id === FACE_ID) target = face;
}
if (!target) { console.error(`face ${FACE_ID} not found`); process.exit(1); }

console.log(`Face ${FACE_ID}:`);
console.log(`  surfaceType = ${target.surfaceType}`);
console.log(`  sameSense   = ${target.sameSense}`);
const surf = target.surface;
console.log(`  surface class = ${surf && surf.constructor.name}`);
if (surf) {
  console.log(`  uRange=[${surf.uMin ?? '?'},${surf.uMax ?? '?'}] vRange=[${surf.vMin ?? '?'},${surf.vMax ?? '?'}]`);
  console.log(`  uDegree=${surf.uDegree ?? '?'} vDegree=${surf.vDegree ?? '?'} nColsU=${surf.numRowsU ?? surf.numColsU ?? '?'}`);
  // Sample corners
  const u0 = surf.uMin ?? 0, u1 = surf.uMax ?? 1, v0 = surf.vMin ?? 0, v1 = surf.vMax ?? 1;
  const corners = [[u0,v0],[u1,v0],[u0,v1],[u1,v1],[(u0+u1)/2,(v0+v1)/2]];
  for (const [u,v] of corners) {
    try { const p = surf.evaluate(u,v); console.log(`  surf(${u.toFixed(3)},${v.toFixed(3)}) = (${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)})`); } catch (e) { console.log(`  surf(${u},${v}) ERR ${e.message}`); }
  }
}

console.log(`\nOuter loop (${target.outerLoop.coedges.length} coedges):`);
for (let i = 0; i < target.outerLoop.coedges.length; i++) {
  const ce = target.outerLoop.coedges[i];
  const e = ce.edge;
  const sv = e.startVertex.point, ev = e.endVertex.point;
  console.log(`  [${i}] sameSense=${ce.sameSense} edge#${e.id}`);
  console.log(`       startV#${e.startVertex.id}=(${sv.x.toFixed(3)},${sv.y.toFixed(3)},${sv.z.toFixed(3)})`);
  console.log(`       endV#${e.endVertex.id}=(${ev.x.toFixed(3)},${ev.y.toFixed(3)},${ev.z.toFixed(3)})`);
  if (e.curve) {
    const tMin = e.curve.uMin ?? e.curve.tMin ?? 0;
    const tMax = e.curve.uMax ?? e.curve.tMax ?? 1;
    const mid = e.curve.evaluate((tMin+tMax)/2);
    console.log(`       curve mid=(${mid.x.toFixed(3)},${mid.y.toFixed(3)},${mid.z.toFixed(3)}) tRange=[${tMin},${tMax}]`);
  }
}

// Tessellate and pull out this face's triangles
const tess = robustTessellateBody(body);
const tris = tess.faces.filter(f => f.topoFaceId === FACE_ID);
console.log(`\n${tris.length} triangles tessellated for face ${FACE_ID}`);

let lo = {x:Infinity,y:Infinity,z:Infinity}, hi={x:-Infinity,y:-Infinity,z:-Infinity};
for (const t of tris) for (const v of t.vertices) {
  if (v.x<lo.x)lo.x=v.x; if (v.y<lo.y)lo.y=v.y; if (v.z<lo.z)lo.z=v.z;
  if (v.x>hi.x)hi.x=v.x; if (v.y>hi.y)hi.y=v.y; if (v.z>hi.z)hi.z=v.z;
}
console.log(`  tri bbox: (${lo.x.toFixed(3)},${lo.y.toFixed(3)},${lo.z.toFixed(3)}) → (${hi.x.toFixed(3)},${hi.y.toFixed(3)},${hi.z.toFixed(3)})`);

// Find the 5 worst-overshoot triangles (compared to loop bbox)
let loLoop={x:Infinity,y:Infinity,z:Infinity}, hiLoop={x:-Infinity,y:-Infinity,z:-Infinity};
for (const ce of target.outerLoop.coedges) {
  const c = ce.edge.curve; if (!c) continue;
  const tMin = c.uMin ?? c.tMin ?? 0, tMax = c.uMax ?? c.tMax ?? 1;
  for (let k=0;k<=32;k++){ const t=tMin+(tMax-tMin)*(k/32); const p=c.evaluate(t);
    if (p.x<loLoop.x)loLoop.x=p.x; if (p.y<loLoop.y)loLoop.y=p.y; if (p.z<loLoop.z)loLoop.z=p.z;
    if (p.x>hiLoop.x)hiLoop.x=p.x; if (p.y>hiLoop.y)hiLoop.y=p.y; if (p.z>hiLoop.z)hiLoop.z=p.z; }
}
console.log(`  loop bbox: (${loLoop.x.toFixed(3)},${loLoop.y.toFixed(3)},${loLoop.z.toFixed(3)}) → (${hiLoop.x.toFixed(3)},${hiLoop.y.toFixed(3)},${hiLoop.z.toFixed(3)})`);

const scored = tris.map(t => {
  let worst = 0;
  for (const v of t.vertices) {
    const dx = Math.max(0, loLoop.x - v.x, v.x - hiLoop.x);
    const dy = Math.max(0, loLoop.y - v.y, v.y - hiLoop.y);
    const dz = Math.max(0, loLoop.z - v.z, v.z - hiLoop.z);
    const d = Math.hypot(dx,dy,dz); if (d>worst) worst=d;
  }
  return { worst, tri: t };
}).sort((a,b)=>b.worst-a.worst);

console.log('\nTop 5 overflowing triangles:');
for (let i=0;i<Math.min(5,scored.length);i++){
  const s = scored[i];
  console.log(`  [${i}] overshoot=${s.worst.toFixed(3)}`);
  for (const v of s.tri.vertices) console.log(`      (${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)})`);
}
