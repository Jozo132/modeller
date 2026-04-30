import { readFileSync } from 'node:fs';
import { parseCMOD } from '../js/cmod.js';
import { Part } from '../js/cad/Part.js';
import { detectBoundaryEdges, detectDegenerateFaces } from '../js/cad/MeshValidator.js';
import { measureMeshTopology, countTopoBodyBoundaryEdges } from '../js/cad/toolkit/TopologyUtils.js';
import { removeDegenerateFaces } from '../js/cad/toolkit/MeshRepair.js';
import { expandPathEdgeKeys } from '../js/cad/EdgeAnalysis.js';
import { edgeKeyFromVerts, edgeVKey, vec3Dot, vec3Len, vec3Normalize, vec3Sub } from '../js/cad/toolkit/Vec3Utils.js';

const raw = readFileSync('tests/samples/box-fillet-2-s-1.cmod', 'utf8');
const part = Part.deserialize(parseCMOD(raw).data.part);

for (const feature of part.featureTree.features) {
  const result = part.featureTree.results[feature.id];
  const geometry = result?.geometry;
  const topoFaces = geometry?.topoBody?.faces ? geometry.topoBody.faces().length : null;
  const error = feature.error?.message || result?.error?.message || 'none';
  console.log(feature.id, feature.type, 'err=', error, 'meshFaces=', geometry?.faces?.length ?? null, 'topoFaces=', topoFaces);
}

const finalGeometry = part.getFinalGeometry().geometry;
console.log('final mesh topology', measureMeshTopology(finalGeometry.faces));
console.log('final topo boundary', countTopoBodyBoundaryEdges(finalGeometry.topoBody));
console.log('final mesh boundary', detectBoundaryEdges(finalGeometry.faces).count);
console.log('final degenerate', detectDegenerateFaces(finalGeometry.faces).count);
const cleanedFaces = finalGeometry.faces.map((face) => ({ ...face, vertices: face.vertices.map((vertex) => ({ ...vertex })) }));
removeDegenerateFaces(cleanedFaces);
console.log('after degenerate removal', measureMeshTopology(cleanedFaces), 'degenerate', detectDegenerateFaces(cleanedFaces).count, 'faces', cleanedFaces.length);
const openTopo = finalGeometry.topoBody.edges().filter((edge) => (edge.coedges || []).length !== 2);
console.log('open topo edges', JSON.stringify(openTopo.map((edge) => ({
  id: edge.id,
  coedges: (edge.coedges || []).length,
  start: edgeVKey(edge.startVertex.point),
  end: edgeVKey(edge.endVertex.point),
  degree: edge.curve?.degree ?? null,
  cps: edge.curve?.controlPoints?.length ?? null,
  faces: (edge.coedges || []).map((coedge) => ({ id: coedge.face?.id, type: coedge.face?.surfaceType, sameSense: coedge.sameSense, shared: coedge.face?.shared || null })),
})), null, 2));
const openFaceIds = new Set(openTopo.flatMap((edge) => (edge.coedges || []).map((coedge) => coedge.face?.id).filter(Boolean)));
for (const face of finalGeometry.topoBody.faces()) {
  if (!openFaceIds.has(face.id) && !face.shared?.isFillet) continue;
  const verts = (face.outerLoop?.coedges || []).map((coedge) => {
    const point = coedge.sameSense === false ? coedge.edge.endVertex.point : coedge.edge.startVertex.point;
    return edgeVKey(point);
  });
  console.log('face loop', face.id, face.surfaceType, face.shared, verts);
}
const targetKeys = new Set([
  '10.00000,0.35036,9.50000',
  '10.00000,0.12233,9.46913',
  '9.81466,0.13041,9.49635',
  '10.00000,10.00000,9.50000',
]);
console.log('edges at terminal target points', JSON.stringify(finalGeometry.topoBody.edges()
  .filter((edge) => targetKeys.has(edgeVKey(edge.startVertex.point)) || targetKeys.has(edgeVKey(edge.endVertex.point)))
  .map((edge) => ({
    id: edge.id,
    start: edgeVKey(edge.startVertex.point),
    end: edgeVKey(edge.endVertex.point),
    coedges: (edge.coedges || []).map((coedge) => ({ face: coedge.face?.id, type: coedge.face?.surfaceType, sameSense: coedge.sameSense })),
  })), null, 2));

const fillet3 = part.featureTree.features.find((feature) => feature.id === 'feature_94');
console.log('fillet3 keys', fillet3.edgeKeys.length, 'radius', fillet3.radius, 'segments', fillet3.segments);

const before = part.getGeometryBeforeFeature('feature_94').geometry;
const expanded = expandPathEdgeKeys(before, fillet3.edgeKeys);
console.log('before paths', before.paths.length, 'before edges', before.edges.length, 'expanded keys', expanded.length);

const keyToEdge = new Map();
for (let index = 0; index < before.edges.length; index++) {
  const edge = before.edges[index];
  keyToEdge.set(edgeKeyFromVerts(edge.start, edge.end), { edge, index });
  keyToEdge.set(edgeKeyFromVerts(edge.end, edge.start), { edge, index });
}

const selectedEdgeIndices = new Set();
for (const key of fillet3.edgeKeys) {
  const match = keyToEdge.get(key);
  if (match) selectedEdgeIndices.add(match.index);
}
const expandedEdgeIndices = new Set();
for (const key of expanded) {
  const match = keyToEdge.get(key);
  if (match) expandedEdgeIndices.add(match.index);
}
const touchedPathIds = [];
for (let pathIndex = 0; pathIndex < before.paths.length; pathIndex++) {
  const path = before.paths[pathIndex];
  const selected = path.edgeIndices.filter((edgeIndex) => selectedEdgeIndices.has(edgeIndex));
  const expandedSelected = path.edgeIndices.filter((edgeIndex) => expandedEdgeIndices.has(edgeIndex));
  if (selected.length > 0 || expandedSelected.length > 0) {
    touchedPathIds.push({ pathIndex, pathEdges: path.edgeIndices.length, selected: selected.length, expanded: expandedSelected.length, isClosed: path.isClosed });
  }
}
console.log('touched paths', touchedPathIds);

const selectedTopo = [];
for (const topoEdge of before.topoBody.edges()) {
  const samples = topoEdge.tessellate(32);
  let hits = 0;
  for (let i = 0; i < samples.length - 1; i++) {
    const sampleKey = edgeKeyFromVerts(samples[i], samples[i + 1]);
    const sampleKeyRev = edgeKeyFromVerts(samples[i + 1], samples[i]);
    if (fillet3.edgeKeys.includes(sampleKey) || fillet3.edgeKeys.includes(sampleKeyRev)) hits++;
  }
  if (hits > 0) {
    const adjacentFaces = [...new Set((topoEdge.coedges || []).map((coedge) => coedge.face).filter(Boolean))];
    selectedTopo.push({
      id: topoEdge.id,
      hits,
      degree: topoEdge.curve?.degree ?? null,
      cps: topoEdge.curve?.controlPoints?.length ?? null,
      start: edgeVKey(topoEdge.startVertex.point),
      end: edgeVKey(topoEdge.endVertex.point),
      faces: adjacentFaces.map((face) => ({ id: face.id, type: face.surfaceType, shared: face.shared || null })),
    });
  }
}
console.log('selected topo edges', JSON.stringify(selectedTopo, null, 2));

const endpointIncidence = new Map();
for (const entry of selectedTopo) {
  for (const key of [entry.start, entry.end]) {
    endpointIncidence.set(key, (endpointIncidence.get(key) || 0) + 1);
  }
}
console.log('selected endpoint incidence', Object.fromEntries(endpointIncidence));

const filletFaces = finalGeometry.topoBody.faces().filter((face) => face.shared?.isFillet);
console.log('fillet topo faces', filletFaces.length);
const faceTypes = new Map();
for (const face of finalGeometry.topoBody.faces()) {
  faceTypes.set(face.surfaceType, (faceTypes.get(face.surfaceType) || 0) + 1);
}
console.log('topo face types', Object.fromEntries([...faceTypes].sort()));
