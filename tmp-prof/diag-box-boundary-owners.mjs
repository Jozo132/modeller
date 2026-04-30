import { readFileSync } from 'node:fs';
import { parseCMOD } from '../js/cmod.js';
import { Part } from '../js/cad/Part.js';
import { edgeVKey } from '../js/cad/toolkit/Vec3Utils.js';

const part = Part.deserialize(parseCMOD(readFileSync('tests/samples/box-fillet-2-s-1.cmod', 'utf8')).data.part);
const faces = part.getFinalGeometry().geometry.faces;
const edgeMap = new Map();
function k(a,b){ const ka=edgeVKey(a), kb=edgeVKey(b); return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`; }
function directed(a,b){ return `${edgeVKey(a)} -> ${edgeVKey(b)}`; }
for (let i=0;i<faces.length;i++) {
  const tri=faces[i];
  for (let j=0;j<3;j++) {
    const a=tri.vertices[j], b=tri.vertices[(j+1)%3];
    const key=k(a,b);
    if (!edgeMap.has(key)) edgeMap.set(key, []);
    edgeMap.get(key).push({ tri:i, topoFaceId:tri.topoFaceId, dir: directed(a,b) });
  }
}
let count=0;
for (const [key, owners] of edgeMap) {
  if (owners.length === 1) {
    console.log(JSON.stringify({ key, owners }));
    if (++count >= 60) break;
  }
}
console.log('shown', count);
