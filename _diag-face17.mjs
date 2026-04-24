import { readFileSync } from 'fs';
import { importSTEP } from './js/cad/StepImport.js';

const step = readFileSync('tests/step/Unnamed-Body.step', 'utf-8');
const mesh = importSTEP(step);

// Collect triangles for topoFaceId === 17
const vkey = v => `${v.x.toFixed(6)},${v.y.toFixed(6)},${v.z.toFixed(6)}`;
const f17 = [];
for (const f of mesh.faces){
  const tfi = f.topoFaceId ?? f.faceId ?? f.originalFaceIndex ?? -1;
  if (tfi===17) f17.push(f);
}
console.log('Face 17 triangle count:', f17.length);

// Count vertex multiplicity (how many distinct 3D positions)
const posSet = new Set();
for (const f of f17) for (const v of f.vertices) posSet.add(vkey(v));
console.log('Face 17 unique vertex positions:', posSet.size);

// Build edge->triangles map inside face 17
const edgeToTris = new Map();
for (let i=0;i<f17.length;i++){
  const f = f17[i];
  const v = f.vertices;
  for (let k=0;k<3;k++){
    const a=vkey(v[k]), b=vkey(v[(k+1)%3]);
    const ek = a<b?a+'|'+b:b+'|'+a;
    if (!edgeToTris.has(ek)) edgeToTris.set(ek,[]);
    edgeToTris.get(ek).push(i);
  }
}

const nmEdges = [];
for (const [ek,tris] of edgeToTris) if (tris.length>2) nmEdges.push([ek,tris]);
nmEdges.sort((a,b)=>b[1].length-a[1].length);
console.log('Face 17 non-manifold edge count:', nmEdges.length);
console.log('First non-manifold edge uses:', nmEdges.slice(0,5).map(([ek,t])=>({edge:ek, times:t.length})));

// Pick first NM edge, print all triangles sharing it
if (nmEdges.length){
  const [ek,tris] = nmEdges[0];
  console.log('\nEdge:', ek);
  for (const ti of tris){
    const f = f17[ti];
    console.log('  tri', ti, '=>', f.vertices.map(v=>`(${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)})`).join(' '));
  }
}

// Also check: are these triangles along the periodic seam? For cylinder face 17, 
// what's the cylinder axis?
// Skipping surface info but look at unique z-ranges
let zmin=Infinity,zmax=-Infinity;
for (const f of f17) for (const v of f.vertices){ if (v.z<zmin) zmin=v.z; if (v.z>zmax) zmax=v.z; }
console.log('Face 17 z-range:', zmin.toFixed(3), zmax.toFixed(3));
