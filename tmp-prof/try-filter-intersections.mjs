import { readFileSync } from 'node:fs';
import { parseCMOD } from '../js/cmod.js';
import { Part } from '../js/cad/Part.js';
import { detectSelfIntersections, detectBoundaryEdges } from '../js/cad/MeshValidator.js';
import { measureMeshTopology } from '../js/cad/toolkit/TopologyUtils.js';

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
console.log('bad', [...bad].sort((a,b)=>a-b));
console.log('topo', measureMeshTopology(filtered), 'boundary', detectBoundaryEdges(filtered).count, 'self', detectSelfIntersections(filtered,{sameTopoFaceOnly:true}).count, detectSelfIntersections(filtered).count);
