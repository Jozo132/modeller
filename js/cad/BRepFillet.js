// js/cad/BRepFillet.js — BRep-level fillet operations
// Extracted from CSG.js to isolate fillet geometry into its own module.

import { NurbsCurve } from './NurbsCurve.js';
import { NurbsSurface } from './NurbsSurface.js';
import { buildTopoBody, SurfaceType } from './BRepTopology.js';

import {
  vec3Sub as _vec3Sub,
  vec3Add as _vec3Add,
  vec3Scale as _vec3Scale,
  vec3Dot as _vec3Dot,
  vec3Cross as _vec3Cross,
  vec3Len as _vec3Len,
  vec3Normalize as _vec3Normalize,
  vec3Lerp as _vec3Lerp,
  circumCenter3D as _circumCenter3D,
  edgeVKey as _edgeVKey,
  edgeKeyFromVerts as _edgeKeyFromVerts,
  openPolylineNormal as _openPolylineNormal,
} from './toolkit/Vec3Utils.js';

import {
  computePolygonNormal as _computePolygonNormal,
  collectFaceEdgeKeys as _collectFaceEdgeKeys,
} from './toolkit/GeometryUtils.js';

import {
  findAdjacentFaces as _findAdjacentFaces,
  buildVertexEdgeMap as _buildVertexEdgeMap,
} from './toolkit/TopologyUtils.js';

import {
  _computeOffsetDirs,
  _buildPlanarFaceDesc,
  _buildPlanarBoundarySegments,
  _extractFeatureFacesFromTopoBody,
  _mapSegmentKeysToTopoEdges,
  _proximityMatchEdgeKeys,
  _buildExactEdgeAdjacencyLookupFromTopoBody,
  _sampleExactEdgePoints,
} from './BRepChamfer.js';

import { tessellateBody } from './Tessellation.js';
import { computeFeatureEdges } from './EdgeAnalysis.js';
import { sampleCylinderPlaneArcWasmReady } from './WasmGeometryOps.js';
import {
  buildTopoFaceById,
  findTerminalCapFace,
  findTopoEdgeByEndpoints,
  intersectPlanesWithCylinder,
  pointInTopoFaceDomain,
  topoFacePlane,
} from './CapProjection.js';

import {
  measureMeshTopology,
  countTopoBodyBoundaryEdges,
} from './toolkit/TopologyUtils.js';

import {
  fixWindingConsistency,
  recomputeFaceNormals,
} from './toolkit/MeshRepair.js';

// -----------------------------------------------------------------------
// Fillet helpers
// -----------------------------------------------------------------------

/**
 * Clip a fillet trim point to the neighboring face edge at a terminal vertex.
 *
 * At non-90° corners, the simple perpendicular offset (vertex + offsDir * tangentDist)
 * may not lie on the non-adjacent face's plane.  This causes non-planar faces and
 * visual artifacts.  By finding the point on the neighboring edge that is at the
 * correct perpendicular distance from the filleted edge, we ensure the trim point
 * lies on the face boundary (shared with the non-adjacent face).
 *
 * This is analogous to the chamfer's _intersectPlanarOffsetWithNeighbor.
 */
function _clipTrimToNeighborEdge(face, vertex, offsDir, tangentDist, defaultPt, filletEdgeDir) {
  const verts = face.vertices;
  if (!verts || verts.length < 3) return defaultPt;

  const n = verts.length;
  // Find vertex index in the face
  let idx = -1;
  for (let i = 0; i < n; i++) {
    if (_vec3Len(_vec3Sub(verts[i], vertex)) < 1e-6) { idx = i; break; }
  }
  if (idx < 0) return defaultPt;

  // The two adjacent edges at this vertex go to prev and next vertices.
  // One of them is the filleted edge — we want the other (the neighbor edge).
  const prev = verts[(idx - 1 + n) % n];
  const next = verts[(idx + 1) % n];
  const dirPrev = _vec3Normalize(_vec3Sub(prev, vertex));
  const dirNext = _vec3Normalize(_vec3Sub(next, vertex));

  // Choose the direction least aligned with the filleted edge
  const dotPrev = Math.abs(_vec3Dot(dirPrev, filletEdgeDir));
  const dotNext = Math.abs(_vec3Dot(dirNext, filletEdgeDir));
  const neighborDir = dotPrev < dotNext ? dirPrev : dirNext;
  const neighborVert = dotPrev < dotNext ? prev : next;

  // Perpendicular distance from vertex + t*neighborDir to the filleted edge
  // (line through vertex in direction filletEdgeDir):
  //   perp_dist = |t| * |cross(neighborDir, filletEdgeDir)|
  // Solve for perp_dist = tangentDist:
  const crossLen = _vec3Len(_vec3Cross(neighborDir, filletEdgeDir));
  if (crossLen < 0.01) return defaultPt; // Nearly parallel — fallback

  const t = tangentDist / crossLen;

  // Guard: the adapted point must not extend past 80% of the neighboring
  // edge length.  This prevents degenerate faces when the non-90° angle
  // is very large (e.g., chamfer+fillet sequences where the bevel face
  // creates a ~45° neighbor edge).
  const neighborEdgeLen = _vec3Len(_vec3Sub(neighborVert, vertex));
  if (neighborEdgeLen < 1e-8 || t > 0.8 * neighborEdgeLen) return defaultPt;

  const adaptedPt = _vec3Add(vertex, _vec3Scale(neighborDir, t));

  // Verify the adapted point is on the correct side (same as offsDir)
  if (_vec3Dot(_vec3Sub(adaptedPt, vertex), offsDir) < 0) {
    return defaultPt;
  }

  // Only use the adapted point if it actually differs from the default
  // (i.e., the corner is non-90°).  For 90° corners, the adapted point
  // matches the default within tolerance.
  const diff = _vec3Len(_vec3Sub(adaptedPt, defaultPt));
  if (diff < 1e-8) return defaultPt;

  return adaptedPt;
}

function _precomputeFilletEdge(faces, edgeKey, radius, segments, exactAdjacencyByKey = null, options = null) {
  const adj = (exactAdjacencyByKey && exactAdjacencyByKey.get(edgeKey)) || _findAdjacentFaces(faces, edgeKey);
  if (adj.length < 2) return null;

  const fi0 = adj[0].fi, fi1 = adj[1].fi;
  const face0 = faces[fi0];
  const face1 = faces[fi1];
  const edgeA = adj[0].a;
  const edgeB = adj[0].b;

  const face0Keys = _collectFaceEdgeKeys(face0);
  const face1Keys = _collectFaceEdgeKeys(face1);

  let edgeDirOverride = options && options.edgeDirOverride ? _vec3Normalize(options.edgeDirOverride) : null;
  if (edgeDirOverride && _vec3Dot(edgeDirOverride, _vec3Sub(edgeB, edgeA)) < 0) {
    edgeDirOverride = _vec3Scale(edgeDirOverride, -1);
  }
  const { offsDir0, offsDir1, isConcave } = _computeOffsetDirs(face0, face1, edgeA, edgeB, edgeDirOverride);

  const alpha = Math.acos(Math.max(-1, Math.min(1, _vec3Dot(offsDir0, offsDir1))));
  if (alpha < 1e-6) return null;

  const tangentDist = radius / Math.tan(alpha / 2);
  const centerDist = radius / Math.sin(alpha / 2);
  const sweep = Math.PI - alpha;
  const bisector = _vec3Normalize(_vec3Add(offsDir0, offsDir1));
  const edgeDir = edgeDirOverride || _vec3Normalize(_vec3Sub(edgeB, edgeA));

  // Standard perpendicular offsets (correct for 90° corners)
  const projectTrimsToFaces = !!(options && options.projectTrimsToFaces);
  let t0a_raw = _vec3Add(edgeA, _vec3Scale(offsDir0, tangentDist));
  let t0b_raw = _vec3Add(edgeB, _vec3Scale(offsDir0, tangentDist));
  let t1a_raw = _vec3Add(edgeA, _vec3Scale(offsDir1, tangentDist));
  let t1b_raw = _vec3Add(edgeB, _vec3Scale(offsDir1, tangentDist));
  if (projectTrimsToFaces) {
    t0a_raw = _projectPointToFeatureFaceSurface(face0, t0a_raw);
    t0b_raw = _projectPointToFeatureFaceSurface(face0, t0b_raw);
    t1a_raw = _projectPointToFeatureFaceSurface(face1, t1a_raw);
    t1b_raw = _projectPointToFeatureFaceSurface(face1, t1b_raw);
  }

  // Clip trim points to neighboring face edges for correct corner geometry.
  // At non-90° corners, the simple perpendicular offset may not lie on the
  // non-adjacent face's plane.  Clipping ensures the trim point is on the
  // face boundary edge shared with the non-adjacent face.
  const disableTrimClipA = !!(options && (options.disableTrimClip || options.disableTrimClipA));
  const disableTrimClipB = !!(options && (options.disableTrimClip || options.disableTrimClipB));
  let t0a = disableTrimClipA ? t0a_raw : _clipTrimToNeighborEdge(face0, edgeA, offsDir0, tangentDist, t0a_raw, _vec3Scale(edgeDir, -1));
  let t0b = disableTrimClipB ? t0b_raw : _clipTrimToNeighborEdge(face0, edgeB, offsDir0, tangentDist, t0b_raw, edgeDir);
  let t1a = disableTrimClipA ? t1a_raw : _clipTrimToNeighborEdge(face1, edgeA, offsDir1, tangentDist, t1a_raw, _vec3Scale(edgeDir, -1));
  let t1b = disableTrimClipB ? t1b_raw : _clipTrimToNeighborEdge(face1, edgeB, offsDir1, tangentDist, t1b_raw, edgeDir);
  if (projectTrimsToFaces) {
    t0a = _projectPointToFeatureFaceSurface(face0, t0a);
    t0b = _projectPointToFeatureFaceSurface(face0, t0b);
    t1a = _projectPointToFeatureFaceSurface(face1, t1a);
    t1b = _projectPointToFeatureFaceSurface(face1, t1b);
  }

  function computeArc(vertex, trimPt0, trimPt1) {
    const center = _vec3Add(vertex, _vec3Scale(bisector, centerDist));
    // Use the standard perpendicular offsets for arc basis vectors
    const stdPt0 = _vec3Add(vertex, _vec3Scale(offsDir0, tangentDist));
    const stdPt1 = _vec3Add(vertex, _vec3Scale(offsDir1, tangentDist));
    const e0 = _vec3Normalize(_vec3Sub(stdPt0, center));
    // Compute the arc sweep basis vector from center and stdPt1, which is
    // independent of edge vertex ordering.  The previous approach using
    // cross(edgeDir, e0) depended on the direction of edgeDir and
    // produced arcs sweeping the wrong way when the edge vertices were
    // ordered differently (common for non-axis-aligned / non-90° edges).
    const t1rel = _vec3Sub(stdPt1, center);
    const t1proj = _vec3Dot(t1rel, e0);
    const rawE1 = _vec3Sub(t1rel, _vec3Scale(e0, t1proj));
    const rawE1Len = _vec3Len(rawE1);
    const e1 = rawE1Len > 1e-10
      ? _vec3Scale(rawE1, 1 / rawE1Len)
      : _vec3Normalize(_vec3Cross(edgeDir, e0));

    // The terminal cap curve is the intersection of the fillet cylinder
    // with the neighbouring end face. For non-90 degree corners that
    // intersection is an ellipse, not a circular section that can be
    // linearly dragged to new endpoints.
    const capNormal = _vec3Normalize(_vec3Cross(
      _vec3Sub(trimPt0, vertex),
      _vec3Sub(trimPt1, vertex),
    ));
    if (_vec3Len(capNormal) > 1e-10) {
      const capArc = _computeFilletChamferArcSamples(
        center,
        edgeDir,
        radius,
        e0,
        e1,
        vertex,
        capNormal,
        trimPt0,
        trimPt1,
        segments,
      );
      if (capArc && capArc.length >= 2) return capArc;
    }

    const cosSweep = Math.cos(sweep);
    const sinSweep = Math.sin(sweep);
    const perp = sinSweep > 1e-10
      ? _vec3Scale(_vec3Sub(_vec3Normalize(_vec3Sub(stdPt1, center)), _vec3Scale(e0, cosSweep)), 1 / sinSweep)
      : e1;
    const arcPoints = [];
    for (let segmentIndex = 0; segmentIndex <= segments; segmentIndex++) {
      const theta = (segmentIndex / segments) * sweep;
      arcPoints.push(_vec3Add(center, _vec3Add(
        _vec3Scale(e0, radius * Math.cos(theta)),
        _vec3Scale(perp, radius * Math.sin(theta))
      )));
    }

    // Fallback only: if cylinder-plane intersection failed, preserve the
    // previous endpoint adaptation rather than leaving an open topology.
    const nPts = arcPoints.length - 1;
    if (nPts >= 1) {
      const d0 = _vec3Sub(trimPt0, arcPoints[0]);
      const d1 = _vec3Sub(trimPt1, arcPoints[nPts]);
      const d0Len = _vec3Len(d0);
      const d1Len = _vec3Len(d1);
      if (d0Len > 1e-8 || d1Len > 1e-8) {
        for (let i = 0; i <= nPts; i++) {
          const t = i / nPts;
          arcPoints[i] = {
            x: arcPoints[i].x + d0.x * (1 - t) + d1.x * t,
            y: arcPoints[i].y + d0.y * (1 - t) + d1.y * t,
            z: arcPoints[i].z + d0.z * (1 - t) + d1.z * t,
          };
        }
      }
    }

    return arcPoints;
  }

  const arcA = computeArc(edgeA, t0a, t1a);
  const arcB = computeArc(edgeB, t0b, t1b);

  // p0a/p0b/p1a/p1b for trim compatibility with batch helpers
  return {
    edgeKey, fi0, fi1, edgeA, edgeB,
    face0Keys, face1Keys,
    p0a: t0a, p0b: t0b, p1a: t1a, p1b: t1b,
    arcA, arcB,
    isConcave,
    radius,
    _sweep: sweep,
    shared: face0.shared ? { ...face0.shared } : null,
  };
}

// -----------------------------------------------------------------------
// Batch fillet helpers
// -----------------------------------------------------------------------

/**
 * Merge trimmed-vertex positions at shared vertices on common faces.
 *
 * When 2+ chamfer edges meet at a vertex and share a common face, each edge
 * independently offsets the vertex inward along the face.  Instead of producing
 * two separate trimmed positions (which creates a gap needing a corner face),
 * compute a single merged position that combines both offsets:
 *   mergedPos = originalVertex + sum(offset_i)
 * This places the vertex at the intersection of the bevel planes on the face.
 * If the p1 positions also converge (as on axis-aligned boxes), the corner
 * polygon degenerates and is automatically skipped.
 */
function _mergeSharedVertexPositions(edgeDataList, vertexEdgeMap) {
  for (const [vk, edgeIndices] of vertexEdgeMap) {
    if (edgeIndices.length < 2) continue;

    // Get original vertex position
    const d0 = edgeDataList[edgeIndices[0]];
    const origV = _edgeVKey(d0.edgeA) === vk ? d0.edgeA : d0.edgeB;

    // Build face → contributions map
    const faceContribs = new Map();
    for (const di of edgeIndices) {
      const d = edgeDataList[di];
      const isA = _edgeVKey(d.edgeA) === vk;

      // fi0 contribution
      if (!faceContribs.has(d.fi0)) faceContribs.set(d.fi0, []);
      faceContribs.get(d.fi0).push({ di, side: 0, isA });

      // fi1 contribution
      if (!faceContribs.has(d.fi1)) faceContribs.set(d.fi1, []);
      faceContribs.get(d.fi1).push({ di, side: 1, isA });
    }

    // For each face shared by 2+ edges, compute the merged position
    for (const [, contribs] of faceContribs) {
      if (contribs.length < 2) continue;

      // Merged position = original vertex + sum of all (offset - V) contributions
      let mx = origV.x, my = origV.y, mz = origV.z;
      for (const c of contribs) {
        const d = edgeDataList[c.di];
        const pos = c.side === 0
          ? (c.isA ? d.p0a : d.p0b)
          : (c.isA ? d.p1a : d.p1b);
        mx += pos.x - origV.x;
        my += pos.y - origV.y;
        mz += pos.z - origV.z;
      }

      // Update each contributing edge's position to the merged value
      for (const c of contribs) {
        const d = edgeDataList[c.di];
        if (c.side === 0) {
          if (c.isA) d.p0a = { x: mx, y: my, z: mz };
          else d.p0b = { x: mx, y: my, z: mz };
        } else {
          if (c.isA) d.p1a = { x: mx, y: my, z: mz };
          else d.p1b = { x: mx, y: my, z: mz };
        }
      }
    }
  }
}

function _solvePlanarCoefficients(axis0, axis1, rel) {
  const g00 = _vec3Dot(axis0, axis0);
  const g01 = _vec3Dot(axis0, axis1);
  const g11 = _vec3Dot(axis1, axis1);
  const rhs0 = _vec3Dot(rel, axis0);
  const rhs1 = _vec3Dot(rel, axis1);
  const det = g00 * g11 - g01 * g01;
  if (Math.abs(det) < 1e-10) return null;
  return {
    u: (rhs0 * g11 - rhs1 * g01) / det,
    v: (rhs1 * g00 - rhs0 * g01) / det,
  };
}

function _samplePolyline(points, samples) {
  if (!points || points.length === 0) return [];
  if (points.length === 1 || samples <= 0) return [{ ...points[0] }];

  const lengths = [0];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += _vec3Len(_vec3Sub(points[i], points[i - 1]));
    lengths.push(total);
  }
  if (total < 1e-10) {
    return Array.from({ length: samples + 1 }, () => ({ ...points[0] }));
  }

  const result = [];
  for (let i = 0; i <= samples; i++) {
    const target = (i / samples) * total;
    let seg = 1;
    while (seg < lengths.length && lengths[seg] < target) {
      seg++;
      if (seg > 10_000_000) throw new Error('_resamplePolylineByArcLength: exceeded 10M iterations');
    }
    const lo = Math.max(0, seg - 1);
    const hi = Math.min(points.length - 1, seg);
    const segLen = lengths[hi] - lengths[lo];
    const t = segLen > 1e-10 ? (target - lengths[lo]) / segLen : 0;
    result.push(_vec3Lerp(points[lo], points[hi], t));
  }
  return result;
}

function _buildTwoEdgeFilletTrim(edgeInfo0, edgeInfo1, origFaces) {
  const data0 = edgeInfo0.data;
  const data1 = edgeInfo1.data;
  const commonFaces = [];
  for (const fi of [data0.fi0, data0.fi1]) {
    if (fi === data1.fi0 || fi === data1.fi1) commonFaces.push(fi);
  }
  if (commonFaces.length !== 1) return null;

  const commonFaceIndex = commonFaces[0];
  const commonFace = origFaces[commonFaceIndex];
  const faceNormal = _vec3Normalize(commonFace && commonFace.normal ? commonFace.normal : { x: 0, y: 0, z: 0 });
  if (_vec3Len(faceNormal) < 1e-10) return null;

  const orientedArc0 = commonFaceIndex === data0.fi0 ? edgeInfo0.arc : [...edgeInfo0.arc].reverse();
  const orientedArc1 = commonFaceIndex === data1.fi0 ? edgeInfo1.arc : [...edgeInfo1.arc].reverse();
  if (!orientedArc0 || !orientedArc1 || orientedArc0.length !== orientedArc1.length || orientedArc0.length < 2) {
    return null;
  }

  const sharedVertex = edgeInfo0.isA ? data0.edgeA : data0.edgeB;
  const other0 = edgeInfo0.isA ? data0.edgeB : data0.edgeA;
  const other1 = edgeInfo1.isA ? data1.edgeB : data1.edgeA;

  const axis0Raw = _vec3Sub(other0, sharedVertex);
  const axis1Raw = _vec3Sub(other1, sharedVertex);
  const axis0Plane = _vec3Sub(axis0Raw, _vec3Scale(faceNormal, _vec3Dot(axis0Raw, faceNormal)));
  const axis1Plane = _vec3Sub(axis1Raw, _vec3Scale(faceNormal, _vec3Dot(axis1Raw, faceNormal)));
  const axis0 = _vec3Normalize(axis0Plane);
  const axis1 = _vec3Normalize(axis1Plane);
  if (_vec3Len(axis0) < 1e-10 || _vec3Len(axis1) < 1e-10) return null;
  if (_vec3Len(_vec3Cross(axis0, axis1)) < 1e-6) return null;
  const planeNormal = _vec3Normalize(_vec3Sub(axis0, axis1));
  if (_vec3Len(planeNormal) < 1e-10) return null;

  const trim = [];
  for (let i = 0; i < orientedArc0.length; i++) {
    const rel0 = _vec3Sub(orientedArc0[i], sharedVertex);
    const rel1 = _vec3Sub(orientedArc1[i], sharedVertex);
    const w0 = _vec3Dot(rel0, faceNormal);
    const w1 = _vec3Dot(rel1, faceNormal);
    const plane0 = _vec3Sub(rel0, _vec3Scale(faceNormal, w0));
    const plane1 = _vec3Sub(rel1, _vec3Scale(faceNormal, w1));
    const coeff0 = _solvePlanarCoefficients(axis0, axis1, plane0);
    const coeff1 = _solvePlanarCoefficients(axis0, axis1, plane1);
    if (!coeff0 || !coeff1) return null;
    trim.push(_vec3Add(sharedVertex, _vec3Add(
      _vec3Add(_vec3Scale(axis0, coeff1.u), _vec3Scale(axis1, coeff0.v)),
      _vec3Scale(faceNormal, (w0 + w1) * 0.5)
    )));
  }

  const trimFor0 = commonFaceIndex === data0.fi0 ? trim : [...trim].reverse();
  const trimFor1 = commonFaceIndex === data1.fi0 ? trim : [...trim].reverse();
  return {
    trimFor0,
    trimFor1,
    planeOrigin: { ...sharedVertex },
    planeNormal,
  };
}

function _applyTwoEdgeFilletSharedTrims(edgeDataList, origFaces, vertexEdgeMap) {
  // Track corner vertex trim endpoints for 3-edge corner patch generation
  const cornerTrimEndpoints = new Map(); // vk → [{ trimEndpoint, pairKey }]

  for (const [vk, edgeIndices] of vertexEdgeMap) {
    if (edgeIndices.length === 2) {
      // Standard 2-edge case
      const data0 = edgeDataList[edgeIndices[0]];
      const data1 = edgeDataList[edgeIndices[1]];
      const edgeInfo0 = {
        data: data0,
        isA: _edgeVKey(data0.edgeA) === vk,
        arc: _edgeVKey(data0.edgeA) === vk ? data0.arcA : data0.arcB,
      };
      const edgeInfo1 = {
        data: data1,
        isA: _edgeVKey(data1.edgeA) === vk,
        arc: _edgeVKey(data1.edgeA) === vk ? data1.arcA : data1.arcB,
      };
      if (!edgeInfo0.arc || !edgeInfo1.arc) continue;

      const trimInfo = _buildTwoEdgeFilletTrim(edgeInfo0, edgeInfo1, origFaces);
      if (!trimInfo) continue;

      if (edgeInfo0.isA) edgeInfo0.data.sharedTrimA = trimInfo.trimFor0;
      else edgeInfo0.data.sharedTrimB = trimInfo.trimFor0;
      if (edgeInfo1.isA) edgeInfo1.data.sharedTrimA = trimInfo.trimFor1;
      else edgeInfo1.data.sharedTrimB = trimInfo.trimFor1;

      if (edgeInfo0.isA) {
        edgeInfo0.data._sharedTrimPlaneAOrigin = { ...trimInfo.planeOrigin };
        edgeInfo0.data._sharedTrimPlaneANormal = { ...trimInfo.planeNormal };
      } else {
        edgeInfo0.data._sharedTrimPlaneBOrigin = { ...trimInfo.planeOrigin };
        edgeInfo0.data._sharedTrimPlaneBNormal = { ...trimInfo.planeNormal };
      }
      if (edgeInfo1.isA) {
        edgeInfo1.data._sharedTrimPlaneAOrigin = { ...trimInfo.planeOrigin };
        edgeInfo1.data._sharedTrimPlaneANormal = { ...trimInfo.planeNormal };
      } else {
        edgeInfo1.data._sharedTrimPlaneBOrigin = { ...trimInfo.planeOrigin };
        edgeInfo1.data._sharedTrimPlaneBNormal = { ...trimInfo.planeNormal };
      }
    } else if (edgeIndices.length >= 3) {
      // 3+ edge corner: do NOT apply pairwise shared trims because
      // they overwrite each other and produce inconsistent boundaries.
      // Instead, leave the original arcs as the fillet strip boundaries
      // at this vertex end, and collect the arc-endpoint data needed to
      // build a spherical corner patch in Step 6.
      //
      // After _mergeSharedVertexPositions, each face's trim positions at
      // this vertex are merged (identical for all edges touching that face).
      // The unique merged positions form the 3 vertices of the spherical
      // corner triangle.  The sphere center is derived from these: each
      // merged vertex = origV + sum(face_offsets_on_that_face), so
      // sphereCenter = origV + (sum_of_merged - 3*origV) / 2.

      const d0 = edgeDataList[edgeIndices[0]];
      const origV = _edgeVKey(d0.edgeA) === vk ? d0.edgeA : d0.edgeB;

      // Collect unique merged trim positions at this vertex
      const triVertices = [];
      const seen = new Set();
      for (const di of edgeIndices) {
        const d = edgeDataList[di];
        const isA = _edgeVKey(d.edgeA) === vk;
        const p0 = isA ? d.p0a : d.p0b;
        const p1 = isA ? d.p1a : d.p1b;
        for (const pt of [p0, p1]) {
          const ptk = _edgeVKey(pt);
          if (!seen.has(ptk)) {
            seen.add(ptk);
            triVertices.push({ ...pt });
          }
        }
      }

      if (triVertices.length >= 3) {
        // Compute the sphere center from the 3 merged vertices.
        // sphere_center = origV + (sum_merged - 3*origV) / 2
        const sumX = triVertices[0].x + triVertices[1].x + triVertices[2].x;
        const sumY = triVertices[0].y + triVertices[1].y + triVertices[2].y;
        const sumZ = triVertices[0].z + triVertices[1].z + triVertices[2].z;
        const sphereCenter = {
          x: origV.x + (sumX - 3 * origV.x) / 2,
          y: origV.y + (sumY - 3 * origV.y) / 2,
          z: origV.z + (sumZ - 3 * origV.z) / 2,
        };
        cornerTrimEndpoints.set(vk, {
          triVertices: triVertices.slice(0, 3),
          sphereCenter,
          edgeIndices: [...edgeIndices],
        });
      }
    }
  }

  return cornerTrimEndpoints;
}

/**
 * For each fillet edge at a 3-edge corner, recompute the vertex-end arc
 * at the merged position.  After _mergeSharedVertexPositions the trim
 * points (p0a/p1a) have been moved to the merged sphere-vertex positions.
 * The pre-merge arc was computed at the original vertex, whose cross-section
 * center is different from the sphere center.  The recomputed arc shares
 * its endpoints with the sphere vertices and lies on both the fillet
 * cylinder and the corner sphere.
 */
function _recomputeCornerArcs(edgeDataList, vertexEdgeMap, cornerTrimEndpoints, segments, faces) {
  if (!cornerTrimEndpoints || cornerTrimEndpoints.size === 0) return;

  for (const [vk, cornerData] of cornerTrimEndpoints) {
    const { edgeIndices } = cornerData;
    if (!edgeIndices) continue;

    for (const di of edgeIndices) {
      const d = edgeDataList[di];
      const isA = _edgeVKey(d.edgeA) === vk;
      // Merged arc endpoints
      const p0 = isA ? d.p0a : d.p0b;  // face0 side merged position
      const p1 = isA ? d.p1a : d.p1b;  // face1 side merged position

      // The arc center at the merged position: project the merged point onto
      // the edge line to find where on the axis the cross-section sits.
      // edgeDir = normalize(edgeB - edgeA).  The cross-section center is
      // the rolling-ball center at that axis parameter.
      const edgeDir = _vec3Normalize(_vec3Sub(d.edgeB, d.edgeA));
      const vertexPos = isA ? d.edgeA : d.edgeB;
      // The merged p0 lies on the face0 plane and on the cylinder.
      // Its projection onto the edge axis gives the slice position.
      const sliceT = _vec3Dot(_vec3Sub(p0, d.edgeA), edgeDir);
      const axisPoint = _vec3Add(d.edgeA, _vec3Scale(edgeDir, sliceT));
      // The arc center is offset from the axis point along the bisector
      const { offsDir0, offsDir1 } = _computeOffsetDirs(
        faces[d.fi0], faces[d.fi1], d.edgeA, d.edgeB
      );
      const bisector = _vec3Normalize(_vec3Add(offsDir0, offsDir1));
      const halfAngle = Math.acos(Math.max(-1, Math.min(1, _vec3Dot(offsDir0, offsDir1)))) / 2;
      const centerDist = d.radius / Math.cos(halfAngle);
      const arcCenter = _vec3Add(axisPoint, _vec3Scale(bisector, centerDist));

      // Compute arc from p0 to p1 around arcCenter
      const e0 = _vec3Normalize(_vec3Sub(p0, arcCenter));
      const t1rel = _vec3Sub(p1, arcCenter);
      const t1proj = _vec3Dot(t1rel, e0);
      const rawE1 = _vec3Sub(t1rel, _vec3Scale(e0, t1proj));
      const rawE1Len = _vec3Len(rawE1);
      const e1 = rawE1Len > 1e-10
        ? _vec3Scale(rawE1, 1 / rawE1Len)
        : _vec3Normalize(_vec3Cross(edgeDir, e0));
      const sweep = Math.atan2(rawE1Len, t1proj) || d._sweep || Math.PI / 2;

      let newArc;
      let exactArcCurve = null;
      try {
        exactArcCurve = NurbsCurve.createArc(arcCenter, d.radius, e0, e1, 0, sweep);
      } catch (_) {
        exactArcCurve = null;
      }
      newArc = [];
      for (let segmentIndex = 0; segmentIndex <= segments; segmentIndex++) {
        const theta = (segmentIndex / segments) * sweep;
        newArc.push(_vec3Add(arcCenter, _vec3Add(
          _vec3Scale(e0, d.radius * Math.cos(theta)),
          _vec3Scale(e1, d.radius * Math.sin(theta))
        )));
      }

      if (isA) {
        d.arcA = newArc;
        d._exactArcCurveA = exactArcCurve || _curveFromSampledPoints(newArc);
      } else {
        d.arcB = newArc;
        d._exactArcCurveB = exactArcCurve || _curveFromSampledPoints(newArc);
      }
    }
  }
}

function _curveFromSampledPoints(points) {
  if (!points || points.length < 2) return null;
  if (points.length === 2) return NurbsCurve.createLine(points[0], points[1]);
  return NurbsCurve.createPolyline(points);
}

function _preserveControlPointSamples(curve) {
  if (curve) curve._preserveControlPointSamples = true;
  return curve;
}

function _projectTerminalFilletCapsOntoAdjacentFaces(topoBody, faces, edgeDataList, vertexEdgeMap, radius, segments) {
  if (!topoBody || !Array.isArray(faces) || !Array.isArray(edgeDataList)) return;
  const topoFaceById = buildTopoFaceById(topoBody);

  for (const data of edgeDataList) {
    const selectedEdge = findTopoEdgeByEndpoints(topoBody, data.edgeA, data.edgeB);
    if (!selectedEdge) continue;

    const face0 = topoFaceById.get(faces[data.fi0]?.topoFaceId);
    const face1 = topoFaceById.get(faces[data.fi1]?.topoFaceId);
    const plane0 = topoFacePlane(face0);
    const plane1 = topoFacePlane(face1);
    if (!face0 || !face1 || !plane0 || !plane1) continue;

    const edgeDir = _vec3Normalize(_vec3Sub(data.edgeB, data.edgeA));
    if (_vec3Len(edgeDir) < 1e-12) continue;
    const { offsDir0, offsDir1 } = _computeOffsetDirs(faces[data.fi0], faces[data.fi1], data.edgeA, data.edgeB);
    const alpha = Math.acos(Math.max(-1, Math.min(1, _vec3Dot(offsDir0, offsDir1))));
    const centerDist = alpha > 1e-6 ? radius / Math.sin(alpha / 2) : radius;
    const bisector = _vec3Normalize(_vec3Add(offsDir0, offsDir1));
    if (_vec3Len(bisector) < 1e-12) continue;

    const projectSide = (isA) => {
      const vertex = isA ? data.edgeA : data.edgeB;
      const vertexKey = _edgeVKey(vertex);
      if ((vertexEdgeMap.get(vertexKey) || []).length > 1) return;

      const capFace = findTerminalCapFace(topoBody, selectedEdge, face0, face1, vertex);
      const capPlane = topoFacePlane(capFace);
      if (!capFace || !capPlane) return;

      const axisPoint = _vec3Add(vertex, _vec3Scale(bisector, centerDist));
      const near0 = isA ? data.p0a : data.p0b;
      const near1 = isA ? data.p1a : data.p1b;
      const hit0 = intersectPlanesWithCylinder(plane0, capPlane, axisPoint, edgeDir, radius, near0, face0, capFace);
      const hit1 = intersectPlanesWithCylinder(plane1, capPlane, axisPoint, edgeDir, radius, near1, face1, capFace);
      if (!hit0 || !hit1 || _vec3Len(_vec3Sub(hit0, hit1)) < 1e-8) return;

      const t0 = _vec3Dot(_vec3Sub(hit0, axisPoint), edgeDir);
      const axisAtHit0 = _vec3Add(axisPoint, _vec3Scale(edgeDir, t0));
      const ex = _vec3Normalize(_vec3Sub(hit0, axisAtHit0));
      if (_vec3Len(ex) < 1e-10) return;
      let ey = _vec3Normalize(_vec3Cross(edgeDir, ex));
      const t1 = _vec3Dot(_vec3Sub(hit1, axisPoint), edgeDir);
      const axisAtHit1 = _vec3Add(axisPoint, _vec3Scale(edgeDir, t1));
      const radial1 = _vec3Normalize(_vec3Sub(hit1, axisAtHit1));
      if (_vec3Dot(radial1, ey) < 0) ey = _vec3Scale(ey, -1);

      const capArc = _computeFilletChamferArcSamples(
        axisPoint,
        edgeDir,
        radius,
        ex,
        ey,
        capPlane.p0,
        capPlane.n,
        hit0,
        hit1,
        segments,
      );
      if (!capArc || capArc.length < 2) return;

      if (isA) {
        data.p0a = hit0;
        data.p1a = hit1;
        data.arcA = capArc;
        data._exactArcCurveA = _curveFromSampledPoints(capArc);
        data._useArcCurveA = true;
      } else {
        data.p0b = hit0;
        data.p1b = hit1;
        data.arcB = capArc;
        data._exactArcCurveB = _curveFromSampledPoints(capArc);
        data._useArcCurveB = true;
      }
    };

    projectSide(true);
    projectSide(false);
  }
}

function _createExactCylinderPlaneTrimCurve(
  points,
  axisStart,
  axisEnd,
  radius,
  planeOriginOverride = null,
  planeNormalOverride = null,
) {
  if (!points || points.length < 2 || !axisStart || !axisEnd || !Number.isFinite(radius) || radius <= 0) {
    return null;
  }
  if (points.length === 2) return NurbsCurve.createLine(points[0], points[1]);

  const planeOrigin = planeOriginOverride || points[0];
  const planeNormal = planeNormalOverride ? _vec3Normalize(planeNormalOverride) : _openPolylineNormal(points);
  if (!planeNormal) return null;

  let maxPlaneResidual = 0;
  for (const point of points) {
    const planeDist = Math.abs(_vec3Dot(planeNormal, _vec3Sub(point, planeOrigin)));
    if (planeDist > maxPlaneResidual) maxPlaneResidual = planeDist;
  }
  if (maxPlaneResidual > 1e-4) return null;

  const axisDir = _vec3Normalize(_vec3Sub(axisEnd, axisStart));
  if (_vec3Len(axisDir) < 1e-10) return null;

  const axisDot = _vec3Dot(planeNormal, axisDir);
  if (Math.abs(axisDot) < 1e-6) return null;

  const t = _vec3Dot(planeNormal, _vec3Sub(planeOrigin, axisStart)) / axisDot;
  const center = _vec3Add(axisStart, _vec3Scale(axisDir, t));
  const majorVector = _vec3Sub(axisDir, _vec3Scale(planeNormal, axisDot));
  const majorDir = _vec3Normalize(majorVector);
  if (_vec3Len(majorDir) < 1e-10) return null;

  const semiMajor = radius / Math.abs(axisDot);
  const semiMinor = radius;
  const baseMinorDir = _vec3Normalize(_vec3Cross(planeNormal, majorDir));
  if (_vec3Len(baseMinorDir) < 1e-10) return null;

  const evaluatePoint = (minorDir, angle) => _vec3Add(center, _vec3Add(
    _vec3Scale(majorDir, semiMajor * Math.cos(angle)),
    _vec3Scale(minorDir, semiMinor * Math.sin(angle)),
  ));

  const buildCandidate = (minorDir) => {
    const angles = [];
    let prevAngle = null;
    let maxEllipseResidual = 0;
    let maxPointResidual = 0;
    let monotonicSign = 0;
    let monotonic = true;

    for (const point of points) {
      const rel = _vec3Sub(point, center);
      const u = _vec3Dot(rel, majorDir) / semiMajor;
      const v = _vec3Dot(rel, minorDir) / semiMinor;
      maxEllipseResidual = Math.max(maxEllipseResidual, Math.abs(u * u + v * v - 1));

      let angle = Math.atan2(v, u);
      if (prevAngle != null) {
        let _angleGuard1 = 0;
        while (angle - prevAngle > Math.PI) { angle -= 2 * Math.PI; if (++_angleGuard1 > 10_000_000) throw new Error('_precomputeFilletEdge angle wrap+: exceeded 10M iterations'); }
        let _angleGuard2 = 0;
        while (angle - prevAngle < -Math.PI) { angle += 2 * Math.PI; if (++_angleGuard2 > 10_000_000) throw new Error('_precomputeFilletEdge angle wrap-: exceeded 10M iterations'); }
        const diff = angle - prevAngle;
        if (Math.abs(diff) > 1e-8) {
          const sign = diff > 0 ? 1 : -1;
          if (monotonicSign === 0) monotonicSign = sign;
          else if (sign !== monotonicSign) monotonic = false;
        }
      }
      angles.push(angle);
      prevAngle = angle;

      const fitPoint = evaluatePoint(minorDir, angle);
      maxPointResidual = Math.max(maxPointResidual, _vec3Len(_vec3Sub(fitPoint, point)));
    }

    return {
      minorDir,
      startAngle: angles[0],
      sweepAngle: angles[angles.length - 1] - angles[0],
      maxEllipseResidual,
      maxPointResidual,
      monotonic,
    };
  };

  const candidates = [
    buildCandidate(baseMinorDir),
    buildCandidate(_vec3Scale(baseMinorDir, -1)),
  ].filter((candidate) => candidate.monotonic && Math.abs(candidate.sweepAngle) > 1e-6);

  if (candidates.length === 0) return null;

  candidates.sort((a, b) =>
    (a.maxPointResidual + a.maxEllipseResidual) - (b.maxPointResidual + b.maxEllipseResidual));
  const best = candidates[0];
  if (best.maxPointResidual > 1e-4 || best.maxEllipseResidual > 1e-4) return null;

  return NurbsCurve.createEllipseArc(
    center,
    semiMajor,
    semiMinor,
    majorDir,
    best.minorDir,
    best.startAngle,
    best.sweepAngle,
  );
}

function _buildExactFilletBoundaryCurve(data, points, side, isSharedTrim) {
  if (!points || points.length < 2) return null;
  if (isSharedTrim) {
    const exactSharedCurve = side === 'A'
      ? data && data._exactSharedTrimCurveA
      : data && data._exactSharedTrimCurveB;
    if (exactSharedCurve) return exactSharedCurve.clone();
    return _createExactCylinderPlaneTrimCurve(
      points,
      data && data._exactAxisStart,
      data && data._exactAxisEnd,
      data && data._exactRadius,
      side === 'A'
        ? data && data._sharedTrimPlaneAOrigin
        : data && data._sharedTrimPlaneBOrigin,
      side === 'A'
        ? data && data._sharedTrimPlaneANormal
        : data && data._sharedTrimPlaneBNormal,
    ) || _curveFromSampledPoints(points);
  }

  const exactArc = side === 'A' ? data && data._exactArcCurveA : data && data._exactArcCurveB;
  if (exactArc) return exactArc.clone();
  return _curveFromSampledPoints(points);
}

function _filletSharedData(data) {
  const {
    _exactAxisStart: _oldAxisStart,
    _exactAxisEnd: _oldAxisEnd,
    _exactRadius: _oldExactRadius,
    isFillet: _oldIsFillet,
    isFilletFace: _oldIsFilletFace,
    ...inherited
  } = data.shared || {};
  const sharedData = {
    ...inherited,
    isFillet: true,
  };
  if (data._exactAxisStart) sharedData._exactAxisStart = { ...data._exactAxisStart };
  if (data._exactAxisEnd) sharedData._exactAxisEnd = { ...data._exactAxisEnd };
  if (data._exactRadius) sharedData._exactRadius = data._exactRadius;
  if (Array.isArray(data._rollingRail0) && Array.isArray(data._rollingRail1) && Array.isArray(data._rollingCenters)) {
    sharedData.isRollingFillet = true;
    sharedData._rollingRail0 = data._rollingRail0.map((point) => ({ ...point }));
    sharedData._rollingRail1 = data._rollingRail1.map((point) => ({ ...point }));
    sharedData._rollingCenters = data._rollingCenters.map((point) => ({ ...point }));
    if (Array.isArray(data._rollingRail0Spans)) sharedData._rollingRail0Spans = data._rollingRail0Spans.map((span) => ({ ...span }));
    if (Array.isArray(data._rollingRail1Spans)) sharedData._rollingRail1Spans = data._rollingRail1Spans.map((span) => ({ ...span }));
    if (Array.isArray(data._rollingSections)) sharedData._rollingSections = data._rollingSections.map((section) => ({ ...section }));
  }
  return sharedData;
}

function _normalizeRollingSectionSpans(sections, railLength) {
  const last = railLength - 1;
  if (!Array.isArray(sections) || sections.length === 0 || last < 1) return [];
  const normalized = [];
  for (const section of sections) {
    const startIndex = Math.max(0, Math.min(last, section.startIndex | 0));
    const endIndex = Math.max(0, Math.min(last, section.endIndex | 0));
    if (endIndex <= startIndex) continue;
    normalized.push({ ...section, startIndex, endIndex });
  }
  normalized.sort((a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex);
  return normalized;
}

function _splitRollingSpansAtSectionBreaks(spans, sections, railLength) {
  const normalizedSpans = _normalizeRollingRailSpans(spans, railLength);
  const normalizedSections = _normalizeRollingSectionSpans(sections, railLength);
  if (normalizedSections.length === 0) return normalizedSpans;

  const breaks = new Set([0, Math.max(0, railLength - 1)]);
  for (const section of normalizedSections) {
    breaks.add(section.startIndex);
    breaks.add(section.endIndex);
  }
  const sortedBreaks = [...breaks].sort((a, b) => a - b);
  const result = [];
  for (const span of normalizedSpans) {
    let startIndex = span.startIndex;
    for (const breakIndex of sortedBreaks) {
      if (breakIndex <= startIndex || breakIndex >= span.endIndex) continue;
      result.push({ ...span, startIndex, endIndex: breakIndex });
      startIndex = breakIndex;
    }
    if (span.endIndex > startIndex) result.push({ ...span, startIndex, endIndex: span.endIndex });
  }
  return result.length > 0 ? result : normalizedSpans;
}

function _normalizeRollingRailSpans(spans, railLength) {
  const last = railLength - 1;
  if (!Array.isArray(spans) || spans.length === 0 || last < 1) {
    return last >= 1 ? [{ startIndex: 0, endIndex: last }] : [];
  }
  const normalized = [];
  for (const span of spans) {
    const startIndex = Math.max(0, Math.min(last, span.startIndex | 0));
    const endIndex = Math.max(0, Math.min(last, span.endIndex | 0));
    if (endIndex <= startIndex) continue;
    normalized.push({ ...span, startIndex, endIndex });
  }
  return normalized.length > 0 ? normalized : [{ startIndex: 0, endIndex: last }];
}

function _rollingRailSpanCurve(rail, span, reverse = false) {
  if (!Array.isArray(rail) || !span) return null;
  const startIndex = Math.max(0, Math.min(rail.length - 1, span.startIndex | 0));
  const endIndex = Math.max(0, Math.min(rail.length - 1, span.endIndex | 0));
  if (endIndex <= startIndex) return null;
  const points = rail.slice(startIndex, endIndex + 1).map((point) => ({ ...point }));
  if (reverse) points.reverse();
  const curve = _curveFromSampledPoints(points);
  if (curve) _preserveControlPointSamples(curve);
  return curve;
}

function _forEachRollingRailSpanCurve(data, visitor) {
  if (!data || typeof visitor !== 'function') return;
  const rail0 = data._rollingRail0;
  const rail1 = data._rollingRail1;
  if (!Array.isArray(rail0) || !Array.isArray(rail1)) return;
  const rail0Spans = _splitRollingSpansAtSectionBreaks(data._rollingRail0Spans, data._rollingSections, rail0.length);
  const rail1Spans = _splitRollingSpansAtSectionBreaks(data._rollingRail1Spans, data._rollingSections, rail1.length);
  for (const span of rail0Spans) {
    const curve = _rollingRailSpanCurve(rail0, span, false);
    if (curve) visitor(curve, span, 0);
  }
  for (const span of rail1Spans) {
    const curve = _rollingRailSpanCurve(rail1, span, false);
    if (curve) visitor(curve, span, 1);
  }
}

function _buildExactRollingFilletFaceDesc(data) {
  const surface = data && data._exactSurface ? data._exactSurface : null;
  const rail0 = data && data._rollingRail0;
  const rail1 = data && data._rollingRail1;
  const arcA = data && data.arcA;
  const arcB = data && data.arcB;
  if (!surface || !Array.isArray(rail0) || !Array.isArray(rail1) || rail0.length !== rail1.length || rail0.length < 3) return null;
  if (!arcA || !arcB || arcA.length < 2 || arcB.length < 2) return null;

  const rail0Spans = _splitRollingSpansAtSectionBreaks(data._rollingRail0Spans, data._rollingSections, rail0.length);
  const rail1Spans = _splitRollingSpansAtSectionBreaks(data._rollingRail1Spans, data._rollingSections, rail1.length);
  const startArcCurve = _buildExactFilletBoundaryCurve(data, arcA, 'A', false);
  const endArc = _buildExactFilletBoundaryCurve(data, arcB, 'B', false);

  const vertices = [];
  const edgeCurves = [];
  const pushEdge = (start, curve, end) => {
    if (!start || !end || _dist3(start, end) < 1e-9) return;
    vertices.push({ ...start });
    edgeCurves.push(curve || NurbsCurve.createLine(start, end));
  };

  pushEdge(rail0[0], startArcCurve, rail1[0]);
  for (const span of rail1Spans) {
    pushEdge(rail1[span.startIndex], _rollingRailSpanCurve(rail1, span, false), rail1[span.endIndex]);
  }
  pushEdge(rail1[rail1.length - 1], endArc ? endArc.reversed() : null, rail0[rail0.length - 1]);
  for (let i = rail0Spans.length - 1; i >= 0; i--) {
    const span = rail0Spans[i];
    pushEdge(rail0[span.endIndex], _rollingRailSpanCurve(rail0, span, true), rail0[span.startIndex]);
  }
  if (vertices.length < 4 || edgeCurves.length !== vertices.length) return null;

  let outwardNormal = _computePolygonNormal(vertices);
  const surfaceNormal = surface.normal(
    (surface.uMin + surface.uMax) * 0.5,
    (surface.vMin + surface.vMax) * 0.5,
  );
  if (outwardNormal && surfaceNormal && _vec3Dot(outwardNormal, surfaceNormal) < 0) {
    const originalCurves = edgeCurves.slice();
    const n = vertices.length;
    vertices.reverse();
    edgeCurves.length = 0;
    for (let i = 0; i < n; i++) {
      const originalIndex = i < n - 1 ? n - 2 - i : n - 1;
      edgeCurves.push(originalCurves[originalIndex].reversed());
    }
    outwardNormal = _computePolygonNormal(vertices);
  }
  const sameSense = !(surfaceNormal && outwardNormal)
    ? true
    : _vec3Dot(outwardNormal, surfaceNormal) >= 0;

  return {
    surface,
    surfaceType: SurfaceType.BSPLINE,
    vertices,
    edgeCurves,
    sameSense,
    shared: _filletSharedData(data),
  };
}

// -----------------------------------------------------------------------
// Exact fillet face descriptors
// -----------------------------------------------------------------------

function _buildExactFilletFaceDesc(data) {
  const rollingDesc = _buildExactRollingFilletFaceDesc(data);
  if (rollingDesc) return rollingDesc;

  const surface = data && data._exactSurface ? data._exactSurface : null;
  const trimA = data && (data.sharedTrimA || data.arcA);
  const trimB = data && (data.sharedTrimB || data.arcB);
  if (!surface || !trimA || !trimB || trimA.length < 2 || trimB.length < 2) return null;

  // Junction curves override standard arc endpoints at junction ends
  const juncA = data._junctionCurveA;
  const juncB = data._junctionCurveB;
  const hasJuncA = !!(juncA && juncA.length >= 2);
  const hasJuncB = !!(juncB && juncB.length >= 2);

  // Effective arc boundaries: junction curve replaces standard arc at junctions
  // Junction curve goes from face0-trim to intPt (replacing face1-trim)
  const effArcA = hasJuncA ? juncA : trimA;
  const effArcB = hasJuncB ? juncB : trimB;

  const denseBoundary = [
    ...effArcA.map((point) => ({ ...point })),
    ...[...effArcB].reverse().map((point) => ({ ...point })),
  ];

  let vertices = [
    { ...effArcA[0] },
    { ...effArcA[effArcA.length - 1] },
    { ...effArcB[effArcB.length - 1] },
    { ...effArcB[0] },
  ];

  // Build edge curves for the fillet face.
  // Edges 0 and 2 are the arc cross-section boundaries (A and B sides).
  // Edges 1 and 3 are straight-line connections between the rails.
  const useSimpleSideEdges = data._brepSideEdges !== false;
  let edgeCurves;
  if (useSimpleSideEdges) {
    const hasSharedA = !!(data && data.sharedTrimA);
    const hasSharedB = !!(data && data.sharedTrimB);

    let edgeCurve0 = NurbsCurve.createLine(effArcA[0], effArcA[effArcA.length - 1]);
    let edgeCurve2 = NurbsCurve.createLine(effArcB[effArcB.length - 1], effArcB[0]);

    // Junction curve: use polyline from sampled intersection points
    if (hasJuncA && juncA.length > 2) {
      const curve = _curveFromSampledPoints(juncA);
      if (curve) edgeCurve0 = curve;
    } else if (hasSharedA && trimA.length > 2) {
      const curve = _buildExactFilletBoundaryCurve(data, trimA, 'A', true);
      if (curve) edgeCurve0 = curve;
    } else if (data._useArcCurveA && data._exactArcCurveA) {
      // 3-edge corner: use the arc polyline so the fillet strip and
      // sphere corner patch share the same TopoEdge curve.
      edgeCurve0 = data._exactArcCurveA.clone();
    }
    if (hasJuncB && juncB.length > 2) {
      const reversed = [...juncB].reverse();
      const curve = _curveFromSampledPoints(reversed);
      if (curve) edgeCurve2 = curve;
    } else if (hasSharedB && trimB.length > 2) {
      const reversedTrimB = [...trimB].reverse();
      const curve = _buildExactFilletBoundaryCurve(data, reversedTrimB, 'B', true);
      if (curve) edgeCurve2 = curve;
    } else if (data._useArcCurveB && data._exactArcCurveB) {
      // 3-edge corner: use the reversed arc polyline so the fillet strip
      // and sphere corner patch share the same TopoEdge curve.
      edgeCurve2 = data._exactArcCurveB.reversed();
    }

    edgeCurves = [
      edgeCurve0,
      NurbsCurve.createLine(effArcA[effArcA.length - 1], effArcB[effArcB.length - 1]),
      edgeCurve2,
      NurbsCurve.createLine(effArcB[0], effArcA[0]),
    ];
  } else {
    edgeCurves = [
      _buildExactFilletBoundaryCurve(data, trimA, 'A', !!(data && data.sharedTrimA)),
      NurbsCurve.createLine(trimA[trimA.length - 1], trimB[trimB.length - 1]),
      _buildExactFilletBoundaryCurve(data, trimB, 'B', !!(data && data.sharedTrimB)),
      NurbsCurve.createLine(trimB[0], trimA[0]),
    ];
    if (!edgeCurves[0] || !edgeCurves[2]) return null;
    edgeCurves[2] = edgeCurves[2].reversed();
  }

  let outwardNormal = null;
  if (trimA.length >= 2 && trimB.length >= 2) {
    outwardNormal = _computePolygonNormal([
      { ...trimA[0] },
      { ...trimA[1] },
      { ...trimB[1] },
      { ...trimB[0] },
    ]);
  }
  const surfaceNormal = surface.normal(
    (surface.uMin + surface.uMax) * 0.5,
    (surface.vMin + surface.vMax) * 0.5,
  );
  const loopNormal = _computePolygonNormal(denseBoundary);
  if (outwardNormal && loopNormal && _vec3Dot(loopNormal, outwardNormal) < 0) {
    vertices = [...vertices].reverse();
    edgeCurves = [...edgeCurves].reverse().map((curve) => curve.reversed());
  }
  const sameSense = !(surfaceNormal && outwardNormal)
    ? true
    : _vec3Dot(outwardNormal, surfaceNormal) >= 0;

  return {
    surface,
    surfaceType: SurfaceType.BSPLINE,
    vertices,
    edgeCurves,
    sameSense,
    shared: _filletSharedData(data),
  };
}

// -----------------------------------------------------------------------
// Corner face descriptors
// -----------------------------------------------------------------------

function _buildExactCornerPatchFaceDesc(cornerGroup) {
  if (!cornerGroup || cornerGroup.length === 0) return null;
  const patch = cornerGroup[0]._cornerPatch;
  if (!patch) return null;

  let surface = null;
  try {
    surface = NurbsSurface.createCornerBlendPatch(
      patch.top0, patch.top1,
      patch.side0Mid, patch.side1Mid,
      patch.apex, patch.centerPoint,
      patch.topMid,
    );
  } catch (_) {
    surface = null;
  }

  const hasTopMid = patch.topMid &&
    _edgeVKey(patch.topMid) !== _edgeVKey(patch.top0) &&
    _edgeVKey(patch.topMid) !== _edgeVKey(patch.top1);

  let vertices, edgeCurves;
  if (hasTopMid) {
    vertices = [
      { ...patch.top0 }, { ...patch.topMid },
      { ...patch.top1 }, { ...patch.apex },
    ];
    edgeCurves = [
      NurbsCurve.createLine(patch.top0, patch.topMid),
      NurbsCurve.createLine(patch.topMid, patch.top1),
      NurbsCurve.createLine(patch.top1, patch.apex),
      NurbsCurve.createLine(patch.apex, patch.top0),
    ];
  } else {
    vertices = [
      { ...patch.top0 }, { ...patch.top1 }, { ...patch.apex },
    ];
    edgeCurves = [
      NurbsCurve.createLine(patch.top0, patch.top1),
      NurbsCurve.createLine(patch.top1, patch.apex),
      NurbsCurve.createLine(patch.apex, patch.top0),
    ];
  }

  const polyNormal = _computePolygonNormal(vertices);
  let sameSense = true;
  if (surface && polyNormal) {
    const surfNormal = surface.normal(
      (surface.uMin + surface.uMax) * 0.5,
      (surface.vMin + surface.vMax) * 0.5,
    );
    if (surfNormal) sameSense = _vec3Dot(polyNormal, surfNormal) >= 0;
  }

  return {
    surface,
    surfaceType: surface ? SurfaceType.BSPLINE : SurfaceType.PLANE,
    vertices,
    edgeCurves,
    sameSense,
    shared: cornerGroup[0].shared ? { ...cornerGroup[0].shared, isCorner: true } : { isCorner: true },
  };
}

function _buildExactTrihedronFaceDesc(cornerGroup) {
  if (!cornerGroup || cornerGroup.length === 0) return null;
  const triVerts = cornerGroup[0]._triVerts;
  if (!triVerts || triVerts.length !== 3) return null;

  const sphereCenter = cornerGroup.find(f => f._sphereCenter)?._sphereCenter;
  const sphereRadius = cornerGroup.find(f => f._sphereRadius > 0)?._sphereRadius || 0;

  let surface = null;
  if (sphereCenter && sphereRadius > 1e-10) {
    try {
      surface = NurbsSurface.createSphericalPatch(
        sphereCenter, sphereRadius, triVerts[0], triVerts[1], triVerts[2],
      );
    } catch (_) {
      surface = null;
    }
  }

  const vertices = triVerts.map(v => ({ ...v }));

  // Build edge curves.  If arc polylines are available (from the fillet
  // strip arcs), use them so that the sphere patch shares exact edge
  // curves with the adjacent fillet faces.  Otherwise fall back to lines.
  const arcCurves = cornerGroup.find(f => f._arcCurves)?._arcCurves || [];
  const edgeCurves = [];
  for (let i = 0; i < 3; i++) {
    const vA = triVerts[i];
    const vB = triVerts[(i + 1) % 3];
    const vAk = _edgeVKey(vA);
    const vBk = _edgeVKey(vB);

    // Find an arc curve that connects vA → vB (or vB → vA, reversed)
    let matched = null;
    for (const ac of arcCurves) {
      if (ac.startVK === vAk && ac.endVK === vBk) {
        matched = ac.curve && typeof ac.curve.clone === 'function'
          ? ac.curve.clone()
          : _curveFromSampledPoints(ac.points);
        break;
      } else if (ac.startVK === vBk && ac.endVK === vAk) {
        const reversed = [...ac.points].reverse();
        matched = ac.curve && typeof ac.curve.reversed === 'function'
          ? ac.curve.reversed()
          : _curveFromSampledPoints(reversed);
        break;
      }
    }
    edgeCurves.push(matched || NurbsCurve.createLine(vA, vB));
  }

  const polyNormal = _computePolygonNormal(vertices);
  let sameSense = true;
  if (surface && polyNormal) {
    const surfNormal = surface.normal(
      (surface.uMin + surface.uMax) * 0.5,
      (surface.vMin + surface.vMax) * 0.5,
    );
    if (surfNormal) sameSense = _vec3Dot(polyNormal, surfNormal) >= 0;
  }

  const sharedData = cornerGroup[0].shared ? { ...cornerGroup[0].shared, isCorner: true } : { isCorner: true };
  if (sphereCenter) sharedData._sphereCenter = { ...sphereCenter };
  if (sphereRadius > 0) sharedData._sphereRadius = sphereRadius;

  // Attach analytic sphere surfaceInfo so the tessellator's sphere fast path
  // can triangulate this 3-edge corner patch by slerping rings from the
  // centroid toward the boundary (instead of relying on the Cobb NURBS UV
  // map, whose pole-collapse at the u=0 edge causes CDT to emit chord
  // triangles that skip interior boundary samples).
  const surfaceInfo = (sphereCenter && sphereRadius > 0)
    ? { type: 'sphere', origin: { ...sphereCenter }, radius: sphereRadius }
    : null;

  return {
    surface,
    surfaceType: surface ? SurfaceType.SPHERE : SurfaceType.PLANE,
    surfaceInfo,
    vertices,
    edgeCurves,
    sameSense,
    shared: sharedData,
  };
}

function _buildExactCornerFaceDescs(faces) {
  const descs = [];

  // Group two-edge corner patches by _cornerPatchKey
  const patchGroups = new Map();
  // Group trihedron corners by sorted _triVerts key
  const trihedronGroups = new Map();
  // Collect standalone corner faces with neither metadata
  const standaloneFaces = [];

  for (const face of faces) {
    if (!face || !face.isCorner) continue;

    if (face._cornerPatchKey) {
      if (!patchGroups.has(face._cornerPatchKey)) {
        patchGroups.set(face._cornerPatchKey, []);
      }
      patchGroups.get(face._cornerPatchKey).push(face);
    } else if (face._triVerts && face._triVerts.length === 3) {
      const key = face._triVerts.map(v => _edgeVKey(v)).sort().join('|');
      if (!trihedronGroups.has(key)) trihedronGroups.set(key, []);
      trihedronGroups.get(key).push(face);
    } else {
      standaloneFaces.push(face);
    }
  }

  // Build face descs for two-edge corner patches
  for (const [, group] of patchGroups) {
    const desc = _buildExactCornerPatchFaceDesc(group);
    if (desc) descs.push(desc);
  }

  // Build face descs for trihedron corners
  for (const [, group] of trihedronGroups) {
    const desc = _buildExactTrihedronFaceDesc(group);
    if (desc) descs.push(desc);
  }

  // Build planar face descs for standalone corners
  for (const face of standaloneFaces) {
    if (!face.vertices || face.vertices.length < 3) continue;
    const desc = _buildPlanarFaceDesc(face);
    if (desc) descs.push(desc);
  }

  return descs;
}

function _collectOpenTopoEdgesForCap(body) {
  const edgeRefs = new Map();
  for (const shell of body.shells || []) {
    for (const face of shell.faces || []) {
      for (const loop of face.allLoops()) {
        for (const coedge of loop.coedges) {
          const edge = coedge.edge;
          if (!edgeRefs.has(edge.id)) {
            edgeRefs.set(edge.id, {
              edge,
              curve: coedge.curve || edge.curve || null,
              count: 0,
              faces: [],
            });
          }
          const ref = edgeRefs.get(edge.id);
          ref.count++;
          ref.faces.push(face);
        }
      }
    }
  }

  const out = [];
  for (const ref of edgeRefs.values()) {
    if (ref.count >= 2) continue;
    const a = ref.edge.startVertex?.point;
    const b = ref.edge.endVertex?.point;
    if (!a || !b) continue;
    out.push({
      a,
      b,
      aKey: _edgeVKey(a),
      bKey: _edgeVKey(b),
      curve: ref.curve,
      faces: ref.faces,
    });
  }
  return out;
}

function _extractClosedTopoLoopsForCap(openEdges) {
  const remaining = [...openEdges];
  const loops = [];

  while (remaining.length > 0) {
    const start = remaining.shift();
    const loop = [{ ...start }];
    const startKey = start.aKey;
    let currentEndKey = start.bKey;
    let safety = remaining.length + 1;

    while (currentEndKey !== startKey && safety-- > 0) {
      let foundIdx = -1;
      let flip = false;
      for (let i = 0; i < remaining.length; i++) {
        if (remaining[i].aKey === currentEndKey) { foundIdx = i; break; }
        if (remaining[i].bKey === currentEndKey) { foundIdx = i; flip = true; break; }
      }
      if (foundIdx < 0) break;
      const next = remaining.splice(foundIdx, 1)[0];
      if (flip) {
        loop.push({
          a: next.b,
          b: next.a,
          aKey: next.bKey,
          bKey: next.aKey,
          curve: next.curve ? next.curve.reversed() : null,
          faces: next.faces,
        });
        currentEndKey = next.aKey;
      } else {
        loop.push({ ...next });
        currentEndKey = next.bKey;
      }
    }

    if (currentEndKey === startKey && loop.length >= 3) loops.push(loop);
  }

  return loops;
}

function _buildMixedFilletCornerCapDesc(loop) {
  if (!loop || loop.length !== 3) return null;
  const adjacentFaces = loop.flatMap(seg => seg.faces || []);
  const hasChamfer = adjacentFaces.some(face => face.shared?.isChamfer);
  const filletCount = adjacentFaces.filter(face => face.shared?.isFillet).length;
  if (!hasChamfer || filletCount < 2) return null;

  const vertices = loop.map(seg => ({ ...seg.a }));
  const edgeCurves = loop.map(seg =>
    seg.curve ? seg.curve.clone() : NurbsCurve.createLine(seg.a, seg.b)
  );
  const uDir = _vec3Sub(vertices[1], vertices[0]);
  const vDir = _vec3Sub(vertices[2], vertices[0]);
  if (_vec3Len(_vec3Cross(uDir, vDir)) < 1e-12) return null;
  const surface = NurbsSurface.createPlane(vertices[0], uDir, vDir);

  return {
    surface,
    surfaceType: SurfaceType.PLANE,
    vertices,
    edgeCurves,
    sameSense: false,
    shared: { isCorner: true, isFillet: true, isMixedFilletCorner: true, isApproxCornerCap: true },
  };
}

function _capMixedFilletOpenLoops(faceDescs) {
  let body = buildTopoBody(faceDescs);
  let boundaryEdges = countTopoBodyBoundaryEdges(body);
  if (boundaryEdges === 0) return body;

  const openEdges = _collectOpenTopoEdgesForCap(body);
  const loops = _extractClosedTopoLoopsForCap(openEdges);
  let appended = 0;
  for (const loop of loops) {
    const desc = _buildMixedFilletCornerCapDesc(loop);
    if (!desc) continue;
    faceDescs.push(desc);
    appended++;
  }
  if (appended === 0) return body;

  body = buildTopoBody(faceDescs);
  boundaryEdges = countTopoBodyBoundaryEdges(body);
  if (boundaryEdges !== 0) {
    _debugBRepFillet('mixed-corner-cap-incomplete', { appended, boundaryEdges });
  } else {
    _debugBRepFillet('mixed-corner-cap', { appended });
  }
  return body;
}

// -----------------------------------------------------------------------
// Reconstruct face description from original TopoFace
// -----------------------------------------------------------------------

/**
 * Reconstruct a face description from an original TopoFace, applying
 * vertex substitutions as needed.
 *
 * For non-planar BRep faces (bspline, cylinder, etc.) from previous
 * fillet/chamfer operations, this preserves the exact surface and edge
 * curves instead of degrading them to planar polygon approximations.
 *
 * @param {Object} topoFace - Original TopoFace from the input TopoBody
 * @param {Map<string, {x,y,z}[]>} vertexReplacements - Map of vertexKey → ordered replacement vertices
 * @returns {Object|null} Face description for buildTopoBody
 */
function _buildOriginalFaceDesc(topoFace, vertexReplacements = null) {
  if (!topoFace || !topoFace.outerLoop) return null;

  const coedges = topoFace.outerLoop.coedges;
  if (!coedges || coedges.length < 3) return null;

  // Extract loop vertices in winding order
  const origLoopVerts = [];
  for (const ce of coedges) {
    const startPt = ce.sameSense !== false
      ? ce.edge.startVertex.point
      : ce.edge.endVertex.point;
    origLoopVerts.push({ ...startPt });
  }

  // Apply vertex replacements if any
  if (vertexReplacements && vertexReplacements.size > 0) {
    const newVertices = [];
    const n = origLoopVerts.length;

    for (let i = 0; i < n; i++) {
      const vk = _edgeVKey(origLoopVerts[i]);
      const replacements = vertexReplacements.get(vk);

      if (replacements && replacements.length > 0) {
        // This vertex needs to be replaced/split
        for (const rpt of replacements) {
          newVertices.push({ ...rpt });
        }
      } else {
        newVertices.push({ ...origLoopVerts[i] });
      }
    }

    // Build edge curves — all straight lines for the modified boundary
    const edgeCurves = [];
    for (let i = 0; i < newVertices.length; i++) {
      const next = newVertices[(i + 1) % newVertices.length];
      edgeCurves.push(NurbsCurve.createLine(newVertices[i], next));
    }

    return {
      surface: topoFace.surface || null,
      surfaceType: topoFace.surfaceType || SurfaceType.PLANE,
      surfaceInfo: topoFace.surfaceInfo ? { ...topoFace.surfaceInfo } : null,
      fusedGroupId: topoFace.fusedGroupId || null,
      vertices: newVertices,
      edgeCurves,
      sameSense: topoFace.sameSense,
      shared: topoFace.shared ? { ...topoFace.shared } : null,
      stableHash: topoFace.stableHash || null,
    };
  }

  // No replacements — reconstruct from original edges
  const edgeCurves = [];
  for (const ce of coedges) {
    const curve = ce.edge.curve;
    if (ce.sameSense === false && curve && curve.reversed) {
      edgeCurves.push(curve.reversed());
    } else {
      edgeCurves.push(curve || null);
    }
  }

  return {
    surface: topoFace.surface || null,
    surfaceType: topoFace.surfaceType || SurfaceType.PLANE,
    surfaceInfo: topoFace.surfaceInfo ? { ...topoFace.surfaceInfo } : null,
    fusedGroupId: topoFace.fusedGroupId || null,
    vertices: origLoopVerts,
    edgeCurves,
    sameSense: topoFace.sameSense,
    shared: topoFace.shared ? { ...topoFace.shared } : null,
    stableHash: topoFace.stableHash || null,
  };
}

function _rollingTrimForSourceFace(source, faceIndex, atA) {
  if (!source) return null;
  if (source.fi0 === faceIndex) return atA ? source.p0a : source.p0b;
  if (source.fi1 === faceIndex) return atA ? source.p1a : source.p1b;
  return null;
}

function _rollingSourceForOrientedCoedge(source, faceIndex, start, end) {
  if (!source || (source.fi0 !== faceIndex && source.fi1 !== faceIndex)) return null;
  const startKey = _edgeVKey(start);
  const endKey = _edgeVKey(end);
  const edgeAKey = _edgeVKey(source.edgeA);
  const edgeBKey = _edgeVKey(source.edgeB);
  if (startKey === edgeAKey && endKey === edgeBKey) {
    return {
      source,
      start: _rollingTrimForSourceFace(source, faceIndex, true),
      end: _rollingTrimForSourceFace(source, faceIndex, false),
    };
  }
  if (startKey === edgeBKey && endKey === edgeAKey) {
    return {
      source,
      start: _rollingTrimForSourceFace(source, faceIndex, false),
      end: _rollingTrimForSourceFace(source, faceIndex, true),
    };
  }
  return null;
}

function _buildRollingAdjacentPlanarFaceDesc(face, faceIndex, topoFace, edgeDataList) {
  if (!face || !topoFace || !topoFace.outerLoop || topoFace.surfaceType !== SurfaceType.PLANE) return null;
  const rollingData = (edgeDataList || []).find((data) => data && Array.isArray(data._trimSourceData) && Array.isArray(data._rollingRail0));
  if (!rollingData) return null;
  const sources = rollingData._trimSourceData.filter((source) => source && (source.fi0 === faceIndex || source.fi1 === faceIndex));
  if (sources.length === 0) return null;

  const coedges = topoFace.outerLoop.coedges || [];
  if (coedges.length < 3) return null;
  const edges = [];
  let consumed = 0;
  for (const coedge of coedges) {
    const start = coedge.sameSense !== false ? coedge.edge.startVertex.point : coedge.edge.endVertex.point;
    const end = coedge.sameSense !== false ? coedge.edge.endVertex.point : coedge.edge.startVertex.point;
    const match = sources.map((source) => _rollingSourceForOrientedCoedge(source, faceIndex, start, end)).find(Boolean) || null;
    if (match && match.start && match.end && _dist3(match.start, match.end) > 1e-9) consumed++;
    edges.push({ start, end, curve: coedge.edge.curve || null, match });
  }
  if (consumed === 0) return null;

  const vertices = [];
  const edgeCurves = [];
  const edgeCount = edges.length;
  for (let i = 0; i < edgeCount; i++) {
    const edge = edges[i];
    const previous = edges[(i - 1 + edgeCount) % edgeCount];
    const next = edges[(i + 1) % edgeCount];

    let start = edge.start;
    let end = edge.end;
    let curve = edge.curve;
    if (edge.match && edge.match.start && edge.match.end) {
      start = edge.match.start;
      end = edge.match.end;
      curve = NurbsCurve.createLine(start, end);
    } else {
      if (previous.match && previous.match.end && _edgeVKey(previous.end) === _edgeVKey(edge.start)) start = previous.match.end;
      if (next.match && next.match.start && _edgeVKey(next.start) === _edgeVKey(edge.end)) end = next.match.start;
      if (_edgeVKey(start) !== _edgeVKey(edge.start) || _edgeVKey(end) !== _edgeVKey(edge.end)) {
        curve = NurbsCurve.createLine(start, end);
      } else if (curve && coedgeCurveNeedsReverse(edges[i], coedges[i])) {
        curve = curve.reversed();
      }
    }

    if (!start || !end || _dist3(start, end) < 1e-9) continue;
    vertices.push({ ...start });
    edgeCurves.push(curve || NurbsCurve.createLine(start, end));
  }

  if (vertices.length < 3 || vertices.length !== edgeCurves.length) return null;
  return {
    surface: topoFace.surface || null,
    surfaceType: SurfaceType.PLANE,
    surfaceInfo: topoFace.surfaceInfo ? { ...topoFace.surfaceInfo } : null,
    fusedGroupId: topoFace.fusedGroupId || null,
    vertices,
    edgeCurves,
    sameSense: topoFace.sameSense,
    shared: face.shared ? { ...face.shared } : (topoFace.shared ? { ...topoFace.shared } : null),
    stableHash: topoFace.stableHash || face.stableHash || null,
  };
}

function coedgeCurveNeedsReverse(edgeEntry, coedge) {
  if (!edgeEntry || !coedge || !coedge.edge || !coedge.edge.curve || typeof coedge.edge.curve.reversed !== 'function') return false;
  return coedge.sameSense === false;
}

function _distancePointToSegment(point, start, end) {
  const segment = _vec3Sub(end, start);
  const lengthSq = _vec3Dot(segment, segment);
  if (lengthSq < 1e-20) return _dist3(point, start);
  const t = Math.max(0, Math.min(1, _vec3Dot(_vec3Sub(point, start), segment) / lengthSq));
  const closest = {
    x: start.x + segment.x * t,
    y: start.y + segment.y * t,
    z: start.z + segment.z * t,
  };
  return _dist3(point, closest);
}

function _distancePointToCurveSamples(point, curve) {
  if (!curve || !Array.isArray(curve.controlPoints) || curve.controlPoints.length < 2) return Infinity;
  let samples = null;
  if (curve.degree === 1 && curve.controlPoints.length > 2) {
    samples = curve.controlPoints;
  } else if (typeof curve.evaluate === 'function') {
    const uMin = Number.isFinite(curve.uMin) ? curve.uMin : 0;
    const uMax = Number.isFinite(curve.uMax) ? curve.uMax : 1;
    samples = [];
    for (let i = 0; i <= 32; i++) {
      const t = i / 32;
      samples.push(curve.evaluate(uMin + (uMax - uMin) * t));
    }
  } else {
    samples = curve.controlPoints;
  }
  let best = Infinity;
  for (let i = 0; i < samples.length - 1; i++) {
    best = Math.min(best, _distancePointToSegment(point, samples[i], samples[i + 1]));
  }
  return best;
}

function _runVerticesFollowCurve(vertices, start, runLen, curve, tol = 1e-4) {
  if (!Array.isArray(vertices) || !curve) return false;
  const n = vertices.length;
  for (let j = 1; j < runLen; j++) {
    const vertex = vertices[(start + j) % n];
    if (_distancePointToCurveSamples(vertex, curve) > tol) return false;
  }
  return true;
}

// -----------------------------------------------------------------------
// Cross-face arc curve coordination
// -----------------------------------------------------------------------

/**
 * Replace straight-line edge curves with arc polyline curves on face
 * descriptors whose edge endpoints match a fillet arc.
 *
 * Both the fillet face and its adjacent planar face must carry the same
 * arc curve so that `buildTopoBody` deduplicates them into a single
 * shared `TopoEdge`.  The `EdgeSampler` then produces arc-faithful
 * boundary samples on both faces, preventing T-junctions and the
 * "balloon" boundary artefact caused by flat straight-line edges.
 *
 * Only arcs that border exclusively PLANAR adjacent faces (fi0/fi1) are
 * included.  Arcs where an adjacent face is non-planar (e.g., from a
 * previous fillet) are excluded because both the fillet face and the
 * non-planar face would produce incompatible CDT triangulations.
 *
 * @param {Array<Object>} faceDescs - Face descriptors (mutated in place)
 * @param {Array<Object>} edgeDataList - Precomputed fillet edge data
 * @param {Array<Object>} faces - Trimmed mesh faces
 * @param {Map<number,Object>} origTopoFaces - Map topoFaceId → original TopoFace
 */
function _replaceEdgesWithArcCurves(faceDescs, edgeDataList, faces, origTopoFaces) {
  // Build lookup: unordered vertex-key pair → canonical (forward) arc curve.
  // Always provide the same forward curve for both directions, since
  // buildTopoBody's getOrCreateEdge deduplicates edges by comparing curve
  // midpoints — using a single canonical direction ensures both the fillet
  // face and the adjacent planar face pass the check.
  // (Reversed curves evaluate differently at parameter 0.5 for polylines
  // whose knot range isn't [0,1], causing false negatives.)
  const arcCurveLookup = new Map();
  const rollingRailEdgeKeys = new Set();

  const registerCurve = (curve, options = null) => {
    if (!curve || !Array.isArray(curve.controlPoints) || curve.controlPoints.length < 2) return;
    if (curve.degree === 1 && curve.controlPoints.length <= 2) return;
    const sk = _edgeVKey(curve.controlPoints[0]);
    const ek = _edgeVKey(curve.controlPoints[curve.controlPoints.length - 1]);
    if (sk === ek) return;
    const unordered = sk < ek ? `${sk}|${ek}` : `${ek}|${sk}`;
    if (!arcCurveLookup.has(unordered)) arcCurveLookup.set(unordered, curve);
    if (options?.rollingRail) rollingRailEdgeKeys.add(unordered);
  };

  for (const data of edgeDataList) {
    // Check if either adjacent face is non-planar (e.g. previous fillet surface)
    const face0 = faces[data.fi0];
    const face1 = faces[data.fi1];
    const orig0 = face0?.topoFaceId !== undefined ? origTopoFaces.get(face0.topoFaceId) : null;
    const orig1 = face1?.topoFaceId !== undefined ? origTopoFaces.get(face1.topoFaceId) : null;
    const hasNonPlanar = (orig0 && orig0.surfaceType !== 'plane') ||
                          (orig1 && orig1.surfaceType !== 'plane');
    const isRollingData = !!(Array.isArray(data._rollingRail0) && Array.isArray(data._rollingRail1));
    if (hasNonPlanar && !isRollingData) continue;

    // Add non-shared arc cross-section curves
    if (!data.sharedTrimA) registerCurve(data._exactArcCurveA);
    if (!data.sharedTrimB) registerCurve(data._exactArcCurveB);
    if (isRollingData) {
      registerCurve(data._exactRail0Curve, { rollingRail: true });
      registerCurve(data._exactRail1Curve, { rollingRail: true });
      _forEachRollingRailSpanCurve(data, (curve) => registerCurve(curve, { rollingRail: true }));
    }
  }

  // Also add non-trivial edge curves from the original TopoBody.  These
  // preserve arc curves from previous fillet operations so that planar faces
  // referencing inherited arc-sample intermediates can be consolidated back
  // into a single arc-curve edge matching the preserved non-planar face's edge.
  // This includes both degree-1 polyline arcs (from previous fillets) and
  // higher-degree NURBS arc curves (from cylinder/cone faces etc.) so that
  // rebuilt planar faces can consolidate sampled arc points back into the
  // original curve, maintaining edge sharing with non-planar faces.
  if (origTopoFaces && origTopoFaces.size > 0) {
    // Gather edge curves from all origTopoFaces
    const seen = new Set();
    for (const [, topoFace] of origTopoFaces) {
      if (!topoFace.outerLoop) continue;
      for (const coedge of topoFace.outerLoop.coedges) {
        const e = coedge.edge;
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        if (!e.curve) continue;
        // Include degree-1 polyline arcs (>2 control points) and
        // higher-degree NURBS curves (arcs from cylinders, cones, etc.)
        registerCurve(e.curve);
      }
    }
  }

  if (arcCurveLookup.size === 0) return;

  // Build a count of how many non-planar face descriptors reference each arc
  // vertex-pair key.  Arcs shared between TWO non-planar cylinder faces
  // (e.g. a new fillet face and a previous fillet's trimmed face) would cause
  // CDT T-junctions because both surfaces produce incompatible internal
  // triangulations.  An arc referenced by exactly ONE non-planar face (the
  // fillet face itself) is fine — the other face sharing the edge is planar.
  // Sphere faces are excluded from this count because they don't cause
  // T-junction issues with planar faces sharing their boundary arcs.
  const nonPlanarEdgeKeys = new Set();
  {
    const counts = new Map();
    for (const desc of faceDescs) {
      if (!desc.vertices || !desc.edgeCurves) continue;
      const isNonPlanar = desc.surfaceType && desc.surfaceType !== 'plane'
        && desc.surfaceType !== 'sphere';
      if (!isNonPlanar) continue;
      const nv = desc.vertices.length;
      for (let i = 0; i < nv; i++) {
        const k1 = _edgeVKey(desc.vertices[i]);
        const k2 = _edgeVKey(desc.vertices[(i + 1) % nv]);
        const unordered = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
        if (arcCurveLookup.has(unordered)) {
          counts.set(unordered, (counts.get(unordered) || 0) + 1);
        }
      }
    }
    for (const [k, count] of counts) {
      if (count >= 2 && !rollingRailEdgeKeys.has(k)) nonPlanarEdgeKeys.add(k);
    }
  }

  // Replace matching straight-line edge curves with arc curves.
  // Two modes of operation:
  //
  // 1. **Single-edge replacement**: A straight-line edge (2 control points)
  //    whose endpoints match an arc lookup entry is replaced directly.
  //
  // 2. **Sequence consolidation**: Multiple consecutive straight-line edges
  //    whose combined span (first vertex → last vertex) matches an arc lookup
  //    entry are collapsed into a single arc curve edge, removing intermediate
  //    vertices.  This handles faces that inherited intermediate arc sample
  //    points from a previous fillet operation.
  for (const desc of faceDescs) {
    if (!desc.vertices || !desc.edgeCurves) continue;

    // --- Pass 1: single-edge replacement ---
    const n = desc.vertices.length;
    for (let i = 0; i < n; i++) {
      const curve = desc.edgeCurves[i];
      if (!curve || curve.degree !== 1 || !curve.controlPoints || curve.controlPoints.length !== 2) continue;
      const v1 = desc.vertices[i];
      const v2 = desc.vertices[(i + 1) % n];
      const k1 = _edgeVKey(v1);
      const k2 = _edgeVKey(v2);
      const unordered = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
      const arcCurve = arcCurveLookup.get(unordered);
      if (arcCurve && !nonPlanarEdgeKeys.has(unordered)) {
        const arcStart = _edgeVKey(arcCurve.controlPoints[0]);
        desc.edgeCurves[i] = arcStart === k1 ? arcCurve.clone() : arcCurve.reversed();
        if (arcCurve._preserveControlPointSamples) _preserveControlPointSamples(desc.edgeCurves[i]);
      }
    }

    // --- Pass 2: sequence consolidation ---
    // Look for runs of consecutive straight-line edges whose overall span
    // matches an arc endpoint pair.  Only consider sequences of length ≥ 2
    // to avoid duplicating Pass 1 work.
    if (desc.vertices.length <= 3) continue; // can't remove vertices from a triangle
    let changed = true;
    let _consolidateGuard = 0;
    while (changed) {
      if (++_consolidateGuard > 10_000_000) throw new Error('_replaceEdgesWithArcCurves: consolidation exceeded 10M iterations');
      changed = false;
      const m = desc.vertices.length;
      for (let start = 0; start < m; start++) {
        // Try longer runs first (greedy)
        for (let runLen = Math.min(m - 3, m - 1); runLen >= 2; runLen--) {
          // Check that every edge in [start, start+runLen-1] is a straight line
          let allLines = true;
          for (let j = 0; j < runLen; j++) {
            const idx = (start + j) % m;
            const c = desc.edgeCurves[idx];
            if (!c || c.degree !== 1 || !c.controlPoints || c.controlPoints.length !== 2) {
              allLines = false;
              break;
            }
          }
          if (!allLines) continue;

          const firstVert = desc.vertices[start];
          const lastVert = desc.vertices[(start + runLen) % m];
          const fk = _edgeVKey(firstVert);
          const lk = _edgeVKey(lastVert);
          if (fk === lk) continue;
          const unordered = fk < lk ? `${fk}|${lk}` : `${lk}|${fk}`;
          const arcCurve = arcCurveLookup.get(unordered);
          if (!arcCurve || nonPlanarEdgeKeys.has(unordered)) continue;
          if (!_runVerticesFollowCurve(desc.vertices, start, runLen, arcCurve)) continue;

          // Found a match — consolidate: remove intermediate vertices and edges
          const arcStart = _edgeVKey(arcCurve.controlPoints[0]);
          const replacement = arcStart === fk ? arcCurve.clone() : arcCurve.reversed();
          if (arcCurve._preserveControlPointSamples) _preserveControlPointSamples(replacement);

          // Build new arrays without the intermediate vertices
          const newVerts = [];
          const newCurves = [];
          for (let j = 0; j < m; j++) {
            const isIntermediate = (j > start && j < start + runLen) ||
              (start + runLen > m && (j > start || j < (start + runLen) % m));
            if (isIntermediate) continue;
            newVerts.push(desc.vertices[j]);
            if (j === start) {
              newCurves.push(replacement);
            } else {
              const isSkippedCurve = (j > start && j <= start + runLen - 1) ||
                (start + runLen > m && (j > start || j <= (start + runLen - 1) % m));
              if (!isSkippedCurve) {
                newCurves.push(desc.edgeCurves[j]);
              }
            }
          }

          if (newVerts.length >= 3) {
            desc.vertices = newVerts;
            desc.edgeCurves = newCurves;
            changed = true;
            break; // restart scanning with updated arrays
          }
        }
        if (changed) break;
      }
    }
  }
}

// -----------------------------------------------------------------------
// Sequential fillet junction extension
// -----------------------------------------------------------------------

/**
 * Compute the 3D intersection curve between two fillet cylinders.
 *
 * The previous fillet has axis `prevAxisDir` and radius R1.
 * The new fillet has axis `newAxisDir` and radius R2.
 * The intersection is parameterized along d3 = cross(prevAxisDir, newAxisDir).
 *
 * @param {Object} prevFillet - { axisStart, axisEnd, radius, topoFaceId }
 * @param {Object} newData   - Current fillet edge data
 * @param {Array<Object>} faces
 * @param {number} radius    - New fillet radius
 * @param {boolean} isA      - Which end of the new fillet edge
 * @param {Object} origTopoBody
 * @param {number} segments  - Number of curve samples
 * @returns {{ curve: Array<{x,y,z}>, intPt: {x,y,z} } | null}
 */
function _computeFilletFilletIntersectionCurve(
  prevFillet, newData, faces, radius, isA, origTopoBody, segments = 16,
) {
  if (!prevFillet || !prevFillet.axisStart || !prevFillet.axisEnd || !prevFillet.radius) return null;
  if (!origTopoBody || !origTopoBody.shells) return null;

  const edgeVertex = isA ? newData.edgeA : newData.edgeB;
  const R1 = prevFillet.radius;
  const R2 = radius;

  // Previous fillet axis direction
  const prevAxisDir = _vec3Normalize(_vec3Sub(prevFillet.axisEnd, prevFillet.axisStart));

  // Find previous fillet TopoFace
  let prevTopoFace = null;
  for (const shell of origTopoBody.shells) {
    for (const face of (shell.faces || [])) {
      if (face.id === prevFillet.topoFaceId) {
        prevTopoFace = face;
        break;
      }
    }
    if (prevTopoFace) break;
  }
  if (!prevTopoFace || !prevTopoFace.outerLoop) return null;

  // Extract vertices of previous fillet face
  const prevVerts = prevTopoFace.outerLoop.coedges.map(ce =>
    ce.sameSense !== false ? ce.edge.startVertex.point : ce.edge.endVertex.point);

  // Find vertices at the junction cross-section (same axis parameter as edgeVertex)
  const evProj = _vec3Dot(_vec3Sub(edgeVertex, prevFillet.axisStart), prevAxisDir);
  const junctionVerts = prevVerts.filter(v => {
    const proj = _vec3Dot(_vec3Sub(v, prevFillet.axisStart), prevAxisDir);
    return Math.abs(proj - evProj) < 0.01;
  });
  if (junctionVerts.length < 2) return null;

  // Find the two distinct arc endpoints on the previous fillet
  const arcP0 = junctionVerts[0];
  let arcP1 = null;
  for (let i = 1; i < junctionVerts.length; i++) {
    if (_vec3Len(_vec3Sub(junctionVerts[i], arcP0)) > 0.01) {
      arcP1 = junctionVerts[i];
      break;
    }
  }
  if (!arcP1) return null;

  // Compute previous fillet's arc center using chord midpoint + height
  const chord = _vec3Sub(arcP1, arcP0);
  const midpt = _vec3Lerp(arcP0, arcP1, 0.5);
  const chordLen = _vec3Len(chord);
  const halfChord = chordLen / 2;
  if (halfChord >= R1 - 1e-8) return null;

  const h = Math.sqrt(Math.max(0, R1 * R1 - halfChord * halfChord));
  const chordDir = _vec3Scale(chord, 1 / chordLen);
  const perpDir = _vec3Normalize(_vec3Cross(chordDir, prevAxisDir));
  if (_vec3Len(perpDir) < 1e-6) return null;

  // Two possible centers; choose the one farther from the ORIGINAL edge
  // point (projected onto the previous fillet's axis). The correct center
  // is the one offset INTO the body, away from the original sharp edge.
  const center1 = _vec3Add(midpt, _vec3Scale(perpDir, h));
  const center2 = _vec3Sub(midpt, _vec3Scale(perpDir, h));
  const origEdgePt = _vec3Add(prevFillet.axisStart, _vec3Scale(prevAxisDir, evProj));
  const dc1 = _vec3Len(_vec3Sub(center1, origEdgePt));
  const dc2 = _vec3Len(_vec3Sub(center2, origEdgePt));
  const prevCylCenter = dc1 > dc2 ? center1 : center2;

  // Compute new fillet cylinder center
  const { offsDir0, offsDir1 } = _computeOffsetDirs(
    faces[newData.fi0], faces[newData.fi1], newData.edgeA, newData.edgeB,
  );
  const alpha2 = Math.acos(Math.max(-1, Math.min(1, _vec3Dot(offsDir0, offsDir1))));
  if (alpha2 < 1e-6) return null;
  const centerDist2 = R2 / Math.sin(alpha2 / 2);
  const bisector2 = _vec3Normalize(_vec3Add(offsDir0, offsDir1));
  if (_vec3Len(bisector2) < 1e-6) return null; // opposite offset dirs
  const newAxisDir = _vec3Normalize(_vec3Sub(newData.edgeB, newData.edgeA));
  const newCylCenter = _vec3Add(edgeVertex, _vec3Scale(bisector2, centerDist2));

  // Compute 3D intersection curve using orthogonal projection
  const d3 = _vec3Normalize(_vec3Cross(prevAxisDir, newAxisDir));
  if (_vec3Len(d3) < 1e-6) return null; // parallel axes

  // Project cylinder centers onto the three orthogonal axes
  const prevC_d1 = _vec3Dot(prevCylCenter, prevAxisDir);
  const prevC_d2 = _vec3Dot(prevCylCenter, newAxisDir);
  const prevC_d3 = _vec3Dot(prevCylCenter, d3);

  const newC_d1 = _vec3Dot(newCylCenter, prevAxisDir);
  const newC_d2 = _vec3Dot(newCylCenter, newAxisDir);
  const newC_d3 = _vec3Dot(newCylCenter, d3);

  // Restrict d3 range to arc overlap
  const arcP0_d3 = _vec3Dot(arcP0, d3);
  const arcP1_d3 = _vec3Dot(arcP1, d3);
  const prevArc_d3_min = Math.min(arcP0_d3, arcP1_d3);
  const prevArc_d3_max = Math.max(arcP0_d3, arcP1_d3);

  const face0Trim = isA ? newData.p0a : newData.p0b;
  const face1Trim = isA ? newData.p1a : newData.p1b;
  const ft0_d3 = _vec3Dot(face0Trim, d3);
  const ft1_d3 = _vec3Dot(face1Trim, d3);
  const newArc_d3_min = Math.min(ft0_d3, ft1_d3);
  const newArc_d3_max = Math.max(ft0_d3, ft1_d3);

  const eff_d3_min = Math.max(prevArc_d3_min, newArc_d3_min, prevC_d3 - R1, newC_d3 - R2);
  const eff_d3_max = Math.min(prevArc_d3_max, newArc_d3_max, prevC_d3 + R1, newC_d3 + R2);
  if (eff_d3_max - eff_d3_min < 1e-8) return null;

  // Determine which branch of sqrt to use
  const arcP0_d2 = _vec3Dot(arcP0, newAxisDir);
  const arcP1_d2 = _vec3Dot(arcP1, newAxisDir);
  const arcMid_d2 = (arcP0_d2 + arcP1_d2) / 2;
  const sign_prev_d2 = arcMid_d2 > prevC_d2 ? 1 : -1;

  const ft0_d1 = _vec3Dot(face0Trim, prevAxisDir);
  const ft1_d1 = _vec3Dot(face1Trim, prevAxisDir);
  const ftMid_d1 = (ft0_d1 + ft1_d1) / 2;
  const sign_new_d1 = ftMid_d1 > newC_d1 ? 1 : -1;

  // Sample the intersection curve
  const numSamples = Math.max(segments, 8);
  const curvePoints = [];
  for (let i = 0; i <= numSamples; i++) {
    const d3val = eff_d3_min + (i / numSamples) * (eff_d3_max - eff_d3_min);

    const sq_prev = R1 * R1 - (d3val - prevC_d3) * (d3val - prevC_d3);
    const sq_new = R2 * R2 - (d3val - newC_d3) * (d3val - newC_d3);
    if (sq_prev < 0 || sq_new < 0) continue;

    const d1val = newC_d1 + sign_new_d1 * Math.sqrt(sq_new);
    const d2val = prevC_d2 + sign_prev_d2 * Math.sqrt(sq_prev);

    const comp_d1 = _vec3Scale(prevAxisDir, d1val);
    const comp_d2 = _vec3Scale(newAxisDir, d2val);
    const comp_d3 = _vec3Scale(d3, d3val);
    const pt = _vec3Add(_vec3Add(comp_d1, comp_d2), comp_d3);
    curvePoints.push(pt);
  }

  if (curvePoints.length < 2) return null;

  // Orient curve to start near face0 trim, end near face1 trim
  const dFirst = _vec3Len(_vec3Sub(curvePoints[0], face0Trim));
  const dLast = _vec3Len(_vec3Sub(curvePoints[curvePoints.length - 1], face0Trim));
  if (dLast < dFirst) curvePoints.reverse();

  const intPt = curvePoints[curvePoints.length - 1];
  return { curve: curvePoints, intPt };
}

/**
 * Extend fillet trim lines at junctions with previous fillet arcs.
 *
 * When a new fillet meets a previous fillet at a shared vertex on a planar
 * face, the boundary creates an abrupt "notch" where the new fillet's
 * offset jumps back to the previous fillet's arc.  This function detects
 * such junctions and either:
 *
 * (a) Computes the 3D intersection curve between the two fillet cylinders
 *     and uses it to smoothly clip the first fillet (no corner face), or
 *
 * (b) Falls back to the old approach: removes above-offset arc vertices,
 *     inserts the offset-arc intersection point, and creates a corner face.
 *
 * @param {Array<Object>} trimmedFaces - Trimmed mesh-level faces (mutated)
 * @param {Array<Object>} edgeDataList - Fillet edge data
 * @param {Array<Object>} faces        - Original extracted faces (pre-trim)
 * @param {Object}        origTopoBody - Input TopoBody (may have previous fillet surfaces)
 * @param {number}        radius       - New fillet radius
 */
function _extendTrimsAtPreviousFilletJunctions(trimmedFaces, edgeDataList, faces, origTopoBody, radius) {
  if (!origTopoBody || !origTopoBody.shells) return;

  // Build lookup: vertex key → previous fillet info (axis, radius, topoFaceId) | null
  const vertexPrevFillet = new Map();
  for (const shell of origTopoBody.shells) {
    for (const topoFace of (shell.faces || [])) {
      if (topoFace.surfaceType === 'plane') continue;
      if (!topoFace.outerLoop) continue;
      const shared = topoFace.shared;
      const hasMeta = shared && shared.isFillet &&
        shared._exactAxisStart && shared._exactAxisEnd && shared._exactRadius;
      for (const ce of topoFace.outerLoop.coedges) {
        const sk = _edgeVKey(ce.edge.startVertex.point);
        const ek = _edgeVKey(ce.edge.endVertex.point);
        if (hasMeta) {
          const info = {
            axisStart: shared._exactAxisStart,
            axisEnd: shared._exactAxisEnd,
            radius: shared._exactRadius,
            topoFaceId: topoFace.id,
          };
          vertexPrevFillet.set(sk, info);
          vertexPrevFillet.set(ek, info);
        } else {
          if (!vertexPrevFillet.has(sk)) vertexPrevFillet.set(sk, null);
          if (!vertexPrevFillet.has(ek)) vertexPrevFillet.set(ek, null);
        }
      }
    }
  }

  for (const data of edgeDataList) {
    if (data._rollingRail0) continue;
    const tangentDist = _vec3Len(_vec3Sub(data.p0a, data.edgeA));
    if (!tangentDist || tangentDist < 1e-10) continue;

    const { offsDir0, offsDir1 } = _computeOffsetDirs(
      faces[data.fi0], faces[data.fi1], data.edgeA, data.edgeB,
    );

    for (const isA of [true, false]) {
      const edgeVertex = isA ? data.edgeA : data.edgeB;
      const evk = _edgeVKey(edgeVertex);
      if (!vertexPrevFillet.has(evk)) continue;

      const prevFillet = vertexPrevFillet.get(evk);

      // Attempt to compute 3D intersection curve.  Do this before applying
      // the endpoint-only tangent-contact guard: an edge endpoint can lie on
      // the previous fillet boundary while the new fillet cylinder still cuts
      // through the previous fillet surface beyond that endpoint.
      let intCurve = null;
      if (prevFillet) {
        intCurve = _computeFilletFilletIntersectionCurve(
          prevFillet, data, faces, radius, isA, origTopoBody,
        );
      }

      let tangentContactOnly = false;
      if (!intCurve && prevFillet) {
        const apEnd = _vec3Sub(edgeVertex, prevFillet.axisStart);
        const prevAxisDir = _vec3Normalize(
          _vec3Sub(prevFillet.axisEnd, prevFillet.axisStart),
        );
        const along = _vec3Dot(apEnd, prevAxisDir);
        const radial = _vec3Sub(apEnd, _vec3Scale(prevAxisDir, along));
        const distToPrevAxis = _vec3Len(radial);
        const overlapTol = Math.max(1e-4, prevFillet.radius * 1e-3);
        tangentContactOnly = distToPrevAxis >= prevFillet.radius - overlapTol;
      }

      if (intCurve && intCurve.curve && intCurve.curve.length >= 2) {
        // Store the junction curve on the edge data for _buildExactFilletFaceDesc
        if (isA) {
          data._junctionCurveA = intCurve.curve;
          data._junctionIntPtA = intCurve.intPt;
        } else {
          data._junctionCurveB = intCurve.curve;
          data._junctionIntPtB = intCurve.intPt;
        }

        // Modify mesh-level trimmed faces at the junction
        _applyJunctionCurveToMesh(
          trimmedFaces, data, faces, edgeVertex,
          offsDir0, offsDir1, tangentDist, intCurve, isA,
        );
      } else if (tangentContactOnly) {
        // Skip — no real junction; preserve existing trim & arc samples.
      } else {
        // Fallback: old flat-clip approach (corner face + offset intersection)
        const sideParams = [
          { fi: data.fi0, offsDir: offsDir0, p: isA ? data.p0a : data.p0b },
          { fi: data.fi1, offsDir: offsDir1, p: isA ? data.p1a : data.p1b },
        ];
        for (const { fi, offsDir, p: trimPt } of sideParams) {
          const origFace = faces[fi];
          if (!origFace) continue;
          const topoFaceId = origFace.topoFaceId;
          if (topoFaceId === undefined) continue;
          const trimmedFace = trimmedFaces.find(
            (f) => f.topoFaceId === topoFaceId,
          );
          if (!trimmedFace) continue;
          const trimVK = _edgeVKey(trimPt);
          const trimIdx = trimmedFace.vertices.findIndex(
            (v) => _edgeVKey(v) === trimVK,
          );
          if (trimIdx < 0) continue;
          _tryExtendTrimDirection(
            trimmedFace, trimmedFaces, trimIdx, edgeVertex,
            offsDir, tangentDist, trimPt,
          );
        }
      }
    }
  }
}

// -----------------------------------------------------------------------
// Fillet–chamfer junction
// -----------------------------------------------------------------------

/**
 * Sample the curve where a fillet cylinder intersects a planar face (e.g. a
 * previous chamfer's bevel plane).  The curve is the cylinder's silhouette
 * on the plane — a circular arc when the plane is perpendicular to the
 * axis, otherwise an ellipse arc.
 *
 * Cylinder is parameterised in cross-section as
 *   P(θ, t) = cylCenter + r · cos θ · ex + r · sin θ · ey + t · axis
 * where {ex, ey} is an orthonormal frame perpendicular to `axis`.
 *
 * The plane is `(P − planePoint) · planeNormal = 0`.  Substituting and
 * solving for `t(θ)` gives a single-valued function (provided the cylinder
 * axis is not parallel to the plane), so each θ yields a unique 3D point
 * on the intersection curve.
 *
 * `startPt` and `endPt` must lie on both surfaces (within tolerance);
 * their θ values define the arc parameter range.  The shorter angular
 * sweep is sampled.
 *
 * @returns {Array<{x,y,z}>|null} `segments+1` polyline samples from
 *          `startPt` to `endPt`, inclusive.  `null` on failure
 *          (axis ∥ plane, degenerate frame, etc.).
 */
function _computeFilletChamferArcSamples(
  cylCenter, axisDir, radius, ex, ey,
  planePoint, planeNormal,
  startPt, endPt, segments = 12, preferLongSweep = false,
) {
  if (!preferLongSweep) {
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
  }

  const C = _vec3Dot(axisDir, planeNormal);
  if (Math.abs(C) < 1e-9) return null; // axis parallel to plane

  const K = _vec3Dot(_vec3Sub(cylCenter, planePoint), planeNormal);
  const A = _vec3Dot(ex, planeNormal);
  const B = _vec3Dot(ey, planeNormal);

  const at = (theta) => {
    const ct = Math.cos(theta), st = Math.sin(theta);
    const t = -(K + radius * ct * A + radius * st * B) / C;
    return _vec3Add(
      _vec3Add(cylCenter, _vec3Scale(axisDir, t)),
      _vec3Add(_vec3Scale(ex, radius * ct), _vec3Scale(ey, radius * st)),
    );
  };

  const thetaOf = (pt) => {
    const rel = _vec3Sub(pt, cylCenter);
    return Math.atan2(_vec3Dot(rel, ey), _vec3Dot(rel, ex));
  };

  const t0 = thetaOf(startPt);
  const t1 = thetaOf(endPt);
  let dt = t1 - t0;
  while (dt > Math.PI) dt -= 2 * Math.PI;
  while (dt < -Math.PI) dt += 2 * Math.PI;
  if (preferLongSweep) dt = dt >= 0 ? dt - 2 * Math.PI : dt + 2 * Math.PI;
  if (Math.abs(dt) < 1e-6) return null;

  const out = [];
  for (let i = 0; i <= segments; i++) {
    out.push(at(t0 + dt * (i / segments)));
  }
  // Snap exact endpoints to avoid sub-tol drift
  out[0] = { ...startPt };
  out[out.length - 1] = { ...endPt };
  return out;
}

/**
 * Replace stitched-line trims with proper cylinder-plane arc samples where
 * a new fillet meets a previous chamfer face.
 *
 * Symptom: at the corner where (a) the new fillet edge ends and (b) a
 * previous chamfer face also has a corner, the trim builder splits the
 * shared corner vertex into two trim points (`p0?` on one adjacent face's
 * plane, `p1?` on the other).  The chamfer face — which was supposed to
 * stay planar — receives the OFF-PLANE trim point, producing a wedge that
 * juts out of the chamfer plane.  Visually this is a non-planar bevel.
 *
 * Fix: for every fillet edge endpoint that touches a chamfer face, locate
 *   - `inPlanePt`  — the trim point that already lies on the chamfer plane
 *   - `offPlanePt` — the trim point that does NOT
 *   - `cornerPt`  — the chamfer-face corner that originally was adjacent
 *                   to the now-trimmed edgeVertex (it is on both the
 *                   chamfer plane AND the second adjacent face, e.g. the
 *                   side face), and remains in the chamfer's loop.
 * Sample the cylinder ∩ chamfer-plane arc from `inPlanePt` to `cornerPt`
 * and re-stitch three faces:
 *   - chamfer face: drop offPlanePt, insert arc samples between inPlanePt
 *     and cornerPt → face becomes planar again
 *   - "second adjacent" face (the one carrying offPlanePt): drop
 *     offPlanePt → it becomes a clean rectangle
 *   - fillet face / edge data: rewire the trim end-point from offPlanePt
 *     to cornerPt and replace the cap polyline with the arc → cylinder
 *     extends past the simple cross-section to meet the chamfer cleanly
 */
function _extendTrimsAtPreviousChamferJunctions(
  trimmedFaces, edgeDataList, faces, origTopoBody, radius,
) {
  if (!origTopoBody || !origTopoBody.shells) return;
  const _dbg = (typeof process !== 'undefined' && process.env && process.env.DEBUG_FCJ === '1');
  const log = (...a) => { if (_dbg) console.log('[FCJ]', ...a); };

  // Build vertex-key → list of planar bridge TopoFaces touching that vertex.
  // A "bridge" is any planar face whose loop contains the fillet endpoint
  // and that participates in the trim-builder's vertex-split (so both p0
  // and p1 trim points end up in its loop).  Chamfer faces are the
  // canonical example, but any planar transition face produced by a prior
  // operation (bevel from boolean, manual draft, blended bridge, …) ends up
  // in the same shape and benefits from the same surgery.  The downstream
  // geometric checks (offIdx ≥ 0, neighbours = inPlane + corner) already
  // reject faces that don't actually have the bridge topology.
  const vertexChamfer = new Map();
  for (const shell of origTopoBody.shells) {
    for (const topoFace of shell.faces || []) {
      if (!topoFace.outerLoop) continue;
      // Surface must be planar — cylinder/plane intersection is what we
      // build; non-planar neighbours are handled by phase 3.
      if (topoFace.surfaceType && topoFace.surfaceType !== 'plane') continue;
      const verts = topoFace.outerLoop.coedges.map(ce =>
        ce.sameSense !== false
          ? { ...ce.edge.startVertex.point }
          : { ...ce.edge.endVertex.point },
      );
      if (verts.length < 3) continue;
      const planeNormal = _computePolygonNormal(verts);
      if (!planeNormal) continue;
      const nLen = _vec3Len(planeNormal);
      if (nLen < 1e-9) continue;
      const normalUnit = { x: planeNormal.x / nLen, y: planeNormal.y / nLen, z: planeNormal.z / nLen };
      const info = { topoFace, verts, planePoint: verts[0], planeNormal: normalUnit };
      for (const v of verts) {
        const vk = _edgeVKey(v);
        if (!vertexChamfer.has(vk)) vertexChamfer.set(vk, []);
        vertexChamfer.get(vk).push(info);
      }
    }
  }
  if (vertexChamfer.size === 0) return;
  log(`planar bridge candidates touching ${vertexChamfer.size} vertex keys`);

  for (const data of edgeDataList) {
    const edgeDir = _vec3Normalize(_vec3Sub(data.edgeB, data.edgeA));
    const { offsDir0, offsDir1 } = _computeOffsetDirs(
      faces[data.fi0], faces[data.fi1], data.edgeA, data.edgeB,
    );
    const alpha = Math.acos(Math.max(-1, Math.min(1, _vec3Dot(offsDir0, offsDir1))));
    if (alpha < 1e-6) continue;
    const centerDist = radius / Math.sin(alpha / 2);
    const bisector = _vec3Normalize(_vec3Add(offsDir0, offsDir1));
    if (_vec3Len(bisector) < 1e-6) continue;

    for (const isA of [true, false]) {
      const edgeVertex = isA ? data.edgeA : data.edgeB;
      const evk = _edgeVKey(edgeVertex);
      const chamferList = vertexChamfer.get(evk);
      if (!chamferList || chamferList.length === 0) continue;
      log(`fillet end ${evk} touches ${chamferList.length} chamfer face(s)`);

      const p0 = isA ? data.p0a : data.p0b;
      const p1 = isA ? data.p1a : data.p1b;

      // Cylinder cross-section frame at this end
      const cylCenter = _vec3Add(edgeVertex, _vec3Scale(bisector, centerDist));
      const evRel = _vec3Sub(edgeVertex, cylCenter);
      const evAlong = _vec3Dot(evRel, edgeDir);
      const evPerp = _vec3Sub(evRel, _vec3Scale(edgeDir, evAlong));
      const exLen = _vec3Len(evPerp);
      if (exLen < 1e-9) continue;
      const ex = { x: evPerp.x / exLen, y: evPerp.y / exLen, z: evPerp.z / exLen };
      const ey = _vec3Cross(edgeDir, ex); // already unit since edgeDir ⊥ ex and both unit

      for (const { topoFace, verts: chamferVerts, planePoint, planeNormal } of chamferList) {
        // Skip the fillet's own adjacent faces — extending into them would
        // re-fillet the face the cylinder is already rolling on.
        const f0Id = faces[data.fi0]?.topoFaceId;
        const f1Id = faces[data.fi1]?.topoFaceId;
        if (topoFace.id === f0Id || topoFace.id === f1Id) continue;

        // Cylinder axis must not be parallel to the chamfer plane
        const axisDotN = _vec3Dot(edgeDir, planeNormal);
        if (Math.abs(axisDotN) < 1e-6) continue;

        // Decide which of {p0,p1} lies on the chamfer plane (= "inPlane")
        // and which is off (= "offPlane").  Tolerance scales with radius.
        const tol = Math.max(1e-4, radius * 1e-2);
        const d0 = _vec3Dot(_vec3Sub(p0, planePoint), planeNormal);
        const d1 = _vec3Dot(_vec3Sub(p1, planePoint), planeNormal);
        let inPlane, offPlane, isInP0;
        if (Math.abs(d0) < tol && Math.abs(d1) > tol) {
          inPlane = p0; offPlane = p1; isInP0 = true;
        } else if (Math.abs(d1) < tol && Math.abs(d0) > tol) {
          inPlane = p1; offPlane = p0; isInP0 = false;
        } else {
          log(`  ambiguous d0=${d0.toFixed(4)} d1=${d1.toFixed(4)}`);
          continue; // ambiguous — skip
        }
        const inPlaneKey = _edgeVKey(inPlane);
        const offPlaneKey = _edgeVKey(offPlane);

        // The "other adjacent face" is the one whose plane contains offPlane
        // — fi0 if isInP0=false, fi1 if isInP0=true.
        const otherFaceIdx = isInP0 ? data.fi1 : data.fi0;
        const otherFace = faces[otherFaceIdx];
        if (!otherFace || otherFace.topoFaceId === undefined) continue;

        // Find the chamfer-corner = neighbour of edgeVertex in chamferVerts
        // that lies on the OTHER adjacent face's plane (so it's shared
        // between the chamfer and that face — i.e. it survives as a corner
        // of the chamfer face after the fillet trim).
        const otherNormal = otherFace.normal
          ? _vec3Normalize(otherFace.normal)
          : null;
        const otherPlanePt = (otherFace.vertices && otherFace.vertices[0]) || null;
        if (!otherNormal || !otherPlanePt) continue;
        const otherFaceBoundaryKeys = new Set((otherFace.vertices || []).map((point) => _edgeVKey(point)));
        const onOtherPlane = (p) =>
          Math.abs(_vec3Dot(_vec3Sub(p, otherPlanePt), otherNormal)) < tol;
        const onOtherBoundary = (p) => otherFaceBoundaryKeys.has(_edgeVKey(p));

        let evIdx = -1;
        for (let i = 0; i < chamferVerts.length; i++) {
          if (_edgeVKey(chamferVerts[i]) === evk) { evIdx = i; break; }
        }
        if (evIdx < 0) continue;
        const m = chamferVerts.length;
        const prev = chamferVerts[(evIdx - 1 + m) % m];
        const next = chamferVerts[(evIdx + 1) % m];
        let corner = null;
        let cornerIndex = -1;
        if (_edgeVKey(prev) !== evk && (onOtherPlane(prev) || onOtherBoundary(prev))) {
          corner = prev;
          cornerIndex = (evIdx - 1 + m) % m;
        } else if (_edgeVKey(next) !== evk && (onOtherPlane(next) || onOtherBoundary(next))) {
          corner = next;
          cornerIndex = (evIdx + 1) % m;
        }
        if (!corner) { log('  no corner found'); continue; }
        if (!onOtherPlane(corner) && onOtherBoundary(corner) && cornerIndex >= 0) {
          const walkDir = cornerIndex === (evIdx - 1 + m) % m ? -1 : 1;
          let terminalIndex = cornerIndex;
          for (let step = 0; step < m - 1; step++) {
            const nextIndex = (terminalIndex + walkDir + m) % m;
            if (nextIndex === evIdx) break;
            const nextPoint = chamferVerts[nextIndex];
            if (!onOtherBoundary(nextPoint)) break;
            terminalIndex = nextIndex;
          }
          corner = chamferVerts[terminalIndex];
          cornerIndex = terminalIndex;
        }
        const cornerKey = _edgeVKey(corner);
        log(`  inPlane=${inPlaneKey} offPlane=${offPlaneKey} corner=${cornerKey}`);

        // Compute arc samples from inPlane to corner on cylinder ∩ plane
        const segments = 8;
        let arc = _computeFilletChamferArcSamples(
          cylCenter, edgeDir, radius, ex, ey,
          planePoint, planeNormal,
          inPlane, corner, segments,
        );
        const arcPenalty = (samples) => {
          if (!Array.isArray(samples) || samples.length < 2) return Infinity;
          let penalty = 0;
          for (const sample of samples) {
            if (!pointInTopoFaceDomain(topoFace, sample, Math.max(1e-4, radius * 1e-3))) penalty++;
          }
          return penalty;
        };
        const alternateArc = _computeFilletChamferArcSamples(
          cylCenter, edgeDir, radius, ex, ey,
          planePoint, planeNormal,
          inPlane, corner, segments, true,
        );
        if (arcPenalty(alternateArc) < arcPenalty(arc)) arc = alternateArc;
        if (!arc || arc.length < 3) continue;

        // ── (a) Surgery on the chamfer face's trimmed loop ──
        // Find offPlane in the loop; verify its neighbours are inPlane
        // and corner; replace offPlane with the *interior* arc samples.
        const chamferTrim = trimmedFaces.find(
          f => f.topoFaceId === topoFace.id,
        );
        if (!chamferTrim || !chamferTrim.vertices) { log('  chamferTrim missing'); continue; }
        const cv = chamferTrim.vertices;
        const offIdx = cv.findIndex(v => _edgeVKey(v) === offPlaneKey);
        if (offIdx < 0) { log('  offIdx<0 in chamferTrim'); continue; }
        const cn = cv.length;
        const pK = _edgeVKey(cv[(offIdx - 1 + cn) % cn]);
        const nK = _edgeVKey(cv[(offIdx + 1) % cn]);

        // The expected layouts at this point in the loop are
        //   [..., other, offPlane, inPlane, corner, ...]    (forward)
        //   [..., corner, inPlane, offPlane, other, ...]    (reverse)
        // i.e. offPlane is adjacent to inPlane, and corner is 2 vertices
        // away from offPlane (one step past inPlane).
        let chamferInsertion = null;
        let insertArcAfterInPlane = false;
        let removeIndices = [];
        const collectForwardSpanToCorner = () => {
          const indices = [];
          let idx = offIdx;
          for (let step = 0; step < cn; step++) {
            if (_edgeVKey(cv[idx]) === cornerKey) return indices;
            indices.push(idx);
            idx = (idx + 1) % cn;
          }
          return null;
        };
        const collectReverseSpanToCorner = () => {
          const indices = [];
          let idx = offIdx;
          for (let step = 0; step < cn; step++) {
            if (_edgeVKey(cv[idx]) === cornerKey) return indices;
            indices.push(idx);
            idx = (idx - 1 + cn) % cn;
          }
          return null;
        };
        if (nK === inPlaneKey) {
          const nnK = _edgeVKey(cv[(offIdx + 2) % cn]);
          if (nnK === cornerKey) {
            // forward: replace [off] with nothing, then insert arc-interior
            // between inPlane (now at offIdx after splice) and corner.
            removeIndices = [offIdx];
            chamferInsertion = arc.slice(1, -1).map(p => ({ ...p }));
            insertArcAfterInPlane = true;
          }
        } else if (pK === inPlaneKey) {
          if (nK === cornerKey) {
            removeIndices = [offIdx];
            chamferInsertion = arc.slice(1, -1).map(p => ({ ...p }));
            insertArcAfterInPlane = true;
          } else {
            const ppK = _edgeVKey(cv[(offIdx - 2 + cn) % cn]);
            if (ppK === cornerKey) {
            // reverse: traversal order is [corner, inPlane, offPlane],
            // so arc-interior must be reversed.
              removeIndices = [offIdx];
              chamferInsertion = arc.slice(1, -1).reverse().map(p => ({ ...p }));
              insertArcAfterInPlane = false;
            } else {
              const span = collectForwardSpanToCorner();
              if (span && span.length > 0) {
                removeIndices = span;
                chamferInsertion = arc.slice(1, -1).map(p => ({ ...p }));
                insertArcAfterInPlane = true;
              }
            }
          }
        } else if (pK === cornerKey && nK === inPlaneKey) {
          removeIndices = [offIdx];
          chamferInsertion = arc.slice(1, -1).reverse().map(p => ({ ...p }));
          insertArcAfterInPlane = false;
        } else if (nK === inPlaneKey) {
          const span = collectReverseSpanToCorner();
          if (span && span.length > 0) {
            removeIndices = span;
            chamferInsertion = arc.slice(1, -1).reverse().map(p => ({ ...p }));
            insertArcAfterInPlane = false;
          }
        }
        if (removeIndices.length === 0 || !chamferInsertion) {
          log(`  chamfer loop neighbours: prev=${pK} next=${nK} (need inPlane+corner)`);
          continue;
        }

        // ── (b) Surgery on the "other adjacent" face ──
        // It carries offPlane between two corners on its own plane;
        // simply remove offPlane → loop becomes a clean polygon.
        const otherTrim = trimmedFaces.find(
          f => f.topoFaceId === otherFace.topoFaceId,
        );
        if (!otherTrim || !otherTrim.vertices) continue;
        const otherOffIdx = otherTrim.vertices.findIndex(
          v => _edgeVKey(v) === offPlaneKey,
        );
        if (otherOffIdx < 0) { log('  otherOffIdx<0'); continue; }
        const otherCornerIdx = otherTrim.vertices.findIndex(
          v => _edgeVKey(v) === cornerKey,
        );
        const otherRemoveIndices = [];
        if (otherCornerIdx >= 0) {
          const walk = (dir) => {
            const indices = [];
            let idx = (otherCornerIdx + dir + otherTrim.vertices.length) % otherTrim.vertices.length;
            for (let step = 0; step < otherTrim.vertices.length; step++) {
              indices.push(idx);
              if (idx === otherOffIdx) return indices;
              idx = (idx + dir + otherTrim.vertices.length) % otherTrim.vertices.length;
            }
            return null;
          };
          const forward = walk(1);
          const reverse = walk(-1);
          const chosen = forward && reverse
            ? (forward.length <= reverse.length ? forward : reverse)
            : (forward || reverse);
          if (chosen) otherRemoveIndices.push(...chosen);
        }
        if (otherRemoveIndices.length === 0) otherRemoveIndices.push(otherOffIdx);
        if (otherTrim.vertices.length - otherRemoveIndices.length < 3) continue;
        log(`  applying surgery: chamfer.id=${topoFace.id} other.id=${otherFace.topoFaceId}`);

        // ── (c) Update edgeData so the fillet face uses the corner ──
        // The cap polyline (arcA/arcB) becomes the cylinder ∩ plane arc
        // and the trim end-point on the offPlane side becomes the corner.
        // Direction matters: arc[0] = inPlane = p0 side, arc[last] = corner = p1 side.
        // arcA / arcB are stored as p0 → p1 in the existing computeArc code.
        // If isInP0 === true, then inPlane is p0, corner is p1 — direction matches.
        // If isInP0 === false, inPlane is p1, corner is p0 — reverse.
        const arcForCap = isInP0
          ? arc.map(p => ({ ...p }))
          : arc.slice().reverse().map(p => ({ ...p }));

        // Apply commits — only AFTER we've passed every sanity check above.
        // Layout: forward = [..., other, off, in, corner, ...]
        //         reverse = [..., corner, in, off, other, ...]
        // After removing off the loop reads:
        //         forward = [..., other, in, corner, ...] — insert arc[1..-1] AFTER in
        //         reverse = [..., corner, in, other, ...] — insert arc[1..-1] reversed BEFORE in
        chamferTrim.vertices = (() => {
          const removeSet = new Set(removeIndices);
          const newVerts = cv.filter((_, index) => !removeSet.has(index));
          const inIdxNew = newVerts.findIndex(v => _edgeVKey(v) === inPlaneKey);
          if (inIdxNew >= 0) {
            const insertAt = insertArcAfterInPlane ? inIdxNew + 1 : inIdxNew;
            newVerts.splice(insertAt, 0, ...chamferInsertion);
          }
          return newVerts;
        })();
        otherTrim.vertices = (() => {
          const removeSet = new Set(otherRemoveIndices);
          return otherTrim.vertices.filter((_, index) => !removeSet.has(index));
        })();
        const updateRollingEndpoint = (atA) => {
          if (!Array.isArray(data._rollingRail0) || !Array.isArray(data._rollingRail1)) return;
          const index = atA ? 0 : data._rollingRail0.length - 1;
          if (index < 0 || index >= data._rollingRail0.length || index >= data._rollingRail1.length) return;
          if (isInP0) data._rollingRail1[index] = { ...corner };
          else data._rollingRail0[index] = { ...corner };
          if (Array.isArray(data._rollingCenters) && data._rollingCenters[index]) {
            const referenceIndex = atA ? index + 1 : index - 1;
            const referenceCenter = data._rollingCenters[referenceIndex] || cylCenter;
            const fittedCenter = _fitRollingCenterToRadius(
              data._rollingRail0[index],
              data._rollingRail1[index],
              radius,
              referenceCenter,
            );
            data._rollingCenters[index] = fittedCenter || { ...cylCenter };
          }
        };
        if (isA) {
          if (isInP0) data.p1a = { ...corner }; else data.p0a = { ...corner };
          data.arcA = arcForCap;
          data._exactArcCurveA = _curveFromSampledPoints(arcForCap);
          data._useArcCurveA = true;
          data._chamferArcAtA = true;
          updateRollingEndpoint(true);
        } else {
          if (isInP0) data.p1b = { ...corner }; else data.p0b = { ...corner };
          data.arcB = arcForCap;
          data._exactArcCurveB = _curveFromSampledPoints(arcForCap);
          data._useArcCurveB = true;
          data._chamferArcAtB = true;
          updateRollingEndpoint(false);
        }
      }
    }
  }
}

/**
 * Apply the 3D intersection curve to mesh-level trimmed faces.
 *
 * For each adjacent planar face at the junction:
 * - Finds above-offset arc vertices between the trim point and the
 *   first vertex below the intersection.
 * - Removes the trim point AND the above-offset vertices.
 * - Inserts the intersection point (intPt) in their place.
 *
 * For the previous fillet face:
 * - Removes arc vertices above the intersection.
 * - Inserts intPt into the boundary and stores the junction curve.
 *
 * Does NOT create a corner face — the junction is handled by the
 * intersection curve shared between the two fillet surfaces.
 */
function _applyJunctionCurveToMesh(
  trimmedFaces, data, faces, edgeVertex,
  offsDir0, offsDir1, tangentDist, intCurve, isA,
) {
  const { intPt } = intCurve;

  // Process the fi1 side (the face that has above-offset arc vertices)
  const sideParams = [
    { fi: data.fi1, offsDir: offsDir1, p: isA ? data.p1a : data.p1b },
    { fi: data.fi0, offsDir: offsDir0, p: isA ? data.p0a : data.p0b },
  ];

  for (const { fi, offsDir, p: trimPt } of sideParams) {
    const origFace = faces[fi];
    if (!origFace) continue;
    const topoFaceId = origFace.topoFaceId;
    if (topoFaceId === undefined) continue;

    const trimmedFace = trimmedFaces.find(
      (f) => f.topoFaceId === topoFaceId,
    );
    if (!trimmedFace) continue;

    const trimVK = _edgeVKey(trimPt);
    const n = trimmedFace.vertices.length;
    const trimIdx = trimmedFace.vertices.findIndex(
      (v) => _edgeVKey(v) === trimVK,
    );
    if (trimIdx < 0) continue;

    // Walk from trimPt to find consecutive above-offset arc vertices
    for (const walkDir of [1, -1]) {
      const above = [];
      let idx = (trimIdx + walkDir + n) % n;

      for (let step = 0; step < n - 1; step++) {
        const v = trimmedFace.vertices[idx];
        const d = _vec3Dot(_vec3Sub(v, edgeVertex), offsDir);
        if (d > 1e-8 && d < tangentDist - 1e-6) {
          above.push({ idx, vertex: v, d });
        } else {
          break;
        }
        idx = (idx + walkDir + n) % n;
      }

      if (above.length < 2) continue;

      // Find the below-vertex (first vertex past the above span)
      const lastAbove = above[above.length - 1];
      const belowIdx = (lastAbove.idx + walkDir + n) % n;
      const belowV = trimmedFace.vertices[belowIdx];

      // Remove BOTH trimPt AND above-offset vertices, insert intPt
      const removeSet = new Set(above.map((a) => a.idx));
      removeSet.add(trimIdx); // also remove the trim point itself

      const newVerts = [];
      for (let vi = 0; vi < n; vi++) {
        if (removeSet.has(vi)) continue;
        newVerts.push(trimmedFace.vertices[vi]);
      }

      // Find where to insert intPt — between the vertex before trimPt
      // and belowV in the new boundary.
      const belowVK = _edgeVKey(belowV);
      // The vertex before trimIdx in walkDir is the "rail vertex" (e.g., (10,10,9.5))
      const railIdx = (trimIdx - walkDir + n) % n;
      const railV = trimmedFace.vertices[railIdx];
      const railVK = _edgeVKey(railV);

      let insertPos = -1;
      for (let vi = 0; vi < newVerts.length; vi++) {
        const curVK = _edgeVKey(newVerts[vi]);
        const nextVK = _edgeVKey(newVerts[(vi + 1) % newVerts.length]);
        if ((curVK === railVK && nextVK === belowVK) ||
            (curVK === belowVK && nextVK === railVK)) {
          insertPos = vi + 1;
          break;
        }
      }
      if (insertPos >= 0) {
        newVerts.splice(insertPos, 0, { ...intPt });
      }

      if (newVerts.length >= 3) {
        trimmedFace.vertices = newVerts;
      }

      // Update the previous fillet face: remove above-intersection arc
      // vertices and insert intPt.
      for (const otherFace of trimmedFaces) {
        if (otherFace === trimmedFace) continue;
        const otherN = otherFace.vertices.length;
        const firstAboveVK = _edgeVKey(above[0].vertex);
        const hasAbove = otherFace.vertices.some(
          (v) => _edgeVKey(v) === firstAboveVK,
        );
        if (!hasAbove) continue;

        // Find and remove the above-offset vertices from the fillet face
        const otherAboveVKs = new Set(above.map(a => _edgeVKey(a.vertex)));
        // Also remove the old connection point (trimPt) from the fillet face
        otherAboveVKs.add(trimVK);

        const keptVerts = [];
        for (let vi = 0; vi < otherN; vi++) {
          const vk = _edgeVKey(otherFace.vertices[vi]);
          if (otherAboveVKs.has(vk)) continue;
          keptVerts.push(otherFace.vertices[vi]);
        }

        // Insert intPt between belowV and the nearest kept vertex
        // from the original arc direction
        let otherInsertPos = -1;
        for (let vi = 0; vi < keptVerts.length; vi++) {
          const curVK = _edgeVKey(keptVerts[vi]);
          if (curVK === belowVK) {
            otherInsertPos = vi + 1;
            break;
          }
        }
        if (otherInsertPos < 0) {
          // Try inserting before belowV
          for (let vi = 0; vi < keptVerts.length; vi++) {
            if (_edgeVKey(keptVerts[vi]) === belowVK) {
              otherInsertPos = vi;
              break;
            }
          }
        }
        if (otherInsertPos >= 0) {
          keptVerts.splice(otherInsertPos, 0, { ...intPt });
        }

        if (keptVerts.length >= 3) {
          otherFace.vertices = keptVerts;
        }

        // Store junction curve metadata for BRep edge curve building
        if (!otherFace._junctionCurves) otherFace._junctionCurves = [];
        otherFace._junctionCurves.push({
          curve: intCurve.curve,
        });
      }

      break; // only process one direction per trim point
    }
  }
}

/**
 * Walk from trimIdx in both directions; for the first direction that has
 * ≥2 "above-offset" arc vertices, clip them and insert the intersection
 * point.  Also create a corner face from the removed vertices.
 */
function _tryExtendTrimDirection(
  trimmedFace, trimmedFaces, trimIdx, edgeVertex,
  offsDir, tangentDist, trimPt,
) {
  const n = trimmedFace.vertices.length;

  for (const walkDir of [1, -1]) {
    // Collect consecutive vertices that are "above" the offset
    // (their offset distance < tangentDist, meaning closer to edge).
    const above = [];
    let idx = (trimIdx + walkDir + n) % n;

    for (let step = 0; step < n - 1; step++) {
      const v = trimmedFace.vertices[idx];
      const d = _vec3Dot(_vec3Sub(v, edgeVertex), offsDir);
      if (d > 1e-8 && d < tangentDist - 1e-6) {
        above.push({ idx, vertex: v, d });
      } else {
        break;
      }
      idx = (idx + walkDir + n) % n;
    }

    if (above.length < 2) continue;

    // Find the first vertex *below* the offset (the one kept).
    const lastAbove = above[above.length - 1];
    const belowIdx = (lastAbove.idx + walkDir + n) % n;
    const belowV = trimmedFace.vertices[belowIdx];
    const belowD = _vec3Dot(_vec3Sub(belowV, edgeVertex), offsDir);

    // Interpolate to find intersection with offset line
    if (Math.abs(belowD - lastAbove.d) < 1e-12) continue;
    const t = (tangentDist - lastAbove.d) / (belowD - lastAbove.d);
    if (t < -0.01 || t > 1.01) continue;
    const intPt = _vec3Lerp(lastAbove.vertex, belowV, Math.max(0, Math.min(1, t)));

    // ── Build corner face from removed vertices ──
    // The corner face is a planar polygon on the same plane as the
    // parent face, bounded by:
    //   trimPt → intPt          (straight line at offset distance)
    //   intPt → above[n-1] → … → above[0] → trimPt   (the removed arc)
    //
    // Walk direction determines vertex order:
    //   walkDir=+1: above[] is in boundary order (trimPt → above[0] … above[n-1])
    //   walkDir=-1: above[] is in reverse boundary order
    const cornerVerts = [];
    if (walkDir === 1) {
      cornerVerts.push({ ...trimPt });
      for (const a of above) cornerVerts.push({ ...a.vertex });
      cornerVerts.push({ ...intPt });
    } else {
      cornerVerts.push({ ...trimPt });
      cornerVerts.push({ ...intPt });
      for (let i = above.length - 1; i >= 0; i--) {
        cornerVerts.push({ ...above[i].vertex });
      }
    }

    if (cornerVerts.length >= 3) {
      const parentNormal = trimmedFace.normal
        ? { ...trimmedFace.normal }
        : _computePolygonNormal(trimmedFace.vertices);
      trimmedFaces.push({
        vertices: cornerVerts,
        normal: parentNormal,
        shared: trimmedFace.shared ? { ...trimmedFace.shared } : null,
      });
    }

    // ── Modify the planar face: remove above-offset vertices,
    //    insert the intersection point in their place. ──
    const removeSet = new Set(above.map((a) => a.idx));
    const newVerts = [];
    let intInserted = false;

    // Walk in boundary order (index 0 … n-1) and rebuild.
    for (let vi = 0; vi < n; vi++) {
      if (removeSet.has(vi)) {
        // Insert intersection point once, at the boundary position
        // closest to the "below" side.
        if (!intInserted) {
          // For walkDir=+1 the first removed index comes right after
          // trimIdx in boundary order → insert intPt at the END of
          // the removed span (just before the below vertex).
          // For walkDir=-1, the first removed index is just before
          // trimIdx → insert intPt at the START of the removed span.
          // We'll collect them all and splice once below.
        }
        continue;
      }
      newVerts.push(trimmedFace.vertices[vi]);
    }

    // Now insert intPt in the correct position.
    // The intersection point replaces the removed span.  In boundary
    // order the span sits between trimPt and belowV.  Find where
    // belowV ended up in newVerts and insert intPt next to it.
    const belowVK = _edgeVKey(belowV);
    const trimVK = _edgeVKey(trimPt);
    let insertPos = -1;
    for (let vi = 0; vi < newVerts.length; vi++) {
      const curVK = _edgeVKey(newVerts[vi]);
      const nextVK = _edgeVKey(newVerts[(vi + 1) % newVerts.length]);
      // intPt goes between trimPt and belowV
      if ((curVK === trimVK && nextVK === belowVK) ||
          (curVK === belowVK && nextVK === trimVK)) {
        insertPos = vi + 1;
        break;
      }
    }
    if (insertPos >= 0) {
      newVerts.splice(insertPos, 0, { ...intPt });
    }

    if (newVerts.length >= 3) {
      trimmedFace.vertices = newVerts;
    }

    // ── Also modify the previous fillet face that shares these arc
    //    edges.  The fillet face KEEPS the above-offset arc vertices
    //    (they become shared edges with the corner face) but needs the
    //    intersection point inserted between the last kept vertex and
    //    the first above-offset vertex. ──
    for (const otherFace of trimmedFaces) {
      if (otherFace === trimmedFace) continue;
      // Check if this face contains the above-offset vertices
      const otherN = otherFace.vertices.length;
      const firstAboveVK = _edgeVKey(above[0].vertex);
      const hasAbove = otherFace.vertices.some(
        (v) => _edgeVKey(v) === firstAboveVK,
      );
      if (!hasAbove) continue;

      // Find the position just before/after the above-offset arc span
      // and insert the intersection point there.
      const lastAboveVK = _edgeVKey(above[above.length - 1].vertex);
      const belowVK2 = _edgeVKey(belowV);
      let otherInsertPos = -1;
      for (let vi = 0; vi < otherN; vi++) {
        const curVK = _edgeVKey(otherFace.vertices[vi]);
        const nextVK = _edgeVKey(otherFace.vertices[(vi + 1) % otherN]);
        // Insert between belowV and lastAbove (they should be adjacent
        // on the fillet face since the boundary is reversed)
        if ((curVK === belowVK2 && nextVK === lastAboveVK) ||
            (curVK === lastAboveVK && nextVK === belowVK2)) {
          otherInsertPos = vi + 1;
          break;
        }
      }
      if (otherInsertPos >= 0) {
        otherFace.vertices.splice(otherInsertPos, 0, { ...intPt });
      }
    }

    // Only process one direction per trim point
    break;
  }
}

// -----------------------------------------------------------------------
// Main entry point
// -----------------------------------------------------------------------

function _buildExactFilletTopoBody(faces, edgeDataList, origTopoBody = null) {
  if (!faces || !Array.isArray(faces) || !edgeDataList || edgeDataList.length === 0) return null;

  // Build a lookup from topoFaceId → original TopoFace for BRep preservation
  const origTopoFaces = new Map();
  if (origTopoBody && origTopoBody.shells) {
    for (const shell of origTopoBody.shells) {
      for (const topoFace of (shell.faces || [])) {
        origTopoFaces.set(topoFace.id, topoFace);
      }
    }
  }

  // Build set of face indices that are adjacent to fillet edges (already trimmed in mesh)
  const filletAdjacentFaceIds = new Set();
  for (const data of edgeDataList) {
    const trimSources = Array.isArray(data._trimSourceData) && data._trimSourceData.length > 0
      ? data._trimSourceData
      : [data];
    for (const source of trimSources) {
      const face0 = faces[source.fi0];
      const face1 = faces[source.fi1];
      if (face0 && face0.topoFaceId !== undefined) filletAdjacentFaceIds.add(face0.topoFaceId);
      if (face1 && face1.topoFaceId !== undefined) filletAdjacentFaceIds.add(face1.topoFaceId);
    }
  }

  // Also consider faces with junction curves as adjacent —
  // they need the junction curve edge handling in the adjacent branch
  for (const f of faces) {
    if (f._junctionCurves && f._junctionCurves.length > 0 && f.topoFaceId !== undefined) {
      filletAdjacentFaceIds.add(f.topoFaceId);
    }
  }

  // Build a set of face indices that are adjacent to current fillet edges
  const filletAdjacentIndices = new Set();
  for (const data of edgeDataList) {
    const trimSources = Array.isArray(data._trimSourceData) && data._trimSourceData.length > 0
      ? data._trimSourceData
      : [data];
    for (const source of trimSources) {
      filletAdjacentIndices.add(source.fi0);
      filletAdjacentIndices.add(source.fi1);
    }
  }

  const faceDescs = [];

  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi];
    if (!face || face.isCorner) continue;

    // Check if this face has an original BRep face that should be preserved
    const topoFaceId = face.topoFaceId;
    const origFace = topoFaceId !== undefined ? origTopoFaces.get(topoFaceId) : null;
    const isNonPlanar = origFace && origFace.surfaceType !== 'plane';
    const isNotAdjacent = topoFaceId !== undefined && !filletAdjacentFaceIds.has(topoFaceId);

    if (origFace && !isNonPlanar && filletAdjacentIndices.has(fi)) {
      const rollingPlanarDesc = _buildRollingAdjacentPlanarFaceDesc(face, fi, origFace, edgeDataList);
      if (rollingPlanarDesc) {
        faceDescs.push(rollingPlanarDesc);
        continue;
      }
    }

    if (origFace && isNonPlanar) {
      if (isNotAdjacent) {
        // Non-adjacent non-planar: preserve original edge curves via replacement map
        const vertReplacements = _buildVertexReplacementMap(face, origFace);
        const desc = _buildOriginalFaceDesc(origFace, vertReplacements);
        if (desc) {
          faceDescs.push(desc);
          continue;
        }
      } else {
        // Adjacent non-planar (e.g., fillet face from a previous operation):
        // The boundary has already been trimmed in the main loop.  Build the
        // face descriptor directly from the trimmed vertices + original surface
        // so the curved surface is preserved in the output TopoBody.
        const trimmedVerts = face.vertices.map(v => ({ ...v }));
        if (trimmedVerts.length >= 3) {
          const junctionCurves = face._junctionCurves || [];
          const edgeCurves = [];
          for (let i = 0; i < trimmedVerts.length; i++) {
            const v1 = trimmedVerts[i];
            const v2 = trimmedVerts[(i + 1) % trimmedVerts.length];
            let edgeCurve = NurbsCurve.createLine(v1, v2);

            // Check if this edge matches a stored junction curve
            if (junctionCurves.length > 0) {
              const v1k = _edgeVKey(v1);
              const v2k = _edgeVKey(v2);
              for (const jc of junctionCurves) {
                const curveStart = jc.curve[0];
                const curveEnd = jc.curve[jc.curve.length - 1];
                const csVK = _edgeVKey(curveStart);
                const ceVK = _edgeVKey(curveEnd);
                if (v1k === csVK && v2k === ceVK) {
                  const c = _curveFromSampledPoints(jc.curve);
                  if (c) edgeCurve = c;
                  break;
                } else if (v1k === ceVK && v2k === csVK) {
                  const reversed = [...jc.curve].reverse();
                  const c = _curveFromSampledPoints(reversed);
                  if (c) edgeCurve = c;
                  break;
                }
              }
            }

            edgeCurves.push(edgeCurve);
          }
          faceDescs.push({
            surface: origFace.surface,
            surfaceType: origFace.surfaceType || SurfaceType.BSPLINE,
            surfaceInfo: origFace.surfaceInfo ? { ...origFace.surfaceInfo } : null,
            fusedGroupId: origFace.fusedGroupId || null,
            vertices: trimmedVerts,
            edgeCurves,
            sameSense: origFace.sameSense,
            shared: origFace.shared ? { ...origFace.shared } : null,
            stableHash: origFace.stableHash || null,
          });
          continue;
        }
      }
      // Fall through to planar if reconstruction fails
    }

    const desc = _buildPlanarFaceDesc(face, edgeDataList);
    if (!desc) return null;
    faceDescs.push(desc);
  }

  for (const data of edgeDataList) {
    const desc = _buildExactFilletFaceDesc(data);
    if (!desc) return null;
    faceDescs.push(desc);
  }

  // Include corner face descriptors (two-edge patches, trihedron patches, standalone)
  const cornerDescs = _buildExactCornerFaceDescs(faces);
  faceDescs.push(...cornerDescs);

  if (faceDescs.length === 0) return null;

  // Replace straight-line edge curves with arc curves on edges that match
  // fillet arc endpoints.  This must happen AFTER all face descriptors are
  // assembled so both the fillet face and its adjacent planar/non-planar
  // neighbours receive the same curve, ensuring buildTopoBody's edge
  // deduplication succeeds.
  _replaceEdgesWithArcCurves(faceDescs, edgeDataList, faces, origTopoFaces);

  return _capMixedFilletOpenLoops(faceDescs);
}

/**
 * Build a vertex replacement map by comparing the trimmed face's vertices
 * with the original TopoFace's loop vertices. When a vertex from the original
 * face is missing from the trimmed face, find the replacement vertices
 * that were inserted in its place, ordered to maintain face boundary winding.
 *
 * @param {Object} trimmedFace - The trimmed mesh face with modified vertices
 * @param {Object} origTopoFace - The original TopoFace from the input TopoBody
 * @returns {Map<string, Array<{x,y,z}>>} vertexKey → ordered replacement vertices
 */
function _buildVertexReplacementMap(trimmedFace, origTopoFace) {
  const replacements = new Map();
  if (!trimmedFace || !origTopoFace || !origTopoFace.outerLoop) return replacements;

  // Get original loop vertices in winding order
  const origVerts = [];
  for (const ce of origTopoFace.outerLoop.coedges) {
    const pt = ce.sameSense !== false
      ? ce.edge.startVertex.point
      : ce.edge.endVertex.point;
    origVerts.push({ ...pt });
  }

  // Get trimmed face vertices
  const trimVerts = trimmedFace.vertices || [];
  const trimVertKeys = new Set(trimVerts.map(v => _edgeVKey(v)));
  const origVertKeys = new Set(origVerts.map(v => _edgeVKey(v)));

  // For each original vertex missing from the trimmed face,
  // identify replacement vertices and order them by face boundary winding
  for (let oi = 0; oi < origVerts.length; oi++) {
    const origVk = _edgeVKey(origVerts[oi]);
    if (trimVertKeys.has(origVk)) continue;

    // This vertex was replaced. Find replacement vertices by looking at the
    // trimmed face's boundary walk — the replacements are vertices that aren't
    // in the original face and are near the removed vertex.
    const prevOrig = origVerts[(oi - 1 + origVerts.length) % origVerts.length];
    const nextOrig = origVerts[(oi + 1) % origVerts.length];
    const prevVk = _edgeVKey(prevOrig);
    const nextVk = _edgeVKey(nextOrig);

    // Walk the trimmed face vertices to find the segment between
    // the prev and next original vertices
    const trimN = trimVerts.length;
    let prevIdx = -1, nextIdx = -1;
    for (let ti = 0; ti < trimN; ti++) {
      const tvk = _edgeVKey(trimVerts[ti]);
      if (tvk === prevVk) prevIdx = ti;
      if (tvk === nextVk) nextIdx = ti;
    }

    if (prevIdx === -1 || nextIdx === -1) {
      // Can't find anchors — try to use proximity ordering instead
      const newVerts = trimVerts.filter(v => !origVertKeys.has(_edgeVKey(v)));
      if (newVerts.length > 0) {
        // Order by distance to previous original vertex (closest first in walk)
        const pv = prevOrig;
        newVerts.sort((a, b) => {
          const da = (a.x - pv.x) ** 2 + (a.y - pv.y) ** 2 + (a.z - pv.z) ** 2;
          const db = (b.x - pv.x) ** 2 + (b.y - pv.y) ** 2 + (b.z - pv.z) ** 2;
          return da - db;
        });
        replacements.set(origVk, newVerts);
      }
      continue;
    }

    // Extract vertices between prevIdx and nextIdx in the trimmed face walk
    const replVerts = [];
    let idx = (prevIdx + 1) % trimN;
    const maxSteps = trimN;
    let steps = 0;
    while (idx !== nextIdx && steps < maxSteps) {
      const tvk = _edgeVKey(trimVerts[idx]);
      if (!origVertKeys.has(tvk)) {
        replVerts.push({ ...trimVerts[idx] });
      }
      idx = (idx + 1) % trimN;
      steps++;
    }

    if (replVerts.length > 0) {
      replacements.set(origVk, replVerts);
    }
  }

  return replacements;
}

// -----------------------------------------------------------------------
// BRep-level fillet entry point
// -----------------------------------------------------------------------

function _debugBRepFillet(...args) {
  if (typeof process === 'undefined' || !process?.env?.DEBUG_BREP_FILLET) return;
  console.log('[applyBRepFillet]', ...args);
}

function _dist3(a, b) {
  return Math.hypot((a.x || 0) - (b.x || 0), (a.y || 0) - (b.y || 0), (a.z || 0) - (b.z || 0));
}

function _clonePoint(point) {
  return { x: point.x, y: point.y, z: point.z };
}

function _isNonLinearTopoEdge(topoEdge) {
  const curve = topoEdge && topoEdge.curve;
  return !!(curve && !(curve.degree === 1 && Array.isArray(curve.controlPoints) && curve.controlPoints.length === 2));
}

function _parseEdgeKeyPoints(edgeKey) {
  if (!edgeKey || typeof edgeKey !== 'string') return null;
  const sep = edgeKey.indexOf('|');
  if (sep < 0) return null;
  const parsePoint = (text) => {
    const coords = text.split(',').map(Number);
    if (coords.length !== 3 || coords.some(Number.isNaN)) return null;
    return { x: coords[0], y: coords[1], z: coords[2] };
  };
  const a = parsePoint(edgeKey.slice(0, sep));
  const b = parsePoint(edgeKey.slice(sep + 1));
  return a && b ? { a, b } : null;
}

function _selectionCoversTopoEdgeSpan(topoEdge, edgeKeys, tol = 0.08) {
  if (!topoEdge || !Array.isArray(edgeKeys) || edgeKeys.length === 0) return false;
  const start = topoEdge.startVertex && topoEdge.startVertex.point;
  const end = topoEdge.endVertex && topoEdge.endVertex.point;
  if (!start || !end) return false;

  let nearStart = Infinity;
  let nearEnd = Infinity;
  for (const key of edgeKeys) {
    const parsed = _parseEdgeKeyPoints(key);
    if (!parsed) continue;
    for (const point of [parsed.a, parsed.b]) {
      nearStart = Math.min(nearStart, _dist3(point, start));
      nearEnd = Math.min(nearEnd, _dist3(point, end));
    }
  }
  return nearStart <= tol && nearEnd <= tol;
}

function _topoEdgeDirectionFromVertex(edge, vertex) {
  if (!edge || !vertex) return null;
  if (edge.startVertex === vertex) return _vec3Normalize(_vec3Sub(edge.endVertex.point, edge.startVertex.point));
  if (edge.endVertex === vertex) return _vec3Normalize(_vec3Sub(edge.startVertex.point, edge.endVertex.point));
  return null;
}

function _topoEdgeOtherVertex(edge, vertex) {
  if (!edge || !vertex) return null;
  if (edge.startVertex === vertex) return edge.endVertex;
  if (edge.endVertex === vertex) return edge.startVertex;
  return null;
}

function _topoEdgeFaceIds(edge) {
  const ids = new Set();
  for (const coedge of edge?.coedges || []) {
    if (coedge.face?.id != null) ids.add(coedge.face.id);
  }
  return ids;
}

function _topoEdgesShareFace(edgeA, edgeB) {
  const ids = _topoEdgeFaceIds(edgeA);
  for (const id of _topoEdgeFaceIds(edgeB)) {
    if (ids.has(id)) return true;
  }
  return false;
}

function _isLinearTopoEdge(edge) {
  const curve = edge && edge.curve;
  return !!(curve && curve.degree === 1 && Array.isArray(curve.controlPoints) && curve.controlPoints.length === 2);
}

function _expandTangentChainFromEndpoint(topoBody, seedEdge, seedVertex, seedDir, dotThreshold = 0.92) {
  if (!topoBody || !seedEdge || !seedVertex || !seedDir) return [];
  const allEdges = [...topoBody.edges()];
  const chain = [];
  let previousEdge = seedEdge;
  let currentVertex = seedVertex;
  let currentDir = seedDir;
  const used = new Set([seedEdge.id]);

  for (let step = 0; step < 48; step++) {
    let best = null;
    for (const candidate of allEdges) {
      if (!candidate || used.has(candidate.id)) continue;
      if (candidate.startVertex !== currentVertex && candidate.endVertex !== currentVertex) continue;
      if (!_isLinearTopoEdge(candidate)) continue;
      if (!_topoEdgesShareFace(previousEdge, candidate)) continue;
      const dir = _topoEdgeDirectionFromVertex(candidate, currentVertex);
      if (!dir) continue;
      const score = _vec3Dot(dir, currentDir);
      if (score < dotThreshold) continue;
      if (!best || score > best.score) {
        best = { edge: candidate, dir, score };
      }
    }
    if (!best) break;
    const nextVertex = _topoEdgeOtherVertex(best.edge, currentVertex);
    if (!nextVertex) break;
    chain.push({ edge: best.edge, from: currentVertex, to: nextVertex });
    used.add(best.edge.id);
    previousEdge = best.edge;
    currentVertex = nextVertex;
    currentDir = best.dir;
  }

  return chain;
}

function _resolveFullSpanRollingTopoEdgeSelection(topoBody, edgeKeys, segments, edgeSampleSegments) {
  const selectedEdges = _selectedTopoEdgesForFilletKeys(topoBody, edgeKeys, segments);
  if (selectedEdges.length !== 1 || !_isNonLinearTopoEdge(selectedEdges[0])) return null;

  const topoEdge = selectedEdges[0];
  if (!_selectionCoversTopoEdgeSpan(topoEdge, edgeKeys)) return null;

  const rollingSampleSegments = Math.max(segments * 4, 32);
  const samples = _sampleExactEdgePoints(topoEdge, Math.min(edgeSampleSegments, rollingSampleSegments));
  if (!Array.isArray(samples) || samples.length < 3) return null;

  const startVertex = topoEdge.startVertex;
  const endVertex = topoEdge.endVertex;
  const startDir = _vec3Normalize(_vec3Sub(samples[0], samples[1]));
  const endDir = _vec3Normalize(_vec3Sub(samples[samples.length - 1], samples[samples.length - 2]));
  const startChain = _expandTangentChainFromEndpoint(topoBody, topoEdge, startVertex, startDir, 0.965);
  const endChain = _expandTangentChainFromEndpoint(topoBody, topoEdge, endVertex, endDir, 0.965);
  _debugBRepFillet('rolling-selection', {
    edgeId: topoEdge.id,
    samples: samples.length,
    startChain: startChain.map((entry) => entry.edge.id),
    endChain: endChain.map((entry) => entry.edge.id),
  });

  const orderedSamples = [];
  const segmentRefs = [];
  for (let i = startChain.length - 1; i >= 0; i--) {
    orderedSamples.push(_clonePoint(startChain[i].to.point));
    segmentRefs.push({ topoEdgeId: startChain[i].edge.id, direction: 'reverse-chain' });
  }
  orderedSamples.push(...samples.map(_clonePoint));
  for (let i = 0; i < samples.length - 1; i++) {
    segmentRefs.push({ topoEdgeId: topoEdge.id, direction: 'selected' });
  }
  for (const entry of endChain) {
    orderedSamples.push(_clonePoint(entry.to.point));
    segmentRefs.push({ topoEdgeId: entry.edge.id, direction: 'forward-chain' });
  }

  const segmentKeys = [];
  for (let i = 0; i < orderedSamples.length - 1; i++) {
    segmentKeys.push(_edgeKeyFromVerts(orderedSamples[i], orderedSamples[i + 1]));
  }
  return { topoEdge, samples: orderedSamples, segmentKeys, segmentRefs, startChain, endChain };
}

function _topoLoopDesc(loop) {
  const coedges = loop && Array.isArray(loop.coedges) ? loop.coedges : [];
  const vertices = [];
  const edgeCurves = [];
  for (const coedge of coedges) {
    const edge = coedge && coedge.edge;
    if (!edge) continue;
    vertices.push(_clonePoint((coedge.sameSense === false ? edge.endVertex : edge.startVertex).point));
    edgeCurves.push(coedge.sameSense === false && edge.curve && typeof edge.curve.reversed === 'function'
      ? edge.curve.reversed()
      : edge.curve || null);
  }
  return { vertices, edgeCurves };
}

function _topoFaceDesc(face, outerLoopDesc = null) {
  const outer = outerLoopDesc || _topoLoopDesc(face.outerLoop);
  const desc = {
    surface: face.surface || null,
    surfaceType: face.surfaceType || SurfaceType.UNKNOWN,
    vertices: outer.vertices,
    edgeCurves: outer.edgeCurves,
    sameSense: face.sameSense,
    shared: face.shared ? { ...face.shared } : null,
    fusedGroupId: face.fusedGroupId || undefined,
    stableHash: face.stableHash || undefined,
  };
  if (face.surfaceInfo) desc.surfaceInfo = { ...face.surfaceInfo };
  if (Array.isArray(face.innerLoops) && face.innerLoops.length > 0) {
    desc.innerLoops = face.innerLoops.map((loop) => _topoLoopDesc(loop));
  }
  return desc;
}

function _topoFaceDescReplacingEdge(face, edgeToReplace, replacement) {
  const coedges = face?.outerLoop?.coedges || [];
  const vertices = [];
  const edgeCurves = [];
  const originalStarts = [];
  const originalEnds = [];
  const replacedEdgeIndices = new Set();

  for (let i = 0; i < coedges.length; i++) {
    const coedge = coedges[i];
    const edge = coedge.edge;
    const orientedStart = (coedge.sameSense === false ? edge.endVertex : edge.startVertex).point;
    const orientedEnd = (coedge.sameSense === false ? edge.startVertex : edge.endVertex).point;
    originalStarts.push(orientedStart);
    originalEnds.push(orientedEnd);
    vertices.push(_clonePoint(orientedStart));
    edgeCurves.push(coedge.sameSense === false && edge.curve && typeof edge.curve.reversed === 'function'
      ? edge.curve.reversed()
      : edge.curve || null);
  }

  for (let i = 0; i < coedges.length; i++) {
    const coedge = coedges[i];
    const edge = coedge.edge;
    if (edge === edgeToReplace) {
      if (coedge.sameSense === false) {
        vertices[i] = _clonePoint(replacement.end);
        vertices[(i + 1) % coedges.length] = _clonePoint(replacement.start);
        edgeCurves[i] = replacement.curve && typeof replacement.curve.reversed === 'function'
          ? replacement.curve.reversed()
          : replacement.curve || null;
      } else {
        vertices[i] = _clonePoint(replacement.start);
        vertices[(i + 1) % coedges.length] = _clonePoint(replacement.end);
        edgeCurves[i] = replacement.curve || null;
      }
      replacedEdgeIndices.add(i);
    }
  }

  for (let i = 0; i < coedges.length; i++) {
    if (replacedEdgeIndices.has(i)) continue;
    const next = (i + 1) % coedges.length;
    const startChanged = _dist3(vertices[i], originalStarts[i]) > 1e-7;
    const endChanged = _dist3(vertices[next], originalEnds[i]) > 1e-7;
    const curve = edgeCurves[i];
    const isLinear = !curve || (curve.degree === 1 && Array.isArray(curve.controlPoints) && curve.controlPoints.length === 2);
    if ((startChanged || endChanged) && isLinear) {
      edgeCurves[i] = NurbsCurve.createLine(vertices[i], vertices[next]);
    }
  }
  return _topoFaceDesc(face, { vertices, edgeCurves });
}

function _faceHasPoint(face, point, tol = 1e-5) {
  for (const coedge of face?.outerLoop?.coedges || []) {
    const edge = coedge.edge;
    if (_dist3(edge.startVertex.point, point) <= tol || _dist3(edge.endVertex.point, point) <= tol) return true;
  }
  for (const loop of face?.innerLoops || []) {
    for (const coedge of loop.coedges || []) {
      const edge = coedge.edge;
      if (_dist3(edge.startVertex.point, point) <= tol || _dist3(edge.endVertex.point, point) <= tol) return true;
    }
  }
  return false;
}

function _orderedSplitForFace(prev, next, split) {
  const top = split.topPoint;
  const cyl = split.cylPoint;
  const scoreTopFirst = _dist3(prev, top) + _dist3(cyl, next);
  const scoreCylFirst = _dist3(prev, cyl) + _dist3(top, next);
  if (scoreCylFirst < scoreTopFirst) {
    return {
      first: cyl,
      second: top,
      curve: split.capCurve && typeof split.capCurve.reversed === 'function'
        ? split.capCurve.reversed()
        : split.capCurve,
    };
  }
  return { first: top, second: cyl, curve: split.capCurve };
}

function _topoFaceDescWithVertexSplits(face, splits) {
  const base = _topoLoopDesc(face.outerLoop);
  const originalVertices = base.vertices;
  const vertices = [];
  const capCurveByStartIndex = new Map();

  for (let i = 0; i < originalVertices.length; i++) {
    const vertex = originalVertices[i];
    const split = splits.find((candidate) => _dist3(vertex, candidate.vertex) <= 1e-5);
    if (!split) {
      vertices.push(vertex);
      continue;
    }

    const prev = originalVertices[(i + originalVertices.length - 1) % originalVertices.length];
    const next = originalVertices[(i + 1) % originalVertices.length];
    const ordered = _orderedSplitForFace(prev, next, split);
    const capStartIndex = vertices.length;
    vertices.push(_clonePoint(ordered.first), _clonePoint(ordered.second));
    capCurveByStartIndex.set(capStartIndex, ordered.curve || null);
  }

  const edgeCurves = [];
  for (let i = 0; i < vertices.length; i++) {
    if (capCurveByStartIndex.has(i)) {
      edgeCurves.push(capCurveByStartIndex.get(i));
    } else {
      edgeCurves.push(NurbsCurve.createLine(vertices[i], vertices[(i + 1) % vertices.length]));
    }
  }

  return _topoFaceDesc(face, { vertices, edgeCurves });
}

function _selectedTopoEdgesForFilletKeys(topoBody, edgeKeys, segments = 8) {
  if (!topoBody || !Array.isArray(edgeKeys) || edgeKeys.length === 0) return [];
  const selected = new Map();
  const sampleSegments = Math.max(segments * 4, 32);
  const segMap = _mapSegmentKeysToTopoEdges(topoBody, sampleSegments);
  const uniqueKeys = [...new Set(edgeKeys)];
  const exactByEndpoint = new Map();
  for (const edge of topoBody.edges()) {
    exactByEndpoint.set(_edgeKeyFromVerts(edge.startVertex.point, edge.endVertex.point), edge);
    exactByEndpoint.set(_edgeKeyFromVerts(edge.endVertex.point, edge.startVertex.point), edge);
  }

  for (const key of uniqueKeys) {
    let topoEdge = exactByEndpoint.get(key) || segMap.get(key) || null;
    if (!topoEdge) {
      const match = _nearestSampleSegmentForEdgeKey(key, segMap._allEdgeSamples);
      if (match && match.dist < 0.08) topoEdge = match.topoEdge;
    }
    if (topoEdge) selected.set(topoEdge.id, topoEdge);
  }
  return [...selected.values()];
}

function _adjacentFacesForTopoEdge(edge) {
  const faces = new Map();
  for (const coedge of edge?.coedges || []) {
    if (coedge.face) faces.set(coedge.face.id, coedge.face);
  }
  return [...faces.values()];
}

function _angleInBasis(vector, xAxis, yAxis) {
  return Math.atan2(_vec3Dot(vector, yAxis), _vec3Dot(vector, xAxis));
}

function _pointOnCircle(center, radius, xAxis, yAxis, angle) {
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  return _vec3Add(center, _vec3Scale(_vec3Add(_vec3Scale(xAxis, cosA), _vec3Scale(yAxis, sinA)), radius));
}

function _chooseArcSweep(endVector, midVector, xAxis, yAxis) {
  const endAngle = _angleInBasis(endVector, xAxis, yAxis);
  const candidates = [endAngle, endAngle + 2 * Math.PI, endAngle - 2 * Math.PI];
  let best = null;
  for (const sweep of candidates) {
    if (Math.abs(sweep) < 1e-8) continue;
    const midpoint = _pointOnCircle({ x: 0, y: 0, z: 0 }, 1, xAxis, yAxis, sweep * 0.5);
    const dist = _dist3(_vec3Normalize(midVector), _vec3Normalize(midpoint));
    if (!best || dist < best.dist) best = { sweep, dist };
  }
  return best ? best.sweep : endAngle;
}

function _faceCentroid(face) {
  const points = face?.outerLoop?.points ? face.outerLoop.points() : [];
  if (points.length === 0) return null;
  const sum = points.reduce((acc, point) => ({
    x: acc.x + point.x,
    y: acc.y + point.y,
    z: acc.z + point.z,
  }), { x: 0, y: 0, z: 0 });
  return _vec3Scale(sum, 1 / points.length);
}

function _createFilletCapArc(minorCenter, radius, axialTrimDir, radialDir, sideSign) {
  const topAxis = _vec3Scale(axialTrimDir, -1);
  const cylinderAxis = _vec3Scale(radialDir, -sideSign);
  return NurbsCurve.createArc(minorCenter, radius, topAxis, cylinderAxis, 0, Math.PI / 2);
}

function _finalizePlaneCylinderArcFillet(geometry, newTopoBody, segments = 8) {
  const topoBoundaryEdges = countTopoBodyBoundaryEdges(newTopoBody);
  if (topoBoundaryEdges !== 0) {
    _debugBRepFillet('plane-cylinder-arc-boundary-edges', { topoBoundaryEdges });
    if (typeof process !== 'undefined' && process?.env?.DEBUG_BREP_FILLET) {
      let dumped = 0;
      for (const edge of newTopoBody.edges()) {
        if ((edge.coedges || []).length === 2) continue;
        console.log('[applyBRepFillet] plane-cylinder-open-edge', {
          start: edge.startVertex.point,
          end: edge.endVertex.point,
          degree: edge.curve?.degree ?? null,
          coedges: (edge.coedges || []).map((coedge) => ({ face: coedge.face?.id, sameSense: coedge.sameSense })),
        });
        dumped++;
        if (dumped >= 16) break;
      }
    }
    return null;
  }

  let mesh;
  try {
    mesh = tessellateBody(newTopoBody, {
      validate: false,
      edgeSegments: Math.max(segments * 4, 32),
      surfaceSegments: Math.max(segments * 4, 32),
      preferWasm: true,
      requireWasm: true,
      incrementalCache: geometry && geometry._incrementalTessellationCache
        ? geometry._incrementalTessellationCache
        : null,
      dirtyFaceIds: geometry && !geometry.allFacesDirty && Array.isArray(geometry.invalidatedFaceIds)
        ? geometry.invalidatedFaceIds
        : null,
      fallbackOnInvalidWasm: false,
    });
  } catch (error) {
    _debugBRepFillet('plane-cylinder-arc-tessellate-failed', error?.message || String(error));
    return null;
  }

  if (!mesh || !mesh.faces || mesh.faces.length === 0) return null;
  const edgeResult = computeFeatureEdges(mesh.faces);
  const brepFaces = [];
  for (const shell of newTopoBody.shells || []) {
    for (const face of shell.faces || []) {
      brepFaces.push({
        id: face.id,
        surfaceType: face.surfaceType === 'sphere' ? 'spherical' : face.surfaceType,
        surface: face.surface || null,
        surfaceInfo: face.surfaceInfo ? { ...face.surfaceInfo } : null,
        sameSense: face.sameSense,
        shared: face.shared || null,
      });
    }
  }

  return {
    vertices: mesh.vertices || [],
    faces: mesh.faces,
    edges: edgeResult.edges,
    paths: edgeResult.paths,
    visualEdges: edgeResult.visualEdges,
    topoBody: newTopoBody,
    brep: { faces: brepFaces },
    _tessellator: mesh._tessellator || null,
    incrementalTessellation: mesh.incrementalTessellation || null,
    _incrementalTessellationCache: mesh._incrementalTessellationCache || null,
  };
}

function _tryApplyPlaneCylinderArcFillet(geometry, edgeKeys, radius, segments) {
  const topoBody = geometry && geometry.topoBody;
  const selectedEdges = _selectedTopoEdgesForFilletKeys(topoBody, edgeKeys, segments);
  if (selectedEdges.length !== 1 || !_isNonLinearTopoEdge(selectedEdges[0])) return undefined;

  const selectedEdge = selectedEdges[0];
  const adjacentFaces = _adjacentFacesForTopoEdge(selectedEdge);
  const planeFace = adjacentFaces.find((face) => face.surfaceType === SurfaceType.PLANE) || null;
  const cylinderFace = adjacentFaces.find((face) => face.surfaceType === SurfaceType.CYLINDER) || null;
  if (!planeFace || !cylinderFace) return undefined;

  const plane = topoFacePlane(planeFace);
  if (!plane) return null;

  const samples = selectedEdge.tessellate(Math.max(segments * 4, 64));
  if (!Array.isArray(samples) || samples.length < 3) return null;
  const start = selectedEdge.startVertex.point;
  const end = selectedEdge.endVertex.point;
  const mid = samples[Math.floor(samples.length / 2)];
  const circleCenter = _circumCenter3D(start, mid, end);
  if (!circleCenter || !Number.isFinite(circleCenter.x) || !Number.isFinite(circleCenter.y) || !Number.isFinite(circleCenter.z)) return null;

  const edgeRadius = _dist3(start, circleCenter);
  if (edgeRadius <= radius + 1e-8) return null;
  const planeNormal = _vec3Normalize(plane.n);
  const xAxis = _vec3Normalize(_vec3Sub(start, circleCenter));
  const yAxis = _vec3Normalize(_vec3Cross(planeNormal, xAxis));
  if (_vec3Len(yAxis) < 1e-10) return null;
  const endVector = _vec3Sub(end, circleCenter);
  const midVector = _vec3Sub(mid, circleCenter);
  const sweep = _chooseArcSweep(endVector, midVector, xAxis, yAxis);
  if (Math.abs(sweep) < 1e-8 || Math.abs(sweep) > Math.PI * 1.05) return undefined;

  const midRadial = _vec3Normalize(midVector);
  const plusProbe = _vec3Add(circleCenter, _vec3Scale(midRadial, edgeRadius + radius));
  const minusProbe = _vec3Add(circleCenter, _vec3Scale(midRadial, edgeRadius - radius));
  const plusInside = pointInTopoFaceDomain(planeFace, plusProbe, 1e-5);
  const minusInside = pointInTopoFaceDomain(planeFace, minusProbe, 1e-5);
  const sideSign = plusInside && !minusInside ? 1 : (!plusInside && minusInside ? -1 : 1);
  const trimRadius = edgeRadius + sideSign * radius;
  if (trimRadius <= 1e-8) return null;

  const cylinderCentroid = _faceCentroid(cylinderFace);
  const axialTrimDir = cylinderCentroid && _vec3Dot(_vec3Sub(cylinderCentroid, circleCenter), planeNormal) >= 0
    ? planeNormal
    : _vec3Scale(planeNormal, -1);
  const cylinderTrimCenter = _vec3Add(circleCenter, _vec3Scale(axialTrimDir, radius));

  const topCurve = NurbsCurve.createArc(circleCenter, trimRadius, xAxis, yAxis, 0, sweep);
  const cylinderCurve = NurbsCurve.createArc(cylinderTrimCenter, edgeRadius, xAxis, yAxis, 0, sweep);
  const topStart = topCurve.evaluate(0);
  const topEnd = topCurve.evaluate(1);
  const cylStart = cylinderCurve.evaluate(0);
  const cylEnd = cylinderCurve.evaluate(1);
  const endRadial = _vec3Normalize(_vec3Sub(end, circleCenter));
  const startCenter = _vec3Add(cylinderTrimCenter, _vec3Scale(xAxis, trimRadius));
  const endCenter = _vec3Add(cylinderTrimCenter, _vec3Scale(endRadial, trimRadius));
  const capStart = _createFilletCapArc(startCenter, radius, axialTrimDir, xAxis, sideSign);
  const capEnd = _createFilletCapArc(endCenter, radius, axialTrimDir, endRadial, sideSign);

  const faceDescs = [];
  for (const face of topoBody.faces()) {
    if (face === planeFace) {
      faceDescs.push(_topoFaceDescReplacingEdge(face, selectedEdge, { start: topStart, end: topEnd, curve: topCurve }));
      continue;
    }
    if (face === cylinderFace) {
      faceDescs.push(_topoFaceDescReplacingEdge(face, selectedEdge, { start: cylStart, end: cylEnd, curve: cylinderCurve }));
      continue;
    }

    const splits = [];
    if (_faceHasPoint(face, start)) {
      splits.push({ vertex: start, topPoint: topStart, cylPoint: cylStart, capCurve: capStart });
    }
    if (_faceHasPoint(face, end)) {
      splits.push({ vertex: end, topPoint: topEnd, cylPoint: cylEnd, capCurve: capEnd });
    }
    faceDescs.push(splits.length > 0 ? _topoFaceDescWithVertexSplits(face, splits) : _topoFaceDesc(face));
  }

  faceDescs.push({
    surface: null,
    surfaceType: SurfaceType.TORUS,
    vertices: [_clonePoint(topStart), _clonePoint(topEnd), _clonePoint(cylEnd), _clonePoint(cylStart)],
    edgeCurves: [topCurve, capEnd, cylinderCurve.reversed(), capStart.reversed()],
    sameSense: true,
    shared: { isFillet: true, isFilletFace: true, isPlaneCylinderArcFillet: true, radius },
    surfaceInfo: {
      type: 'torus',
      origin: _clonePoint(cylinderTrimCenter),
      axis: _clonePoint(planeNormal),
      xDir: _clonePoint(xAxis),
      yDir: _clonePoint(yAxis),
      majorR: trimRadius,
      minorR: radius,
    },
  });

  const newTopoBody = buildTopoBody(faceDescs);
  return _finalizePlaneCylinderArcFillet(geometry, newTopoBody, segments);
}

function _nearestSampleSegmentForEdgeKey(edgeKey, allEdgeSamples) {
  if (!edgeKey || !Array.isArray(allEdgeSamples) || allEdgeSamples.length === 0) return null;
  const sep = edgeKey.indexOf('|');
  if (sep < 0) return null;
  const aCoords = edgeKey.slice(0, sep).split(',').map(Number);
  const bCoords = edgeKey.slice(sep + 1).split(',').map(Number);
  if (aCoords.length !== 3 || bCoords.length !== 3 || aCoords.some(Number.isNaN) || bCoords.some(Number.isNaN)) return null;
  const mid = {
    x: (aCoords[0] + bCoords[0]) * 0.5,
    y: (aCoords[1] + bCoords[1]) * 0.5,
    z: (aCoords[2] + bCoords[2]) * 0.5,
  };

  let best = null;
  for (const { topoEdge, samples } of allEdgeSamples) {
    if (!topoEdge || !Array.isArray(samples) || samples.length < 2) continue;
    for (let i = 0; i < samples.length - 1; i++) {
      const s0 = samples[i];
      const s1 = samples[i + 1];
      const dx = s1.x - s0.x;
      const dy = s1.y - s0.y;
      const dz = s1.z - s0.z;
      const lenSq = dx * dx + dy * dy + dz * dz;
      let t = 0;
      if (lenSq > 1e-20) {
        t = ((mid.x - s0.x) * dx + (mid.y - s0.y) * dy + (mid.z - s0.z) * dz) / lenSq;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
      }
      const px = s0.x + t * dx;
      const py = s0.y + t * dy;
      const pz = s0.z + t * dz;
      const dist = Math.sqrt((mid.x - px) ** 2 + (mid.y - py) ** 2 + (mid.z - pz) ** 2);
      if (!best || dist < best.dist) {
        best = { topoEdge, sampleKey: _edgeKeyFromVerts(s0, s1), dist };
      }
    }
  }
  return best;
}

function _resolveFilletEdgeKeysToExactTopoEdges(topoBody, edgeKeys, segments = 8) {
  if (!topoBody || !Array.isArray(edgeKeys) || edgeKeys.length === 0) return [];

  const segMap = _mapSegmentKeysToTopoEdges(topoBody, Math.max(segments * 4, 32));
  const uniqueKeys = [...new Set(edgeKeys)];
  const exactTopoEdges = new Map();
  const curvedSegmentKeys = [];
  const unmatchedKeys = [];

  for (const key of uniqueKeys) {
    const topoEdge = segMap.get(key);
    if (topoEdge) {
      const curve = topoEdge.curve;
      const isLinear = !curve || (
        curve.degree === 1 &&
        Array.isArray(curve.controlPoints) &&
        curve.controlPoints.length === 2
      );
      if (isLinear) exactTopoEdges.set(topoEdge.id, topoEdge);
      else curvedSegmentKeys.push(key);
    } else {
      unmatchedKeys.push(key);
    }
  }

  if (unmatchedKeys.length > 0) {
    const stillUnmatched = [];
    for (const key of unmatchedKeys) {
      const match = _nearestSampleSegmentForEdgeKey(key, segMap._allEdgeSamples);
      if (!match || match.dist >= 0.08) {
        stillUnmatched.push(key);
        continue;
      }

      const curve = match.topoEdge.curve;
      const isLinear = !curve || (
        curve.degree === 1 &&
        Array.isArray(curve.controlPoints) &&
        curve.controlPoints.length === 2
      );
      if (isLinear) exactTopoEdges.set(match.topoEdge.id, match.topoEdge);
      else curvedSegmentKeys.push(match.sampleKey);
    }
    if (stillUnmatched.length > 0) {
      _proximityMatchEdgeKeys(stillUnmatched, segMap._allEdgeSamples, exactTopoEdges);
    }
  }

  return [
    ...new Set(curvedSegmentKeys),
    ...[...exactTopoEdges.values()].map((topoEdge) => _edgeKeyFromVerts(
    topoEdge.startVertex.point,
    topoEdge.endVertex.point,
    )),
  ];
}

function _pointFinite(point) {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
}

function _averagePoints(points) {
  const valid = points.filter(_pointFinite);
  if (valid.length === 0) return null;
  const sum = valid.reduce((acc, point) => ({
    x: acc.x + point.x,
    y: acc.y + point.y,
    z: acc.z + point.z,
  }), { x: 0, y: 0, z: 0 });
  return _vec3Scale(sum, 1 / valid.length);
}

function _centerFromFilletArc(arc, fallbackData, fallbackVertex) {
  if (Array.isArray(arc) && arc.length >= 3) {
    const center = _circumCenter3D(arc[0], arc[Math.floor(arc.length / 2)], arc[arc.length - 1]);
    if (_pointFinite(center)) return center;
  }

  if (fallbackData && fallbackVertex) {
    const { offsDir0, offsDir1 } = _computeOffsetDirs(
      fallbackData._face0,
      fallbackData._face1,
      fallbackData.edgeA,
      fallbackData.edgeB,
    );
    const alpha = Math.acos(Math.max(-1, Math.min(1, _vec3Dot(offsDir0, offsDir1))));
    const centerDist = alpha > 1e-6 ? fallbackData.radius / Math.sin(alpha / 2) : fallbackData.radius;
    const bisector = _vec3Normalize(_vec3Add(offsDir0, offsDir1));
    if (_vec3Len(bisector) > 1e-10) return _vec3Add(fallbackVertex, _vec3Scale(bisector, centerDist));
  }

  return null;
}

function _fitRollingCenterToRadius(rail0, rail1, radius, referenceCenter) {
  if (!_pointFinite(rail0) || !_pointFinite(rail1) || !Number.isFinite(radius) || radius <= 0) return null;
  const chord = _vec3Sub(rail1, rail0);
  const chordLen = _vec3Len(chord);
  if (chordLen < 1e-12 || chordLen > radius * 2 + 1e-6) return null;
  const mid = _vec3Scale(_vec3Add(rail0, rail1), 0.5);
  const chordDir = _vec3Scale(chord, 1 / chordLen);
  let refDir = referenceCenter && _pointFinite(referenceCenter)
    ? _vec3Sub(referenceCenter, mid)
    : null;
  if (refDir) {
    refDir = _vec3Sub(refDir, _vec3Scale(chordDir, _vec3Dot(refDir, chordDir)));
  }
  if (!refDir || _vec3Len(refDir) < 1e-10) {
    const fallbackAxis = Math.abs(chordDir.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
    refDir = _vec3Cross(chordDir, fallbackAxis);
  }
  const normal = _vec3Normalize(refDir);
  if (_vec3Len(normal) < 1e-10) return null;
  const halfChord = chordLen * 0.5;
  const height = Math.sqrt(Math.max(0, radius * radius - halfChord * halfChord));
  return _vec3Add(mid, _vec3Scale(normal, height));
}

function _repairRollingEndpointCenter(endpoint, referenceEndpoint, radius) {
  if (!endpoint || !referenceEndpoint || !_pointFinite(endpoint.p0) || !_pointFinite(endpoint.p1)) return;
  if (_dist3(endpoint.p0, endpoint.p1) < 1e-10) {
    const referenceCenter = referenceEndpoint.center;
    if (_pointFinite(referenceCenter)) {
      const direction = _vec3Normalize(_vec3Sub(referenceCenter, endpoint.p0));
      if (_vec3Len(direction) > 1e-10) endpoint.center = _vec3Add(endpoint.p0, _vec3Scale(direction, radius));
    }
    return;
  }
  const center = endpoint.center;
  const r0 = center && _pointFinite(center) ? _vec3Len(_vec3Sub(endpoint.p0, center)) : Infinity;
  const r1 = center && _pointFinite(center) ? _vec3Len(_vec3Sub(endpoint.p1, center)) : Infinity;
  const tolerance = Math.max(1e-4, radius * 1e-3);
  if (Math.abs(r0 - radius) <= tolerance && Math.abs(r1 - radius) <= tolerance) return;
  const fitted = _fitRollingCenterToRadius(endpoint.p0, endpoint.p1, radius, referenceEndpoint.center);
  if (fitted) endpoint.center = fitted;
}

function _rollingEndpointChord(endpoint) {
  if (!endpoint || !_pointFinite(endpoint.p0) || !_pointFinite(endpoint.p1)) return 0;
  return _vec3Len(_vec3Sub(endpoint.p1, endpoint.p0));
}

function _expandRollingEndpointChord(endpoint, radius, targetChord) {
  if (!endpoint || !_pointFinite(endpoint.p0) || !_pointFinite(endpoint.p1) || !_pointFinite(endpoint.center)) return false;
  if (!Number.isFinite(radius) || radius <= 0 || !Number.isFinite(targetChord) || targetChord <= 0) return false;
  const currentChord = _rollingEndpointChord(endpoint);
  const clampedTarget = Math.min(targetChord, radius * 1.998);
  if (currentChord >= clampedTarget * 0.985) return false;

  const v0 = _vec3Sub(endpoint.p0, endpoint.center);
  const v1 = _vec3Sub(endpoint.p1, endpoint.center);
  const r0 = _vec3Len(v0);
  const r1 = _vec3Len(v1);
  if (r0 < radius * 0.25 || r1 < radius * 0.25) return false;
  const u0 = _vec3Scale(v0, 1 / r0);
  const u1 = _vec3Scale(v1, 1 / r1);
  let midDir = _vec3Add(u0, u1);
  if (_vec3Len(midDir) < 1e-10) return false;
  midDir = _vec3Normalize(midDir);
  let spreadDir = _vec3Sub(u1, u0);
  spreadDir = _vec3Sub(spreadDir, _vec3Scale(midDir, _vec3Dot(spreadDir, midDir)));
  if (_vec3Len(spreadDir) < 1e-10) return false;
  spreadDir = _vec3Normalize(spreadDir);

  const halfAngle = Math.asin(Math.max(0, Math.min(0.999, clampedTarget / (2 * radius))));
  const midScale = Math.cos(halfAngle);
  const spreadScale = Math.sin(halfAngle);
  const next0 = _vec3Normalize(_vec3Sub(_vec3Scale(midDir, midScale), _vec3Scale(spreadDir, spreadScale)));
  const next1 = _vec3Normalize(_vec3Add(_vec3Scale(midDir, midScale), _vec3Scale(spreadDir, spreadScale)));
  const candidate0 = _vec3Add(endpoint.center, _vec3Scale(next0, radius));
  const candidate1 = _vec3Add(endpoint.center, _vec3Scale(next1, radius));
  const sameOrder = _dist3(candidate0, endpoint.p0) + _dist3(candidate1, endpoint.p1)
    <= _dist3(candidate0, endpoint.p1) + _dist3(candidate1, endpoint.p0);
  endpoint.p0 = sameOrder ? candidate0 : candidate1;
  endpoint.p1 = sameOrder ? candidate1 : candidate0;
  return true;
}

function _stabilizeRollingFilletSectionWidths(endpoints, sections, faces, radius) {
  if (!Array.isArray(endpoints) || endpoints.length < 3 || !Array.isArray(sections)) return;
  for (const section of sections) {
    const face0 = faces && faces[section.face0];
    const face1 = faces && faces[section.face1];
    if (!face0?.isFillet || !face1?.isFillet) continue;
    const start = Math.max(0, Math.min(endpoints.length - 1, section.startIndex | 0));
    const end = Math.max(start + 1, Math.min(endpoints.length - 1, section.endIndex | 0));
    const startChord = _rollingEndpointChord(endpoints[start]);
    const endChord = _rollingEndpointChord(endpoints[end]);
    const targetChord = Math.min(radius * 0.75, Math.max(startChord, endChord));
    if (!Number.isFinite(targetChord) || targetChord <= radius * 0.5) continue;
    for (let i = start + 1; i < end; i++) {
      _expandRollingEndpointChord(endpoints[i], radius, targetChord);
    }
  }
}

function _orientedSegmentEndpoint(data, samples, sampleIndex, atEnd) {
  const sampleA = samples[sampleIndex];
  const sampleB = samples[sampleIndex + 1];
  const forwardScore = _dist3(data.edgeA, sampleA) + _dist3(data.edgeB, sampleB);
  const reverseScore = _dist3(data.edgeA, sampleB) + _dist3(data.edgeB, sampleA);
  const forward = forwardScore <= reverseScore;
  const isEdgeA = atEnd ? !forward : forward;
  const point = isEdgeA ? data.edgeA : data.edgeB;
  const p0 = isEdgeA ? data.p0a : data.p0b;
  const p1 = isEdgeA ? data.p1a : data.p1b;
  const arc = isEdgeA ? data.arcA : data.arcB;
  return { data, isEdgeA, point, p0, p1, arc };
}

function _setSegmentEndpointTrim(endpoint, p0, p1) {
  if (!endpoint || !endpoint.data || !p0 || !p1) return;
  if (endpoint.isEdgeA) {
    endpoint.data.p0a = { ...p0 };
    endpoint.data.p1a = { ...p1 };
  } else {
    endpoint.data.p0b = { ...p0 };
    endpoint.data.p1b = { ...p1 };
  }
}

function _setSegmentEndpointArc(endpoint, arc) {
  if (!endpoint || !endpoint.data || !Array.isArray(arc) || arc.length < 2) return;
  const curve = _curveFromSampledPoints(arc);
  if (endpoint.isEdgeA) {
    endpoint.data.arcA = arc.map((point) => ({ ...point }));
    endpoint.data._exactArcCurveA = curve;
    endpoint.data._useArcCurveA = true;
  } else {
    endpoint.data.arcB = arc.map((point) => ({ ...point }));
    endpoint.data._exactArcCurveB = curve;
    endpoint.data._useArcCurveB = true;
  }
}

function _isPlanarFeatureFace(face) {
  return !!face && (!face.surfaceType || face.surfaceType === SurfaceType.PLANE || face.surfaceType === 'plane');
}

function _projectPointToFeatureFacePlane(face, point) {
  if (!_isPlanarFeatureFace(face) || !point || !face.normal || !Array.isArray(face.vertices) || face.vertices.length === 0) return point;
  const normal = _vec3Normalize(face.normal);
  if (_vec3Len(normal) < 1e-10) return point;
  const planePoint = face.vertices[0];
  const distance = _vec3Dot(_vec3Sub(point, planePoint), normal);
  return _vec3Sub(point, _vec3Scale(normal, distance));
}

function _projectPointToFeatureFaceSurface(face, point) {
  if (!face || !point) return point;
  if (_isPlanarFeatureFace(face)) return _projectPointToFeatureFacePlane(face, point);
  const surface = face.surface;
  if (!surface || typeof surface.closestPointUV !== 'function' || typeof surface.evaluate !== 'function') return point;
  try {
    const uv = surface.closestPointUV(point);
    if (!uv || !Number.isFinite(uv.u) || !Number.isFinite(uv.v)) return point;
    const projected = surface.evaluate(uv.u, uv.v);
    return projected && _pointFinite(projected) ? projected : point;
  } catch (_error) {
    return point;
  }
}

function _projectRollingEndpointRailToPlanarOwners(endpoint, side, faces) {
  if (!endpoint || !Array.isArray(endpoint.setters)) return null;
  let point = side === 0 ? endpoint.p0 : endpoint.p1;
  if (!point) return null;
  for (const setter of endpoint.setters) {
    const data = setter && setter.data;
    if (!data) continue;
    const faceIndex = side === 0 ? data.fi0 : data.fi1;
    const face = faces && faces[faceIndex];
    if (!_isPlanarFeatureFace(face)) continue;
    point = _projectPointToFeatureFacePlane(face, point);
  }
  return point;
}

function _edgeDirectionAwayFromPoint(edge, point, tol = 1e-5) {
  if (!edge || !point) return null;
  if (_dist3(edge.startVertex.point, point) <= tol) {
    const dir = _vec3Normalize(_vec3Sub(edge.endVertex.point, point));
    return _vec3Len(dir) > 1e-10 ? dir : null;
  }
  if (_dist3(edge.endVertex.point, point) <= tol) {
    const dir = _vec3Normalize(_vec3Sub(edge.startVertex.point, point));
    return _vec3Len(dir) > 1e-10 ? dir : null;
  }
  return null;
}

function _edgeHasFace(edge, face) {
  if (!edge || !face) return false;
  return (edge.coedges || []).some((coedge) => coedge.face === face);
}

function _capFaceDirectionSharedWithSupport(capFace, supportFace, vertexPoint) {
  if (!capFace || !supportFace || !vertexPoint) return null;
  for (const coedge of capFace.outerLoop?.coedges || []) {
    const edge = coedge.edge;
    if (!_edgeHasFace(edge, supportFace)) continue;
    const dir = _edgeDirectionAwayFromPoint(edge, vertexPoint);
    if (dir) return dir;
  }
  return null;
}

function _pruneSingleUseDegenerateCoedges(topoBody, tolerance = 1e-9) {
  if (!topoBody || typeof topoBody.faces !== 'function') return 0;
  let removed = 0;
  for (const face of topoBody.faces()) {
    for (const loop of face.allLoops ? face.allLoops() : [face.outerLoop, ...(face.innerLoops || [])]) {
      if (!loop || !Array.isArray(loop.coedges) || loop.coedges.length <= 3) continue;
      const removeSet = new Set();
      for (const coedge of loop.coedges) {
        const edge = coedge && coedge.edge;
        const isDegenerate = edge && _dist3(edge.startVertex.point, edge.endVertex.point) <= tolerance;
        if (isDegenerate && (edge.coedges || []).length <= 1) {
          removeSet.add(coedge);
        }
      }
      if (removeSet.size === 0 || loop.coedges.length - removeSet.size < 3) continue;
      loop.coedges = loop.coedges.filter((coedge) => !removeSet.has(coedge));
      for (const coedge of removeSet) {
        const edge = coedge.edge;
        edge.coedges = (edge.coedges || []).filter((candidate) => candidate !== coedge);
        coedge.loop = null;
        coedge.face = null;
        removed++;
      }
    }
  }
  return removed;
}

function _simplePlanarRollingTerminalCap(topoBody, faces, endpoint, radius, segments) {
  const setter = endpoint?.setters?.[0];
  const data = setter?.data;
  if (!topoBody || !data || !endpoint?.point || !Number.isFinite(radius) || radius <= 0) return null;

  let selectedEdge = findTopoEdgeByEndpoints(topoBody, data.edgeA, data.edgeB);
  if (!selectedEdge && setter.topoEdgeId != null && typeof topoBody.edges === 'function') {
    selectedEdge = [...topoBody.edges()].find((edge) => edge.id === setter.topoEdgeId) || null;
  }
  if (!selectedEdge) return null;
  const topoFaceById = buildTopoFaceById(topoBody);
  const support0 = faces?.[data.fi0]?.topoFaceId != null ? topoFaceById.get(faces[data.fi0].topoFaceId) : null;
  const support1 = faces?.[data.fi1]?.topoFaceId != null ? topoFaceById.get(faces[data.fi1].topoFaceId) : null;
  if (!support0 || !support1) return null;

  const capFace = findTerminalCapFace(topoBody, selectedEdge, support0, support1, endpoint.point);
  const capPlane = topoFacePlane(capFace);
  if (!capFace || !capPlane) return null;

  const dir0 = _capFaceDirectionSharedWithSupport(capFace, support0, endpoint.point);
  const dir1 = _capFaceDirectionSharedWithSupport(capFace, support1, endpoint.point);
  if (!dir0 || !dir1) return null;

  const dot = Math.max(-1, Math.min(1, _vec3Dot(dir0, dir1)));
  const theta = Math.acos(dot);
  if (theta < 1e-5 || Math.abs(Math.PI - theta) < 1e-5) return null;

  const tangentDist = radius / Math.tan(theta / 2);
  if (!Number.isFinite(tangentDist) || tangentDist <= 1e-9) return null;
  const p0 = _vec3Add(endpoint.point, _vec3Scale(dir0, tangentDist));
  const p1 = _vec3Add(endpoint.point, _vec3Scale(dir1, tangentDist));
  if (!pointInTopoFaceDomain(capFace, p0, 1e-4) || !pointInTopoFaceDomain(capFace, p1, 1e-4)) return null;

  const bisector = _vec3Normalize(_vec3Add(dir0, dir1));
  if (_vec3Len(bisector) < 1e-10) return null;
  const capCenter = _vec3Add(endpoint.point, _vec3Scale(bisector, radius / Math.sin(theta / 2)));
  const startVec = _vec3Normalize(_vec3Sub(p0, capCenter));
  const endVec = _vec3Normalize(_vec3Sub(p1, capCenter));
  if (_vec3Len(startVec) < 1e-10 || _vec3Len(endVec) < 1e-10) return null;

  let capNormal = _vec3Normalize(capPlane.n);
  if (_vec3Len(capNormal) < 1e-10) return null;
  let yAxis = _vec3Normalize(_vec3Cross(capNormal, startVec));
  if (_vec3Len(yAxis) < 1e-10) {
    capNormal = _vec3Scale(capNormal, -1);
    yAxis = _vec3Normalize(_vec3Cross(capNormal, startVec));
  }
  if (_vec3Len(yAxis) < 1e-10) return null;

  let sweep = Math.atan2(_vec3Dot(endVec, yAxis), _vec3Dot(endVec, startVec));
  const midVec = _vec3Normalize(_vec3Add(
    _vec3Scale(startVec, Math.cos(sweep * 0.5)),
    _vec3Scale(yAxis, Math.sin(sweep * 0.5)),
  ));
  const cornerVec = _vec3Normalize(_vec3Sub(endpoint.point, capCenter));
  if (_vec3Len(cornerVec) > 1e-10 && _vec3Dot(midVec, cornerVec) < 0) {
    sweep = sweep >= 0 ? sweep - 2 * Math.PI : sweep + 2 * Math.PI;
  }
  if (!Number.isFinite(sweep) || Math.abs(sweep) < 1e-6 || Math.abs(sweep) > Math.PI + 1e-4) return null;

  const arc = [];
  const sampleCount = Math.max(2, segments | 0);
  for (let segmentIndex = 0; segmentIndex <= sampleCount; segmentIndex++) {
    const theta = (segmentIndex / sampleCount) * sweep;
    arc.push(_vec3Add(capCenter, _vec3Add(
      _vec3Scale(startVec, radius * Math.cos(theta)),
      _vec3Scale(yAxis, radius * Math.sin(theta)),
    )));
  }
  if (!Array.isArray(arc) || arc.length < 2) return null;
  arc[0] = { ...p0 };
  arc[arc.length - 1] = { ...p1 };
  return { p0, p1, arc };
}

function _findSampleSegmentIndexForData(data, samples) {
  const mid = _vec3Scale(_vec3Add(data.edgeA, data.edgeB), 0.5);
  let best = null;
  for (let i = 0; i < samples.length - 1; i++) {
    const sampleMid = _vec3Scale(_vec3Add(samples[i], samples[i + 1]), 0.5);
    const dist = _dist3(mid, sampleMid);
    if (!best || dist < best.dist) best = { index: i, dist };
  }
  return best;
}

function _buildRollingRailOwnershipSpans(indexed, side) {
  if (!Array.isArray(indexed) || indexed.length === 0) return [];
  const faceKey = (entry) => side === 0 ? entry.data.fi0 : entry.data.fi1;
  const spans = [];
  let startIndex = 0;
  let currentFaceIndex = faceKey(indexed[0]);
  for (let i = 1; i < indexed.length; i++) {
    const nextFaceIndex = faceKey(indexed[i]);
    if (nextFaceIndex === currentFaceIndex) continue;
    spans.push({ startIndex, endIndex: i, faceIndex: currentFaceIndex });
    startIndex = i;
    currentFaceIndex = nextFaceIndex;
  }
  spans.push({ startIndex, endIndex: indexed.length, faceIndex: currentFaceIndex });
  return spans;
}

function _rollingPrimitiveSectionKey(indexedEntry, segmentRef) {
  const data = indexedEntry && indexedEntry.data;
  const topoEdgeId = segmentRef && segmentRef.topoEdgeId != null ? segmentRef.topoEdgeId : 'unknown';
  const fi0 = data ? data.fi0 : 'unknown';
  const fi1 = data ? data.fi1 : 'unknown';
  return `${topoEdgeId}|${fi0}|${fi1}`;
}

function _buildRollingPrimitiveSections(indexed, rollingSelection, endpoints) {
  if (!Array.isArray(indexed) || indexed.length === 0) return [];
  const segmentRefs = Array.isArray(rollingSelection?.segmentRefs) && rollingSelection.segmentRefs.length === indexed.length
    ? rollingSelection.segmentRefs
    : indexed.map((entry) => ({ topoEdgeId: entry.data?.topoEdgeId ?? null, direction: 'unknown' }));

  const ranges = [];
  let startIndex = 0;
  let currentKey = _rollingPrimitiveSectionKey(indexed[0], segmentRefs[0]);
  for (let i = 1; i < indexed.length; i++) {
    const nextKey = _rollingPrimitiveSectionKey(indexed[i], segmentRefs[i]);
    if (nextKey === currentKey) continue;
    ranges.push({ startIndex, endIndex: i });
    startIndex = i;
    currentKey = nextKey;
  }
  ranges.push({ startIndex, endIndex: indexed.length });

  return ranges.map((range, sectionIndex) => {
    const first = indexed[range.startIndex]?.data;
    const ref = segmentRefs[range.startIndex] || {};
    const startEndpoint = endpoints && endpoints[range.startIndex];
    const endEndpoint = endpoints && endpoints[range.endIndex];
    return {
      sectionIndex,
      startIndex: range.startIndex,
      endIndex: range.endIndex,
      sourceStartIndex: range.startIndex,
      sourceEndIndex: range.endIndex - 1,
      topoEdgeId: ref.topoEdgeId ?? null,
      direction: ref.direction || null,
      face0: first?.fi0 ?? null,
      face1: first?.fi1 ?? null,
      previousSectionIndex: sectionIndex > 0 ? sectionIndex - 1 : null,
      nextSectionIndex: sectionIndex + 1 < ranges.length ? sectionIndex + 1 : null,
      startJoinIndex: range.startIndex,
      endJoinIndex: range.endIndex,
      startRail0: startEndpoint?.p0 ? { ...startEndpoint.p0 } : null,
      startRail1: startEndpoint?.p1 ? { ...startEndpoint.p1 } : null,
      endRail0: endEndpoint?.p0 ? { ...endEndpoint.p0 } : null,
      endRail1: endEndpoint?.p1 ? { ...endEndpoint.p1 } : null,
    };
  });
}

function _reversePointArray(points) {
  return Array.isArray(points) ? [...points].reverse().map((point) => ({ ...point })) : points;
}

function _swapRollingSourceSides(data) {
  if (!data) return;
  [data.fi0, data.fi1] = [data.fi1, data.fi0];
  [data.face0Keys, data.face1Keys] = [data.face1Keys, data.face0Keys];
  [data.p0a, data.p1a] = [data.p1a, data.p0a];
  [data.p0b, data.p1b] = [data.p1b, data.p0b];
  data.arcA = _reversePointArray(data.arcA);
  data.arcB = _reversePointArray(data.arcB);
  if (data._exactArcCurveA && typeof data._exactArcCurveA.reversed === 'function') data._exactArcCurveA = data._exactArcCurveA.reversed();
  if (data._exactArcCurveB && typeof data._exactArcCurveB.reversed === 'function') data._exactArcCurveB = data._exactArcCurveB.reversed();
  if (data._face0 || data._face1) [data._face0, data._face1] = [data._face1, data._face0];
  data.shared = data._face0?.shared ? { ...data._face0.shared } : data.shared;
}

function _rollingDataSideForFace(data, faceIndex) {
  if (!data) return -1;
  if (data.fi0 === faceIndex) return 0;
  if (data.fi1 === faceIndex) return 1;
  return -1;
}

function _orientRollingSourceSides(indexed) {
  if (!Array.isArray(indexed) || indexed.length < 2) return;
  for (let i = 1; i < indexed.length; i++) {
    const previous = indexed[i - 1].data;
    const current = indexed[i].data;
    const sharedFaces = [previous.fi0, previous.fi1].filter((faceIndex) => faceIndex === current.fi0 || faceIndex === current.fi1);
    if (sharedFaces.length === 1) {
      const faceIndex = sharedFaces[0];
      const previousSide = _rollingDataSideForFace(previous, faceIndex);
      const currentSide = _rollingDataSideForFace(current, faceIndex);
      if (previousSide >= 0 && currentSide >= 0 && previousSide !== currentSide) _swapRollingSourceSides(current);
      continue;
    }

    const prevEnd = _orientedSegmentEndpoint(previous, [previous.edgeA, previous.edgeB], 0, true);
    const curStart = _orientedSegmentEndpoint(current, [current.edgeA, current.edgeB], 0, false);
    const direct = _dist3(prevEnd.p0, curStart.p0) + _dist3(prevEnd.p1, curStart.p1);
    const swapped = _dist3(prevEnd.p0, curStart.p1) + _dist3(prevEnd.p1, curStart.p0);
    if (swapped + 1e-8 < direct) _swapRollingSourceSides(current);
  }
}

function _mergeRollingTopoEdgeFilletData(edgeDataList, rollingSelection, faces, topoBody = null) {
  if (!rollingSelection || !Array.isArray(edgeDataList) || edgeDataList.length < 2) return edgeDataList;
  const samples = rollingSelection.samples;
  if (!Array.isArray(samples) || samples.length < 3) return edgeDataList;
  const segmentRefs = Array.isArray(rollingSelection.segmentRefs) && rollingSelection.segmentRefs.length === samples.length - 1
    ? rollingSelection.segmentRefs
    : [];

  const indexed = [];
  const seenIndices = new Set();
  for (const data of edgeDataList) {
    const match = _findSampleSegmentIndexForData(data, samples);
    if (!match || match.dist > 0.08 || seenIndices.has(match.index)) {
      _debugBRepFillet('rolling-merge-failed', {
        reason: !match ? 'no-match' : (match.dist > 0.08 ? 'far-match' : 'duplicate-index'),
        dist: match?.dist,
        index: match?.index,
        edgeData: edgeDataList.length,
        samples: samples.length,
      });
      return edgeDataList;
    }
    seenIndices.add(match.index);
    data._face0 = faces[data.fi0];
    data._face1 = faces[data.fi1];
    indexed.push({ data, index: match.index });
  }
  indexed.sort((a, b) => a.index - b.index);

  for (let i = 0; i < indexed.length; i++) {
    if (indexed[i].index !== i) {
      _debugBRepFillet('rolling-merge-failed', {
        reason: 'non-contiguous-index',
        expected: i,
        actual: indexed[i].index,
        edgeData: edgeDataList.length,
        samples: samples.length,
      });
      return edgeDataList;
    }
  }
  if (indexed.length !== samples.length - 1) {
    _debugBRepFillet('rolling-merge-failed', {
      reason: 'missing-segments',
      indexed: indexed.length,
      needed: samples.length - 1,
      edgeData: edgeDataList.length,
      samples: samples.length,
    });
    return edgeDataList;
  }

  _orientRollingSourceSides(indexed);

  const first = indexed[0].data;
  const last = indexed[indexed.length - 1].data;
  const endpoints = [];
  const firstStart = _orientedSegmentEndpoint(indexed[0].data, samples, indexed[0].index, false);
  firstStart.topoEdgeId = segmentRefs[indexed[0].index]?.topoEdgeId ?? null;
  endpoints.push({
    point: firstStart.point,
    p0: { ...firstStart.p0 },
    p1: { ...firstStart.p1 },
    center: _centerFromFilletArc(firstStart.arc, indexed[0].data, firstStart.point),
    arc: firstStart.arc,
    setters: [firstStart],
  });

  for (let i = 0; i < indexed.length - 1; i++) {
    const prevEnd = _orientedSegmentEndpoint(indexed[i].data, samples, indexed[i].index, true);
    const nextStart = _orientedSegmentEndpoint(indexed[i + 1].data, samples, indexed[i + 1].index, false);
    prevEnd.topoEdgeId = segmentRefs[indexed[i].index]?.topoEdgeId ?? null;
    nextStart.topoEdgeId = segmentRefs[indexed[i + 1].index]?.topoEdgeId ?? null;
    const p0 = _averagePoints([prevEnd.p0, nextStart.p0]);
    const p1 = _averagePoints([prevEnd.p1, nextStart.p1]);
    const center = _averagePoints([
      _centerFromFilletArc(prevEnd.arc, indexed[i].data, prevEnd.point),
      _centerFromFilletArc(nextStart.arc, indexed[i + 1].data, nextStart.point),
    ]);
    if (!p0 || !p1 || !center) {
      _debugBRepFillet('rolling-merge-failed', { reason: 'interior-endpoint-center', index: i });
      return edgeDataList;
    }
    endpoints.push({
      point: prevEnd.point,
      p0,
      p1,
      center,
      arc: null,
      setters: [prevEnd, nextStart],
    });
  }

  const lastEnd = _orientedSegmentEndpoint(indexed[indexed.length - 1].data, samples, indexed[indexed.length - 1].index, true);
  lastEnd.topoEdgeId = segmentRefs[indexed[indexed.length - 1].index]?.topoEdgeId ?? null;
  endpoints.push({
    point: lastEnd.point,
    p0: { ...lastEnd.p0 },
    p1: { ...lastEnd.p1 },
    center: _centerFromFilletArc(lastEnd.arc, indexed[indexed.length - 1].data, lastEnd.point),
    arc: lastEnd.arc,
    setters: [lastEnd],
  });

  for (const endpoint of endpoints) {
    const projectedP0 = _projectRollingEndpointRailToPlanarOwners(endpoint, 0, faces);
    const projectedP1 = _projectRollingEndpointRailToPlanarOwners(endpoint, 1, faces);
    if (projectedP0) endpoint.p0 = { ...projectedP0 };
    if (projectedP1) endpoint.p1 = { ...projectedP1 };
  }

  const capSegments = Math.max(2, (firstStart.arc?.length || lastEnd.arc?.length || 9) - 1);
  const startCap = _simplePlanarRollingTerminalCap(topoBody, faces, endpoints[0], first.radius, capSegments);
  if (startCap) {
    endpoints[0].p0 = { ...startCap.p0 };
    endpoints[0].p1 = { ...startCap.p1 };
    endpoints[0].arc = startCap.arc.map((point) => ({ ...point }));
  }
  const terminalIndex = endpoints.length - 1;
  const endCap = _simplePlanarRollingTerminalCap(topoBody, faces, endpoints[terminalIndex], first.radius, capSegments);
  if (endCap) {
    endpoints[terminalIndex].p0 = { ...endCap.p0 };
    endpoints[terminalIndex].p1 = { ...endCap.p1 };
    endpoints[terminalIndex].arc = endCap.arc.map((point) => ({ ...point }));
  }

  if (endpoints.length >= 2) {
    for (let i = 0; i < endpoints.length; i++) {
      const references = [];
      if (i > 0 && endpoints[i - 1].center) references.push(endpoints[i - 1].center);
      if (i + 1 < endpoints.length && endpoints[i + 1].center) references.push(endpoints[i + 1].center);
      const referenceCenter = _averagePoints(references) || endpoints[i].center;
      _repairRollingEndpointCenter(endpoints[i], { center: referenceCenter }, first.radius);
    }
  }

  const rollingSections = _buildRollingPrimitiveSections(indexed, rollingSelection, endpoints);
  _stabilizeRollingFilletSectionWidths(endpoints, rollingSections, faces, first.radius);

  for (const endpoint of endpoints) {
    if (!endpoint.center) {
      _debugBRepFillet('rolling-merge-failed', { reason: 'terminal-center' });
      return edgeDataList;
    }
    for (const setter of endpoint.setters) {
      _setSegmentEndpointTrim(setter, endpoint.p0, endpoint.p1);
      if (endpoint.arc && !endpoint.pointTerminal) _setSegmentEndpointArc(setter, endpoint.arc);
    }
  }

  const startArc = endpoints[0].arc || firstStart.arc;
  const endArc = endpoints[endpoints.length - 1].arc || lastEnd.arc;

  const merged = {
    ...first,
    edgeKey: _edgeKeyFromVerts(endpoints[0].point, endpoints[endpoints.length - 1].point),
    edgeA: { ...endpoints[0].point },
    edgeB: { ...endpoints[endpoints.length - 1].point },
    p0a: { ...endpoints[0].p0 },
    p1a: { ...endpoints[0].p1 },
    p0b: { ...endpoints[endpoints.length - 1].p0 },
    p1b: { ...endpoints[endpoints.length - 1].p1 },
    arcA: startArc,
    arcB: endArc,
    _exactArcCurveA: _curveFromSampledPoints(startArc),
    _exactArcCurveB: _curveFromSampledPoints(endArc),
    _rollingRail0: endpoints.map((endpoint) => ({ ...endpoint.p0 })),
    _rollingRail1: endpoints.map((endpoint) => ({ ...endpoint.p1 })),
    _rollingCenters: endpoints.map((endpoint) => ({ ...endpoint.center })),
    _rollingRail0Spans: _buildRollingRailOwnershipSpans(indexed, 0),
    _rollingRail1Spans: _buildRollingRailOwnershipSpans(indexed, 1),
    _rollingSections: rollingSections,
    _trimSourceData: indexed.map((entry) => entry.data),
    _brepSideEdges: false,
  };

  delete merged._exactAxisStart;
  delete merged._exactAxisEnd;
  delete merged._face0;
  delete merged._face1;
  if (last.face0Keys) merged.face0Keys = last.face0Keys;
  if (last.face1Keys) merged.face1Keys = last.face1Keys;
  _debugBRepFillet('rolling-merge-success', {
    railPoints: endpoints.length,
    sourceSegments: indexed.length,
    sections: rollingSections.map((section) => ({ start: section.startIndex, end: section.endIndex, edge: section.topoEdgeId, faces: [section.face0, section.face1] })),
    startChain: rollingSelection.startChain?.map((entry) => entry.edge.id) || [],
    endChain: rollingSelection.endChain?.map((entry) => entry.edge.id) || [],
  });
  return [merged];
}

/**
 * Apply B-Rep fillet (rolling-ball blend) to a TopoBody.
 *
 * Operates directly on the TopoBody topology:
 * 1. For each selected edge, compute tangent offset points and circular arc
 *    cross-sections on both adjacent faces.
 * 2. Trim the original faces along the offset lines.
 * 3. Create cylindrical fillet surfaces between the two rail curves.
 * 4. Handle corner patches where fillets meet at shared vertices.
 *
 * @param {Object} geometry - Input geometry with .topoBody
 * @param {string[]} edgeKeys - Edge keys to fillet (position-based)
 * @param {number} radius - Fillet radius
 * @param {number} [segments=8] - Arc tessellation segments
 * @returns {Object|null} New geometry or null if BRep fillet not applicable
 */
export function applyBRepFillet(geometry, edgeKeys, radius, segments = 8) {
  const topoBody = geometry && geometry.topoBody;
  if (!topoBody || !topoBody.shells) {
    _debugBRepFillet('missing-topobody');
    return null;
  }

  const curvedPlaneCylinderResult = _tryApplyPlaneCylinderArcFillet(geometry, edgeKeys, radius, segments);
  if (curvedPlaneCylinderResult !== undefined) return curvedPlaneCylinderResult;

  // Step 1: Extract mesh-level faces from TopoBody for edge adjacency
  const edgeSampleSegments = Math.max(segments * 4, 32);
  const faces = _extractFeatureFacesFromTopoBody(geometry, edgeSampleSegments);
  if (!faces || faces.length === 0) {
    _debugBRepFillet('no-faces');
    return null;
  }

  // Build exact edge adjacency lookup from TopoBody
  const exactAdjacencyByKey = _buildExactEdgeAdjacencyLookupFromTopoBody(topoBody, faces, edgeSampleSegments);

  // Step 2: Precompute fillet data for each edge
  const rollingSelection = _resolveFullSpanRollingTopoEdgeSelection(topoBody, edgeKeys, segments, edgeSampleSegments);
  const exactEdgeKeys = rollingSelection
    ? rollingSelection.segmentKeys
    : _resolveFilletEdgeKeysToExactTopoEdges(topoBody, edgeKeys, segments);
  const uniqueKeys = exactEdgeKeys.length > 0 ? exactEdgeKeys : [...new Set(edgeKeys)];
  let edgeDataList = [];
  const seenExactEdges = new Set();
  for (let keyIndex = 0; keyIndex < uniqueKeys.length; keyIndex++) {
    const key = uniqueKeys[keyIndex];
    let edgeDirOverride = null;
    if (rollingSelection && Array.isArray(rollingSelection.samples)) {
      const tangentStart = rollingSelection.samples[Math.max(0, keyIndex - 1)];
      const tangentEnd = rollingSelection.samples[Math.min(rollingSelection.samples.length - 1, keyIndex + 2)];
      if (tangentStart && tangentEnd && _dist3(tangentStart, tangentEnd) > 1e-9) {
        edgeDirOverride = _vec3Normalize(_vec3Sub(tangentEnd, tangentStart));
      }
    }
    const rollingPrecomputeOptions = rollingSelection
      ? {
        disableTrimClipA: keyIndex > 0,
        disableTrimClipB: keyIndex < uniqueKeys.length - 1,
        edgeDirOverride,
        projectTrimsToFaces: false,
      }
      : null;
    const data = _precomputeFilletEdge(
      faces,
      key,
      radius,
      segments,
      exactAdjacencyByKey,
      rollingPrecomputeOptions,
    );
    if (!data) continue;
    const exactKey = `${_edgeKeyFromVerts(data.edgeA, data.edgeB)}|${Math.min(data.fi0, data.fi1)}:${Math.max(data.fi0, data.fi1)}`;
    if (seenExactEdges.has(exactKey)) continue;
    seenExactEdges.add(exactKey);
    edgeDataList.push(data);
  }
  edgeDataList = _mergeRollingTopoEdgeFilletData(edgeDataList, rollingSelection, faces, topoBody);
  if (edgeDataList.length === 0) {
    _debugBRepFillet('no-precomputed-edges', { edgeKeys: uniqueKeys.length });
    return null;
  }

  // Step 3: Merge shared vertex positions and apply two-edge fillet trims
  const vertexEdgeMap = _buildVertexEdgeMap(edgeDataList);
  _projectTerminalFilletCapsOntoAdjacentFaces(topoBody, faces, edgeDataList, vertexEdgeMap, radius, segments);
  _mergeSharedVertexPositions(edgeDataList, vertexEdgeMap);
  const cornerTrimEndpoints = _applyTwoEdgeFilletSharedTrims(edgeDataList, faces, vertexEdgeMap);

  // Step 3b: Recompute fillet arcs at 3-edge corners.
  // _mergeSharedVertexPositions updated p0a/p1a to the merged positions but
  // the arcA/arcB arrays still use the pre-merge arc computed at the original
  // vertex.  For 3-edge corners the fillet strip must end at the merged
  // position (the sphere vertex), so recompute each arc there.
  _recomputeCornerArcs(edgeDataList, vertexEdgeMap, cornerTrimEndpoints, segments, faces);

  // Step 4: Trim original faces and build fillet face descriptors
  // Create a set of face indices that are adjacent to fillet edges
  const filletFaceIndices = new Set();
  for (const data of edgeDataList) {
    const trimSources = Array.isArray(data._trimSourceData) && data._trimSourceData.length > 0
      ? data._trimSourceData
      : [data];
    for (const source of trimSources) {
      filletFaceIndices.add(source.fi0);
      filletFaceIndices.add(source.fi1);
    }
  }

  // Trim each face: for faces adjacent to filleted edges, replace edge
  // endpoint vertices with the corresponding fillet offset points.
  // For non-adjacent faces that share a vertex with a fillet edge,
  // split the vertex into the two fillet trim points.
  //
  // Build a lookup: vertexKey+faceIndex → trim data for direct face adjacency
  const vertexTrimLookup = new Map(); // "fi|vertexKey" → { data, isEdgeA, isFace0 }
  for (const data of edgeDataList) {
    const trimSources = Array.isArray(data._trimSourceData) && data._trimSourceData.length > 0
      ? data._trimSourceData
      : [data];
    for (const source of trimSources) {
      const vkA = _edgeVKey(source.edgeA);
      const vkB = _edgeVKey(source.edgeB);
      vertexTrimLookup.set(`${source.fi0}|${vkA}`, { data: source, isEdgeA: true, isFace0: true });
      vertexTrimLookup.set(`${source.fi0}|${vkB}`, { data: source, isEdgeA: false, isFace0: true });
      vertexTrimLookup.set(`${source.fi1}|${vkA}`, { data: source, isEdgeA: true, isFace0: false });
      vertexTrimLookup.set(`${source.fi1}|${vkB}`, { data: source, isEdgeA: false, isFace0: false });
    }
  }

  // Build vertex-key → all fillet data touching that vertex (for non-adjacent faces)
  const vertexFilletMap = new Map(); // vertexKey → [{data, isEdgeA}]
  for (const data of edgeDataList) {
    const trimSources = Array.isArray(data._trimSourceData) && data._trimSourceData.length > 0
      ? data._trimSourceData
      : [data];
    for (const source of trimSources) {
      const vkA = _edgeVKey(source.edgeA);
      const vkB = _edgeVKey(source.edgeB);
      if (!vertexFilletMap.has(vkA)) vertexFilletMap.set(vkA, []);
      vertexFilletMap.get(vkA).push({ data: source, isEdgeA: true });
      if (!vertexFilletMap.has(vkB)) vertexFilletMap.set(vkB, []);
      vertexFilletMap.get(vkB).push({ data: source, isEdgeA: false });
    }
  }

  const trimmedFaces = [];
  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi];
    if (!face || !face.vertices || face.vertices.length < 3) continue;

    if (!filletFaceIndices.has(fi)) {
      // Non-fillet face: check if any vertex is at a fillet edge endpoint.
      // Such vertices need to be split into the two fillet trim points
      // (one on each adjacent face side) to maintain watertight topology.
      const origVerts = face.vertices;
      const n = origVerts.length;
      let modified = false;
      const newVerts = [];

      for (let vi = 0; vi < n; vi++) {
        const v = origVerts[vi];
        const vk = _edgeVKey(v);
        const filletEntries = vertexFilletMap.get(vk);
        if (!filletEntries || filletEntries.length === 0) {
          newVerts.push({ ...v });
          continue;
        }

        // This vertex is at a fillet edge endpoint.
        // Insert trim points in the correct order to maintain boundary winding.
        const vNext = origVerts[(vi + 1) % n];
        const vPrev = origVerts[(vi - 1 + n) % n];

        // Check which fillet-adjacent face this non-adjacent face borders at this vertex.
        // This determines whether to insert one trim point (single-side) or both.
        const faceEdgeKeys = _collectFaceEdgeKeys(face);
        let side0 = false, side1 = false;
        for (const entry of filletEntries) {
          const face0Keys = entry.data.face0Keys;
          const face1Keys = entry.data.face1Keys;
          for (const ek of faceEdgeKeys) {
            if (face0Keys && face0Keys.has(ek)) side0 = true;
            if (face1Keys && face1Keys.has(ek)) side1 = true;
          }
        }

        // Collect appropriate trim points based on face-side affinity
        const trimPts = [];
        for (const entry of filletEntries) {
          const p0 = entry.isEdgeA ? entry.data.p0a : entry.data.p0b;
          const p1 = entry.isEdgeA ? entry.data.p1a : entry.data.p1b;
          if (side0 && !side1) {
            // Face borders only fi0 side — use only p0
            trimPts.push(p0);
          } else if (side1 && !side0) {
            // Face borders only fi1 side — use only p1
            trimPts.push(p1);
          } else {
            // Face borders both or neither — use both (vertex split)
            trimPts.push(p0, p1);
          }
        }

        if (trimPts.length === 1) {
          // Single-side: replace vertex with the one trim point
          newVerts.push({ ...trimPts[0] });
          modified = true;
        } else if (trimPts.length === 2) {
          // Order the split trim points so the rebuilt boundary keeps the
          // original adjacent edges on the correct sides of the split.
          // The first inserted point should stay on the prev->vertex edge,
          // and the second should stay on the vertex->next edge.
          const distanceToLine = (point, a, b) => {
            const ab = _vec3Sub(b, a);
            const len = _vec3Len(ab);
            if (len < 1e-10) return _dist3(point, a);
            return _vec3Len(_vec3Cross(_vec3Sub(point, a), ab)) / len;
          };
          const scoreOrder = (first, second) => {
            return distanceToLine(first, vPrev, v) + distanceToLine(second, v, vNext);
          };

          const score01 = scoreOrder(trimPts[0], trimPts[1]);
          const score10 = scoreOrder(trimPts[1], trimPts[0]);
          if (score01 <= score10) {
            newVerts.push({ ...trimPts[0] }, { ...trimPts[1] });
          } else {
            newVerts.push({ ...trimPts[1] }, { ...trimPts[0] });
          }
          modified = true;
        } else if (trimPts.length > 2) {
          // Multiple fillet edges share this vertex on a non-adjacent face.
          // Sort all trim points by angular order around the boundary walk.
          const dirPrev = _vec3Normalize(_vec3Sub(vPrev, v));
          const faceNormal = face.normal
            ? { x: face.normal.x, y: face.normal.y, z: face.normal.z }
            : _computePolygonNormal(origVerts);

          // Deduplicate trim points at the same position
          const uniqueTrimPts = [];
          const seen = new Set();
          for (const pt of trimPts) {
            const ptKey = _edgeVKey(pt);
            if (!seen.has(ptKey)) {
              seen.add(ptKey);
              uniqueTrimPts.push(pt);
            }
          }

          // Sort by signed angle from vPrev direction around face normal
          uniqueTrimPts.sort((a, b) => {
            const da = _vec3Normalize(_vec3Sub(a, v));
            const db = _vec3Normalize(_vec3Sub(b, v));
            const angleA = Math.atan2(
              _vec3Dot(_vec3Cross(dirPrev, da), faceNormal),
              _vec3Dot(dirPrev, da)
            );
            const angleB = Math.atan2(
              _vec3Dot(_vec3Cross(dirPrev, db), faceNormal),
              _vec3Dot(dirPrev, db)
            );
            return angleA - angleB;
          });

          for (const pt of uniqueTrimPts) {
            newVerts.push({ ...pt });
          }
          modified = true;
        } else {
          // No trim points — keep original
          newVerts.push({ ...v });
        }
      }

      if (modified && newVerts.length >= 3) {
        trimmedFaces.push({ ...face, vertices: newVerts, normal: face.normal });
      } else {
        trimmedFaces.push(face);
      }
      continue;
    }

    // This face IS adjacent to one or more fillet edges.
    // Replace vertices at fillet edge endpoints with offset trim points.
    const origVerts = face.vertices;
    const newVerts = [];
    for (let vi = 0; vi < origVerts.length; vi++) {
      const vk = _edgeVKey(origVerts[vi]);
      const trimInfo = vertexTrimLookup.get(`${fi}|${vk}`);
      if (trimInfo) {
        const pt = trimInfo.isFace0
          ? (trimInfo.isEdgeA ? trimInfo.data.p0a : trimInfo.data.p0b)
          : (trimInfo.isEdgeA ? trimInfo.data.p1a : trimInfo.data.p1b);
        newVerts.push({ ...pt });
      } else {
        newVerts.push({ ...origVerts[vi] });
      }
    }

    if (newVerts.length < 3) continue;
    trimmedFaces.push({
      ...face,
      vertices: newVerts,
      normal: face.normal,
    });
  }

  // Step 4b: Extend fillet trims at sequential fillet junctions.
  // Where the new fillet meets a previous fillet's arc boundary on a shared
  // planar face, extend the trim to the arc–offset intersection so the
  // boundary transitions smoothly instead of creating a "notch".
  _extendTrimsAtPreviousFilletJunctions(
    trimmedFaces, edgeDataList, faces, topoBody, radius,
  );
  _debugBRepFillet('after-previous-fillet-junctions', { trimmedFaces: trimmedFaces.length, edgeData: edgeDataList.length });

  // Step 4c: Where the new fillet meets a previous CHAMFER face, replace
  // the linear stitch (which left the chamfer face non-planar) with the
  // proper cylinder ∩ chamfer-plane arc.  See the function's doc-comment
  // for the geometric construction.
  _extendTrimsAtPreviousChamferJunctions(
    trimmedFaces, edgeDataList, faces, topoBody, radius,
  );
  _debugBRepFillet('after-previous-chamfer-junctions', { trimmedFaces: trimmedFaces.length, edgeData: edgeDataList.length });

  // Step 5: Build exact NURBS fillet surfaces for each edge data
  for (const data of edgeDataList) {
    // Build NURBS cylinder surface for the fillet strip
    const arcA = data.sharedTrimA || data.arcA;
    const arcB = data.sharedTrimB || data.arcB;
    if (!arcA || !arcB || arcA.length < 2 || arcB.length < 2) continue;

    if (Array.isArray(data._rollingRail0) && Array.isArray(data._rollingRail1) && Array.isArray(data._rollingCenters)) {
      if (data._rollingRail0.length === data._rollingRail1.length &&
          data._rollingRail0.length === data._rollingCenters.length &&
          data._rollingRail0.length >= 3) {
        try {
          const edgeDir = _vec3Normalize(_vec3Sub(data.edgeB, data.edgeA));
          const surface = NurbsSurface.createFilletSurface(
            data._rollingRail0,
            data._rollingRail1,
            data._rollingCenters,
            radius,
            edgeDir,
          );
          data._exactSurface = surface;
          data._exactRadius = radius;
          data._exactRail0Curve = _curveFromSampledPoints(data._rollingRail0);
          data._exactRail1Curve = _curveFromSampledPoints(data._rollingRail1);
          _preserveControlPointSamples(data._exactRail0Curve);
          _preserveControlPointSamples(data._exactRail1Curve);
          if (!data._exactArcCurveA) data._exactArcCurveA = _curveFromSampledPoints(arcA);
          if (!data._exactArcCurveB) data._exactArcCurveB = _curveFromSampledPoints(arcB);
          continue;
        } catch (e) {
          _debugBRepFillet('create-rolling-fillet-surface-failed', e?.message || String(e));
        }
      }
    }

    // The fillet surface is a cylinder ruled between arcA and arcB.
    // createFilletSurface expects:
    //   rail0[j] = face0 trim point at edge position j
    //   rail1[j] = face1 trim point at edge position j
    //   centers[j] = rolling-ball center at edge position j
    // Each cross-section (rail0[j] → rail1[j]) is a circular arc.
    const edgeDir = _vec3Normalize(_vec3Sub(data.edgeB, data.edgeA));

    const { offsDir0, offsDir1 } = _computeOffsetDirs(
      faces[data.fi0], faces[data.fi1], data.edgeA, data.edgeB
    );
    const alpha = Math.acos(Math.max(-1, Math.min(1, _vec3Dot(offsDir0, offsDir1))));
    const centerDist = alpha > 1e-6 ? radius / Math.sin(alpha / 2) : radius;
    const bisector = _vec3Normalize(_vec3Add(offsDir0, offsDir1));

    // Two edge positions: edgeA (start) and edgeB (end).
    // For recomputed corner arcs, the arc start may not be at the
    // original vertex — project arc midpoints onto the edge axis
    // to find the correct center positions.
    const rail0 = [
      { ...arcA[0] },                      // face0 trim at edgeA end
      { ...arcB[0] },                      // face0 trim at edgeB end
    ];
    const rail1 = [
      { ...arcA[arcA.length - 1] },        // face1 trim at edgeA end
      { ...arcB[arcB.length - 1] },        // face1 trim at edgeB end
    ];

    // Compute the arc center at each end by projecting the arc midpoint
    // onto the edge axis.
    const midA = arcA[Math.floor(arcA.length / 2)];
    const midB = arcB[Math.floor(arcB.length / 2)];
    const tA = _vec3Dot(_vec3Sub(midA, data.edgeA), edgeDir);
    const tB = _vec3Dot(_vec3Sub(midB, data.edgeA), edgeDir);
    const axisA = _vec3Add(data.edgeA, _vec3Scale(edgeDir, tA));
    const axisB = _vec3Add(data.edgeA, _vec3Scale(edgeDir, tB));
    const centers = [
      _vec3Add(axisA, _vec3Scale(bisector, centerDist)),
      _vec3Add(axisB, _vec3Scale(bisector, centerDist)),
    ];

    try {
      const surface = NurbsSurface.createFilletSurface(rail0, rail1, centers, radius, edgeDir);
      data._exactSurface = surface;
      data._exactAxisStart = { ...axisA };
      data._exactAxisEnd = { ...axisB };
      data._exactRadius = radius;

      // Build NURBS arc curves for the arcs if not already present
      if (!data._exactArcCurveA) {
        data._exactArcCurveA = _curveFromSampledPoints(arcA);
      }
      if (!data._exactArcCurveB) {
        data._exactArcCurveB = _curveFromSampledPoints(arcB);
      }
    } catch (e) {
      _debugBRepFillet('create-fillet-surface-failed', e?.message || String(e));
      // Continue without exact surface — will fall back to polyline/planar
    }
  }
  _debugBRepFillet('after-surface-build', { edgeData: edgeDataList.length });

  // Step 6: Generate spherical corner patch faces for 3-edge vertices.
  // At vertices where 3 fillet edges meet, the three fillet strips each
  // end in an arc whose endpoints are shared with adjacent strips.
  // The gap between the three strips is filled by a spherical triangle
  // patch centered at the original vertex.
  for (const [vk, cornerData] of cornerTrimEndpoints) {
    const { triVertices, sphereCenter, edgeIndices: cornerEdgeIndices } = cornerData;
    if (!triVertices || triVertices.length < 3) continue;

    // Compute the sphere radius: distance from the sphere center to any
    // of the triangle vertices (they should all be equidistant for an
    // equal-radius corner on orthogonal faces).
    const dx = triVertices[0].x - sphereCenter.x;
    const dy = triVertices[0].y - sphereCenter.y;
    const dz = triVertices[0].z - sphereCenter.z;
    const sphereRadius = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (sphereRadius < 1e-10) continue;

    // Collect the arc polylines at this vertex from each edge.
    // These arcs form the boundary curves shared between the fillet
    // strip faces and the spherical corner patch.
    const arcCurves = []; // [{startVK, endVK, points, curve}]
    for (const di of cornerEdgeIndices) {
      const d = edgeDataList[di];
      const isA = _edgeVKey(d.edgeA) === vk;
      const arc = isA ? d.arcA : d.arcB;
      if (!arc || arc.length < 2) continue;
      const exactCurve = isA ? d._exactArcCurveA : d._exactArcCurveB;
      const startVK = _edgeVKey(arc[0]);
      const endVK = _edgeVKey(arc[arc.length - 1]);
      arcCurves.push({
        startVK,
        endVK,
        points: arc,
        curve: exactCurve && typeof exactCurve.clone === 'function' ? exactCurve.clone() : null,
      });
    }

    // Order the three vertices so the resulting face normal points
    // outward (away from the solid interior).  The outward direction
    // is from the sphere center towards the surface (centroid - center).
    // `inwardDir` = sphereCenter − centroid points INWARD, so if the
    // polygon normal aligns with it, the winding is inward and must flip.
    const v0 = triVertices[0], v1 = triVertices[1], v2 = triVertices[2];
    const polyNormal = _computePolygonNormal([v0, v1, v2]);
    const inwardDir = _vec3Normalize(_vec3Sub(sphereCenter, {
      x: (v0.x + v1.x + v2.x) / 3,
      y: (v0.y + v1.y + v2.y) / 3,
      z: (v0.z + v1.z + v2.z) / 3,
    }));
    // If polyNormal aligns with inwardDir, it points inward → need flip
    const inward = polyNormal && _vec3Dot(polyNormal, inwardDir) > 0;
    const orderedVerts = inward ? [v0, v2, v1] : [v0, v1, v2];

    // Store the arc curves and sphere metadata on the corner face
    // so _buildExactTrihedronFaceDesc can use them for edge curves.
    const outNormal = inward ? _vec3Scale(polyNormal, -1) : polyNormal;
    trimmedFaces.push({
      vertices: orderedVerts.map(v => ({ ...v })),
      normal: outNormal,
      isCorner: true,
      _triVerts: orderedVerts.map(v => ({ ...v })),
      _sphereCenter: { ...sphereCenter },
      _sphereRadius: sphereRadius,
      _arcCurves: arcCurves,
      shared: { isCorner: true, isFillet: true },
    });

    // Mark each fillet edge at this vertex to use arc polyline curves
    // instead of straight lines.  This ensures the fillet strip face
    // and sphere patch share the same TopoEdge curve.
    for (const di of cornerEdgeIndices) {
      const d = edgeDataList[di];
      const isA = _edgeVKey(d.edgeA) === vk;
      if (isA) d._useArcCurveA = true;
      else d._useArcCurveB = true;
    }
  }

  // Step 7: Build the exact fillet TopoBody
  // Mark fillet faces in trimmed faces
  for (const data of edgeDataList) {
    // The fillet strip face will be added by _buildExactFilletTopoBody
    // Ensure the trimmed faces are tagged for _buildExactFilletTopoBody
  }

  // _buildExactFilletTopoBody expects trimmed faces and edgeDataList
  const newTopoBody = _buildExactFilletTopoBody(trimmedFaces, edgeDataList, topoBody);
  _debugBRepFillet('after-build-topobody', { hasBody: !!newTopoBody });
  if (!newTopoBody) {
    _debugBRepFillet('build-topobody-failed');
    return null;
  }
  const prunedDegenerateCoedges = _pruneSingleUseDegenerateCoedges(newTopoBody);
  if (prunedDegenerateCoedges > 0) _debugBRepFillet('pruned-degenerate-coedges', { prunedDegenerateCoedges });

  const topoBoundaryEdges = countTopoBodyBoundaryEdges(newTopoBody);
  _debugBRepFillet('after-topo-boundary-check', { topoBoundaryEdges });
  if (topoBoundaryEdges !== 0) {
    _debugBRepFillet('topo-boundary-edges', { topoBoundaryEdges });
    // For fillet, boundary edges are common due to complex corner geometry
    // Don't reject immediately — try tessellation anyway
  }

  // Step 7: Tessellate
  let mesh;
  try {
    // H21: when the input geometry carries DirtyFaceTracker-stamped
    // `invalidatedFaceIds`, forward them as explicit cache-eviction hints
    // so the tessellator re-triangulates those faces even if their content
    // key happens to match a cached mesh. `allFacesDirty: true` collapses
    // to "ignore the whole cache" which the tessellator handles by just
    // not hitting it.
    const inputDirty = geometry && !geometry.allFacesDirty && Array.isArray(geometry.invalidatedFaceIds) && geometry.invalidatedFaceIds.length > 0
      ? geometry.invalidatedFaceIds
      : null;
    const requireWasmTessellation = edgeDataList.some((edgeData) => edgeData && Array.isArray(edgeData._rollingRail0));
    const stableEdgeSegments = Math.max(segments, 32);
    const stableSurfaceSegments = Math.max(Math.ceil(segments / 2), 16);
    _debugBRepFillet('before-tessellate', { faces: newTopoBody.faces().length });
    mesh = tessellateBody(newTopoBody, {
      validate: false,
      edgeSegments: stableEdgeSegments,
      surfaceSegments: stableSurfaceSegments,
      preferWasm: true,
      requireWasm: requireWasmTessellation,
      incrementalCache: geometry && geometry._incrementalTessellationCache
        ? geometry._incrementalTessellationCache
        : null,
      dirtyFaceIds: inputDirty,
      fallbackOnInvalidWasm: !requireWasmTessellation,
    });
    _debugBRepFillet('after-tessellate', { triangles: mesh?.faces?.length || 0 });
  } catch (error) {
    _debugBRepFillet('tessellate-failed', error?.message || String(error));
    return null;
  }

  if (!mesh || !mesh.faces || mesh.faces.length === 0) {
    _debugBRepFillet('empty-mesh');
    return null;
  }

  // Winding consistency: for fillet bodies with curved surfaces,
  // skip BFS-based winding fix to avoid corrupting the tessellator's
  // sameSense-aware normals.
  const bodyCurved = newTopoBody.shells.some(
    (s) => s.faces.some((f) => f.surfaceType !== 'plane')
  );
  const hasMixedCornerCap = newTopoBody.shells.some(
    (s) => s.faces.some((f) => f.shared?.isMixedFilletCorner)
  );
  const preFixTopology = measureMeshTopology(mesh.faces);
  if ((!bodyCurved || hasMixedCornerCap) &&
      preFixTopology.boundaryEdges === 0 && preFixTopology.nonManifoldEdges === 0) {
    fixWindingConsistency(mesh.faces);
    recomputeFaceNormals(mesh.faces);
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

  // Build a lightweight BRep view from the TopoBody so downstream code
  // (tests, export) can inspect exact surface data.
  let brep = null;
  if (newTopoBody && newTopoBody.shells) {
    const brepFaces = [];
    for (const shell of newTopoBody.shells) {
      for (const face of (shell.faces || [])) {
        const entry = {
          id: face.id,
          // Convert internal 'sphere' type to 'spherical' for BRep output
          // to match STEP/external convention used by tests and export.
          surfaceType: face.surfaceType === 'sphere' ? 'spherical' : face.surfaceType,
          surface: face.surface || null,
          surfaceInfo: face.surfaceInfo ? { ...face.surfaceInfo } : null,
          sameSense: face.sameSense,
          shared: face.shared || null,
        };
        // Attach sphere metadata if present
        if (face.shared && face.shared._sphereCenter) {
          entry.sphereCenter = { ...face.shared._sphereCenter };
          entry.sphereRadius = face.shared._sphereRadius || 0;
        }
        brepFaces.push(entry);
      }
    }
    brep = { faces: brepFaces };
  }

  return {
    vertices: mesh.vertices || [],
    faces: mesh.faces,
    edges: edgeResult.edges,
    paths: edgeResult.paths,
    visualEdges: edgeResult.visualEdges,
    topoBody: newTopoBody,
    brep,
    _tessellator: mesh._tessellator || null,
    incrementalTessellation: mesh.incrementalTessellation || null,
    _incrementalTessellationCache: mesh._incrementalTessellationCache || null,
  };
}
// Exports
// -----------------------------------------------------------------------

export {
  _buildExactFilletTopoBody,
  _precomputeFilletEdge,
  _buildTwoEdgeFilletTrim,
  _applyTwoEdgeFilletSharedTrims,
  _createExactCylinderPlaneTrimCurve,
  _buildExactFilletBoundaryCurve,
  _buildExactFilletFaceDesc,
  _curveFromSampledPoints,
  _mergeSharedVertexPositions,
  _solvePlanarCoefficients,
  _samplePolyline,
  _buildExactCornerPatchFaceDesc,
  _buildExactTrihedronFaceDesc,
  _buildExactCornerFaceDescs,
};
