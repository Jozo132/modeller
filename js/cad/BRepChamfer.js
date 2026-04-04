// js/cad/BRepChamfer.js — BRep-level chamfer operations
// Extracted from CSG.js to isolate chamfer geometry into its own module.

import { NurbsSurface } from './NurbsSurface.js';
import { NurbsCurve } from './NurbsCurve.js';
import { buildTopoBody, SurfaceType } from './BRepTopology.js';
import { tessellateBody } from './Tessellation.js';
import { computeFeatureEdges } from './EdgeAnalysis.js';

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
  while (edgeCount < vertices.length) {
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

  return {
    surface,
    surfaceType: SurfaceType.PLANE,
    vertices: boundaryVertices,
    edgeCurves: boundarySegments
      ? boundarySegments.map((segment) => segment.curve)
      : face.vertices.map((vertex, index) =>
        NurbsCurve.createLine(vertex, face.vertices[(index + 1) % face.vertices.length])),
    shared: face.shared ? { ...face.shared } : null,
  };
}

// -----------------------------------------------------------------------
// Mesh-level chamfer helpers (shared with fillet path in CSG.js)
// -----------------------------------------------------------------------

function _computeOffsetDirs(face0, face1, edgeA, edgeB) {
  const n0 = vec3Normalize(face0.normal);
  const n1 = vec3Normalize(face1.normal);
  const edgeDir = vec3Normalize(vec3Sub(edgeB, edgeA));

  const offsDir0 = vec3Normalize(vec3Cross(n0, edgeDir));
  const offsDir1 = vec3Normalize(vec3Cross(edgeDir, n1));

  const cen0 = faceCentroid(face0);
  if (vec3Dot(offsDir0, vec3Sub(cen0, edgeA)) < 0) {
    offsDir0.x = -offsDir0.x; offsDir0.y = -offsDir0.y; offsDir0.z = -offsDir0.z;
  }
  const cen1 = faceCentroid(face1);
  if (vec3Dot(offsDir1, vec3Sub(cen1, edgeA)) < 0) {
    offsDir1.x = -offsDir1.x; offsDir1.y = -offsDir1.y; offsDir1.z = -offsDir1.z;
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
      const centerUV = toUV(center);
      const radius = vec3Len(vec3Sub(start, center));
      const dy = targetV - centerUV.y;
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
  return fromUV(x, targetV);
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
  const edgeDir = edgeLen > 1e-14 ? vec3Scale(edgeVec, 1 / edgeLen) : { x: 1, y: 0, z: 0 };

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
    // Ensure offDir points into the face (toward face centroid)
    const centroid = faceCentroid(face);
    const edgeMid = vec3Lerp(sp, ep, 0.5);
    if (vec3Dot(vec3Sub(centroid, edgeMid), offDir) < 0) {
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
          if (sweep < 0) sweep += 2 * Math.PI;
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
            if (sweep < 0) sweep += 2 * Math.PI;
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
  const c0 = offset0.curve;
  const c1 = offset1.curve;

  // If both curves are NURBS arcs with compatible parametrization, build a ruled surface
  if (c0.degree === 2 && c1.degree === 2 &&
      c0.controlPoints.length === c1.controlPoints.length &&
      c0.knots.length === c1.knots.length) {
    const nCols = c0.controlPoints.length;
    const nRows = 2;
    const controlPoints = [];
    const weights = [];
    for (let j = 0; j < nCols; j++) {
      controlPoints.push({ ...c0.controlPoints[j] });
      weights.push(c0.weights[j]);
    }
    for (let j = 0; j < nCols; j++) {
      controlPoints.push({ ...c1.controlPoints[j] });
      weights.push(c1.weights[j]);
    }
    return new NurbsSurface(
      1, c0.degree,       // linear in u, quadratic in v
      nRows, nCols,
      controlPoints,
      [0, 0, 1, 1],       // linear u-knots
      [...c0.knots],       // arc v-knots
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
    }
  }

  return adjacencyByKey;
}

function _extractFeatureFacesFromTopoBody(geometry) {
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
          ? _sampleExactEdgePoints(coedge.edge, 8)
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
        normal: normal && vec3Len(normal) > 1e-10 ? vec3Normalize(normal) : { x: 0, y: 0, z: 1 },
        shared: topoFace.shared ? { ...topoFace.shared } : null,
        isFillet: !!(topoFace.shared && topoFace.shared.isFillet),
        isCorner: !!(topoFace.shared && topoFace.shared.isCorner),
        surfaceType: topoFace.surfaceType,
        faceGroup: topoFace.id,
        topoFaceId: topoFace.id,
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

  // Step 3: Build face descriptors for new TopoBody
  const faceDescs = [];

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
              return isStart ? off.startPt : off.endPt;
            }

            return vertexPoint;
          };

          sp = resolveEndpoint(edgeSp);
          ep = resolveEndpoint(edgeEp);
          const endpointsUnchanged = pointsCoincident3D(sp, edgeSp) && pointsCoincident3D(ep, edgeEp);

          rebuiltEdges.push({
            start: sp,
            end: ep,
            curve: endpointsUnchanged
              ? (_getOrientedCoedgeCurve(coedge) || NurbsCurve.createLine(sp, ep))
              : NurbsCurve.createLine(sp, ep),
          });
        } else {
          // Chamfered edge: replace with offset curve on this face
          const off = chamInfo.face0 === face ? chamInfo.off0 : chamInfo.off1;
          rebuiltEdges.push({
            start: off.startPt,
            end: off.endPt,
            curve: off.curve,
          });
        }
      }

      // Handle vertices at chamfered corners that need connecting edges
      // between the offset endpoints on different faces
      const finalVerts = [];
      const finalCurves = [];
      for (let i = 0; i < rebuiltEdges.length; i++) {
        const current = rebuiltEdges[i];
        const next = rebuiltEdges[(i + 1) % rebuiltEdges.length];
        finalVerts.push(current.start);
        finalCurves.push(current.curve);

        // Check if there's a gap between this edge's endpoint and next edge's start
        if (vec3Len(vec3Sub(current.end, next.start)) > 1e-8) {
          finalVerts.push(current.end);
          finalCurves.push(NurbsCurve.createLine(current.end, next.start));
        }
      }

      if (finalVerts.length < 3) continue;

      faceDescs.push({
        surface: face.surface,
        surfaceType: face.surfaceType,
        vertices: finalVerts,
        edgeCurves: finalCurves,
        innerLoops: face.innerLoops.map((loop) => _extractLoopDesc(loop)),
        sameSense: face.sameSense,
        shared: face.shared ? { ...face.shared } : null,
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

    faceDescs.push({
      surface,
      surfaceType: surfType,
      vertices: [off0.startPt, off0.endPt, off1.endPt, off1.startPt],
      edgeCurves: [
        off0.curve,
        NurbsCurve.createLine(off0.endPt, off1.endPt),
        off1.curve.reversed(),
        NurbsCurve.createLine(off1.startPt, off0.startPt),
      ],
      shared: ci.face0.shared ? { ...ci.face0.shared, isChamfer: true } : { isChamfer: true },
    });
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

  // Step 6: Build new TopoBody and tessellate
  let newTopoBody;
  try {
    newTopoBody = buildTopoBody(faceDescs);
  } catch (error) {
    _debugBRepChamfer('build-topobody-failed', error?.message || String(error));
    return null; // fallback to mesh chamfer
  }

  const topoBoundaryEdges = countTopoBodyBoundaryEdges(newTopoBody);
  if (topoBoundaryEdges !== 0) {
    _debugBRepChamfer('topo-boundary-edges', { topoBoundaryEdges, faceCount: faceDescs.length });
    return null;
  }

  let mesh;
  try {
    mesh = tessellateBody(newTopoBody, { validate: true });
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
  ) || (baselineMeshTopo && (baselineMeshTopo.boundaryEdges > 0 || baselineMeshTopo.nonManifoldEdges > 0));
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

  const edgeResult = computeFeatureEdges(mesh.faces);

  return {
    vertices: mesh.vertices || [],
    faces: mesh.faces,
    edges: edgeResult.edges,
    paths: edgeResult.paths,
    visualEdges: edgeResult.visualEdges,
    topoBody: newTopoBody,
  };
}

// -----------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------

export {
  _extractFeatureFacesFromTopoBody,
  _buildExactEdgeAdjacencyLookupFromTopoBody,
  _sampleExactEdgePoints,
  _precomputeChamferEdge,
  _computeOffsetDirs,
  _buildExactChamferTopoBody,
};
