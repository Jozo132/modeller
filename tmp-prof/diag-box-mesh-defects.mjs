import { readFileSync } from 'node:fs';
import { parseCMOD } from '../js/cmod.js';
import { Part } from '../js/cad/Part.js';
import { detectDegenerateFaces, detectSelfIntersections } from '../js/cad/MeshValidator.js';
import { measureMeshTopology } from '../js/cad/toolkit/TopologyUtils.js';

const part = Part.deserialize(parseCMOD(readFileSync('tests/samples/box-fillet-2-s-1.cmod', 'utf8')).data.part);
const geometry = part.getFinalGeometry().geometry;
console.log('topology', measureMeshTopology(geometry.faces));
console.log('degenerate total', detectDegenerateFaces(geometry.faces).count);
const byFace = new Map();
for (let i = 0; i < geometry.faces.length; i++) {
  const tri = geometry.faces[i];
  const id = tri.topoFaceId ?? -1;
  if (!byFace.has(id)) byFace.set(id, []);
  byFace.get(id).push({ tri, index: i });
}
for (const [id, entries] of [...byFace.entries()].sort((a, b) => a[0] - b[0])) {
  const tris = entries.map((entry) => entry.tri);
  const deg = detectDegenerateFaces(tris).count;
  const self = detectSelfIntersections(tris).count;
  const topo = measureMeshTopology(tris);
  const face = geometry.topoBody.faces().find((candidate) => candidate.id === id);
  if (deg || self || topo.boundaryEdges || topo.nonManifoldEdges || topo.windingErrors || face?.shared?.isFillet) {
    console.log(JSON.stringify({
      id,
      type: face?.surfaceType,
      coedges: face?.outerLoop?.coedges?.length,
      shared: face?.shared ? { isFillet: face.shared.isFillet, isRollingFillet: face.shared.isRollingFillet, radius: face.shared._exactRadius } : null,
      tris: tris.length,
      topo,
      deg,
      self,
    }));
  }
}
const pairs = detectSelfIntersections(geometry.faces, { sameTopoFaceOnly: true }).pairs.slice(0, 10);
console.log('first same-face self pairs', pairs.map(([a, b]) => ({ a, b, fa: geometry.faces[a].topoFaceId, fb: geometry.faces[b].topoFaceId })));
