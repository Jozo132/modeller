import { readFileSync } from 'node:fs';
import { parseCMOD } from '../js/cmod.js';
import { Part } from '../js/cad/Part.js';
import { _mapSegmentKeysToTopoEdges, _sampleExactEdgePoints } from '../js/cad/BRepChamfer.js';
import { edgeVKey, vec3Dot, vec3Len, vec3Normalize, vec3Sub } from '../js/cad/toolkit/Vec3Utils.js';

const raw = readFileSync('tests/samples/box-fillet-2-s-1.cmod', 'utf8');
const partData = parseCMOD(raw).data.part;
const featureData = partData.featureTree.features.find((candidate) => candidate.id === 'feature_94');
featureData.suppressed = true;
const part = Part.deserialize(partData);
const feature = featureData;
const beforeGeometry = part.getGeometryBeforeFeature('feature_94').geometry;
const topoBody = beforeGeometry.topoBody;
const segmentMap = _mapSegmentKeysToTopoEdges(topoBody, Math.max(feature.segments * 4, 32));

function parseEdgeKey(edgeKey) {
  const separator = edgeKey.indexOf('|');
  const parsePoint = (text) => {
    const values = text.split(',').map(Number);
    return { x: values[0], y: values[1], z: values[2] };
  };
  return { start: parsePoint(edgeKey.slice(0, separator)), end: parsePoint(edgeKey.slice(separator + 1)) };
}

function distancePointToSegment(point, start, end) {
  const segment = vec3Sub(end, start);
  const lengthSq = vec3Dot(segment, segment);
  const rawT = lengthSq > 1e-20 ? vec3Dot(vec3Sub(point, start), segment) / lengthSq : 0;
  const t = Math.max(0, Math.min(1, rawT));
  const closest = {
    x: start.x + segment.x * t,
    y: start.y + segment.y * t,
    z: start.z + segment.z * t,
  };
  return vec3Len(vec3Sub(point, closest));
}

function findNearestTopoEdge(edgeKey) {
  const direct = segmentMap.get(edgeKey);
  if (direct) return { edge: direct, distance: 0, source: 'map' };
  const parsed = parseEdgeKey(edgeKey);
  const midPoint = {
    x: (parsed.start.x + parsed.end.x) * 0.5,
    y: (parsed.start.y + parsed.end.y) * 0.5,
    z: (parsed.start.z + parsed.end.z) * 0.5,
  };
  let best = null;
  for (const entry of segmentMap._allEdgeSamples || []) {
    for (let sampleIndex = 0; sampleIndex < entry.samples.length - 1; sampleIndex++) {
      const distance = distancePointToSegment(midPoint, entry.samples[sampleIndex], entry.samples[sampleIndex + 1]);
      if (!best || distance < best.distance) best = { edge: entry.topoEdge, distance, source: 'nearest' };
    }
  }
  return best;
}

function faceNormalAtPoint(face, point) {
  if (!face?.surface || typeof face.surface.normal !== 'function') return face.normal || null;
  let uv = null;
  if (typeof face.surface.closestPointUV === 'function') uv = face.surface.closestPointUV(point);
  const u = uv ? uv.u : (face.surface.uMin + face.surface.uMax) * 0.5;
  const v = uv ? uv.v : (face.surface.vMin + face.surface.vMax) * 0.5;
  let normal = vec3Normalize(face.surface.normal(u, v));
  if (face.sameSense === false) normal = { x: -normal.x, y: -normal.y, z: -normal.z };
  return normal;
}

function edgeDirectionFromVertex(edge, vertex) {
  if (edge.startVertex === vertex) return vec3Normalize(vec3Sub(edge.endVertex.point, edge.startVertex.point));
  if (edge.endVertex === vertex) return vec3Normalize(vec3Sub(edge.startVertex.point, edge.endVertex.point));
  return null;
}

function otherVertex(edge, vertex) {
  if (edge.startVertex === vertex) return edge.endVertex;
  if (edge.endVertex === vertex) return edge.startVertex;
  return null;
}

const matchCounts = new Map();
for (const edgeKey of feature.edgeKeys) {
  const match = findNearestTopoEdge(edgeKey);
  if (!match || match.distance > 0.08) continue;
  const previous = matchCounts.get(match.edge.id) || { edge: match.edge, count: 0, maxDistance: 0, sources: new Set() };
  previous.count++;
  previous.maxDistance = Math.max(previous.maxDistance, match.distance);
  previous.sources.add(match.source);
  matchCounts.set(match.edge.id, previous);
}

console.log('featureKeys', feature.edgeKeys.length, 'matchedTopoEdges', matchCounts.size);
for (const entry of [...matchCounts.values()].sort((left, right) => right.count - left.count)) {
  const edge = entry.edge;
  const samples = _sampleExactEdgePoints(edge, 16);
  console.log('selectedEdge', JSON.stringify({
    id: edge.id,
    count: entry.count,
    maxDistance: Number(entry.maxDistance.toFixed(6)),
    sources: [...entry.sources],
    start: edgeVKey(edge.startVertex.point),
    end: edgeVKey(edge.endVertex.point),
    degree: edge.curve?.degree ?? null,
    controlPoints: edge.curve?.controlPoints?.length ?? null,
    samples: [samples[0], samples[Math.floor(samples.length / 2)], samples[samples.length - 1]].map(edgeVKey),
  }));
  const faces = [...new Set((edge.coedges || []).map((coedge) => coedge.face).filter(Boolean))];
  for (const face of faces) {
    console.log('  adjacentFace', JSON.stringify({
      id: face.id,
      type: face.surfaceType,
      sameSense: face.sameSense,
      coedges: face.outerLoop?.coedges?.length || 0,
      shared: face.shared ? {
        isFillet: !!face.shared.isFillet,
        isRollingFillet: !!face.shared.isRollingFillet,
        exactRadius: face.shared._exactRadius ?? null,
        radius: face.shared.radius ?? null,
      } : null,
      faceNormal: face.normal ? edgeVKey(vec3Normalize(face.normal)) : null,
      localNormals: samples.filter((_, index) => index === 0 || index === Math.floor(samples.length / 2) || index === samples.length - 1)
        .map((point) => edgeVKey(faceNormalAtPoint(face, point))),
    }));
  }
  for (const endpoint of [edge.startVertex, edge.endVertex]) {
    const endpointKey = edgeVKey(endpoint.point);
    const selectedDirection = endpoint === edge.startVertex
      ? vec3Normalize(vec3Sub(samples[1], samples[0]))
      : vec3Normalize(vec3Sub(samples[samples.length - 2], samples[samples.length - 1]));
    const incidents = [];
    for (const candidate of topoBody.edges()) {
      if (candidate.id === edge.id) continue;
      if (candidate.startVertex !== endpoint && candidate.endVertex !== endpoint) continue;
      const direction = edgeDirectionFromVertex(candidate, endpoint);
      const opposite = otherVertex(candidate, endpoint);
      incidents.push({
        id: candidate.id,
        dotWithSelected: Number(vec3Dot(direction, selectedDirection).toFixed(6)),
        start: edgeVKey(candidate.startVertex.point),
        end: edgeVKey(candidate.endVertex.point),
        other: opposite ? edgeVKey(opposite.point) : null,
        degree: candidate.curve?.degree ?? null,
        controlPoints: candidate.curve?.controlPoints?.length ?? null,
        faces: [...new Set((candidate.coedges || []).map((coedge) => coedge.face).filter(Boolean))]
          .map((face) => ({ id: face.id, type: face.surfaceType, fillet: !!face.shared?.isFillet, radius: face.shared?._exactRadius ?? null })),
      });
    }
    incidents.sort((left, right) => Math.abs(right.dotWithSelected) - Math.abs(left.dotWithSelected));
    console.log('  endpointIncidents', endpointKey, JSON.stringify(incidents));
  }
}

const debugEdgeIds = new Set([35, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50]);
for (const edge of topoBody.edges()) {
  if (!debugEdgeIds.has(edge.id)) continue;
  console.log('debugEdge', JSON.stringify({
    id: edge.id,
    start: edgeVKey(edge.startVertex.point),
    end: edgeVKey(edge.endVertex.point),
    degree: edge.curve?.degree ?? null,
    controlPoints: edge.curve?.controlPoints?.length ?? null,
    faces: [...new Set((edge.coedges || []).map((coedge) => coedge.face).filter(Boolean))]
      .map((face) => ({ id: face.id, type: face.surfaceType, fillet: !!face.shared?.isFillet, radius: face.shared?._exactRadius ?? null })),
  }));
}