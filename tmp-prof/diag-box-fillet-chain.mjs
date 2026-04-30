import { readFileSync } from 'node:fs';
import { parseCMOD } from '../js/cmod.js';
import { Part } from '../js/cad/Part.js';
import { _mapSegmentKeysToTopoEdges, _sampleExactEdgePoints } from '../js/cad/BRepChamfer.js';
import { edgeKeyFromVerts, edgeVKey, vec3Dot, vec3Len, vec3Normalize, vec3Sub } from '../js/cad/toolkit/Vec3Utils.js';
import { measureMeshTopology, countTopoBodyBoundaryEdges } from '../js/cad/toolkit/TopologyUtils.js';
import { detectBoundaryEdges, detectDegenerateFaces, detectSelfIntersections } from '../js/cad/MeshValidator.js';

const raw = readFileSync('tests/samples/box-fillet-2-s-1.cmod', 'utf8');
const part = Part.deserialize(parseCMOD(raw).data.part);
const feature = part.featureTree.features.find((item) => item.id === 'feature_94');
const before = part.getGeometryBeforeFeature('feature_94').geometry;
const topo = before.topoBody;
const edgeSegments = Math.max((feature.segments || 8) * 4, 32);
const segMap = _mapSegmentKeysToTopoEdges(topo, edgeSegments);

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function isLinear(edge) {
  const curve = edge?.curve;
  return !curve || (curve.degree === 1 && Array.isArray(curve.controlPoints) && curve.controlPoints.length === 2);
}

function nearestTopoEdgeForKey(key) {
  let topoEdge = segMap.get(key) || null;
  if (topoEdge) return { topoEdge, dist: 0, source: 'segment-map' };
  const sep = key.indexOf('|');
  const a = key.slice(0, sep).split(',').map(Number);
  const b = key.slice(sep + 1).split(',').map(Number);
  const mid = { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, z: (a[2] + b[2]) / 2 };
  let best = null;
  for (const { topoEdge: edge, samples } of segMap._allEdgeSamples || []) {
    for (let i = 0; i < samples.length - 1; i++) {
      const s0 = samples[i];
      const s1 = samples[i + 1];
      const dir = vec3Sub(s1, s0);
      const len2 = vec3Dot(dir, dir);
      let t = len2 > 1e-20 ? vec3Dot(vec3Sub(mid, s0), dir) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const p = { x: s0.x + dir.x * t, y: s0.y + dir.y * t, z: s0.z + dir.z * t };
      const d = dist(mid, p);
      if (!best || d < best.dist) best = { topoEdge: edge, dist: d, source: 'nearest' };
    }
  }
  return best;
}

function edgeDirectionAt(edge, vertex) {
  const samples = _sampleExactEdgePoints(edge, 64);
  if (!Array.isArray(samples) || samples.length < 2) {
    const a = edge.startVertex.point;
    const b = edge.endVertex.point;
    const dir = edgeVKey(vertex) === edgeVKey(a) ? vec3Sub(b, a) : vec3Sub(a, b);
    return vec3Normalize(dir);
  }
  const start = edge.startVertex.point;
  const end = edge.endVertex.point;
  if (dist(vertex, start) <= dist(vertex, end)) return vec3Normalize(vec3Sub(samples[1], samples[0]));
  return vec3Normalize(vec3Sub(samples[samples.length - 2], samples[samples.length - 1]));
}

function edgeSummary(edge) {
  const faces = [...new Set((edge.coedges || []).map((coedge) => coedge.face).filter(Boolean))];
  return {
    id: edge.id,
    linear: isLinear(edge),
    degree: edge.curve?.degree ?? null,
    cps: edge.curve?.controlPoints?.length ?? null,
    start: edgeVKey(edge.startVertex.point),
    end: edgeVKey(edge.endVertex.point),
    length: Number(dist(edge.startVertex.point, edge.endVertex.point).toFixed(6)),
    faces: faces.map((face) => ({ id: face.id, type: face.surfaceType, shared: face.shared || null })),
  };
}

function faceNormalAt(face, point) {
  if (!face?.surface || typeof face.surface.normal !== 'function') return null;
  let uv = null;
  if (typeof face.surface.closestPointUV === 'function') uv = face.surface.closestPointUV(point);
  const u = uv ? uv.u : (face.surface.uMin + face.surface.uMax) * 0.5;
  const v = uv ? uv.v : (face.surface.vMin + face.surface.vMax) * 0.5;
  let normal = face.surface.normal(u, v);
  if (face.sameSense === false) normal = { x: -normal.x, y: -normal.y, z: -normal.z };
  return vec3Normalize(normal);
}

const selected = new Map();
for (const key of feature.edgeKeys) {
  const match = nearestTopoEdgeForKey(key);
  if (match && match.dist < 0.08) selected.set(match.topoEdge.id, match.topoEdge);
}

console.log('feature keys', feature.edgeKeys.length, 'selected topo edges', selected.size);
for (const edge of selected.values()) {
  console.log('SELECTED', JSON.stringify(edgeSummary(edge), null, 2));
  const adjacentFaces = [...new Set((edge.coedges || []).map((coedge) => coedge.face).filter(Boolean))];
  if (adjacentFaces.length >= 2) {
    const samples = _sampleExactEdgePoints(edge, 8);
    const angles = [];
    for (const point of samples) {
      const n0 = faceNormalAt(adjacentFaces[0], point);
      const n1 = faceNormalAt(adjacentFaces[1], point);
      if (!n0 || !n1) continue;
      const dot = Math.max(-1, Math.min(1, vec3Dot(n0, n1)));
      angles.push(Number((Math.acos(dot) * 180 / Math.PI).toFixed(4)));
    }
    console.log('SELECTED_LOCAL_NORMAL_ANGLES_DEG', angles);
  }
}

for (const edge of selected.values()) {
  for (const endpoint of [edge.startVertex.point, edge.endVertex.point]) {
    const endpointKey = edgeVKey(endpoint);
    const selectedDir = edgeDirectionAt(edge, endpoint);
    const incident = [];
    for (const candidate of topo.edges()) {
      if (candidate.id === edge.id) continue;
      const touches = edgeVKey(candidate.startVertex.point) === endpointKey || edgeVKey(candidate.endVertex.point) === endpointKey;
      if (!touches) continue;
      const candidateDir = edgeDirectionAt(candidate, endpoint);
      const dot = vec3Dot(selectedDir, candidateDir);
      incident.push({ dot: Number(dot.toFixed(6)), angleDeg: Number((Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI).toFixed(3)), edge: edgeSummary(candidate) });
    }
    incident.sort((a, b) => Math.abs(b.dot) - Math.abs(a.dot));
    console.log('INCIDENT at', endpointKey, JSON.stringify(incident, null, 2));
  }
}

function otherEndpoint(edge, vertexKey) {
  return edgeVKey(edge.startVertex.point) === vertexKey ? edge.endVertex.point : edge.startVertex.point;
}

function walkTangentChain(seedEdge, seedVertex) {
  const chain = [seedEdge];
  let previousEdge = seedEdge;
  let currentPoint = seedVertex;
  let previousDir = edgeDirectionAt(previousEdge, currentPoint);
  for (let step = 0; step < 12; step++) {
    const currentKey = edgeVKey(currentPoint);
    let best = null;
    for (const candidate of topo.edges()) {
      if (candidate.id === previousEdge.id || chain.some((edge) => edge.id === candidate.id)) continue;
      const touches = edgeVKey(candidate.startVertex.point) === currentKey || edgeVKey(candidate.endVertex.point) === currentKey;
      if (!touches) continue;
      const candidateDir = edgeDirectionAt(candidate, currentPoint);
      const tangentScore = -vec3Dot(previousDir, candidateDir);
      if (!best || tangentScore > best.tangentScore) best = { edge: candidate, tangentScore, candidateDir };
    }
    if (!best || best.tangentScore < 0.96) break;
    chain.push(best.edge);
    currentPoint = otherEndpoint(best.edge, currentKey);
    previousEdge = best.edge;
    previousDir = vec3Normalize(vec3Sub(currentPoint, otherEndpoint(previousEdge, edgeVKey(currentPoint))));
  }
  return chain;
}

for (const edge of selected.values()) {
  for (const endpoint of [edge.startVertex.point, edge.endVertex.point]) {
    const chain = walkTangentChain(edge, endpoint);
    console.log('TANGENT_CHAIN from', edgeVKey(endpoint), JSON.stringify(chain.map(edgeSummary), null, 2));
    const terminalEdge = chain[chain.length - 1];
    const terminalStart = terminalEdge === edge ? endpoint : otherEndpoint(terminalEdge, edgeVKey(chain[chain.length - 2].startVertex.point) === edgeVKey(terminalEdge.startVertex.point) || edgeVKey(chain[chain.length - 2].endVertex.point) === edgeVKey(terminalEdge.startVertex.point)
      ? edgeVKey(terminalEdge.startVertex.point)
      : edgeVKey(terminalEdge.endVertex.point));
    const terminalKey = edgeVKey(terminalStart);
    const terminalIncident = [];
    for (const candidate of topo.edges()) {
      if (chain.some((chainEdge) => chainEdge.id === candidate.id)) continue;
      const touches = edgeVKey(candidate.startVertex.point) === terminalKey || edgeVKey(candidate.endVertex.point) === terminalKey;
      if (touches) terminalIncident.push(edgeSummary(candidate));
    }
    console.log('CHAIN_TERMINAL_INCIDENT at', terminalKey, JSON.stringify(terminalIncident, null, 2));
  }
}

const finalGeometry = part.getFinalGeometry().geometry;
console.log('final topo faces', finalGeometry.topoBody.faces().length);
console.log('final topo boundary', countTopoBodyBoundaryEdges(finalGeometry.topoBody));
console.log('final mesh topology', measureMeshTopology(finalGeometry.faces));
console.log('mesh validator boundary', detectBoundaryEdges(finalGeometry.faces).count);
console.log('degenerate', detectDegenerateFaces(finalGeometry.faces).count);
console.log('self intersections sameTopo', detectSelfIntersections(finalGeometry.faces, { sameTopoFaceOnly: true }).count);
console.log('self intersections all', detectSelfIntersections(finalGeometry.faces).count);

for (const face of finalGeometry.topoBody.faces()) {
  if (!face.shared?.isFillet) continue;
  console.log('FILLET_FACE', JSON.stringify({
    id: face.id,
    type: face.surfaceType,
    shared: face.shared,
    coedges: face.outerLoop?.coedges?.length || 0,
    vertices: (face.outerLoop?.points?.() || []).slice(0, 10).map(edgeVKey),
  }, null, 2));
}
