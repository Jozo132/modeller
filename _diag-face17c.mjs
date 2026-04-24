import { readFileSync } from 'fs';
import { importSTEP } from './js/cad/StepImport.js';
const step = readFileSync('tests/step/Unnamed-Body.step', 'utf-8');
const mesh = importSTEP(step);
const f17 = mesh.faces.filter(f => (f.topoFaceId??f.faceId??f.originalFaceIndex) === 17);
// Distribution of z values of non-rim vertices
const nonRimZ = [];
for (const f of f17) for (const v of f.vertices)
  if (v.z > 10.001 && v.z < 13.999) nonRimZ.push(v.z);
nonRimZ.sort((a,b)=>a-b);
// Unique z values
const uniq = [...new Set(nonRimZ.map(z=>z.toFixed(4)))];
console.log('Unique non-rim Z levels:', uniq.length, '→', uniq.slice(0,20), '...');
console.log('Z range of non-rim verts:', nonRimZ[0], '…', nonRimZ[nonRimZ.length-1]);

// How many triangles have all three vertices?
let rimOnly=0, hasInner=0;
for (const f of f17){
  const v = f.vertices;
  const allRim = v.every(p=>Math.abs(p.z-14)<1e-3 || Math.abs(p.z-10)<1e-3);
  if (allRim) rimOnly++; else hasInner++;
}
console.log('Triangles: rim-only=', rimOnly, 'hasInner=', hasInner);

// Count triangles with 2 vertices on rim
let type_2top=0, type_2bot=0, type_1top1bot=0, other=0;
for (const f of f17){
  const v = f.vertices;
  const top = v.filter(p=>Math.abs(p.z-14)<1e-3).length;
  const bot = v.filter(p=>Math.abs(p.z-10)<1e-3).length;
  if (top===2) type_2top++;
  else if (bot===2) type_2bot++;
  else if (top===1 && bot===1) type_1top1bot++;
  else other++;
}
console.log('2-top rim:', type_2top, '2-bot rim:', type_2bot, '1top+1bot:', type_1top1bot, 'other:', other);
