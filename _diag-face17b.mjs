import { readFileSync } from 'fs';
import { importSTEP } from './js/cad/StepImport.js';

const step = readFileSync('tests/step/Unnamed-Body.step', 'utf-8');
const mesh = importSTEP(step);
const vkey = v => `${v.x.toFixed(6)},${v.y.toFixed(6)},${v.z.toFixed(6)}`;
const f17 = mesh.faces.filter(f => (f.topoFaceId??f.faceId??f.originalFaceIndex) === 17);

// UV info?
console.log('First face vertex sample:', Object.keys(f17[0].vertices[0]));
// Distribution of vertex uv over face 17
let withUV=0;
for (const f of f17) for (const v of f.vertices) if (v._u!==undefined) withUV++;
console.log('Vertices with _u/_v:', withUV, '/', f17.length*3);

// What's the UV range?
let uMin=Infinity,uMax=-Infinity,vMin=Infinity,vMax=-Infinity;
for (const f of f17) for (const v of f.vertices){
  if (v._u!==undefined){
    if (v._u<uMin) uMin=v._u; if (v._u>uMax) uMax=v._u;
    if (v._v!==undefined){ if (v._v<vMin) vMin=v._v; if (v._v>vMax) vMax=v._v; }
  }
}
console.log('UV range:', uMin, uMax, vMin, vMax);

// Build edge -> triangles
const edgeToTris = new Map();
for (let i=0;i<f17.length;i++){
  const v = f17[i].vertices;
  for (let k=0;k<3;k++){
    const a=vkey(v[k]), b=vkey(v[(k+1)%3]);
    const ek = a<b?a+'|'+b:b+'|'+a;
    if (!edgeToTris.has(ek)) edgeToTris.set(ek,[]);
    edgeToTris.get(ek).push(i);
  }
}

const nmEdges = [...edgeToTris.entries()].filter(([,t])=>t.length>2);
nmEdges.sort((a,b)=>b[1].length-a[1].length);

// For the first NM edge, show UV of each triangle
const [ek, tris] = nmEdges[0];
console.log('\n--- Non-manifold edge:', ek);
for (const ti of tris){
  const f = f17[ti];
  const uvs = f.vertices.map(v => `u=${v._u!==undefined?v._u.toFixed(4):'?'},v=${v._v!==undefined?v._v.toFixed(4):'?'}`);
  const pos = f.vertices.map(v => `(${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)})`);
  console.log(`  tri ${ti}:`);
  for (let k=0;k<3;k++) console.log(`    ${pos[k]}  ${uvs[k]}`);
}

// Count how many NM edges have all endpoints on one z value (top or bottom rim)
let topRim=0, botRim=0, other=0;
for (const [ek] of nmEdges){
  const [a,b] = ek.split('|');
  const za = parseFloat(a.split(',')[2]);
  const zb = parseFloat(b.split(',')[2]);
  if (Math.abs(za-14)<1e-3 && Math.abs(zb-14)<1e-3) topRim++;
  else if (Math.abs(za-10)<1e-3 && Math.abs(zb-10)<1e-3) botRim++;
  else other++;
}
console.log(`\nNM edges on top rim: ${topRim}, bottom rim: ${botRim}, other: ${other}`);
