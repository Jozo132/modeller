// js/cad/BRepChamfer.js — BRep-level chamfer operations
// Extracted from CSG.js to isolate chamfer geometry into its own module.

import { NurbsSurface } from './NurbsSurface.js';
import { NurbsCurve } from './NurbsCurve.js';
import { buildTopoBody, SurfaceType } from './BRepTopology.js';
import { tessellateBody } from './Tessellation.js';
import { computeFeatureEdges } from './EdgeAnalysis.js';
import { sampleCylinderPlaneArcWasmReady } from './WasmGeometryOps.js';
import {
  findTerminalCapFace,
  projectLineToPlane,
  topoFacePlane,
  topoPointsClose,
} from './CapProjection.js';

import {
  vec3Sub,
  vec3Add,
  vec3Scale,
  vec3Dot,
  vec3Cross,
  vec3Len,
  vec3Normalize,
  vec3Lerp,
  circumCenter3D,
  projectOntoAxis,
  pointsCoincident3D,
  canonicalPoint,
  fmtCoord,
  edgeVKey,
  edgeKeyFromVerts,
} from './toolkit/Vec3Utils.js';

import {
  computePolygonNormal,
  faceCentroid,
  collectFaceEdgeKeys,
} from './toolkit/GeometryUtils.js';

import {
  fixWindingConsistency,
  recomputeFaceNormals,
} from './toolkit/MeshRepair.js';

import {
  measureMeshTopology,
  countTopoBodyBoundaryEdges,
  findAdjacentFaces,
} from './toolkit/TopologyUtils.js';

// -----------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------

function _collectFaceTopoFaceIds(face) {
  const ids = [];
  if (!face) return ids;
  if (face.topoFaceId !== undefined) ids.push(face.topoFaceId);
  if (Array.isArray(face.topoFaceIds)) {
    for (const topoFaceId of face.topoFaceIds) {
      if (topoFaceId !== undefined) ids.push(topoFaceId);
    }
  }
  return [...new Set(ids)];
}

function _buildRepFaceIndexByTopoFaceId(faces) {
  const repFaceIndexByTopoFaceId = new Map();
  for (let fi = 0; fi < faces.length; fi++) {
    const topoFaceIds = _collectFaceTopoFaceIds(faces[fi]);
    for (const topoFaceId of topoFaceIds) {
      if (!repFaceIndexByTopoFaceId.has(topoFaceId)) {
        repFaceIndexByTopoFaceId.set(topoFaceId, fi);
      }
    }
  }
  return repFaceIndexByTopoFaceId;
}

function _buildPlanarBoundarySegments(vertices, edgeDataList) {
  if (!Array.isArray(vertices) || vertices.length < 3) return null;
  const loopKeys = vertices.map((vertex) => edgeVKey(vertex));
  const candidates = [];

  const registerCandidate = (points, curve) => {
    if (!points || points.length <= 2 || !curve) return;
    candidates.push({
      keys: points.map((point) => edgeVKey(point)),
      curve,
    });
  };

  for (const data of edgeDataList || []) {
    if (!data) continue;
    if (!data.sharedTrimA) registerCandidate(data.arcA, data._exactArcCurveA);
    if (!data.sharedTrimB) registerCandidate(data.arcB, data._exactArcCurveB);
  }

  const matchesCandidate = (startIndex, candidateKeys) => {
    for (let i = 0; i < candidateKeys.length; i++) {
      if (loopKeys[(startIndex + i) % loopKeys.length] !== candidateKeys[i]) return false;
    }
    return true;
  };

  const segments = [];
  let edgeCount = 0;
  let index = 0;
  let _loopGuard = 0;
  while (edgeCount < vertices.length) {
    if (++_loopGuard > 10_000_000) throw new Error('_buildPlanarBoundarySegments: exceeded 10M iterations — likely infinite loop');
    let best = null;

    for (const candidate of candidates) {
      const len = candidate.keys.length;
      if (len <= 2 || len > vertices.length) continue;

      if (matchesCandidate(index, candidate.keys)) {
        if (!best || len > best.len) {
          best = { len, curve: candidate.curve.clone() };
        }
      }

      const reversedKeys = [...candidate.keys].reverse();
      if (matchesCandidate(index, reversedKeys)) {
        if (!best || len > best.len) {
          best = { len, curve: candidate.curve.reversed() };
        }
      }
    }

    if (best) {
      segments.push({
        start: { ...vertices[index] },
        curve: best.curve,
      });
      edgeCount += best.len - 1;
      index = (index + best.len - 1) % vertices.length;
      continue;
    }

    const nextIndex = (index + 1) % vertices.length;
    segments.push({
      start: { ...vertices[index] },
      curve: NurbsCurve.createLine(vertices[index], vertices[nextIndex]),
    });
    edgeCount += 1;
    index = nextIndex;
  }

  return segments.length > 0 ? segments : null;
}

function _buildPlanarFaceDesc(face, edgeDataList = null) {
  if (!face || !face.vertices || face.vertices.length < 3) return null;

  let surface = null;
  try {
    surface = NurbsSurface.createPlane(
      face.vertices[0],
      vec3Sub(face.vertices[1], face.vertices[0]),
      vec3Sub(face.vertices[face.vertices.length - 1], face.vertices[0]),
    );
  } catch (_) {
    surface = null;
  }

  const boundarySegments = _buildPlanarBoundarySegments(face.vertices, edgeDataList);
  const boundaryVertices = boundarySegments
    ? boundarySegments.map((segment) => ({ ...segment.start }))
    : face.vertices.map((vertex) => ({ ...vertex }));

  const innerLoops = Array.isArray(face.innerLoops)
    ? face.innerLoops.map((loop) => {
      if (!loop) return null;
      if (Array.isArray(loop.coedges)) return _extractLoopDesc(loop);
      const vertices = Array.isArray(loop.vertices)
        ? loop.vertices.map((vertex) => ({ ...vertex }))
        : [];
      if (vertices.length < 3) return null;
      const edgeCurves = Array.isArray(loop.edgeCurves) && loop.edgeCurves.length === vertices.length
        ? loop.edgeCurves.map((curve, index) => curve || NurbsCurve.createLine(vertices[index], vertices[(index + 1) % vertices.length]))
        : vertices.map((vertex, index) => NurbsCurve.createLine(vertex, vertices[(index + 1) % vertices.length]));
      return { vertices, edgeCurves };
    }).filter(Boolean)
    : [];

  return {
    surface,
    surfaceType: SurfaceType.PLANE,
    vertices: boundaryVertices,
    edgeCurves: boundarySegments
      ? boundarySegments.map((segment) => segment.curve)
      : face.vertices.map((vertex, index) =>
        NurbsCurve.createLine(vertex, face.vertices[(index + 1) % face.vertices.length])),
    innerLoops,
    shared: face.shared ? { ...face.shared } : null,
    stableHash: face.topoFaceStableHash || face.stableHash || null,
  };
}

// -----------------------------------------------------------------------
// Mesh-level chamfer helpers (shared with fillet path in CSG.js)
// -----------------------------------------------------------------------

function _findFaceEdgeDirectionSign(face, edgeA, edgeB) {
  const verts = face && Array.isArray(face.vertices) ? face.vertices : null;
  if (!verts || verts.length < 3) return 0;

  let indexA = -1;
  let indexB = -1;
  for (let i = 0; i < verts.length; i++) {
    if (indexA < 0 && vec3Len(vec3Sub(verts[i], edgeA)) < 1e-5) indexA = i;
    if (indexB < 0 && vec3Len(vec3Sub(verts[i], edgeB)) < 1e-5) indexB = i;
    if (indexA >= 0 && indexB >= 0) break;
  }
  if (indexA < 0 || indexB < 0 || indexA === indexB) return 0;

  const n = verts.length;
  const nextA = (indexA + 1) % n;
  const prevA = (indexA - 1 + n) % n;
  if (nextA === indexB) return 1;
  if (prevA === indexB) return -1;

  const edgeDir = vec3Normalize(vec3Sub(edgeB, edgeA));
  const nextDir = vec3Normalize(vec3Sub(verts[nextA], edgeA));
  const prevDir = vec3Normalize(vec3Sub(verts[prevA], edgeA));
  if (vec3Dot(nextDir, edgeDir) > 0.7) return 1;
  if (vec3Dot(prevDir, edgeDir) > 0.7) return -1;

  const nextB = (indexB + 1) % n;
  const prevB = (indexB - 1 + n) % n;
  const fromPrevB = vec3Normalize(vec3Sub(edgeB, verts[prevB]));
  const toNextB = vec3Normalize(vec3Sub(verts[nextB], edgeB));
  if (vec3Dot(fromPrevB, edgeDir) > 0.7) return 1;
  if (vec3Dot(toNextB, edgeDir) > 0.7) return -1;

  return 0;
}

function _faceNormalAtEdge(face, edgeA, edgeB) {
  const fallback = face && face.normal ? vec3Normalize(face.normal) : { x: 0, y: 0, z: 1 };
  if (!face || !face.surface || face.surfaceType === SurfaceType.PLANE) return fallback;

  const mid = vec3Scale(vec3Add(edgeA, edgeB), 0.5);
  try {
    let uv = null;
    if (typeof face.surface.closestPointUV === 'function') {
      uv = face.surface.closestPointUV(mid);
    }
    const u = uv ? uv.u : ((face.surface.uMin + face.surface.uMax) * 0.5);
    const v = uv ? uv.v : ((face.surface.vMin + face.surface.vMax) * 0.5);
    if (typeof face.surface.normal === 'function') {
      let normal = vec3Normalize(face.surface.normal(u, v));
      if (face.sameSense === false) normal = vec3Scale(normal, -1);
      if (vec3Len(normal) > 1e-10) return normal;
    }
  } catch (_error) {
    // Fall through to the polygon normal.
  }
  return fallback;
}

function _faceInteriorOffsetDir(face, edgeA, edgeB, edgeDir, normalOverride = null) {
  const sign = _findFaceEdgeDirectionSign(face, edgeA, edgeB);
  if (sign === 0) return null;
  const normal = vec3Normalize(normalOverride || face.normal);
  return sign > 0
    ? vec3Normalize(vec3Cross(normal, edgeDir))
    : vec3Normalize(vec3Cross(edgeDir, normal));
}

function _computeOffsetDirs(face0, face1, edgeA, edgeB, edgeDirOverride = null) {
  const fallbackN0 = vec3Normalize(face0.normal);
  const fallbackN1 = vec3Normalize(face1.normal);
  let n0 = _faceNormalAtEdge(face0, edgeA, edgeB);
  let n1 = _faceNormalAtEdge(face1, edgeA, edgeB);
  const localDot = Math.abs(vec3Dot(n0, n1));
  const fallbackDot = Math.abs(vec3Dot(fallbackN0, fallbackN1));
  if (localDot > 0.995 && fallbackDot < 0.995) {
    n0 = fallbackN0;
    n1 = fallbackN1;
  }
  const overrideLen = edgeDirOverride ? vec3Len(edgeDirOverride) : 0;
  const edgeDir = overrideLen > 1e-10
    ? vec3Normalize(edgeDirOverride)
    : vec3Normalize(vec3Sub(edgeB, edgeA));

  const boundaryDir0 = _faceInteriorOffsetDir(face0, edgeA, edgeB, edgeDir, n0);
  const boundaryDir1 = _faceInteriorOffsetDir(face1, edgeA, edgeB, edgeDir, n1);
  const offsDir0 = boundaryDir0 || vec3Normalize(vec3Cross(n0, edgeDir));
  const offsDir1 = boundaryDir1 || vec3Normalize(vec3Cross(edgeDir, n1));

  if (!boundaryDir0) {
    const cen0 = faceCentroid(face0);
    if (vec3Dot(offsDir0, vec3Sub(cen0, edgeA)) < 0) {
      offsDir0.x = -offsDir0.x; offsDir0.y = -offsDir0.y; offsDir0.z = -offsDir0.z;
    }
  }
  if (!boundaryDir1) {
    const cen1 = faceCentroid(face1);
    if (vec3Dot(offsDir1, vec3Sub(cen1, edgeA)) < 0) {
      offsDir1.x = -offsDir1.x; offsDir1.y = -offsDir1.y; offsDir1.z = -offsDir1.z;
    }
  }
  // Detect concave (reflex) edge: offset into face0 aligns with face1 outward normal
  const isConcave = vec3Dot(offsDir0, n1) > 1e-6;
  return { offsDir0, offsDir1, edgeDir, isConcave };
}

function _precomputeChamferEdge(faces, edgeKey, dist, exactAdjacencyByKey = null) {
  const adj = (exactAdjacencyByKey && exactAdjacencyByKey.get(edgeKey)) || findAdjacentFaces(faces, edgeKey);
  if (adj.length < 2) return null;

  const fi0 = adj[0].fi, fi1 = adj[1].fi;
  const face0 = faces[fi0];
  const face1 = faces[fi1];
  const edgeA = adj[0].a;
  const edgeB = adj[0].b;

  const face0Keys = collectFaceEdgeKeys(face0);
  const face1Keys = collectFaceEdgeKeys(face1);

  const { offsDir0, offsDir1, isConcave } = _computeOffsetDirs(face0, face1, edgeA, edgeB);

  const p0a = vec3Add(edgeA, vec3Scale(offsDir0, dist));
  const p0b = vec3Add(edgeB, vec3Scale(offsDir0, dist));
  const p1a = vec3Add(edgeA, vec3Scale(offsDir1, dist));
  const p1b = vec3Add(edgeB, vec3Scale(offsDir1, dist));

  return {
    edgeKey, fi0, fi1, edgeA, edgeB,
    face0Keys, face1Keys,
    p0a, p0b, p1a, p1b,
    isConcave,
    shared: face0.shared ? { ...face0.shared } : null,
  };
}

// -----------------------------------------------------------------------
// BRep-level chamfer — operates directly on TopoBody topology
// -----------------------------------------------------------------------

function _buildExactChamferTopoBody(faces, edgeDataList) {
  if (!faces || !Array.isArray(faces) || !edgeDataList || edgeDataList.length === 0) return null;

  const faceDescs = [];

  // Planar trimmed faces (original faces after trimming)
  // Bevel and corner faces are appended at the tail of the faces array —
  // the first (faces.length - bevelCount - cornerCount) faces are the originals.
  // To distinguish, skip faces that are chamfer bevel quads or corner faces.
  for (const face of faces) {
    if (!face || !face.vertices || face.vertices.length < 3) continue;
    // Skip bevel faces (they are added below from edgeDataList)
    if (face._isChamferBevel) continue;
    // Skip corner faces (handled separately)
    if (face.isCorner) continue;
    const desc = _buildPlanarFaceDesc(face);
    if (!desc) return null;
    faceDescs.push(desc);
  }

  // Chamfer bevel faces
  for (const data of edgeDataList) {
    let surface = null;
    try {
      surface = NurbsSurface.createChamferSurface(data.p0a, data.p0b, data.p1a, data.p1b);
    } catch (_) {
      surface = null;
    }

    const vertices = [
      { ...data.p0a }, { ...data.p1a }, { ...data.p1b }, { ...data.p0b },
    ];
    const edgeCurves = [
      NurbsCurve.createLine(data.p0a, data.p1a),
      NurbsCurve.createLine(data.p1a, data.p1b),
      NurbsCurve.createLine(data.p1b, data.p0b),
      NurbsCurve.createLine(data.p0b, data.p0a),
    ];

    const polyNormal = computePolygonNormal(vertices);
    let sameSense = true;
    if (surface && polyNormal) {
      const surfNormal = surface.normal(0.5, 0.5);
      if (surfNormal) sameSense = vec3Dot(polyNormal, surfNormal) >= 0;
    }

    faceDescs.push({
      surface,
      surfaceType: surface ? SurfaceType.PLANE : SurfaceType.PLANE,
      vertices,
      edgeCurves,
      sameSense,
      shared: data.shared ? { ...data.shared, isChamfer: true } : { isChamfer: true },
    });
  }

  // Corner face descriptors
  for (const face of faces) {
    if (!face || !face.isCorner) continue;
    if (!face.vertices || face.vertices.length < 3) continue;
    const desc = _buildPlanarFaceDesc(face);
    if (desc) faceDescs.push(desc);
  }

  if (faceDescs.length === 0) return null;
  return buildTopoBody(faceDescs);
}

/**
 * Map mesh-level edge keys (from tessellated segments) to their parent TopoEdges.
 * Returns Map<meshEdgeKey, TopoEdge>.
 */
function _mapSegmentKeysToTopoEdges(topoBody, edgeSegments = 16) {
  const map = new Map();
  const allEdgeSamples = [];
  for (const shell of topoBody.shells) {
    for (const topoEdge of shell.edges()) {
      const samples = _sampleExactEdgePoints(topoEdge, edgeSegments);
      if (samples.length < 2) continue;
      allEdgeSamples.push({ topoEdge, samples });
      // Register the full-endpoint key
      const fullKey = edgeKeyFromVerts(
        topoEdge.startVertex.point, topoEdge.endVertex.point
      );
      map.set(fullKey, topoEdge);
      // Register each tessellated segment key
      for (let i = 0; i < samples.length - 1; i++) {
        map.set(edgeKeyFromVerts(samples[i], samples[i + 1]), topoEdge);
      }
    }
  }
  map._allEdgeSamples = allEdgeSamples;
  return map;
}

/**
 * Proximity-based fallback: for each unmatched edge key, parse the two
 * endpoints and find the TopoEdge whose polyline tessellation is closest
 * to the midpoint of the key segment.
 */
function _proximityMatchEdgeKeys(unmatchedKeys, allEdgeSamples, chamferTopoEdges) {
  if (!allEdgeSamples || allEdgeSamples.length === 0) return;
  // Proximity tolerance: the stored edge keys are at approximately arc-length
  // uniform positions, while BRep tessellation uses NURBS parametric sampling.
  // The resulting position differences are typically ~0.005-0.015 units for a
  // radius-10 arc at 16 segments.  0.05 gives ample headroom without risking
  // false positives between edges that are at least one arc-radius apart.
  const tol = 0.05;
  for (const key of unmatchedKeys) {
    const sep = key.indexOf('|');
    if (sep < 0) continue;
    const aCoords = key.slice(0, sep).split(',').map(Number);
    const bCoords = key.slice(sep + 1).split(',').map(Number);
    if (aCoords.length !== 3 || bCoords.length !== 3) continue;
    const mid = {
      x: (aCoords[0] + bCoords[0]) * 0.5,
      y: (aCoords[1] + bCoords[1]) * 0.5,
      z: (aCoords[2] + bCoords[2]) * 0.5,
    };
    let bestEdge = null, bestDist = Infinity;
    for (const { topoEdge, samples } of allEdgeSamples) {
      for (let i = 0; i < samples.length - 1; i++) {
        const s0 = samples[i], s1 = samples[i + 1];
        // point-to-segment distance (project mid onto segment s0→s1)
        const dx = s1.x - s0.x, dy = s1.y - s0.y, dz = s1.z - s0.z;
        const lenSq = dx * dx + dy * dy + dz * dz;
        let t = 0;
        if (lenSq > 1e-20) {
          t = ((mid.x - s0.x) * dx + (mid.y - s0.y) * dy + (mid.z - s0.z) * dz) / lenSq;
          if (t < 0) t = 0; else if (t > 1) t = 1;
        }
        const px = s0.x + t * dx, py = s0.y + t * dy, pz = s0.z + t * dz;
        const d = Math.sqrt((mid.x - px) ** 2 + (mid.y - py) ** 2 + (mid.z - pz) ** 2);
        if (d < bestDist) { bestDist = d; bestEdge = topoEdge; }
      }
    }
    if (bestEdge && bestDist < tol) {
      chamferTopoEdges.set(bestEdge.id, bestEdge);
    }
  }
}

function _getCoedgeEdgePoints(coedge) {
  const sameSense = coedge?.sameSense !== false;
  return {
    start: sameSense ? coedge.edge.startVertex.point : coedge.edge.endVertex.point,
    end: sameSense ? coedge.edge.endVertex.point : coedge.edge.startVertex.point,
  };
}

function _intersectPlanarOffsetWithNeighbor(coedge, origin, uAxis, vAxis, targetV, nearPoint) {
  if (!coedge?.edge) return null;

  const { start, end } = _getCoedgeEdgePoints(coedge);
  const toUV = (point) => {
    const delta = vec3Sub(point, origin);
    return {
      x: vec3Dot(delta, uAxis),
      y: vec3Dot(delta, vAxis),
    };
  };
  const fromUV = (x, y) => vec3Add(origin, vec3Add(vec3Scale(uAxis, x), vec3Scale(vAxis, y)));

  const curve = coedge.edge.curve;
  if (curve && curve.degree === 2 && curve.controlPoints.length >= 3) {
    const center = _recoverArcCenter(curve, start, end);
    if (center) {
      const radius = vec3Len(vec3Sub(start, center));
      const centerUV = toUV(center);
      const dy = targetV - centerUV.y;

      // Tangent-continuous neighbor arc (common when chamfering an edge whose
      // endpoint vertex was previously filleted): the arc is tangent to the
      // chamfered edge at their shared vertex, so the parallel-offset line at
      // `targetV` passes through (or near) the arc center.  In that case the
      // line-circle equation has two symmetric roots at `centerX ± radius`,
      // both equidistant from `nearPoint`, so miter-intersecting would
      // arbitrarily snap the chamfer endpoint to one of the arc's extremities
      // (collapsing the adjacent fillet face).  Detect this and keep the raw
      // parallel-offset endpoint — the fillet face's arc stays intact and
      // Step 3's gap-closer will connect the chamfer offset cleanly to the
      // shared vertex's original location.
      if (Math.abs(dy) < radius * 0.1) return null;
      const inside = radius * radius - dy * dy;
      if (inside >= -1e-8) {
        const dx = Math.sqrt(Math.max(0, inside));
        const candidates = [
          fromUV(centerUV.x - dx, targetV),
          fromUV(centerUV.x + dx, targetV),
        ];
        candidates.sort((a, b) => vec3Len(vec3Sub(a, nearPoint)) - vec3Len(vec3Sub(b, nearPoint)));
        return candidates[0];
      }
    }
  }

  const startUV = toUV(start);
  const endUV = toUV(end);
  const dy = endUV.y - startUV.y;
  if (Math.abs(dy) < 1e-10) return null;

  const t = (targetV - startUV.y) / dy;
  const x = startUV.x + t * (endUV.x - startUV.x);
  const result = fromUV(x, targetV);
  return result;
}

function _projectPlanarPoint(point, normal) {
  const absX = Math.abs(normal?.x || 0);
  const absY = Math.abs(normal?.y || 0);
  const absZ = Math.abs(normal?.z || 0);
  if (absZ >= absX && absZ >= absY) return { x: point.x, y: point.y };
  if (absY >= absX) return { x: point.x, y: point.z };
  return { x: point.y, y: point.z };
}

function _pointInPolygon2D(point, polygon) {
  let inside = false;
  for (let currentIndex = 0, previousIndex = polygon.length - 1; currentIndex < polygon.length; previousIndex = currentIndex++) {
    const current = polygon[currentIndex];
    const previous = polygon[previousIndex];
    const crosses = (current.y > point.y) !== (previous.y > point.y);
    if (!crosses) continue;
    const xAtY = (previous.x - current.x) * (point.y - current.y) / ((previous.y - current.y) || 1e-30) + current.x;
    if (point.x < xAtY) inside = !inside;
  }
  return inside;
}

function _sampleLoopPoints(loop, segments = 16) {
  if (!loop || !Array.isArray(loop.coedges)) return [];
  const points = [];
  for (const coedge of loop.coedges) {
    let samples = coedge?.edge ? _sampleExactEdgePoints(coedge.edge, segments) : [];
    if (coedge && coedge.sameSense === false) samples = samples.reverse();
    if (points.length > 0 && samples.length > 0) samples = samples.slice(1);
    points.push(...samples);
  }
  if (points.length > 1 && vec3Len(vec3Sub(points[0], points[points.length - 1])) < 1e-8) {
    points.pop();
  }
  return points;
}

function _planarFaceContainsPoint(face, point, normal) {
  const projectedPoint = _projectPlanarPoint(point, normal);
  const outer = _sampleLoopPoints(face.outerLoop, 24).map((sample) => _projectPlanarPoint(sample, normal));
  if (outer.length < 3 || !_pointInPolygon2D(projectedPoint, outer)) return false;

  for (const innerLoop of face.innerLoops || []) {
    const hole = _sampleLoopPoints(innerLoop, 24).map((sample) => _projectPlanarPoint(sample, normal));
    if (hole.length >= 3 && _pointInPolygon2D(projectedPoint, hole)) return false;
  }
  return true;
}

function _chooseLocalPlanarOffsetDirection(face, edgeMid, offDir, dist, edgeLen, faceNormal) {
  const probeDistance = Math.max(Math.min(Math.abs(dist || 0) * 0.25, Math.max(edgeLen, 1) * 0.05), 1e-5);
  const positivePoint = vec3Add(edgeMid, vec3Scale(offDir, probeDistance));
  const negativePoint = vec3Add(edgeMid, vec3Scale(offDir, -probeDistance));
  const positiveInside = _planarFaceContainsPoint(face, positivePoint, faceNormal);
  const negativeInside = _planarFaceContainsPoint(face, negativePoint, faceNormal);
  if (positiveInside && !negativeInside) return offDir;
  if (negativeInside && !positiveInside) return vec3Scale(offDir, -1);
  return null;
}

/**
 * Compute the offset curve of a TopoEdge on a given adjacent face.
 *
 * Returns { curve: NurbsCurve, startPt: {x,y,z}, endPt: {x,y,z} }
 * where curve runs from startPt to endPt at distance `dist` from the edge
 * into the face surface.
 */
function _offsetEdgeOnSurface(topoEdge, face, coedge, dist) {
  const sType = face.surfaceType;
  const oriented = coedge ? _getCoedgeEdgePoints(coedge) : {
    start: topoEdge.startVertex.point,
    end: topoEdge.endVertex.point,
  };
  const sp = oriented.start;
  const ep = oriented.end;
  const edgeVec = vec3Sub(ep, sp);
  const edgeLen = vec3Len(edgeVec);

  // For self-closing edges (start === end), the chord direction is zero.
  // Use the curve tangent at the midpoint instead.
  let edgeDir;
  if (edgeLen > 1e-14) {
    edgeDir = vec3Scale(edgeVec, 1 / edgeLen);
  } else if (topoEdge.curve && typeof topoEdge.curve.evaluate === 'function') {
    // Self-loop: evaluate tangent at midpoint
    const p0 = topoEdge.curve.evaluate(0.45);
    const p1 = topoEdge.curve.evaluate(0.55);
    if (p0 && p1) {
      const tangent = vec3Sub(p1, p0);
      const tLen = vec3Len(tangent);
      edgeDir = tLen > 1e-14 ? vec3Scale(tangent, 1 / tLen) : { x: 1, y: 0, z: 0 };
    } else {
      edgeDir = { x: 1, y: 0, z: 0 };
    }
  } else {
    edgeDir = { x: 1, y: 0, z: 0 };
  }

  if (sType === SurfaceType.PLANE) {
    // Get face normal from evaluation or from surface
    let faceNormal;
    if (face.surface && typeof face.surface.normal === 'function') {
      faceNormal = face.surface.normal(0.5, 0.5);
      if (face.sameSense === false) faceNormal = vec3Scale(faceNormal, -1);
    } else {
      // Approximate from boundary vertices
      const verts = [];
      for (const ce of face.outerLoop.coedges) {
        verts.push(ce.edge.startVertex.point);
      }
      faceNormal = computePolygonNormal(verts) || { x: 0, y: 0, z: 1 };
    }
    faceNormal = vec3Normalize(faceNormal);

    // Offset direction: cross(faceNormal, edgeDir) pointing into the face
    let offDir = vec3Normalize(vec3Cross(faceNormal, edgeDir));
    const edgeMid = vec3Lerp(sp, ep, 0.5);
    const localOffDir = _chooseLocalPlanarOffsetDirection(face, edgeMid, offDir, dist, edgeLen, faceNormal);
    if (localOffDir) {
      offDir = localOffDir;
    } else if (vec3Dot(vec3Sub(faceCentroid(face), edgeMid), offDir) < 0) {
      offDir = vec3Scale(offDir, -1);
    }

    const curve = topoEdge.curve;
    if (curve && curve.degree === 2 && curve.controlPoints.length >= 3) {
      // Arc edge on a plane → offset = concentric arc
      // Recover arc center: the middle control point of a degree-2 rational arc
      // The center is equidistant from the start and end points
      // We can also compute it from the offset direction at each endpoint
      const r0 = vec3Sub(sp, vec3Scale(offDir, 0));
      // For a circular arc, the offset direction at each point is radial (toward center)
      // offDir at sp should point from sp toward center (or away from center)
      // Use the arc geometry: center = sp + R * radialDir
      // The offset of a circular arc with radius R at distance d is another arc with radius R ∓ d

      // Reconstruct arc center from the curve
      const arcCenter = _recoverArcCenter(curve, sp, ep);
      if (arcCenter) {
        const r = vec3Len(vec3Sub(sp, arcCenter));
        // Check if offset goes toward center or away.
        // Use the arc midpoint for the radial test: at the endpoints the
        // radial direction can be perpendicular to offDir (dot ≈ 0), giving
        // an unreliable sign.  At the midpoint the radial is maximally
        // aligned with the curvature direction, so the dot product reliably
        // indicates whether the face interior lies toward or away from the
        // arc center.
        const arcMid = curve.evaluate(0.5);
        const radialAtMid = vec3Normalize(vec3Sub(arcMid, arcCenter));
        const inward = vec3Dot(radialAtMid, offDir) < 0; // offDir points toward center
        const newR = inward ? r - dist : r + dist;
        if (newR < 1e-10) return null; // degenerate

        const newSp = vec3Add(arcCenter, vec3Scale(vec3Normalize(vec3Sub(sp, arcCenter)), newR));
        const newEp = vec3Add(arcCenter, vec3Scale(vec3Normalize(vec3Sub(ep, arcCenter)), newR));

        // Build the offset arc in the same local frame
        const xAx = vec3Normalize(vec3Sub(newSp, arcCenter));
        const yAx = vec3Normalize(vec3Cross(faceNormal, xAx));
        const r1 = vec3Sub(newEp, arcCenter);
        const cosA = Math.max(-1, Math.min(1, vec3Dot(r1, vec3Scale(xAx, newR)) / (newR * newR)));
        const sinA = vec3Dot(r1, vec3Scale(yAx, newR)) / (newR * newR);
        let sweep = Math.atan2(sinA, cosA);

        // Validate sweep direction against the original arc's midpoint.
        // The offset arc is concentric so its midpoint is at the same
        // angular position as the original curve's parametric midpoint.
        // If the tentative sweep puts the arc midpoint far from the
        // expected position, the sweep is going the wrong way around the
        // circle — apply the complementary angle.  NurbsCurve.createArc
        // handles both positive and negative sweep angles correctly.
        const expectedMid = vec3Add(arcCenter, vec3Scale(
          vec3Normalize(vec3Sub(arcMid, arcCenter)), newR));
        const halfAngle = sweep / 2;
        const computedMid = vec3Add(arcCenter, vec3Add(
          vec3Scale(xAx, newR * Math.cos(halfAngle)),
          vec3Scale(yAx, newR * Math.sin(halfAngle))));
        const midError = vec3Len(vec3Sub(computedMid, expectedMid));
        // For semicircular arcs (|sweep| ≈ π) both ±π reach the same
        // endpoint; always use the positive sweep that is consistent with
        // the face boundary loop direction (faceNormal × xAx).
        // For non-semicircular arcs, validate against the original curve's
        // midpoint and apply the complementary angle when the tentative
        // sweep traces the wrong half of the circle.  createArc handles
        // both positive and negative sweeps.
        const isSemicircle = Math.abs(Math.abs(sweep) - Math.PI) < 0.1;
        if (isSemicircle) {
          // For semicircular arcs, atan2 can return either +π or -π due to
          // floating-point ambiguity when sinA ≈ 0.  Use the midpoint error
          // to select the geometrically correct direction: one direction has
          // midError ≈ 0 (correct side), the other has midError ≈ 2R (wrong).
          if (midError > 0.1 * newR) {
            sweep = -sweep;
          }
        } else if (midError > 0.1 * newR) {
          sweep = sweep > 0 ? sweep - 2 * Math.PI : sweep + 2 * Math.PI;
        }

        const offCurve = NurbsCurve.createArc(arcCenter, newR, xAx, yAx, 0, sweep);
        return {
          curve: offCurve,
          startPt: newSp,
          endPt: newEp,
          arcCenter,
          radius: newR,
          startVertexPoint: sp,
          endVertexPoint: ep,
        };
      }
    }

    // Straight edge on a plane → parallel line
    let newSp = vec3Add(sp, vec3Scale(offDir, dist));
    let newEp = vec3Add(ep, vec3Scale(offDir, dist));

    const loop = coedge?.loop;
    if (loop && Array.isArray(loop.coedges) && loop.coedges.length >= 3) {
      const idx = loop.coedges.indexOf(coedge);
      if (idx >= 0) {
        const prev = loop.coedges[(idx - 1 + loop.coedges.length) % loop.coedges.length];
        const next = loop.coedges[(idx + 1) % loop.coedges.length];
        newSp = _intersectPlanarOffsetWithNeighbor(prev, sp, edgeDir, offDir, dist, newSp) || newSp;
        newEp = _intersectPlanarOffsetWithNeighbor(next, sp, edgeDir, offDir, dist, newEp) || newEp;
      }
    }

    return {
      curve: NurbsCurve.createLine(newSp, newEp),
      startPt: newSp,
      endPt: newEp,
      startVertexPoint: sp,
      endVertexPoint: ep,
    };

  } else if (sType === SurfaceType.CYLINDER) {
    // Cylindrical face — determine edge orientation relative to axis
    const surfInfo = face.surfaceInfo || _extractCylinderInfo(face);
    if (!surfInfo) {
      // Fallback to linear offset
      return _offsetEdgeLinearFallback(topoEdge, face, dist);
    }

    const { axis, center: cylCenter, radius: cylR } = surfInfo;
    const axisDir = vec3Normalize(axis);

    // Check if edge is circumferential (perpendicular to axis) or axial (along axis)
    const edgeDotAxis = Math.abs(vec3Dot(edgeDir, axisDir));

    if (edgeDotAxis < 0.1) {
      // Circumferential edge (arc along the bottom/top of cylinder)
      // Offset = shift along axis direction
      // Determine which direction to offset (into the face)
      const centroid = faceCentroid(face);
      const edgeMid = vec3Lerp(sp, ep, 0.5);
      const towardFace = vec3Sub(centroid, edgeMid);
      const axisDist = vec3Dot(towardFace, axisDir);
      const offDir = axisDist > 0 ? axisDir : vec3Scale(axisDir, -1);

      const newSp = vec3Add(sp, vec3Scale(offDir, dist));
      const newEp = vec3Add(ep, vec3Scale(offDir, dist));

      if (topoEdge.curve && topoEdge.curve.degree === 2) {
        const arcCenter = _recoverArcCenter(topoEdge.curve, sp, ep);
        if (arcCenter) {
          const newCenter = vec3Add(arcCenter, vec3Scale(offDir, dist));
          const xAx = vec3Normalize(vec3Sub(newSp, newCenter));
          const yAx = vec3Normalize(vec3Cross(axisDir, xAx));
          const r1 = vec3Sub(newEp, newCenter);
          const cosA = Math.max(-1, Math.min(1, vec3Dot(r1, vec3Scale(xAx, cylR)) / (cylR * cylR)));
          const sinA = vec3Dot(r1, vec3Scale(yAx, cylR)) / (cylR * cylR);
          let sweep = Math.atan2(sinA, cosA);

          // Validate sweep against original arc midpoint (same approach
          // as planar case — see detailed comment above).
          const arcMidCyl = topoEdge.curve.evaluate(0.5);
          const expectedMidCyl = vec3Add(arcMidCyl, vec3Scale(offDir, dist));
          const halfAngleCyl = sweep / 2;
          const computedMidCyl = vec3Add(newCenter, vec3Add(
            vec3Scale(xAx, cylR * Math.cos(halfAngleCyl)),
            vec3Scale(yAx, cylR * Math.sin(halfAngleCyl))));
          const midErrorCyl = vec3Len(vec3Sub(computedMidCyl, expectedMidCyl));
          const isSemicircleCyl = Math.abs(Math.abs(sweep) - Math.PI) < 0.1;
          if (isSemicircleCyl) {
            // Same midpoint-based direction check as the planar case.
            if (midErrorCyl > 0.1 * cylR) {
              sweep = -sweep;
            }
          } else if (midErrorCyl > 0.1 * cylR) {
            sweep = sweep > 0 ? sweep - 2 * Math.PI : sweep + 2 * Math.PI;
          }

          const offCurve = NurbsCurve.createArc(newCenter, cylR, xAx, yAx, 0, sweep);
          return {
            curve: offCurve,
            startPt: newSp,
            endPt: newEp,
            arcCenter: newCenter,
            radius: cylR,
            startVertexPoint: sp,
            endVertexPoint: ep,
          };
        }
      }
      return {
        curve: NurbsCurve.createLine(newSp, newEp),
        startPt: newSp,
        endPt: newEp,
        startVertexPoint: sp,
        endVertexPoint: ep,
      };

    } else {
      // Axial edge (along cylinder axis)
      // Offset = angular shift: d/R radians around the axis
      const radialSp = vec3Normalize(vec3Sub(sp, projectOntoAxis(sp, cylCenter, axisDir)));
      const tangentSp = vec3Cross(axisDir, radialSp);
      const centroid = faceCentroid(face);
      const edgeMid = vec3Lerp(sp, ep, 0.5);
      const towardFace = vec3Sub(centroid, edgeMid);
      const intoFace = vec3Dot(towardFace, tangentSp) > 0 ? tangentSp : vec3Scale(tangentSp, -1);

      // Rotate by angle = dist / cylR
      const angle = dist / cylR;
      const cosA = Math.cos(angle);
      const sinA = vec3Dot(intoFace, tangentSp) > 0 ? Math.sin(angle) : -Math.sin(angle);

      const rotatePoint = (p) => {
        const proj = projectOntoAxis(p, cylCenter, axisDir);
        const radial = vec3Sub(p, proj);
        const rLen = vec3Len(radial);
        if (rLen < 1e-14) return p;
        const rDir = vec3Scale(radial, 1 / rLen);
        const tDir = vec3Cross(axisDir, rDir);
        const newRadial = vec3Add(
          vec3Scale(rDir, rLen * cosA),
          vec3Scale(tDir, rLen * sinA)
        );
        return vec3Add(proj, newRadial);
      };

      const newSp = rotatePoint(sp);
      const newEp = rotatePoint(ep);
      return {
        curve: NurbsCurve.createLine(newSp, newEp),
        startPt: newSp,
        endPt: newEp,
        startVertexPoint: sp,
        endVertexPoint: ep,
      };
    }

  } else if (sType === SurfaceType.BSPLINE || sType === SurfaceType.EXTRUSION) {
    // Detect linear-extrusion surfaces: degreeU === 1, numRowsU === 2.
    // These surfaces are linear in the u-direction (extrusion axis) and
    // follow the cross-section curve in the v-direction.
    const surf = face.surface;
    if (surf && surf.degreeU === 1 && surf.numRowsU === 2 && surf.numColsV >= 2) {
      // Extract extrusion axis from control point rows
      const nCols = surf.numColsV;
      const row0_0 = surf.controlPoints[0];
      const row1_0 = surf.controlPoints[nCols];
      const extAxis = vec3Sub(row1_0, row0_0);
      const extLen = vec3Len(extAxis);
      if (extLen > 1e-14) {
        const axisDir = vec3Scale(extAxis, 1 / extLen);
        const edgeDotAxis = Math.abs(vec3Dot(edgeDir, axisDir));

        if (edgeDotAxis < 0.1) {
          // Profile edge (circumferential, perpendicular to extrusion axis)
          // Offset = shift along the extrusion axis direction (into the face)
          const centroid = faceCentroid(face);
          const edgeMid = vec3Lerp(sp, ep, 0.5);
          const towardFace = vec3Sub(centroid, edgeMid);
          const axisDist = vec3Dot(towardFace, axisDir);
          const offDir = axisDist > 0 ? axisDir : vec3Scale(axisDir, -1);

          const newSp = vec3Add(sp, vec3Scale(offDir, dist));
          const newEp = vec3Add(ep, vec3Scale(offDir, dist));

          // Preserve curve type: if the edge is a NURBS curve, translate it
          const curve = topoEdge.curve;
          let offCurve;
          if (curve && curve.degree >= 2 && curve.controlPoints && curve.controlPoints.length >= 3) {
            // Translate the curve control points along the extrusion axis
            const offCPs = curve.controlPoints.map(cp => vec3Add(cp, vec3Scale(offDir, dist)));
            offCurve = new NurbsCurve(curve.degree, offCPs, curve.knots.slice(), curve.weights.slice());
          } else {
            offCurve = NurbsCurve.createLine(newSp, newEp);
          }
          return {
            curve: offCurve,
            startPt: newSp,
            endPt: newEp,
            startVertexPoint: sp,
            endVertexPoint: ep,
          };

        } else {
          // Axial edge (along extrusion direction)
          // Offset = move perpendicular to axis on the surface.
          const centroid = faceCentroid(face);
          const edgeMid = vec3Lerp(sp, ep, 0.5);
          const towardFace = vec3Sub(centroid, edgeMid);
          // Remove axial component to get purely cross-sectional direction
          const crossComp = vec3Sub(towardFace, vec3Scale(axisDir, vec3Dot(towardFace, axisDir)));
          const crossLen = vec3Len(crossComp);
          const offDir = crossLen > 1e-14
            ? vec3Scale(crossComp, 1 / crossLen)
            : vec3Normalize(vec3Sub(towardFace, vec3Scale(edgeDir, vec3Dot(towardFace, edgeDir))));

          const newSp = vec3Add(sp, vec3Scale(offDir, dist));
          const newEp = vec3Add(ep, vec3Scale(offDir, dist));
          return {
            curve: NurbsCurve.createLine(newSp, newEp),
            startPt: newSp,
            endPt: newEp,
            startVertexPoint: sp,
            endVertexPoint: ep,
          };
        }
      }
    }
  }

  // Fallback: linear offset (approximate for unsupported surface types)
  return _offsetEdgeLinearFallback(topoEdge, face, dist);
}

/** Recover the center of a degree-2 rational arc NurbsCurve */
function _recoverArcCenter(curve, sp, ep) {
  // For a degree-2 NURBS arc, the control point layout is:
  //   [start, weighted_shoulder, end] for a single span
  // or multi-span for larger arcs.
  // The center can be found geometrically:
  // All points on the arc are equidistant from the center.
  // For a single-span (3-cp) arc: center = shoulder−projected offset
  // Simpler: evaluate the midpoint and use 3-point circle construction.
  const mid = curve.evaluate(0.5);
  if (!mid) return null;
  // Three points on arc: sp, mid, ep
  return circumCenter3D(sp, mid, ep);
}

/** Extract cylinder axis/center/radius from a cylindrical TopoFace */
function _extractCylinderInfo(face) {
  if (!face.surface) return null;
  // Try to extract from surface info metadata
  if (face.surfaceInfo) return face.surfaceInfo;
  // Try to recover from the cylinder surface control points
  const surf = face.surface;
  if (surf.degreeU === 1 && surf.degreeV === 2 && surf.numRowsU === 2) {
    // Cylinder: 2 rows of arc CPs, linear in u-direction
    const nCols = surf.numColsV;
    const row0 = [];
    const row1 = [];
    for (let j = 0; j < nCols; j++) {
      row0.push(surf.controlPoints[j]);
      row1.push(surf.controlPoints[nCols + j]);
    }
    // Axis = row1[0] - row0[0]
    const axis = vec3Sub(row1[0], row0[0]);
    // Center of the arc: evaluate bottom row at midpoint
    const p0 = row0[0];
    const pMid = surf.evaluate(0, 0.5);
    const pEnd = row0[nCols - 1];
    const center = circumCenter3D(p0, pMid, pEnd);
    const radius = center ? vec3Len(vec3Sub(p0, center)) : null;
    if (center && radius) {
      return { axis, center, radius };
    }
  }
  return null;
}

function _offsetEdgeLinearFallback(topoEdge, face, dist) {
  const sp = topoEdge.startVertex.point;
  const ep = topoEdge.endVertex.point;
  const edgeDir = vec3Normalize(vec3Sub(ep, sp));
  const centroid = faceCentroid(face);
  const edgeMid = vec3Lerp(sp, ep, 0.5);
  const towardFace = vec3Normalize(vec3Sub(centroid, edgeMid));
  // Remove component along edge direction
  const perp = vec3Normalize(vec3Sub(towardFace, vec3Scale(edgeDir, vec3Dot(towardFace, edgeDir))));
  const newSp = vec3Add(sp, vec3Scale(perp, dist));
  const newEp = vec3Add(ep, vec3Scale(perp, dist));
  return {
    curve: NurbsCurve.createLine(newSp, newEp),
    startPt: newSp,
    endPt: newEp,
    startVertexPoint: sp,
    endVertexPoint: ep,
  };
}

/**
 * Build a ruled NURBS surface between two arc curves (for arc-edge chamfers).
 * When both offsets produce arcs, this creates a conical or cylindrical ruled surface.
 */
function _buildChamferRuledSurface(offset0, offset1) {
  let c0 = offset0.curve;
  let c1 = offset1.curve;

  // If both curves are NURBS arcs with compatible parametrization, build a ruled surface
  if (c0.degree === 2 && c1.degree === 2 &&
      c0.controlPoints.length === c1.controlPoints.length &&
      c0.knots.length === c1.knots.length) {

    // For semicircular arcs, the sweep direction may differ between the
    // planar and cylindrical offsets due to floating-point ambiguity in
    // atan2 (returning +π vs -π) combined with different local coordinate
    // frames (faceNormal vs axisDir).  Both sweeps are individually correct,
    // but they may trace opposite halves of the circle.  Check whether the
    // curves' midpoints are compatible; if not, reverse one curve so the
    // ruled surface pairs corresponding control points correctly.
    const mid0 = c0.evaluate(0.5);
    const mid1 = c1.evaluate(0.5);
    if (mid0 && mid1) {
      // For a well-formed chamfer, the midpoints of the two offset arcs
      // should be close (separated only by the chamfer distance).  If they
      // are far apart, the curves trace opposite halves of the circle.
      const midDist = vec3Len(vec3Sub(mid0, mid1));
      const endDist = vec3Len(vec3Sub(offset0.startPt, offset1.startPt));
      if (midDist > 3 * Math.max(endDist, 1e-6)) {
        // Factor of 3: on a correctly paired chamfer the arc midpoints are
        // roughly `distance` apart (≈ endDist).  A factor of 3 gives ample
        // margin while reliably catching the opposite-half case where the
        // midpoint distance ≈ diameter (≫ endDist).
        // Reverse c1 so its parametrization matches c0
        c1 = c1.reversed();
      }
    }

    // Build the surface with c0 in row 0 (u=0) and c1 in row 1 (u=1).
    // The face vertex quad will be [off0.start, off0.end, off1.end, off1.start].
    // We need the surface normal (dS/du × dS/dv) to agree with the Newell
    // normal of that quad so that _computeSameSense returns true and the
    // tessellator produces correctly oriented triangles.
    //
    // Compute the vertex-quad Newell normal and compare with the surface
    // normal; if they disagree, swap rows to flip the surface normal.
    const verts = [offset0.startPt, offset0.endPt, offset1.endPt, offset1.startPt];
    let lnx = 0, lny = 0, lnz = 0;
    for (let i = 0; i < verts.length; i++) {
      const vc = verts[i];
      const vn = verts[(i + 1) % verts.length];
      lnx += (vc.y - vn.y) * (vc.z + vn.z);
      lny += (vc.z - vn.z) * (vc.x + vn.x);
      lnz += (vc.x - vn.x) * (vc.y + vn.y);
    }

    let rowA = c0, rowB = c1;      // row 0, row 1

    // Surface normal ≈ cross(dS/du, dS/dv) at the parametric center.
    // dS/du = (row1_mid - row0_mid), dS/dv ≈ tangent along the arc at v=0.5.
    const midA = rowA.evaluate(0.5);
    const midB = rowB.evaluate(0.5);
    if (midA && midB) {
      const dux = midB.x - midA.x, duy = midB.y - midA.y, duz = midB.z - midA.z;
      // Approximate dS/dv via finite difference on the row0 curve.
      // A ±0.01 step around v=0.5 gives a stable tangent estimate — small
      // enough to be local, large enough to avoid floating-point noise.
      const vLo = rowA.evaluate(0.49);
      const vHi = rowA.evaluate(0.51);
      if (vLo && vHi) {
        const dvx = vHi.x - vLo.x, dvy = vHi.y - vLo.y, dvz = vHi.z - vLo.z;
        const snx = duy * dvz - duz * dvy;
        const sny = duz * dvx - dux * dvz;
        const snz = dux * dvy - duy * dvx;
        const dot = lnx * snx + lny * sny + lnz * snz;
        if (dot < 0) {
          // Swap rows so surface normal agrees with vertex winding
          rowA = c1; rowB = c0;
        }
      }
    }

    const nCols = rowA.controlPoints.length;
    const nRows = 2;
    const controlPoints = [];
    const weights = [];
    for (let j = 0; j < nCols; j++) {
      controlPoints.push({ ...rowA.controlPoints[j] });
      weights.push(rowA.weights[j]);
    }
    for (let j = 0; j < nCols; j++) {
      controlPoints.push({ ...rowB.controlPoints[j] });
      weights.push(rowB.weights[j]);
    }
    return new NurbsSurface(
      1, rowA.degree,       // linear in u, quadratic in v
      nRows, nCols,
      controlPoints,
      [0, 0, 1, 1],       // linear u-knots
      [...rowA.knots],       // arc v-knots
      weights
    );
  }

  // Fallback: bilinear patch (flat chamfer)
  return NurbsSurface.createChamferSurface(
    offset0.startPt, offset0.endPt, offset1.startPt, offset1.endPt
  );
}

function _extractLoopDesc(loop) {
  if (!loop || !Array.isArray(loop.coedges) || loop.coedges.length === 0) {
    return { vertices: [], edgeCurves: [] };
  }

  const vertices = [];
  const edgeCurves = [];
  for (const coedge of loop.coedges) {
    const edge = coedge.edge;
    const sameSense = coedge.sameSense !== false;
    const start = sameSense ? edge.startVertex.point : edge.endVertex.point;
    const end = sameSense ? edge.endVertex.point : edge.startVertex.point;
    const curve = edge.curve
      ? (sameSense ? edge.curve : edge.curve.reversed())
      : NurbsCurve.createLine(start, end);
    vertices.push({ ...start });
    edgeCurves.push(curve);
  }

  return { vertices, edgeCurves };
}

function _getOrientedCoedgeCurve(coedge) {
  if (!coedge?.edge) return null;

  const edge = coedge.edge;
  if (!edge.curve) {
    const { start, end } = _getCoedgeEdgePoints(coedge);
    return NurbsCurve.createLine(start, end);
  }

  return coedge.sameSense !== false ? edge.curve : edge.curve.reversed();
}

function _orientOffsetAlongTopoEdge(offset, topoEdge) {
  const topoStart = topoEdge.startVertex.point;
  const sameDirection = pointsCoincident3D(offset.startVertexPoint || topoStart, topoStart);
  return sameDirection ? {
    startPt: offset.startPt,
    endPt: offset.endPt,
    curve: offset.curve,
  } : {
    startPt: offset.endPt,
    endPt: offset.startPt,
    curve: offset.curve.reversed ? offset.curve.reversed() : offset.curve,
  };
}

/**
 * Rebuild offset curve to match updated startPt/endPt after intersection adjustment.
 * For straight-line offsets, recreates the line with the new endpoints.
 * Arc offsets are left unchanged: their geometry is defined by center/radius and
 * the arc parameterization is not affected by the endpoint intersection adjustment
 * (the face rebuild and bevel face construction use off.startPt/endPt for vertices,
 * while the arc curve provides the in-between shape via the surface).
 */
function _rebuildOffsetCurve(off) {
  if (!off || !off.curve) return;
  // Only rebuild straight-line curves
  if (off.curve.degree === 1 && off.curve.controlPoints && off.curve.controlPoints.length === 2) {
    off.curve = NurbsCurve.createLine(off.startPt, off.endPt);
  }
}

function _projectChamferOffsetEndpointToCapPlane(off, vertexPoint, capPlane) {
  if (!off || !capPlane) return false;
  const isStart = topoPointsClose(off.startVertexPoint, vertexPoint);
  const isEnd = topoPointsClose(off.endVertexPoint, vertexPoint);
  if (!isStart && !isEnd) return false;

  const lineDir = vec3Normalize(vec3Sub(off.endPt, off.startPt));
  if (vec3Len(lineDir) < 1e-12) return false;
  const projected = projectLineToPlane(off.startPt, lineDir, capPlane);
  if (!projected) return false;

  if (isStart) off.startPt = projected;
  if (isEnd) off.endPt = projected;
  _rebuildOffsetCurve(off);
  return true;
}

function _projectTerminalChamferCapsOntoAdjacentFaces(topoBody, chamferInfos, vertexChamfers) {
  if (!topoBody || !Array.isArray(chamferInfos)) return;
  for (const ci of chamferInfos) {
    const projectAtVertex = (vertexPoint) => {
      const touches = vertexChamfers.get(edgeVKey(vertexPoint)) || [];
      if (touches.length > 1) return;
      const capFace = findTerminalCapFace(topoBody, ci.topoEdge, ci.face0, ci.face1, vertexPoint);
      const capPlane = topoFacePlane(capFace);
      if (!capPlane) return;

      _projectChamferOffsetEndpointToCapPlane(ci.off0, vertexPoint, capPlane);
      _projectChamferOffsetEndpointToCapPlane(ci.off1, vertexPoint, capPlane);
    };

    if (ci.topoEdge.startVertex && ci.topoEdge.startVertex.point) projectAtVertex(ci.topoEdge.startVertex.point);
    if (ci.topoEdge.endVertex && ci.topoEdge.endVertex.point) projectAtVertex(ci.topoEdge.endVertex.point);
  }
}

// -----------------------------------------------------------------------
// Cylinder-plane intersection helpers (used by fillet-junction surgery
// to extend chamfer offsets that land inside a previous fillet's cylinder
// onto the cylinder ∩ chamfer-plane arc — see _computeFilletJunctions).
// Mirrors BRepFillet._computeFilletChamferArcSamples / _curveFromSampledPoints.
// -----------------------------------------------------------------------

function _curveFromSamples(points) {
  if (!points || points.length < 2) return null;
  if (points.length === 2) return NurbsCurve.createLine(points[0], points[1]);
  return NurbsCurve.createPolyline(points);
}

/**
 * Sample points along the cylinder ∩ plane arc between startPt and endPt.
 * Both startPt and endPt must lie on the cylinder (within tol) AND on the
 * plane (within tol). Returns null if axis is parallel to plane or the
 * angular sweep is degenerate. Uses analytic ellipse parameterization:
 *   P(θ) = cylCenter + axisDir · t(θ) + ex · r·cos θ + ey · r·sin θ
 *   t(θ) = -(K + r·cos θ · A + r·sin θ · B) / C
 * where K = (cylCenter - planePoint)·n, A = ex·n, B = ey·n, C = axisDir·n.
 */
function _computeCylPlaneArcSamples(
  cylCenter, axisDir, radius, ex, ey,
  planePoint, planeNormal, startPt, endPt, segments = 12,
) {
  const wasmSamples = sampleCylinderPlaneArcWasmReady({
    cylCenter,
    axisDir,
    radius,
    ex,
    ey,
    planePoint,
    planeNormal,
    startPt,
    endPt,
    segments,
  });
  if (wasmSamples) return wasmSamples;

  const C = vec3Dot(axisDir, planeNormal);
  if (Math.abs(C) < 1e-9) return null;
  const K = vec3Dot(vec3Sub(cylCenter, planePoint), planeNormal);
  const A = vec3Dot(ex, planeNormal);
  const B = vec3Dot(ey, planeNormal);

  const at = (theta) => {
    const ct = Math.cos(theta), st = Math.sin(theta);
    const t = -(K + radius * ct * A + radius * st * B) / C;
    return vec3Add(
      vec3Add(cylCenter, vec3Scale(axisDir, t)),
      vec3Add(vec3Scale(ex, radius * ct), vec3Scale(ey, radius * st)),
    );
  };
  const thetaOf = (pt) => {
    const rel = vec3Sub(pt, cylCenter);
    return Math.atan2(vec3Dot(rel, ey), vec3Dot(rel, ex));
  };

  const t0 = thetaOf(startPt);
  const t1 = thetaOf(endPt);
  let dt = t1 - t0;
  while (dt > Math.PI) dt -= 2 * Math.PI;
  while (dt < -Math.PI) dt += 2 * Math.PI;
  if (Math.abs(dt) < 1e-6) return null;

  const out = [];
  for (let i = 0; i <= segments; i++) {
    out.push(at(t0 + dt * (i / segments)));
  }
  out[0] = { ...startPt };
  out[out.length - 1] = { ...endPt };
  return out;
}

/**
 * Intersect line P0 + t·dir with cylinder (axisP, axisDir, radius).
 * Returns the +t solution (tMin if both > 0; first positive if one).
 * Returns null if discriminant < 0 or no positive root.
 */
function _intersectLineCylinder(P0, dir, axisP, axisDir, radius) {
  // (P0 + t·dir - axisP) - ((P0+t·dir - axisP)·axisDir) · axisDir
  // squared length = radius²
  const W = vec3Sub(P0, axisP);
  const wAx = vec3Dot(W, axisDir);
  const dAx = vec3Dot(dir, axisDir);
  // Perpendicular components
  const wp = vec3Sub(W, vec3Scale(axisDir, wAx));
  const dp = vec3Sub(dir, vec3Scale(axisDir, dAx));
  const a = vec3Dot(dp, dp);
  const b = 2 * vec3Dot(wp, dp);
  const c = vec3Dot(wp, wp) - radius * radius;
  if (Math.abs(a) < 1e-12) return null;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  const t2 = (-b + sq) / (2 * a);
  // Pick the smallest positive root (extension forward)
  let t;
  if (t1 > 1e-9 && t2 > 1e-9) t = Math.min(t1, t2);
  else if (t1 > 1e-9) t = t1;
  else if (t2 > 1e-9) t = t2;
  else return null;
  return vec3Add(P0, vec3Scale(dir, t));
}

function _intersectLineCylinderAll(P0, dir, axisP, axisDir, radius) {
  const W = vec3Sub(P0, axisP);
  const wAx = vec3Dot(W, axisDir);
  const dAx = vec3Dot(dir, axisDir);
  const wp = vec3Sub(W, vec3Scale(axisDir, wAx));
  const dp = vec3Sub(dir, vec3Scale(axisDir, dAx));
  const a = vec3Dot(dp, dp);
  const b = 2 * vec3Dot(wp, dp);
  const c = vec3Dot(wp, wp) - radius * radius;
  if (Math.abs(a) < 1e-12) return [];
  const disc = b * b - 4 * a * c;
  if (disc < -1e-10) return [];
  if (Math.abs(disc) <= 1e-10) {
    return [vec3Add(P0, vec3Scale(dir, -b / (2 * a)))];
  }
  const sq = Math.sqrt(Math.max(0, disc));
  return [
    vec3Add(P0, vec3Scale(dir, (-b - sq) / (2 * a))),
    vec3Add(P0, vec3Scale(dir, (-b + sq) / (2 * a))),
  ];
}

function _planeFromFace(face) {
  if (!face || face.surfaceType !== SurfaceType.PLANE || !face.surface) return null;
  if (typeof face.surface.evaluate !== 'function') return null;
  const p0 = face.surface.evaluate(0.5, 0.5);
  let n = null;
  if (typeof face.surface.normal === 'function') {
    n = face.surface.normal(0.5, 0.5);
  } else {
    const eps = 1e-4;
    const pu = face.surface.evaluate(0.5 + eps, 0.5);
    const pv = face.surface.evaluate(0.5, 0.5 + eps);
    n = vec3Cross(vec3Sub(pu, p0), vec3Sub(pv, p0));
  }
  const nLen = vec3Len(n);
  if (nLen < 1e-12) return null;
  n = vec3Scale(n, 1 / nLen);
  if (face.sameSense === false) n = vec3Scale(n, -1);
  return { p0, n };
}

function _intersectPlanesWithCylinder(planeA, planeB, axisP, axisDir, radius, nearPt) {
  const dir = vec3Cross(planeA.n, planeB.n);
  const dirLen = vec3Len(dir);
  if (dirLen < 1e-10) return null;
  const lineDir = vec3Scale(dir, 1 / dirLen);
  const dA = vec3Dot(planeA.n, planeA.p0);
  const dB = vec3Dot(planeB.n, planeB.p0);
  const dirSq = vec3Dot(dir, dir);
  const termA = vec3Scale(vec3Cross(planeB.n, dir), dA);
  const termB = vec3Scale(vec3Cross(dir, planeA.n), dB);
  const linePt = vec3Scale(vec3Add(termA, termB), 1 / dirSq);
  const hits = _intersectLineCylinderAll(linePt, lineDir, axisP, axisDir, radius);
  if (hits.length === 0) return null;
  hits.sort((a, b) => vec3Len(vec3Sub(a, nearPt)) - vec3Len(vec3Sub(b, nearPt)));
  return hits[0];
}

function _debugBRepChamfer(...args) {
  if (typeof process === 'undefined' || !process?.env?.DEBUG_BREP_CHAMFER) return;
  console.log('[applyBRepChamfer]', ...args);
}

// -----------------------------------------------------------------------
// Shared helpers (used by mesh chamfer/fillet in CSG.js)
// -----------------------------------------------------------------------

function _sampleExactEdgePoints(edge, segments = 8) {
  if (!edge || typeof edge.tessellate !== 'function') return [];
  const curve = edge.curve || null;
  const isLinearCurve = !curve || (
    curve.degree === 1 &&
    Array.isArray(curve.controlPoints) &&
    curve.controlPoints.length === 2
  );
  const sampleCount = isLinearCurve ? 1 : segments;
  return edge.tessellate(sampleCount).map((point) => canonicalPoint(point));
}

function _isLinearTopoEdge(edge) {
  const curve = edge && edge.curve;
  return !curve || (
    curve.degree === 1 &&
    Array.isArray(curve.controlPoints) &&
    curve.controlPoints.length === 2
  );
}

function _buildExactEdgeAdjacencyLookupFromTopoBody(topoBody, faces, edgeSegments = 8) {
  if (!topoBody || !topoBody.shells || !Array.isArray(faces) || faces.length === 0) {
    return null;
  }

  const repFaceIndexByTopoFaceId = _buildRepFaceIndexByTopoFaceId(faces);
  if (repFaceIndexByTopoFaceId.size === 0) return null;

  const adjacencyByKey = new Map();
  for (const shell of topoBody.shells) {
    for (const edge of shell.edges()) {
      const samples = _sampleExactEdgePoints(edge, edgeSegments);
      if (samples.length < 2) continue;

      const vertexStart = edge.startVertex && edge.startVertex.point
        ? canonicalPoint(edge.startVertex.point)
        : null;
      const vertexEnd = edge.endVertex && edge.endVertex.point
        ? canonicalPoint(edge.endVertex.point)
        : null;
      const startPoint = vertexStart || samples[0];
      const endPoint = vertexEnd || samples[samples.length - 1];
      if (!startPoint || !endPoint) continue;

      const entries = [];
      for (const coedge of edge.coedges || []) {
        const topoFaceId = coedge && coedge.face ? coedge.face.id : undefined;
        const fi = repFaceIndexByTopoFaceId.get(topoFaceId);
        if (fi === undefined) continue;
        const sameSense = !coedge || coedge.sameSense !== false;
        entries.push({
          fi,
          a: sameSense ? { ...startPoint } : { ...endPoint },
          b: sameSense ? { ...endPoint } : { ...startPoint },
        });
      }
      if (entries.length < 2) continue;

      const addAdjacency = (key) => {
        if (!key || adjacencyByKey.has(key)) return;
        adjacencyByKey.set(key, entries.map((entry) => ({
          fi: entry.fi,
          a: { ...entry.a },
          b: { ...entry.b },
        })));
      };

      addAdjacency(edgeKeyFromVerts(startPoint, endPoint));
      addAdjacency(edgeKeyFromVerts(samples[0], samples[samples.length - 1]));

      if (!_isLinearTopoEdge(edge)) {
        for (let sampleIndex = 0; sampleIndex < samples.length - 1; sampleIndex++) {
          const sampleA = samples[sampleIndex];
          const sampleB = samples[sampleIndex + 1];
          const segmentEntries = [];
          for (const coedge of edge.coedges || []) {
            const topoFaceId = coedge && coedge.face ? coedge.face.id : undefined;
            const fi = repFaceIndexByTopoFaceId.get(topoFaceId);
            if (fi === undefined) continue;
            const sameSense = !coedge || coedge.sameSense !== false;
            segmentEntries.push({
              fi,
              a: sameSense ? { ...sampleA } : { ...sampleB },
              b: sameSense ? { ...sampleB } : { ...sampleA },
            });
          }
          if (segmentEntries.length >= 2) {
            const key = edgeKeyFromVerts(sampleA, sampleB);
            if (!adjacencyByKey.has(key)) adjacencyByKey.set(key, segmentEntries);
          }
        }
      }
    }
  }

  return adjacencyByKey;
}

function _extractFeatureFacesFromTopoBody(geometry, edgeSegments = 8) {
  if (!geometry || !geometry.topoBody || !Array.isArray(geometry.topoBody.shells)) {
    return Array.isArray(geometry && geometry.faces) ? geometry.faces : [];
  }

  const extracted = [];
  for (const shell of geometry.topoBody.shells) {
    for (const topoFace of shell.faces || []) {
      if (!topoFace || !topoFace.outerLoop || !Array.isArray(topoFace.outerLoop.coedges)) continue;
      const vertices = [];
      for (const coedge of topoFace.outerLoop.coedges) {
        let samples = coedge && coedge.edge
          ? _sampleExactEdgePoints(coedge.edge, edgeSegments)
          : [];
        if (coedge && coedge.sameSense === false) samples = samples.reverse();
        if (vertices.length > 0 && samples.length > 0) samples = samples.slice(1);
        vertices.push(...samples);
      }
      if (vertices.length > 1) {
        const first = vertices[0];
        const last = vertices[vertices.length - 1];
        if (vec3Len(vec3Sub(first, last)) < 1e-8) vertices.pop();
      }
      if (!Array.isArray(vertices) || vertices.length < 3) continue;
      let normal = computePolygonNormal(vertices);
      if ((!normal || vec3Len(normal) < 1e-10) && topoFace.surface && typeof topoFace.surface.normal === 'function') {
        const u = (topoFace.surface.uMin + topoFace.surface.uMax) * 0.5;
        const v = (topoFace.surface.vMin + topoFace.surface.vMax) * 0.5;
        try {
          normal = topoFace.surface.normal(u, v);
          if (topoFace.sameSense === false) {
            normal = { x: -normal.x, y: -normal.y, z: -normal.z };
          }
        } catch (_e) {
          normal = null;
        }
      }
      const faceData = {
        vertices: vertices.map((vertex) => ({ x: vertex.x, y: vertex.y, z: vertex.z })),
        innerLoops: (topoFace.innerLoops || []).map((loop) => _extractLoopDesc(loop)),
        normal: normal && vec3Len(normal) > 1e-10 ? vec3Normalize(normal) : { x: 0, y: 0, z: 1 },
        shared: topoFace.shared ? { ...topoFace.shared } : null,
        isFillet: !!(topoFace.shared && topoFace.shared.isFillet),
        isCorner: !!(topoFace.shared && topoFace.shared.isCorner),
        surfaceType: topoFace.surfaceType,
        surface: topoFace.surface || null,
        sameSense: topoFace.sameSense,
        faceGroup: topoFace.id,
        topoFaceId: topoFace.id,
        topoFaceStableHash: topoFace.stableHash || null,
      };
      // Extract cylinder metadata from shared for fillet-fillet intersection detection
      if (topoFace.shared && topoFace.shared._exactAxisStart) {
        faceData._exactAxisStart = { ...topoFace.shared._exactAxisStart };
      }
      if (topoFace.shared && topoFace.shared._exactAxisEnd) {
        faceData._exactAxisEnd = { ...topoFace.shared._exactAxisEnd };
      }
      if (topoFace.shared && topoFace.shared._exactRadius) {
        faceData._exactRadius = topoFace.shared._exactRadius;
      }
      extracted.push(faceData);
    }
  }

  return extracted.length > 0
    ? extracted
    : (Array.isArray(geometry.faces) ? geometry.faces : []);
}

// -----------------------------------------------------------------------
// Main BRep chamfer entry point
// -----------------------------------------------------------------------

/**
 * Apply B-Rep chamfer to a TopoBody.
 *
 * Operates directly on the TopoBody topology, producing exact offset
 * curves on planar and cylindrical surfaces. Creates proper chamfer
 * faces (ruled surfaces) and rebuilds adjacent face boundaries.
 *
 * @param {Object} geometry - Input geometry with .topoBody
 * @param {string[]} edgeKeys - Edge keys to chamfer (position-based)
 * @param {number} distance - Chamfer offset distance
 * @returns {Object|null} New geometry or null if BRep chamfer not applicable
 */
export function applyBRepChamfer(geometry, edgeKeys, distance) {
  const topoBody = geometry && geometry.topoBody;
  if (!topoBody || !topoBody.shells) {
    _debugBRepChamfer('missing-topobody');
    return null;
  }

  // Pre-compute baseline mesh topology from the input body so we can
  // distinguish pre-existing tessellation artifacts (curved surface boundary
  // mismatches) from genuine errors introduced by the chamfer.
  let baselineMeshTopo = null;
  try {
    const baseMesh = tessellateBody(topoBody, { validate: false });
    if (baseMesh && baseMesh.faces && baseMesh.faces.length > 0) {
      baselineMeshTopo = measureMeshTopology(baseMesh.faces);
    }
  } catch (_) {
    // Baseline tessellation failure is non-fatal: if we cannot establish a
    // baseline we proceed without one, using 0 as the reference count.  The
    // B-Rep topology check (_countTopoBodyBoundaryEdges) already validated
    // the input body's structural integrity.
  }

  // Step 1: Map mesh edge keys to TopoEdges
  const segMap = _mapSegmentKeysToTopoEdges(topoBody);
  const uniqueMeshKeys = [...new Set(edgeKeys)];
  const chamferTopoEdges = new Map(); // topoEdge.id → topoEdge
  const unmatchedKeys = [];
  for (const key of uniqueMeshKeys) {
    const te = segMap.get(key);
    if (te) chamferTopoEdges.set(te.id, te);
    else unmatchedKeys.push(key);
  }
  // Proximity fallback for keys that didn't match exact segments
  if (unmatchedKeys.length > 0) {
    _proximityMatchEdgeKeys(unmatchedKeys, segMap._allEdgeSamples, chamferTopoEdges);
  }
  if (chamferTopoEdges.size === 0) {
    _debugBRepChamfer('no-matched-topo-edges', { edgeKeys: uniqueMeshKeys.length });
    return null;
  }

  // Step 2: For each TopoEdge, compute offset info on both adjacent faces
  const chamferInfos = [];
  for (const [, topoEdge] of chamferTopoEdges) {
    const adjFaces = [];
    for (const coedge of topoEdge.coedges) {
      if (coedge.loop && coedge.loop.face) {
        adjFaces.push({ face: coedge.loop.face, coedge, sameSense: coedge.sameSense !== false });
      }
    }
    if (adjFaces.length < 2) continue;

    const off0 = _offsetEdgeOnSurface(topoEdge, adjFaces[0].face, adjFaces[0].coedge, distance);
    const off1 = _offsetEdgeOnSurface(topoEdge, adjFaces[1].face, adjFaces[1].coedge, distance);
    if (!off0 || !off1) continue;

    chamferInfos.push({
      topoEdge,
      face0: adjFaces[0].face,
      face1: adjFaces[1].face,
      off0, off1,
    });
  }
  if (chamferInfos.length === 0) {
    _debugBRepChamfer('no-chamfer-infos', { topoEdges: chamferTopoEdges.size });
    return null;
  }

  // Build lookup: topoEdge.id → chamferInfo
  const chamferByEdgeId = new Map();
  for (const ci of chamferInfos) {
    chamferByEdgeId.set(ci.topoEdge.id, ci);
  }

  // Build lookup: vertex key → chamfer infos that touch it
  const _vkey = (p) => `${fmtCoord(p.x)},${fmtCoord(p.y)},${fmtCoord(p.z)}`;
  const vertexChamfers = new Map();
  for (const ci of chamferInfos) {
    const sp = ci.topoEdge.startVertex.point;
    const ep = ci.topoEdge.endVertex.point;
    for (const p of [sp, ep]) {
      const k = _vkey(p);
      if (!vertexChamfers.has(k)) vertexChamfers.set(k, []);
      vertexChamfers.get(k).push(ci);
    }
  }

  _projectTerminalChamferCapsOntoAdjacentFaces(topoBody, chamferInfos, vertexChamfers);

  // Step 2.5: Intersect offset endpoints at corners where multiple chamfers meet.
  // When 2+ chamfer edges meet at a vertex on the same face, each offset is computed
  // independently, leaving their endpoints non-coincident.  We must intersect them:
  // e.g. on a box top face at corner (0,0,10) with chamfer distance 1,
  // edge 4 offset → (0,1,10) and edge 7 offset → (1,0,10) should both be (1,1,10).
  for (const [vk, cInfos] of vertexChamfers) {
    if (cInfos.length < 2) continue;

    // Group offsets by face: for each face, collect which chamfer infos have an
    // offset on that face at this vertex
    const faceOffsets = new Map(); // face.id → [{ci, off, isStart}]
    for (const ci of cInfos) {
      const isStart0 = _vkey(ci.off0.startVertexPoint || ci.topoEdge.startVertex.point) === vk;
      const isStart1 = _vkey(ci.off1.startVertexPoint || ci.topoEdge.startVertex.point) === vk;

      const f0id = ci.face0.id;
      if (!faceOffsets.has(f0id)) faceOffsets.set(f0id, []);
      faceOffsets.get(f0id).push({ ci, off: ci.off0, offKey: 'off0', isStart: isStart0 });

      const f1id = ci.face1.id;
      if (!faceOffsets.has(f1id)) faceOffsets.set(f1id, []);
      faceOffsets.get(f1id).push({ ci, off: ci.off1, offKey: 'off1', isStart: isStart1 });
    }

    // For each face where 2+ offsets converge, compute intersection
    for (const [, offsets] of faceOffsets) {
      if (offsets.length < 2) continue;

      // For 2 offsets: intersect their lines at this vertex
      // The offsets are line segments (startPt→endPt); we need to find where
      // the infinite lines through them intersect, then update the endpoint.
      if (offsets.length === 2) {
        const [o0, o1] = offsets;
        const pt0 = o0.isStart ? o0.off.startPt : o0.off.endPt;
        const pt0other = o0.isStart ? o0.off.endPt : o0.off.startPt;
        const pt1 = o1.isStart ? o1.off.startPt : o1.off.endPt;
        const pt1other = o1.isStart ? o1.off.endPt : o1.off.startPt;

        // Direction vectors along the offset lines
        const dir0 = vec3Normalize(vec3Sub(pt0other, pt0));
        const dir1 = vec3Normalize(vec3Sub(pt1other, pt1));

        // Intersect two lines: pt0 + t*dir0 = pt1 + s*dir1
        // Using least-squares intersection for robustness
        const crossDir = vec3Cross(dir0, dir1);
        const crossLen = vec3Len(crossDir);
        if (crossLen > 1e-10) {
          // Lines are not parallel — compute intersection
          const diff = vec3Sub(pt1, pt0);
          const t = vec3Dot(vec3Cross(diff, dir1), crossDir) / (crossLen * crossLen);
          const intPt = vec3Add(pt0, vec3Scale(dir0, t));

          // Update the offset endpoints and rebuild curves to match
          if (o0.isStart) o0.off.startPt = intPt;
          else o0.off.endPt = intPt;
          if (o1.isStart) o1.off.startPt = intPt;
          else o1.off.endPt = intPt;
          _rebuildOffsetCurve(o0.off);
          _rebuildOffsetCurve(o1.off);
        } else {
          // Parallel offsets — merge to midpoint
          const mid = vec3Lerp(pt0, pt1, 0.5);
          if (o0.isStart) o0.off.startPt = mid;
          else o0.off.endPt = mid;
          if (o1.isStart) o1.off.startPt = mid;
          else o1.off.endPt = mid;
          _rebuildOffsetCurve(o0.off);
          _rebuildOffsetCurve(o1.off);
        }
      } else {
        // 3+ offsets: merge to centroid of all endpoint positions
        let cx = 0, cy = 0, cz = 0;
        for (const o of offsets) {
          const pt = o.isStart ? o.off.startPt : o.off.endPt;
          cx += pt.x; cy += pt.y; cz += pt.z;
        }
        cx /= offsets.length; cy /= offsets.length; cz /= offsets.length;
        const merged = { x: cx, y: cy, z: cz };
        for (const o of offsets) {
          if (o.isStart) o.off.startPt = merged;
          else o.off.endPt = merged;
          _rebuildOffsetCurve(o.off);
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Step 2.75: Fillet-junction surgery
  // -----------------------------------------------------------------------
  // When a chamfer-edge endpoint coincides with a vertex of a previous
  // fillet's rail (face carrying _exactAxis*/_exactRadius metadata), the
  // raw chamfer offsets land INSIDE the cylinder (or on its axis) — they
  // are not on the cylinder surface.  Subsequent face-rebuild then emits
  // a chamfer face whose connector edge between off0.endPt and off1.endPt
  // is a straight 3D chord that doesn't lie on the fillet face's surface,
  // while the fillet face's gap-fill emits a UV-interpolated polyline
  // through the same endpoints — two different curves, dedup fails,
  // buildTopoBody reports open boundary edges and the chamfer aborts.
  //
  // Geometric truth: the chamfer must extend each offset along the planar
  // face it lies on until it meets the cylinder, and the chamfer face's
  // connector must be the cylinder ∩ chamfer-plane arc.  Both the chamfer
  // face AND the fillet face share that arc as a common boundary.
  //
  // Algorithm at each chamfer-edge endpoint vertex V:
  //   1. Find a face attached at V carrying _exactAxis* metadata that is
  //      not ci.face0 or ci.face1 — the prior fillet face.
  //   2. For each offset (off0 on face0, off1 on face1):
  //        - if |offEndPt - axis| < radius: extend offEndPt along the
  //          offset's direction (away from offStartPt) until it hits the
  //          cylinder surface.  Update offEndPt and rebuild the curve.
  //        - if |offEndPt - axis| ≈ radius: leave as-is (already on cyl).
  //   3. Compute cylinder ∩ chamfer-plane arc between the two corrected
  //      endpoints; store keyed by unordered (ext0Pt, ext1Pt) pair.
  //   4. Step 3 gap-fill and Step 4 chamfer-face emit consult this map
  //      and use the arc curve instead of UV-interp / straight-line.
  //
  // After offEndPt extension, resolveEndpoint's existing logic naturally
  // lifts the previously-collapsing fillet rail-cap edges to the new
  // extended position, where they become zero-length and are dropped by
  // the activeEdges filter — closing the loop without any extra surgery
  // on the planar neighbour faces.
  // -----------------------------------------------------------------------
  const _dbgFJ = (typeof process !== 'undefined' && process.env && process.env.DEBUG_FCJ_CHAM === '1');
  const _logFJ = (...a) => { if (_dbgFJ) console.log('[FCJ-CHAM]', ...a); };
  const _pairKey = (a, b) => {
    const ka = _vkey(a), kb = _vkey(b);
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };
  const junctionArcByPair = new Map(); // unordered pairKey → { samples, curve }
  const junctionSplitByPair = new Map(); // unordered pairKey → { a, mid, b, curveAMid, curveMidB }
  const junctionEndpointOverrides = [];

  const _findFilletAtVertex = (V, excludeFaces) => {
    const vk = _vkey(V);
    for (const shell of topoBody.shells) {
      for (const face of shell.faces) {
        if (excludeFaces.includes(face)) continue;
        const sh = face.shared;
        if (!sh || !sh._exactAxisStart || !sh._exactAxisEnd || !sh._exactRadius) continue;
        if (!face.outerLoop) continue;
        const has = face.outerLoop.coedges.some(ce => {
          const sv = ce.edge.startVertex.point;
          const ev = ce.edge.endVertex.point;
          return _vkey(sv) === vk || _vkey(ev) === vk;
        });
        if (has) return { face, axisStart: sh._exactAxisStart, axisEnd: sh._exactAxisEnd, radius: sh._exactRadius };
      }
    }
    return null;
  };

  const _findChamferAtVertex = (V, excludeFaces) => {
    const vk = _vkey(V);
    for (const shell of topoBody.shells) {
      for (const face of shell.faces) {
        if (excludeFaces.includes(face)) continue;
        const sh = face.shared;
        if (!sh || !sh.isChamfer) continue;
        if (!face.outerLoop) continue;
        const has = face.outerLoop.coedges.some(ce => {
          const sv = ce.edge.startVertex.point;
          const ev = ce.edge.endVertex.point;
          return _vkey(sv) === vk || _vkey(ev) === vk;
        });
        if (has) return face;
      }
    }
    return null;
  };

  const _findSharedEdgeOtherEndpoint = (faceA, faceB, atVertex) => {
    const vk = _vkey(atVertex);
    for (const ce of faceA.outerLoop.coedges) {
      const faces = ce.edge.coedges
        .map(edgeCoedge => edgeCoedge?.loop?.face)
        .filter(Boolean);
      if (!faces.includes(faceB)) continue;
      const sp = ce.edge.startVertex.point;
      const ep = ce.edge.endVertex.point;
      if (_vkey(sp) === vk) return ep;
      if (_vkey(ep) === vk) return sp;
    }
    return null;
  };

  for (const ci of chamferInfos) {
    const teSp = ci.topoEdge.startVertex.point;
    const teEp = ci.topoEdge.endVertex.point;

    // Helper: find which end of an offset coincides with vertex V.
    // Returns { isStart, get(): pt, set(pt): void } or null if no match.
    const _offEndAtVertex = (off, V) => {
      const ds = vec3Len(vec3Sub(off.startPt, V));
      const de = vec3Len(vec3Sub(off.endPt, V));
      // _offsetEdgeOnSurface may extend offsets past the original edge end
      // when the planar face's boundary continues past the chamfer edge
      // (e.g. across a fillet rail-cap), so the offset endpoint won't be
      // exactly at V.  We match the closer end and accept any distance —
      // the cylinder containment check below filters out spurious hits.
      const isStart = ds < de;
      return {
        isStart,
        get: () => isStart ? off.startPt : off.endPt,
        set: (pt) => { if (isStart) off.startPt = pt; else off.endPt = pt; },
        other: () => isStart ? off.endPt : off.startPt,
        dist: Math.min(ds, de),
      };
    };

    for (const V of [teSp, teEp]) {
      const fi = _findFilletAtVertex(V, [ci.face0, ci.face1]);
      if (!fi) continue;

      const e0 = _offEndAtVertex(ci.off0, V);
      const e1 = _offEndAtVertex(ci.off1, V);

      // Note: shared._exactAxisStart/End is the ORIGINAL FILLETED EDGE,
      // not the cylinder axis.  The cylinder axis is parallel but offset
      // by `r * inward_bisector` from the original edge.  Derive the
      // cylinder centerline from a cap-arc on the fillet face's loop:
      // a cap arc lies in a plane perpendicular to the axis, so its
      // circumscribed circle's center is the cylinder axis at that slice.
      const cylAxisDir = vec3Normalize(vec3Sub(fi.axisEnd, fi.axisStart));
      let cylAxisStart = null;
      for (const ce of fi.face.outerLoop.coedges) {
        const curve = ce.edge.curve;
        if (!curve || !curve.controlPoints || curve.controlPoints.length < 3) continue;
        const cps = curve.controlPoints;
        const a = cps[0], b = cps[Math.floor(cps.length / 2)], c = cps[cps.length - 1];
        const aAx = vec3Dot(vec3Sub(a, fi.axisStart), cylAxisDir);
        const bAx = vec3Dot(vec3Sub(b, fi.axisStart), cylAxisDir);
        const cAx = vec3Dot(vec3Sub(c, fi.axisStart), cylAxisDir);
        const axRange = Math.max(aAx, bAx, cAx) - Math.min(aAx, bAx, cAx);
        if (axRange > 1e-3) continue;
        const cc = circumCenter3D(a, b, c);
        if (!cc) continue;
        const tOff = vec3Dot(vec3Sub(cc, fi.axisStart), cylAxisDir);
        cylAxisStart = vec3Sub(cc, vec3Scale(cylAxisDir, tOff));
        break;
      }
      if (!cylAxisStart) continue;

      const distFromAxis = (P) => {
        const t = vec3Dot(vec3Sub(P, cylAxisStart), cylAxisDir);
        const onAxis = vec3Add(cylAxisStart, vec3Scale(cylAxisDir, t));
        return vec3Len(vec3Sub(P, onAxis));
      };

      const r0 = distFromAxis(e0.get());
      const r1 = distFromAxis(e1.get());
      const tol = Math.max(1e-3, fi.radius * 0.02);
      if (r0 > fi.radius + tol || r1 > fi.radius + tol) continue;

      // Compute the current chamfer plane from the three "non-extended"
      // corners of the chamfer face quad (using the offset endpoints at the
      // opposite end of the chamfer edge plus the current end's offsets).
      const oppV = (V === teSp) ? teEp : teSp;
      const oppE0 = _offEndAtVertex(ci.off0, oppV).get();
      let pn = vec3Cross(vec3Sub(e0.get(), oppE0), vec3Sub(e1.get(), oppE0));
      const pnLen = vec3Len(pn);
      if (pnLen < 1e-9) continue;
      pn = vec3Scale(pn, 1 / pnLen);
      if (Math.abs(vec3Dot(cylAxisDir, pn)) < 1e-6) continue;

      const inside0 = r0 < fi.radius - tol;
      const inside1 = r1 < fi.radius - tol;
      const on0 = Math.abs(r0 - fi.radius) <= tol;
      const on1 = Math.abs(r1 - fi.radius) <= tol;

      // Mixed 3-fold corner: current chamfer meets a previous fillet and a
      // previous chamfer at the same vertex.  In this case the offset that
      // lies inside the cylinder is usually the plane-plane intersection
      // point (previous chamfer plane ∩ current chamfer plane), not a point
      // that should be extended all the way to the cylinder.  The correct
      // topology inserts T where both chamfer planes meet the fillet
      // cylinder, splitting the new chamfer connector into cylinder arc +
      // plane-plane line and trimming the old fillet/chamfer seam to T.
      if (inside0 !== inside1 && ((inside0 && on1) || (inside1 && on0))) {
        const prevChamferFace = _findChamferAtVertex(V, [ci.face0, ci.face1, fi.face]);
        const prevPlane = _planeFromFace(prevChamferFace);
        if (prevPlane) {
          const insideEnd = inside0 ? e0 : e1;
          const cylEnd = inside0 ? e1 : e0;
          const insidePt = insideEnd.get();
          const cylPt = cylEnd.get();
          const tip = _intersectPlanesWithCylinder(
            prevPlane,
            { p0: oppE0, n: pn },
            cylAxisStart,
            cylAxisDir,
            fi.radius,
            cylPt,
          );
          const scale = Math.max(fi.radius, vec3Len(vec3Sub(cylPt, insidePt)), 1e-6);
          if (tip && vec3Len(vec3Sub(tip, cylPt)) < scale * 4) {
            const along = vec3Dot(vec3Sub(cylPt, cylAxisStart), cylAxisDir);
            const cylCenter = vec3Add(cylAxisStart, vec3Scale(cylAxisDir, along));
            const ex0Vec = vec3Sub(cylPt, cylCenter);
            const exLen = vec3Len(ex0Vec);
            if (exLen >= 1e-9) {
              const ex = vec3Scale(ex0Vec, 1 / exLen);
              const ey = vec3Cross(cylAxisDir, ex);
              const currentSamples = _computeCylPlaneArcSamples(
                cylCenter, cylAxisDir, fi.radius, ex, ey,
                oppE0, pn, cylPt, tip, 8,
              );
              const currentArc = _curveFromSamples(currentSamples);
              if (currentArc) {
                junctionArcByPair.set(_pairKey(cylPt, tip), { samples: currentSamples, curve: currentArc });
                junctionSplitByPair.set(_pairKey(cylPt, insidePt), {
                  a: cylPt,
                  mid: tip,
                  b: insidePt,
                  curveAMid: currentArc,
                  curveMidB: NurbsCurve.createLine(tip, insidePt),
                });
                junctionEndpointOverrides.push({
                  vertexKey: _vkey(V),
                  filletFace: fi.face,
                  chamferFace: prevChamferFace,
                  point: tip,
                });

                const seamOther = _findSharedEdgeOtherEndpoint(fi.face, prevChamferFace, V);
                if (seamOther) {
                  const prevAlong = vec3Dot(vec3Sub(seamOther, cylAxisStart), cylAxisDir);
                  const prevCenter = vec3Add(cylAxisStart, vec3Scale(cylAxisDir, prevAlong));
                  const prevExVec = vec3Sub(seamOther, prevCenter);
                  const prevExLen = vec3Len(prevExVec);
                  if (prevExLen >= 1e-9) {
                    const prevEx = vec3Scale(prevExVec, 1 / prevExLen);
                    const prevEy = vec3Cross(cylAxisDir, prevEx);
                    const prevSamples = _computeCylPlaneArcSamples(
                      prevCenter, cylAxisDir, fi.radius, prevEx, prevEy,
                      prevPlane.p0, prevPlane.n, seamOther, tip, 8,
                    );
                    const prevArc = _curveFromSamples(prevSamples);
                    if (prevArc) junctionArcByPair.set(_pairKey(seamOther, tip), { samples: prevSamples, curve: prevArc });
                  }
                }

                _logFJ(`mixed junction at V=${_vkey(V)}: inside=${_vkey(insidePt)} cyl=${_vkey(cylPt)} tip=${_vkey(tip)}`);
                continue;
              }
            }
          }
        }
      }

      let ext0Pt = e0.get();
      let ext1Pt = e1.get();
      if (r0 < fi.radius - tol) {
        const dir0 = vec3Normalize(vec3Sub(e0.get(), e0.other()));
        const hit = _intersectLineCylinder(e0.get(), dir0, cylAxisStart, cylAxisDir, fi.radius);
        if (!hit) continue;
        ext0Pt = hit;
      }
      if (r1 < fi.radius - tol) {
        const dir1 = vec3Normalize(vec3Sub(e1.get(), e1.other()));
        const hit = _intersectLineCylinder(e1.get(), dir1, cylAxisStart, cylAxisDir, fi.radius);
        if (!hit) continue;
        ext1Pt = hit;
      }

      const along = vec3Dot(vec3Sub(ext0Pt, cylAxisStart), cylAxisDir);
      const cylCenter = vec3Add(cylAxisStart, vec3Scale(cylAxisDir, along));
      const ex0Vec = vec3Sub(ext0Pt, cylCenter);
      const exLen = vec3Len(ex0Vec);
      if (exLen < 1e-9) continue;
      const ex = vec3Scale(ex0Vec, 1 / exLen);
      const ey = vec3Cross(cylAxisDir, ex);

      const samples = _computeCylPlaneArcSamples(
        cylCenter, cylAxisDir, fi.radius, ex, ey,
        oppE0, pn, ext0Pt, ext1Pt, 8,
      );
      if (!samples || samples.length < 3) continue;
      const arcCurve = _curveFromSamples(samples);
      if (!arcCurve) continue;

      e0.set(ext0Pt);
      e1.set(ext1Pt);
      _rebuildOffsetCurve(ci.off0);
      _rebuildOffsetCurve(ci.off1);

      junctionArcByPair.set(_pairKey(ext0Pt, ext1Pt), { samples, curve: arcCurve });
      _logFJ(`junction at V=${_vkey(V)}: ext0=${_vkey(ext0Pt)} ext1=${_vkey(ext1Pt)}`);
    }
  }
  if (junctionArcByPair.size > 0) _logFJ(`built ${junctionArcByPair.size} fillet-junction arc(s)`);

  // Step 3: Build face descriptors for new TopoBody
  const faceDescs = [];

  const _dbgFCF = (typeof process !== 'undefined' && process.env && process.env.DEBUG_FCF === '1');

  for (const shell of topoBody.shells) {
    for (const face of shell.faces) {
      // Walk the boundary and rebuild with offsets
      const coedges = face.outerLoop.coedges;
      const rebuiltEdges = [];

      for (let ci = 0; ci < coedges.length; ci++) {
        const coedge = coedges[ci];
        const edge = coedge.edge;
        const sameSense = coedge.sameSense !== false;
        const edgeSp = sameSense ? edge.startVertex.point : edge.endVertex.point;
        const edgeEp = sameSense ? edge.endVertex.point : edge.startVertex.point;

        const chamInfo = chamferByEdgeId.get(edge.id);

        if (!chamInfo) {
          // Non-chamfered edge: keep but may need to adjust endpoint positions
          // if adjacent vertices are chamfered
          const edgeFaces = edge.coedges
            .map((edgeCoedge) => edgeCoedge?.loop?.face)
            .filter((edgeFace) => !!edgeFace);
          let sp = edgeSp;
          let ep = edgeEp;

          const resolveEndpoint = (vertexPoint) => {
            const vk = _vkey(vertexPoint);
            for (const ov of junctionEndpointOverrides) {
              if (ov.vertexKey !== vk) continue;
              if (edgeFaces.includes(ov.filletFace) && edgeFaces.includes(ov.chamferFace)) {
                if (_dbgFCF) {
                  const fmt = p => p ? `(${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)})` : 'null';
                  console.log(`[FCF] resolveEndpoint mixed-override face=${face.id} vertex=${fmt(vertexPoint)} -> ${fmt(ov.point)}`);
                }
                return ov.point;
              }
            }
            const chamfersAtVertex = vertexChamfers.get(_vkey(vertexPoint));
            if (!chamfersAtVertex) return vertexPoint;

            for (const sci of chamfersAtVertex) {
              const matchedFace = edgeFaces.includes(sci.face0)
                ? sci.face0
                : edgeFaces.includes(sci.face1)
                  ? sci.face1
                  : null;
              if (!matchedFace) continue;

              const off = matchedFace === sci.face0 ? sci.off0 : sci.off1;
              const isStart = vec3Len(vec3Sub(off.startVertexPoint || sci.topoEdge.startVertex.point, vertexPoint)) < 1e-8;
              if (_dbgFCF) {
                const fmt = p => p ? `(${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)})` : 'null';
                const result = isStart ? off.startPt : off.endPt;
                console.log(`[FCF] resolveEndpoint face=${face.id} edgeFaces=[${edgeFaces.map(f=>f.id).join(',')}] vertex=${fmt(vertexPoint)} -> ${fmt(result)} (matchedFace=${matchedFace.id} chamFace0=${sci.face0.id} chamFace1=${sci.face1.id} isStart=${isStart})`);
              }
              return isStart ? off.startPt : off.endPt;
            }

            return vertexPoint;
          };

          sp = resolveEndpoint(edgeSp);
          ep = resolveEndpoint(edgeEp);
          const endpointsUnchanged = pointsCoincident3D(sp, edgeSp) && pointsCoincident3D(ep, edgeEp);

          // For curve edges (degree >= 2, e.g. spline/bezier/arc) whose
          // endpoints have been adjusted by an adjacent chamfer, create a
          // modified curve with updated first/last control points instead
          // of replacing the entire curve with a line.  This preserves the
          // curve's interior shape and prevents 2-edge faces (e.g. lens
          // profiles) from degenerating into < 3 vertex faces that would
          // be skipped, which causes boundary-edge topology failures.
          const originalCurve = _getOrientedCoedgeCurve(coedge);
          const isCurveEdge = originalCurve && originalCurve.degree >= 2;

          let curve;
          const storedEdge = junctionArcByPair.get(_pairKey(sp, ep));
          if (storedEdge) {
            const startK = _vkey(storedEdge.samples[0]);
            const spK = _vkey(sp);
            curve = startK === spK
              ? storedEdge.curve.clone()
              : storedEdge.curve.reversed();
          } else if (endpointsUnchanged) {
            curve = originalCurve || NurbsCurve.createLine(sp, ep);
          } else if ((isCurveEdge || (originalCurve?.degree === 1 && originalCurve.controlPoints?.length > 2)) && originalCurve.controlPoints && originalCurve.controlPoints.length >= 3) {
            // Adjust curve control points to match the new endpoints.
            // For a clamped NURBS curve, cp[0] = start, cp[n-1] = end.
            // Linearly interpolate the endpoint displacement across all
            // control points so interior shape is approximately preserved.
            const cps = originalCurve.controlPoints;
            const n = cps.length;
            const dSp = vec3Sub(sp, cps[0]);
            const dEp = vec3Sub(ep, cps[n - 1]);
            const newCPs = cps.map((cp, idx) => {
              const t = n > 1 ? idx / (n - 1) : 0;
              return vec3Add(cp, vec3Lerp(dSp, dEp, t));
            });
            curve = new NurbsCurve(
              originalCurve.degree, newCPs,
              originalCurve.knots.slice(),
              originalCurve.weights.slice()
            );
          } else {
            curve = NurbsCurve.createLine(sp, ep);
          }

          rebuiltEdges.push({ start: sp, end: ep, curve });
        } else {
          // Chamfered edge: replace with offset curve on this face
          const off = chamInfo.face0 === face ? chamInfo.off0 : chamInfo.off1;
          // Rebuild straight-line curves to match possibly-adjusted endpoints.
          // Arc curves are left as-is (they are trimmed by their parameterization).
          let curve = off.curve;
          if (curve && curve.degree === 1) {
            curve = NurbsCurve.createLine(off.startPt, off.endPt);
          }
          rebuiltEdges.push({
            start: off.startPt,
            end: off.endPt,
            curve,
          });
        }
      }

      // Handle vertices at chamfered corners that need connecting edges
      // between the offset endpoints on different faces
      const finalVerts = [];
      const finalCurves = [];
      // Filter zero-length rebuilt edges: when both endpoints of a
      // non-chamfered edge are resolved to the same point by an adjacent
      // chamfer (e.g. a fillet face's arc-chord edge whose start vertex
      // collapses onto its end vertex through a tangent chamfer miter),
      // the edge degenerates.  Drop it so the face boundary remains
      // non-degenerate and buildTopoBody doesn't emit a zero-length edge.
      const activeEdges = rebuiltEdges.filter(e =>
        vec3Len(vec3Sub(e.start, e.end)) > 1e-8
      );
      if (activeEdges.length < 3) continue;
      for (let i = 0; i < activeEdges.length; i++) {
        const current = activeEdges[i];
        const next = activeEdges[(i + 1) % activeEdges.length];
        finalVerts.push(current.start);
        finalCurves.push(current.curve);

        // Check if there's a gap between this edge's endpoint and next edge's start
        if (vec3Len(vec3Sub(current.end, next.start)) > 1e-8) {
          finalVerts.push(current.end);
          // Prefer a precomputed cylinder ∩ chamfer-plane arc when this
          // gap matches one identified by the fillet-junction surgery
          // pass.  This guarantees the fillet face's gap-fill curve is
          // identical to the chamfer face's connector curve so that
          // buildTopoBody can dedupe the seam.
          const stored = junctionArcByPair.get(_pairKey(current.end, next.start));
          let gapCurve;
          if (stored) {
            const startK = _vkey(stored.samples[0]);
            const curK = _vkey(current.end);
            gapCurve = startK === curK
              ? stored.curve.clone()
              : stored.curve.reversed();
          } else if (face.surface && face.surfaceType !== SurfaceType.PLANE &&
              typeof face.surface.closestPointUV === 'function') {
            // For non-planar faces (e.g. a cylindrical fillet face whose
            // boundary gap results from a tangent-chamfer collapse), a
            // straight 3-D chord between two points on the surface does not
            // lie on the surface.  Sample the gap curve on the surface by
            // linearly interpolating UVs and evaluating, so downstream
            // triangulation gets a boundary that actually lies on the face.
            const uvA = face.surface.closestPointUV(current.end);
            const uvB = face.surface.closestPointUV(next.start, 16, uvA);
            const N = 8;
            const pts = [];
            for (let k = 0; k <= N; k++) {
              const t = k / N;
              const u = uvA.u + (uvB.u - uvA.u) * t;
              const v = uvA.v + (uvB.v - uvA.v) * t;
              pts.push(face.surface.evaluate(u, v));
            }
            pts[0] = current.end;
            pts[pts.length - 1] = next.start;
            gapCurve = NurbsCurve.createPolyline(pts);
          } else {
            gapCurve = NurbsCurve.createLine(current.end, next.start);
          }
          finalCurves.push(gapCurve);
        }
      }

      if (finalVerts.length < 3) continue;

      if (_dbgFCF) {
        const fmt = p => `(${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)})`;
        console.log(`[FCF] face.id=${face.id} type=${face.surfaceType} verts:`, finalVerts.map(fmt).join(' -> '));
      }

      faceDescs.push({
        surface: face.surface,
        surfaceType: face.surfaceType,
        surfaceInfo: face.surfaceInfo || null,
        fusedGroupId: face.fusedGroupId || null,
        vertices: finalVerts,
        edgeCurves: finalCurves,
        innerLoops: face.innerLoops.map((loop) => _extractLoopDesc(loop)),
        sameSense: face.sameSense,
        shared: face.shared ? { ...face.shared } : null,
        stableHash: face.stableHash || face.topoFaceStableHash || null,
      });
    }
  }

  // Step 4: Add chamfer faces
  for (const ci of chamferInfos) {
    const off0 = _orientOffsetAlongTopoEdge(ci.off0, ci.topoEdge);
    const off1 = _orientOffsetAlongTopoEdge(ci.off1, ci.topoEdge);

    const surface = _buildChamferRuledSurface(off0, off1);
    const surfType = (off0.curve.degree === 2 && off1.curve.degree === 2)
      ? SurfaceType.CONE
      : SurfaceType.PLANE;

    // If a chamfer-edge endpoint sits at a previous fillet's vertex, use
    // the precomputed cylinder ∩ chamfer-plane arc as the connector edge
    // so the chamfer face's seam matches the fillet face's gap-fill.
    const _connector = (a, b) => {
      const stored = junctionArcByPair.get(_pairKey(a, b));
      if (!stored) return NurbsCurve.createLine(a, b);
      const startK = _vkey(stored.samples[0]);
      const aK = _vkey(a);
      return startK === aK ? stored.curve.clone() : stored.curve.reversed();
    };
    const _buildChamferBoundary = (reversed = false) => {
      const start = off0.startPt;
      const startKey = _vkey(start);
      const vertsOut = [start];
      const curvesOut = [];
      const addEdge = (to, curve) => {
        curvesOut.push(curve);
        if (_vkey(to) !== startKey) vertsOut.push(to);
      };
      const addConnector = (a, b) => {
        const split = junctionSplitByPair.get(_pairKey(a, b));
        if (!split) {
          addEdge(b, _connector(a, b));
          return;
        }
        const aK = _vkey(a), bK = _vkey(b);
        const splitAK = _vkey(split.a), splitBK = _vkey(split.b);
        if (aK === splitAK && bK === splitBK) {
          addEdge(split.mid, split.curveAMid.clone());
          addEdge(b, split.curveMidB.clone());
        } else if (aK === splitBK && bK === splitAK) {
          addEdge(split.mid, split.curveMidB.reversed());
          addEdge(b, split.curveAMid.reversed());
        } else {
          addEdge(b, _connector(a, b));
        }
      };

      if (!reversed) {
        addEdge(off0.endPt, off0.curve);
        addConnector(off0.endPt, off1.endPt);
        addEdge(off1.startPt, off1.curve.reversed());
        addConnector(off1.startPt, off0.startPt);
      } else {
        addConnector(off0.startPt, off1.startPt);
        addEdge(off1.endPt, off1.curve);
        addConnector(off1.endPt, off0.endPt);
        addEdge(off0.startPt, off0.curve.reversed());
      }
      return { verts: vertsOut, curves: curvesOut };
    };
    let { verts, curves } = _buildChamferBoundary(false);

    // Verify the chamfer face vertex winding produces an outward-pointing
    // Newell normal.  The expected outward direction is the average of the
    // two adjacent faces' outward normals at the original edge midpoint.
    // If the vertex winding disagrees, reverse the vertex/curve order so
    // that buildTopoBody computes the correct sameSense and the tessellator
    // orients triangles outward.  This applies to all chamfer face types
    // (cone for arc-edge chamfers, plane for straight-edge chamfers).
    {
      // Compute Newell normal of the vertex quad
      let lnx = 0, lny = 0, lnz = 0;
      for (let i = 0; i < verts.length; i++) {
        const vc = verts[i];
        const vn = verts[(i + 1) % verts.length];
        lnx += (vc.y - vn.y) * (vc.z + vn.z);
        lny += (vc.z - vn.z) * (vc.x + vn.x);
        lnz += (vc.x - vn.x) * (vc.y + vn.y);
      }
      // Compute expected outward direction from adjacent face normals
      let outX = 0, outY = 0, outZ = 0;
      for (const face of [ci.face0, ci.face1]) {
        if (!face.surface || typeof face.surface.normal !== 'function') continue;
        try {
          const n = face.surface.normal(0.5, 0.5);
          const flip = face.sameSense !== false ? 1 : -1;
          outX += n.x * flip; outY += n.y * flip; outZ += n.z * flip;
        } catch (_) { /* ignore */ }
      }
      // If the vertex Newell normal opposes the expected outward, reverse
      if (lnx * outX + lny * outY + lnz * outZ < 0) {
        ({ verts, curves } = _buildChamferBoundary(true));
      }
    }

    faceDescs.push({
      surface,
      surfaceType: surfType,
      vertices: verts,
      edgeCurves: curves,
      shared: ci.face0.shared ? { ...ci.face0.shared, isChamfer: true } : { isChamfer: true },
    });
    if (_dbgFCF) {
      const fmt = p => `(${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)})`;
      console.log('[FCF] CHAMFER face verts:', verts.map(fmt).join(' -> '));
    }
  }

  // Step 5: Add corner faces where chamfers meet at a vertex
  for (const [vk, cInfos] of vertexChamfers) {
    if (cInfos.length < 2) continue;
    // Find the offset points at this vertex from all chamfer infos
    // and create a corner face connecting them
    const pts = [];
    for (const ci of cInfos) {
      const off0StartKey = _vkey(ci.off0.startVertexPoint || ci.topoEdge.startVertex.point);
      const off1StartKey = _vkey(ci.off1.startVertexPoint || ci.topoEdge.startVertex.point);
      pts.push(vk === off0StartKey ? ci.off0.startPt : ci.off0.endPt);
      pts.push(vk === off1StartKey ? ci.off1.startPt : ci.off1.endPt);
    }
    // Deduplicate nearby points
    const uniquePts = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      let dup = false;
      for (const up of uniquePts) {
        if (vec3Len(vec3Sub(pts[i], up)) < 1e-8) { dup = true; break; }
      }
      if (!dup) uniquePts.push(pts[i]);
    }
    if (uniquePts.length >= 3) {
      const n = computePolygonNormal(uniquePts);
      faceDescs.push({
        surface: NurbsSurface.createPlane(
          uniquePts[0],
          vec3Sub(uniquePts[1], uniquePts[0]),
          vec3Sub(uniquePts[uniquePts.length - 1], uniquePts[0])
        ),
        surfaceType: SurfaceType.PLANE,
        vertices: uniquePts,
        edgeCurves: uniquePts.map((v, i) =>
          NurbsCurve.createLine(v, uniquePts[(i + 1) % uniquePts.length])
        ),
        shared: cInfos[0].face0.shared ? { ...cInfos[0].face0.shared, isCorner: true } : { isCorner: true },
      });
    }
  }

  // -----------------------------------------------------------------------
  // Helper: scan a TopoBody for unmatched (open) edges, returning each as
  // { edge, curve, a, b, aKey, bKey } — collected from the FIRST occurrence
  // of each edge so we have both endpoints and the boundary curve geometry
  // available for capping.
  // -----------------------------------------------------------------------
  const _collectOpenEdges = (body) => {
    const edgeRefs = new Map();
    for (const shell of body.shells || []) {
      for (const face of shell.faces) {
        for (const loop of face.allLoops()) {
          for (const coedge of loop.coedges) {
            const e = coedge.edge;
            if (!edgeRefs.has(e.id)) {
              edgeRefs.set(e.id, {
                edge: e,
                curve: coedge.curve || e.curve || null,
                sameSense: coedge.sameSense !== false,
                count: 0,
                faceIds: [],
                faces: [],
              });
            }
            const r = edgeRefs.get(e.id);
            r.count++;
            r.faceIds.push(face.id);
            r.faces.push(face);
          }
        }
      }
    }
    const out = [];
    for (const r of edgeRefs.values()) {
      if (r.count >= 2) continue;
      const a = r.edge.startVertex?.point;
      const b = r.edge.endVertex?.point;
      if (!a || !b) continue;
      out.push({
        edge: r.edge,
        curve: r.curve,
        a, b,
        aKey: _vkey(a),
        bKey: _vkey(b),
        faceIds: r.faceIds,
        faces: r.faces,
      });
    }
    return out;
  };

  // -----------------------------------------------------------------------
  // Helper: walk open edges to extract closed loops.  Each edge appears in
  // exactly one loop.  A loop's vertices form a cycle: edge[i].b == edge[i+1].a.
  // Edges may be flipped to align directionality (an open edge on a hole
  // boundary has no preferred orientation).
  // -----------------------------------------------------------------------
  const _extractClosedLoops = (openEdges) => {
    const remaining = [...openEdges];
    const loops = [];
    while (remaining.length > 0) {
      const start = remaining.shift();
      const loop = [{ a: start.a, b: start.b, aKey: start.aKey, bKey: start.bKey, curve: start.curve, faces: start.faces }];
      let curEndKey = start.bKey;
      const startKey = start.aKey;
      let safety = remaining.length + 1;
      while (curEndKey !== startKey && safety-- > 0) {
        let foundIdx = -1;
        let flip = false;
        for (let i = 0; i < remaining.length; i++) {
          if (remaining[i].aKey === curEndKey) { foundIdx = i; flip = false; break; }
          if (remaining[i].bKey === curEndKey) { foundIdx = i; flip = true; break; }
        }
        if (foundIdx < 0) break;
        const next = remaining.splice(foundIdx, 1)[0];
        if (flip) {
          loop.push({
            a: next.b, b: next.a,
            aKey: next.bKey, bKey: next.aKey,
            curve: next.curve ? next.curve.reversed() : null,
            faces: next.faces,
          });
          curEndKey = next.aKey;
        } else {
          loop.push({
            a: next.a, b: next.b,
            aKey: next.aKey, bKey: next.bKey,
            curve: next.curve,
            faces: next.faces,
          });
          curEndKey = next.bKey;
        }
      }
      if (curEndKey === startKey && loop.length >= 3) loops.push(loop);
    }
    return loops;
  };

  // -----------------------------------------------------------------------
  // Helper: emit a planar corner-cap face descriptor closing a loop of
  // unmatched boundary edges.  Used when buildTopoBody reports open edges
  // around a 3-fold (or higher) corner where multiple chamfer/fillet
  // operations from PRIOR feature calls meet at the new chamfer's vertex.
  // The cap is planar through the cycle's vertices (3 points always
  // coplanar; >3 points may be slightly non-planar but fitTopology accepts
  // it for closing 3-junction holes that are dominated by short segments).
  // -----------------------------------------------------------------------
  const _emitCornerCapFromLoop = (loop) => {
    if (loop.length < 3) return null;
    // Restrict auto-cap to loops composed entirely of straight-line edges.
    // Loops involving curve edges (e.g. cylinder-arc segments left by a
    // prior fillet, stored either as degree>1 NURBS or as degree-1
    // polylines approximating arcs) describe a non-planar saddle region
    // that a planar surface cannot triangulate without producing
    // non-manifold seams; in those cases we leave the cap to a future
    // surface-aware pass.
    for (const seg of loop) {
      const c = seg.curve;
      if (!c) continue;
      if (c.degree > 1) return null;
      if (c.controlPoints && c.controlPoints.length > 2) return null;
    }
    // Use first vertex of each segment as the polygon vertex sequence
    const verts = loop.map(seg => seg.a);
    const curves = loop.map(seg =>
      seg.curve ? seg.curve.clone() : NurbsCurve.createLine(seg.a, seg.b)
    );

    // Planar surface through first three non-collinear vertices.  The
    // basis vectors are (verts[1]-verts[0]) and (verts[k]-verts[0]) for
    // smallest k yielding a non-degenerate cross product — ensures the
    // surface is well-defined even if the first three are nearly collinear.
    let kPick = -1;
    let bestArea = 0;
    const u0 = vec3Sub(verts[1], verts[0]);
    for (let k = 2; k < verts.length; k++) {
      const vk = vec3Sub(verts[k], verts[0]);
      const cr = vec3Cross(u0, vk);
      const a2 = vec3Len(cr);
      if (a2 > bestArea) { bestArea = a2; kPick = k; }
    }
    if (kPick < 0 || bestArea < 1e-12) return null;
    const surface = NurbsSurface.createPlane(
      verts[0],
      u0,
      vec3Sub(verts[kPick], verts[0]),
    );

    return {
      surface,
      surfaceType: SurfaceType.PLANE,
      vertices: verts,
      edgeCurves: curves,
      shared: { isCorner: true, isAutoCap: true },
    };
  };

  // -----------------------------------------------------------------------
  // Helper: when an open 3-vertex loop bounds 3 chamfer planes (one per
  // edge), the geometrically correct cap is NOT a single planar triangle
  // through the 3 loop verts — that produces a flat-face "stub" at the
  // 3-fold corner instead of a sharp symmetric tip.  Compute the analytic
  // tip T as the intersection of the 3 chamfer planes and emit 3 small
  // triangle faces, each lying on its respective chamfer plane and
  // sharing T as the apex.  The result is a true sharp tip where the 3
  // chamfer planes converge.
  //
  // Returns an array of 3 face descriptors, or null if the configuration
  // doesn't apply (loop not 3-vert, edges not adjacent to chamfer planes,
  // planes parallel/degenerate, or T outside a sanity bound around the
  // loop centroid).
  // -----------------------------------------------------------------------
  const _emitThreePlaneTipFromLoop = (loop) => {
    if (loop.length !== 3) return null;
    // Each loop edge must be on exactly one face that is a planar chamfer
    // (face.shared.isChamfer && surfaceType === PLANE).  Collect 3 planes:
    // (point on plane, normal).
    const planes = [];
    for (const seg of loop) {
      if (!seg.faces || seg.faces.length !== 1) return null;
      const f = seg.faces[0];
      if (!f || !f.shared || !f.shared.isChamfer) return null;
      if (f.surfaceType !== SurfaceType.PLANE) return null;
      const surf = f.surface;
      if (!surf || typeof surf.evaluate !== 'function') return null;
      const p0 = surf.evaluate(0.5, 0.5);
      let n;
      if (typeof surf.normal === 'function') {
        n = surf.normal(0.5, 0.5);
      } else {
        const eps = 1e-4;
        const pu = surf.evaluate(0.5 + eps, 0.5);
        const pv = surf.evaluate(0.5, 0.5 + eps);
        n = vec3Cross(vec3Sub(pu, p0), vec3Sub(pv, p0));
      }
      const nLen = vec3Len(n);
      if (nLen < 1e-12) return null;
      n = vec3Scale(n, 1 / nLen);
      planes.push({ face: f, p0, n });
    }
    // Solve 3-plane intersection: each plane is n·(x - p0) = 0 → n·x = n·p0.
    // Build 3x3 matrix [n0; n1; n2] and right-hand side d = [n0·p0_0, ...].
    const M = [
      [planes[0].n.x, planes[0].n.y, planes[0].n.z],
      [planes[1].n.x, planes[1].n.y, planes[1].n.z],
      [planes[2].n.x, planes[2].n.y, planes[2].n.z],
    ];
    const d = [
      vec3Dot(planes[0].n, planes[0].p0),
      vec3Dot(planes[1].n, planes[1].p0),
      vec3Dot(planes[2].n, planes[2].p0),
    ];
    // Determinant via cofactor expansion
    const det =
      M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) -
      M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) +
      M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
    if (Math.abs(det) < 1e-10) return null;
    // Cramer's rule
    const detX =
      d[0]    * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) -
      M[0][1] * (d[1]    * M[2][2] - M[1][2] * d[2]) +
      M[0][2] * (d[1]    * M[2][1] - M[1][1] * d[2]);
    const detY =
      M[0][0] * (d[1]    * M[2][2] - M[1][2] * d[2]) -
      d[0]    * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) +
      M[0][2] * (M[1][0] * d[2]    - d[1]    * M[2][0]);
    const detZ =
      M[0][0] * (M[1][1] * d[2]    - d[1]    * M[2][1]) -
      M[0][1] * (M[1][0] * d[2]    - d[1]    * M[2][0]) +
      d[0]    * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
    const T = { x: detX / det, y: detY / det, z: detZ / det };
    // Sanity: T should be near the loop centroid (within a few times the
    // loop's bounding-box diagonal).  Otherwise the planes meet at a far
    // point, indicating this isn't a true 3-fold convergence corner.
    const cx = (loop[0].a.x + loop[1].a.x + loop[2].a.x) / 3;
    const cy = (loop[0].a.y + loop[1].a.y + loop[2].a.y) / 3;
    const cz = (loop[0].a.z + loop[1].a.z + loop[2].a.z) / 3;
    let diag = 0;
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        const dx = loop[i].a.x - loop[j].a.x;
        const dy = loop[i].a.y - loop[j].a.y;
        const dz = loop[i].a.z - loop[j].a.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist > diag) diag = dist;
      }
    }
    const tipDist = Math.sqrt((T.x - cx) ** 2 + (T.y - cy) ** 2 + (T.z - cz) ** 2);
    if (tipDist > 4 * diag) return null;
    // Verify T lies on all 3 planes (numerical sanity).
    for (const pl of planes) {
      const off = vec3Dot(pl.n, vec3Sub(T, pl.p0));
      if (Math.abs(off) > 1e-6) return null;
    }
    // Emit 3 triangle face descriptors.  For each loop edge (a→b on plane
    // P), the triangle is (a, b, T) — already on plane P since a, b, T
    // all satisfy P's equation.
    const descs = [];
    for (const seg of loop) {
      const a = seg.a;
      const b = seg.b;
      const verts = [a, b, T];
      const u0 = vec3Sub(b, a);
      const v0 = vec3Sub(T, a);
      const cr = vec3Cross(u0, v0);
      if (vec3Len(cr) < 1e-12) return null; // degenerate triangle
      const surface = NurbsSurface.createPlane(a, u0, v0);
      const curves = [
        seg.curve ? seg.curve.clone() : NurbsCurve.createLine(a, b),
        NurbsCurve.createLine(b, T),
        NurbsCurve.createLine(T, a),
      ];
      descs.push({
        surface,
        surfaceType: SurfaceType.PLANE,
        vertices: verts,
        edgeCurves: curves,
        shared: { isCorner: true, isAutoCap: true, isChamfer: true, isSharpTip: true },
      });
    }
    return descs;
  };

  // Step 6: Build new TopoBody and tessellate
  let newTopoBody;
  try {
    newTopoBody = buildTopoBody(faceDescs);
  } catch (error) {
    _debugBRepChamfer('build-topobody-failed', error?.message || String(error));
    return null; // fallback to mesh chamfer
  }

  let topoBoundaryEdges = countTopoBodyBoundaryEdges(newTopoBody);
  if (topoBoundaryEdges !== 0) {
    // Auto-cap pass: when chamfer/fillet operations from PRIOR feature
    // calls meet at the new chamfer's vertex, the new chamfer face's
    // connector terminates at offset endpoints that don't coincide with
    // existing prior-feature face vertices — leaving a small unmatched
    // boundary cycle.  Detect closed loops of unmatched edges and emit
    // a planar cap face for each.  This handles the cross-call analogue
    // of Step 5's in-call corner cap emission.
    const openEdges = _collectOpenEdges(newTopoBody);
    const loops = _extractClosedLoops(openEdges);
    let appendedCaps = 0;
    let sharpTips = 0;
    for (const loop of loops) {
      // Prefer the analytic 3-chamfer-plane sharp-tip emission for 3-vert
      // loops bounded by 3 chamfer planes — produces a true sharp corner
      // instead of a flat cap stub.
      const tipDescs = _emitThreePlaneTipFromLoop(loop);
      if (tipDescs) {
        for (const d of tipDescs) faceDescs.push(d);
        appendedCaps += tipDescs.length;
        sharpTips++;
        continue;
      }
      const cap = _emitCornerCapFromLoop(loop);
      if (cap) {
        faceDescs.push(cap);
        appendedCaps++;
      }
    }
    if (appendedCaps > 0) {
      _debugBRepChamfer('auto-cap', { appendedCaps, sharpTips, loops: loops.length });
      try {
        newTopoBody = buildTopoBody(faceDescs);
        topoBoundaryEdges = countTopoBodyBoundaryEdges(newTopoBody);
      } catch (error) {
        _debugBRepChamfer('build-topobody-after-cap-failed', error?.message || String(error));
        return null;
      }
    }
  }

  if (topoBoundaryEdges !== 0) {
    const openEdges = _collectOpenEdges(newTopoBody);
    const fmt = p => p ? `(${p.x.toFixed(4)},${p.y.toFixed(4)},${p.z.toFixed(4)})` : '?';
    const open = openEdges.map(o => ({ id: o.edge.id, a: fmt(o.a), b: fmt(o.b), faces: o.faceIds }));
    _debugBRepChamfer('topo-boundary-edges', { topoBoundaryEdges, faceCount: faceDescs.length, openEdges: open });
    return null;
  }

  let mesh;
  try {
    // H21: forward invalidatedFaceIds as dirtyFaceIds. See BRepFillet for
    // the parallel rationale — content-key invalidation is automatic but
    // identity-based eviction needs an explicit signal.
    const inputDirty = geometry && !geometry.allFacesDirty && Array.isArray(geometry.invalidatedFaceIds) && geometry.invalidatedFaceIds.length > 0
      ? geometry.invalidatedFaceIds
      : null;
    mesh = tessellateBody(newTopoBody, {
      validate: true,
      incrementalCache: geometry && geometry._incrementalTessellationCache
        ? geometry._incrementalTessellationCache
        : null,
      dirtyFaceIds: inputDirty,
    });
  } catch (error) {
    _debugBRepChamfer('tessellate-failed', error?.message || String(error));
    return null;
  }

  if (!mesh || !mesh.faces || mesh.faces.length === 0) {
    _debugBRepChamfer('empty-mesh');
    return null;
  }

  // The robust B-Rep tessellator (Tessellator2) produces faces with normals
  // derived from each TopoFace's surface and sameSense flag.  For curved
  // surfaces (cone, cylinder, etc.) these per-face normals are authoritative
  // and _fixWindingConsistency must NOT override them — the BFS propagation
  // can corrupt the sameSense-aware orientation computed by the tessellator.
  //
  // For purely planar chamfers the robust tessellator can still produce
  // minor winding inconsistencies from projected CDT, so the BFS fix
  // remains useful when no curved surfaces are involved.
  //
  // When the mesh contains non-manifold / boundary edges (expected for
  // curved-surface tessellation), skip _fixWindingConsistency entirely as
  // the BFS flips faces across non-manifold seams, corrupting winding and
  // signed volume.
  const bodyCurved = newTopoBody.shells.some(
    (s) => s.faces.some((f) => f.surfaceType !== 'plane')
  );
  const preFixTopology = measureMeshTopology(mesh.faces);
  if (!bodyCurved &&
      preFixTopology.boundaryEdges === 0 && preFixTopology.nonManifoldEdges === 0) {
    fixWindingConsistency(mesh.faces);
    recomputeFaceNormals(mesh.faces);
  }
  const meshTopology = measureMeshTopology(mesh.faces);

  // Accept the chamfer if its mesh topology errors are no worse than the
  // input body's baseline (pre-existing tessellation artifacts from curved
  // surface approximation).  Only reject if the chamfer genuinely introduces
  // NEW boundary or non-manifold edges beyond what already existed, or if
  // winding errors appear that weren't present before.
  //
  // The B-Rep topology check above (topoBoundaryEdges === 0) already
  // guarantees structural correctness of the solid.  When curved surfaces
  // are present (either from the input body or from the chamfer itself),
  // tessellation naturally introduces boundary/non-manifold/winding
  // artifacts at curved-face boundaries.  These artifacts are visual-only
  // and do not indicate geometry errors, so we skip the mesh-level check
  // when the B-Rep is watertight and any curved surfaces are involved.
  const hasCurvedSurfaces = chamferInfos.some(ci =>
    ci.off0.curve.degree >= 2 || ci.off1.curve.degree >= 2
  ) || (baselineMeshTopo && (baselineMeshTopo.boundaryEdges > 0 || baselineMeshTopo.nonManifoldEdges > 0))
    || newTopoBody.shells.some(s => s.faces.some(f => f.surfaceType !== 'plane'));
  if (!hasCurvedSurfaces) {
    const baselineBE = baselineMeshTopo ? baselineMeshTopo.boundaryEdges : 0;
    const baselineNME = baselineMeshTopo ? baselineMeshTopo.nonManifoldEdges : 0;
    const baselineWE = baselineMeshTopo ? baselineMeshTopo.windingErrors : 0;
    if (
      meshTopology.boundaryEdges > baselineBE ||
      meshTopology.nonManifoldEdges > baselineNME ||
      meshTopology.windingErrors > baselineWE
    ) {
      _debugBRepChamfer('mesh-topology-failed', { ...meshTopology, baselineBE, baselineNME, baselineWE });
      return null;
    }
  }

  const canReuseEdgeAnalysis = !!(
    geometry &&
    geometry.edges &&
    geometry.paths &&
    geometry.visualEdges &&
    mesh.incrementalTessellation &&
    mesh.incrementalTessellation.dirtyFaceKeys.length === 0
  );
  const edgeResult = canReuseEdgeAnalysis
    ? {
        edges: geometry.edges,
        paths: geometry.paths,
        visualEdges: geometry.visualEdges,
      }
    : computeFeatureEdges(mesh.faces);

  return {
    vertices: mesh.vertices || [],
    faces: mesh.faces,
    edges: edgeResult.edges,
    paths: edgeResult.paths,
    visualEdges: edgeResult.visualEdges,
    topoBody: newTopoBody,
    incrementalTessellation: mesh.incrementalTessellation || null,
    _incrementalTessellationCache: mesh._incrementalTessellationCache || null,
  };
}

// -----------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------

export {
  _extractFeatureFacesFromTopoBody,
  _mapSegmentKeysToTopoEdges,
  _proximityMatchEdgeKeys,
  _buildExactEdgeAdjacencyLookupFromTopoBody,
  _sampleExactEdgePoints,
  _precomputeChamferEdge,
  _computeOffsetDirs,
  _buildExactChamferTopoBody,
  _buildPlanarFaceDesc,
  _buildPlanarBoundarySegments,
};
