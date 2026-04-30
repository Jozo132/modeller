import { readFileSync } from 'node:fs';
import { parseCMOD } from '../js/cmod.js';
import { Part } from '../js/cad/Part.js';
import { edgeVKey } from '../js/cad/toolkit/Vec3Utils.js';

const part = Part.deserialize(parseCMOD(readFileSync('tests/samples/box-fillet-2-s-1.cmod', 'utf8')).data.part);
const geometry = part.getFinalGeometry().geometry;
const edgeMap = new Map();
for (let faceIndex = 0; faceIndex < geometry.faces.length; faceIndex++) {
  const face = geometry.faces[faceIndex];
  const verts = face.vertices || [];
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    const ka = edgeVKey(a);
    const kb = edgeVKey(b);
    const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    const fwd = ka < kb;
    if (!edgeMap.has(key)) edgeMap.set(key, []);
    edgeMap.get(key).push({ tri: faceIndex, topoFaceId: face.topoFaceId, fwd, dir: `${ka} -> ${kb}` });
  }
}
let shown = 0;
for (const [key, owners] of edgeMap) {
  if (owners.length === 2 && owners[0].fwd === owners[1].fwd) {
    console.log(JSON.stringify({ key, owners }));
    if (++shown >= 80) break;
  }
}
console.log('shown', shown);
