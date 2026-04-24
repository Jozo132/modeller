import { readFileSync } from 'fs';
import { importSTEP } from './js/cad/StepImport.js';

const step = readFileSync('tests/step/Unnamed-Body.step', 'utf-8');
const mesh = importSTEP(step);
console.log('Imported: faces=', mesh.faces.length, 'verts=', mesh.vertices?.length);

const vkey = v => `${v.x.toFixed(6)},${v.y.toFixed(6)},${v.z.toFixed(6)}`;
const edgeMap = new Map();
const faceEdgeMap = new Map();
for (let fi=0;fi<mesh.faces.length;fi++){
  const f = mesh.faces[fi];
  const tfi = f.topoFaceId ?? f.faceId ?? f.originalFaceIndex ?? -1;
  const v = f.vertices;
  if (!v || v.length<3) continue;
  for (let i=0;i<v.length;i++){
    const a = vkey(v[i]), b = vkey(v[(i+1)%v.length]);
    const k = a<b?a+'|'+b:b+'|'+a;
    edgeMap.set(k,(edgeMap.get(k)||0)+1);
    if (!faceEdgeMap.has(tfi)) faceEdgeMap.set(tfi, new Map());
    const fm = faceEdgeMap.get(tfi);
    fm.set(k,(fm.get(k)||0)+1);
  }
}
let boundary=0,nm=0,maxUse=0;
for (const c of edgeMap.values()){ if (c===1) boundary++; if (c>2) nm++; if (c>maxUse) maxUse=c; }
console.log(`Global: boundary=${boundary}, non-manifold=${nm}, maxEdgeUse=${maxUse}`);

const perFaceNM = [];
for (const [tfi,fm] of faceEdgeMap){
  let count=0;
  for (const c of fm.values()) if (c>2) count++;
  if (count>0) perFaceNM.push([tfi,count]);
}
perFaceNM.sort((a,b)=>b[1]-a[1]);
console.log('Per-face non-manifold (top 10):', perFaceNM.slice(0,10));

// Also show per-face edge-use >2 distribution for top face
if (perFaceNM.length){
  const [topFi] = perFaceNM[0];
  const fm = faceEdgeMap.get(topFi);
  const dist = new Map();
  for (const c of fm.values()) dist.set(c,(dist.get(c)||0)+1);
  console.log(`Face ${topFi} edge-count distribution:`, [...dist.entries()].sort((a,b)=>a[0]-b[0]));
}
