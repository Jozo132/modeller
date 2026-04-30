import { readFileSync } from 'node:fs';
import { parseCMOD } from '../js/cmod.js';
import { Part } from '../js/cad/Part.js';
import { applyBRepFillet } from '../js/cad/BRepFillet.js';
import { edgeKeyFromVerts, edgeVKey } from '../js/cad/toolkit/Vec3Utils.js';
import { measureMeshTopology, countTopoBodyBoundaryEdges } from '../js/cad/toolkit/TopologyUtils.js';
import { detectBoundaryEdges, detectDegenerateFaces, detectSelfIntersections } from '../js/cad/MeshValidator.js';

const part = Part.deserialize(parseCMOD(readFileSync('tests/samples/box-fillet-2-s-1.cmod', 'utf8')).data.part);
const feature = part.featureTree.features.find(f => f.id === 'feature_94');
const before = part.getGeometryBeforeFeature('feature_94').geometry;
const edges = [...before.topoBody.edges()];
const chain = [];
for (const edge of edges) {
  const faces = [...new Set((edge.coedges || []).map(ce => ce.face).filter(Boolean))];
  const faceIds = faces.map(f => f.id).sort((a,b)=>a-b).join(',');
  const a = edge.startVertex.point, b = edge.endVertex.point;
  if (faceIds === '16,19' && Math.abs(a.x - 10) < 1e-5 && Math.abs(b.x - 10) < 1e-5 && Math.max(a.z,b.z) <= 9.50001) {
    chain.push(edge);
  }
}
chain.sort((e1,e2)=>Math.max(e2.startVertex.point.z,e2.endVertex.point.z)-Math.max(e1.startVertex.point.z,e1.endVertex.point.z));
console.log('chain edges', chain.map(e => ({id:e.id,start:edgeVKey(e.startVertex.point),end:edgeVKey(e.endVertex.point)})));
const keys = [...feature.edgeKeys, ...chain.map(e => edgeKeyFromVerts(e.startVertex.point, e.endVertex.point))];
const result = applyBRepFillet(before, keys, feature.radius, feature.segments);
if (!result) { console.log('result null'); process.exit(0); }
console.log('topo faces', result.topoBody.faces().length, 'topo boundary', countTopoBodyBoundaryEdges(result.topoBody));
console.log('mesh topology', measureMeshTopology(result.faces));
console.log('boundary', detectBoundaryEdges(result.faces).count, 'deg', detectDegenerateFaces(result.faces).count, 'self same', detectSelfIntersections(result.faces,{sameTopoFaceOnly:true}).count, 'self all', detectSelfIntersections(result.faces).count);
for (const face of result.topoBody.faces().filter(face=>face.shared?.isFillet)) console.log('fillet face', face.id, face.shared, face.outerLoop?.coedges?.length);
