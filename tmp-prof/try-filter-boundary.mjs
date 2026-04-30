import { readFileSync } from 'node:fs';
import { parseCMOD } from '../js/cmod.js';
import { Part } from '../js/cad/Part.js';
import { detectSelfIntersections } from '../js/cad/MeshValidator.js';
import { edgeVKey } from '../js/cad/toolkit/Vec3Utils.js';

const part = Part.deserialize(parseCMOD(readFileSync('tests/samples/box-fillet-2-s-1.cmod', 'utf8')).data.part);
const faces = part.getFinalGeometry().geometry.faces;
const all = detectSelfIntersections(faces,{maxPairs:100000});
const bad = new Set();
for (const [a,b] of all.pairs || []) {
  const fa = faces[a], fb = faces[b];
  if (fa.topoFaceId === 24 && fb.topoFaceId === 29) bad.add(a);
  if (fb.topoFaceId === 24 && fa.topoFaceId === 29) bad.add(b);
}
const filtered = faces.filter((_,i)=>!bad.has(i));
const map = new Map();
for (let i=0;i<filtered.length;i++) {
  const verts = filtered[i].vertices;
  for (let j=0;j<3;j++) {
    const a=verts[j], b=verts[(j+1)%3];
    const ka=edgeVKey(a), kb=edgeVKey(b); const key=ka<kb?`${ka}|${kb}`:`${kb}|${ka}`;
    if(!map.has(key)) map.set(key,[]);
    map.get(key).push({i,topo:filtered[i].topoFaceId,dir:`${ka} -> ${kb}`});
  }
}
for (const [key,owners] of map) if(owners.length===1) console.log(key, owners);
