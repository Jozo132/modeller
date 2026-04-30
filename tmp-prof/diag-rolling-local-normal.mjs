import { readFileSync } from 'node:fs';
import { parseCMOD } from '../js/cmod.js';
import { Part } from '../js/cad/Part.js';
import { edgeVKey, vec3Dot, vec3Len, vec3Normalize, vec3Sub } from '../js/cad/toolkit/Vec3Utils.js';
import { measureMeshTopology, countTopoBodyBoundaryEdges } from '../js/cad/toolkit/TopologyUtils.js';
import { detectBoundaryEdges, detectDegenerateFaces } from '../js/cad/MeshValidator.js';

const raw = readFileSync('tests/samples/box-fillet-2-s-1.cmod', 'utf8');
const part = Part.deserialize(parseCMOD(raw).data.part);
const geometry = part.getFinalGeometry().geometry;
const topoBody = geometry.topoBody;

console.log('topoFaces', topoBody.faces().length, 'topoBoundary', countTopoBodyBoundaryEdges(topoBody));
console.log('meshTopology', JSON.stringify(measureMeshTopology(geometry.faces)));
console.log('validator', JSON.stringify({
  boundary: detectBoundaryEdges(geometry.faces).count,
  degenerate: detectDegenerateFaces(geometry.faces).count,
}));

function pointLineDistance(point, lineA, lineB) {
  const line = vec3Sub(lineB, lineA);
  const lineLength = vec3Len(line);
  if (lineLength < 1e-12) return vec3Len(vec3Sub(point, lineA));
  const direction = vec3Normalize(line);
  const delta = vec3Sub(point, lineA);
  const projected = vec3Dot(delta, direction);
  const closest = {
    x: lineA.x + direction.x * projected,
    y: lineA.y + direction.y * projected,
    z: lineA.z + direction.z * projected,
  };
  return vec3Len(vec3Sub(point, closest));
}

const rollingFace = topoBody.faces().find((face) => face.shared?.isRollingFillet);
if (rollingFace) {
  const shared = rollingFace.shared;
  console.log('rollingFace', rollingFace.id, rollingFace.surfaceType, 'coedges', rollingFace.outerLoop.coedges.length);
  console.log('railCounts', shared._rollingRail0.length, shared._rollingRail1.length, shared._rollingCenters.length);
  const sampleIndexes = [0, 1, 2, Math.floor(shared._rollingRail0.length / 2), shared._rollingRail0.length - 3, shared._rollingRail0.length - 2, shared._rollingRail0.length - 1]
    .filter((value, index, array) => value >= 0 && value < shared._rollingRail0.length && array.indexOf(value) === index);
  for (const sampleIndex of sampleIndexes) {
    const rail0 = shared._rollingRail0[sampleIndex];
    const rail1 = shared._rollingRail1[sampleIndex];
    const center = shared._rollingCenters[sampleIndex];
    console.log('railStation', sampleIndex, JSON.stringify({
      rail0: edgeVKey(rail0),
      rail1: edgeVKey(rail1),
      center: edgeVKey(center),
      r0: Number(vec3Len(vec3Sub(rail0, center)).toFixed(6)),
      r1: Number(vec3Len(vec3Sub(rail1, center)).toFixed(6)),
    }));
  }
  for (const coedge of rollingFace.outerLoop.coedges) {
    const edge = coedge.edge;
    console.log('rollingEdge', edge.id, 'sameSense', coedge.sameSense, 'degree', edge.curve?.degree, 'cps', edge.curve?.controlPoints?.length, edgeVKey(edge.startVertex.point), '->', edgeVKey(edge.endVertex.point));
  }
}

const topFace = topoBody.faces().find((face) => {
  const points = face.outerLoop?.points?.() || [];
  return face.surfaceType === 'plane' && points.length > 0 && points.every((point) => Math.abs(point.z - 10) < 1e-6);
});
if (topFace) {
  console.log('topFace', topFace.id, 'coedges', topFace.outerLoop.coedges.length);
  for (const coedge of topFace.outerLoop.coedges) {
    const edge = coedge.edge;
    console.log('topEdge', edge.id, 'degree', edge.curve?.degree, 'cps', edge.curve?.controlPoints?.length, edgeVKey(edge.startVertex.point), '->', edgeVKey(edge.endVertex.point));
  }
}

for (const face of topoBody.faces()) {
  if (!face.shared?.isFillet && !face.shared?.isRollingFillet) continue;
  console.log('filletFace', face.id, face.surfaceType, 'rolling', !!face.shared?.isRollingFillet, 'coedges', face.outerLoop?.coedges?.length || 0);
}