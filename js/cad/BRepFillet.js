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
  _buildExactEdgeAdjacencyLookupFromTopoBody,
  _sampleExactEdgePoints,
} from './BRepChamfer.js';

import { tessellateBody } from './Tessellation.js';
import { computeFeatureEdges } from './EdgeAnalysis.js';

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

function _precomputeFilletEdge(faces, edgeKey, radius, segments, exactAdjacencyByKey = null) {
  const adj = (exactAdjacencyByKey && exactAdjacencyByKey.get(edgeKey)) || _findAdjacentFaces(faces, edgeKey);
  if (adj.length < 2) return null;

  const fi0 = adj[0].fi, fi1 = adj[1].fi;
  const face0 = faces[fi0];
  const face1 = faces[fi1];
  const edgeA = adj[0].a;
  const edgeB = adj[0].b;

  const face0Keys = _collectFaceEdgeKeys(face0);
  const face1Keys = _collectFaceEdgeKeys(face1);

  const { offsDir0, offsDir1, isConcave } = _computeOffsetDirs(face0, face1, edgeA, edgeB);

  const alpha = Math.acos(Math.max(-1, Math.min(1, _vec3Dot(offsDir0, offsDir1))));
  if (alpha < 1e-6) return null;

  const tangentDist = radius / Math.tan(alpha / 2);
  const centerDist = radius / Math.sin(alpha / 2);
  const sweep = Math.PI - alpha;
  const bisector = _vec3Normalize(_vec3Add(offsDir0, offsDir1));
  const edgeDir = _vec3Normalize(_vec3Sub(edgeB, edgeA));

  // Standard perpendicular offsets (correct for 90° corners)
  const t0a_raw = _vec3Add(edgeA, _vec3Scale(offsDir0, tangentDist));
  const t0b_raw = _vec3Add(edgeB, _vec3Scale(offsDir0, tangentDist));
  const t1a_raw = _vec3Add(edgeA, _vec3Scale(offsDir1, tangentDist));
  const t1b_raw = _vec3Add(edgeB, _vec3Scale(offsDir1, tangentDist));

  // Clip trim points to neighboring face edges for correct corner geometry.
  // At non-90° corners, the simple perpendicular offset may not lie on the
  // non-adjacent face's plane.  Clipping ensures the trim point is on the
  // face boundary edge shared with the non-adjacent face.
  const t0a = _clipTrimToNeighborEdge(face0, edgeA, offsDir0, tangentDist, t0a_raw, _vec3Scale(edgeDir, -1));
  const t0b = _clipTrimToNeighborEdge(face0, edgeB, offsDir0, tangentDist, t0b_raw, edgeDir);
  const t1a = _clipTrimToNeighborEdge(face1, edgeA, offsDir1, tangentDist, t1a_raw, _vec3Scale(edgeDir, -1));
  const t1b = _clipTrimToNeighborEdge(face1, edgeB, offsDir1, tangentDist, t1b_raw, edgeDir);

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
    // Use NURBS arc tessellation to match EdgeSampler's parameterization.
    // This ensures polygon arc boundaries align exactly with NURBS edge samples.
    let arcPoints;
    try {
      const nurbsArc = NurbsCurve.createArc(center, radius, e0, e1, 0, sweep);
      const tessPoints = nurbsArc.tessellate(segments);
      arcPoints = tessPoints.map(p => ({ x: p.x, y: p.y, z: p.z }));
    } catch (e) {
      // Fallback to simple theta-based sampling if NURBS fails
      const cosSweep = Math.cos(sweep);
      const sinSweep = Math.sin(sweep);
      const perp = sinSweep > 1e-10
        ? _vec3Scale(_vec3Sub(_vec3Normalize(_vec3Sub(stdPt1, center)), _vec3Scale(e0, cosSweep)), 1 / sinSweep)
        : e1;
      arcPoints = [];
      for (let s = 0; s <= segments; s++) {
        const theta = (s / segments) * sweep;
        arcPoints.push(_vec3Add(center, _vec3Add(
          _vec3Scale(e0, radius * Math.cos(theta)),
          _vec3Scale(perp, radius * Math.sin(theta))
        )));
      }
    }

    // Blend arc endpoints to match corner-adapted trim points.
    // For 90° corners, trimPt0/trimPt1 match the standard offsets, so
    // the displacement is zero and the arc is unchanged.
    // For non-90° corners, the endpoints are smoothly shifted to align
    // with the neighboring face edges, producing correct watertight geometry.
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
      const sweep = d._sweep || Math.PI / 2;

      let newArc;
      try {
        const nurbsArc = NurbsCurve.createArc(arcCenter, d.radius, e0, e1, 0, sweep);
        newArc = nurbsArc.tessellate(segments).map(p => ({ x: p.x, y: p.y, z: p.z }));
      } catch (_) {
        // Fallback: simple theta-based
        newArc = [];
        for (let s = 0; s <= segments; s++) {
          const theta = (s / segments) * sweep;
          newArc.push(_vec3Add(arcCenter, _vec3Add(
            _vec3Scale(e0, d.radius * Math.cos(theta)),
            _vec3Scale(e1, d.radius * Math.sin(theta))
          )));
        }
      }

      if (isA) {
        d.arcA = newArc;
        d._exactArcCurveA = _curveFromSampledPoints(newArc);
      } else {
        d.arcB = newArc;
        d._exactArcCurveB = _curveFromSampledPoints(newArc);
      }
    }
  }
}

function _curveFromSampledPoints(points) {
  if (!points || points.length < 2) return null;
  if (points.length === 2) return NurbsCurve.createLine(points[0], points[1]);
  return NurbsCurve.createPolyline(points);
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

// -----------------------------------------------------------------------
// Exact fillet face descriptors
// -----------------------------------------------------------------------

function _buildExactFilletFaceDesc(data) {
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

  // Build shared metadata including cylinder axis/radius for fillet-fillet intersection detection
  const sharedData = {
    ...(data.shared || {}),
    isFillet: true,
  };
  // Preserve cylinder metadata for sequential fillet operations
  if (data._exactAxisStart) sharedData._exactAxisStart = { ...data._exactAxisStart };
  if (data._exactAxisEnd) sharedData._exactAxisEnd = { ...data._exactAxisEnd };
  if (data._exactRadius) sharedData._exactRadius = data._exactRadius;

  return {
    surface,
    surfaceType: SurfaceType.BSPLINE,
    vertices,
    edgeCurves,
    sameSense,
    shared: sharedData,
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
        matched = _curveFromSampledPoints(ac.points);
        break;
      } else if (ac.startVK === vBk && ac.endVK === vAk) {
        const reversed = [...ac.points].reverse();
        matched = _curveFromSampledPoints(reversed);
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

  return {
    surface,
    surfaceType: surface ? SurfaceType.SPHERE : SurfaceType.PLANE,
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
    fusedGroupId: topoFace.fusedGroupId || null,
    vertices: origLoopVerts,
    edgeCurves,
    sameSense: topoFace.sameSense,
    shared: topoFace.shared ? { ...topoFace.shared } : null,
    stableHash: topoFace.stableHash || null,
  };
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

  for (const data of edgeDataList) {
    // Check if either adjacent face is non-planar (e.g. previous fillet surface)
    const face0 = faces[data.fi0];
    const face1 = faces[data.fi1];
    const orig0 = face0?.topoFaceId !== undefined ? origTopoFaces.get(face0.topoFaceId) : null;
    const orig1 = face1?.topoFaceId !== undefined ? origTopoFaces.get(face1.topoFaceId) : null;
    const hasNonPlanar = (orig0 && orig0.surfaceType !== 'plane') ||
                          (orig1 && orig1.surfaceType !== 'plane');
    if (hasNonPlanar) continue;

    // Add non-shared arc cross-section curves
    if (!data.sharedTrimA && data.arcA && data.arcA.length >= 2 && data._exactArcCurveA) {
      const k1 = _edgeVKey(data.arcA[0]);
      const k2 = _edgeVKey(data.arcA[data.arcA.length - 1]);
      if (k1 !== k2) {
        const unordered = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
        arcCurveLookup.set(unordered, data._exactArcCurveA);
      }
    }
    if (!data.sharedTrimB && data.arcB && data.arcB.length >= 2 && data._exactArcCurveB) {
      const k1 = _edgeVKey(data.arcB[0]);
      const k2 = _edgeVKey(data.arcB[data.arcB.length - 1]);
      if (k1 !== k2) {
        const unordered = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
        arcCurveLookup.set(unordered, data._exactArcCurveB);
      }
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
        const cps = e.curve.controlPoints;
        if (!cps || cps.length < 2) continue;
        if (e.curve.degree === 1 && cps.length <= 2) continue; // skip simple lines
        const sk = _edgeVKey(e.startVertex.point);
        const ek = _edgeVKey(e.endVertex.point);
        if (sk === ek) continue;
        const unordered = sk < ek ? `${sk}|${ek}` : `${ek}|${sk}`;
        if (!arcCurveLookup.has(unordered)) {
          arcCurveLookup.set(unordered, e.curve);
        }
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
      if (count >= 2) nonPlanarEdgeKeys.add(k);
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

          // Found a match — consolidate: remove intermediate vertices and edges
          const arcStart = _edgeVKey(arcCurve.controlPoints[0]);
          const replacement = arcStart === fk ? arcCurve.clone() : arcCurve.reversed();

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

      // Attempt to compute 3D intersection curve
      let intCurve = null;
      if (prevFillet) {
        intCurve = _computeFilletFilletIntersectionCurve(
          prevFillet, data, faces, radius, isA, origTopoBody,
        );
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
    const face0 = faces[data.fi0];
    const face1 = faces[data.fi1];
    if (face0 && face0.topoFaceId !== undefined) filletAdjacentFaceIds.add(face0.topoFaceId);
    if (face1 && face1.topoFaceId !== undefined) filletAdjacentFaceIds.add(face1.topoFaceId);
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
    filletAdjacentIndices.add(data.fi0);
    filletAdjacentIndices.add(data.fi1);
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

  return buildTopoBody(faceDescs);
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

  // Step 1: Extract mesh-level faces from TopoBody for edge adjacency
  const faces = _extractFeatureFacesFromTopoBody(geometry);
  if (!faces || faces.length === 0) {
    _debugBRepFillet('no-faces');
    return null;
  }

  // Build exact edge adjacency lookup from TopoBody
  const exactAdjacencyByKey = _buildExactEdgeAdjacencyLookupFromTopoBody(topoBody, faces);

  // Step 2: Precompute fillet data for each edge
  const uniqueKeys = [...new Set(edgeKeys)];
  const edgeDataList = [];
  for (const key of uniqueKeys) {
    const data = _precomputeFilletEdge(faces, key, radius, segments, exactAdjacencyByKey);
    if (data) edgeDataList.push(data);
  }
  if (edgeDataList.length === 0) {
    _debugBRepFillet('no-precomputed-edges', { edgeKeys: uniqueKeys.length });
    return null;
  }

  // Step 3: Merge shared vertex positions and apply two-edge fillet trims
  const vertexEdgeMap = _buildVertexEdgeMap(edgeDataList);
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
    filletFaceIndices.add(data.fi0);
    filletFaceIndices.add(data.fi1);
  }

  // Trim each face: for faces adjacent to filleted edges, replace edge
  // endpoint vertices with the corresponding fillet offset points.
  // For non-adjacent faces that share a vertex with a fillet edge,
  // split the vertex into the two fillet trim points.
  //
  // Build a lookup: vertexKey+faceIndex → trim data for direct face adjacency
  const vertexTrimLookup = new Map(); // "fi|vertexKey" → { data, isEdgeA, isFace0 }
  for (const data of edgeDataList) {
    const vkA = _edgeVKey(data.edgeA);
    const vkB = _edgeVKey(data.edgeB);
    vertexTrimLookup.set(`${data.fi0}|${vkA}`, { data, isEdgeA: true, isFace0: true });
    vertexTrimLookup.set(`${data.fi0}|${vkB}`, { data, isEdgeA: false, isFace0: true });
    vertexTrimLookup.set(`${data.fi1}|${vkA}`, { data, isEdgeA: true, isFace0: false });
    vertexTrimLookup.set(`${data.fi1}|${vkB}`, { data, isEdgeA: false, isFace0: false });
  }

  // Build vertex-key → all fillet data touching that vertex (for non-adjacent faces)
  const vertexFilletMap = new Map(); // vertexKey → [{data, isEdgeA}]
  for (const data of edgeDataList) {
    const vkA = _edgeVKey(data.edgeA);
    const vkB = _edgeVKey(data.edgeB);
    if (!vertexFilletMap.has(vkA)) vertexFilletMap.set(vkA, []);
    vertexFilletMap.get(vkA).push({ data, isEdgeA: true });
    if (!vertexFilletMap.has(vkB)) vertexFilletMap.set(vkB, []);
    vertexFilletMap.get(vkB).push({ data, isEdgeA: false });
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
          // Two trim points: order by proximity to incoming edge direction.
          const dirPrev = _vec3Normalize(_vec3Sub(vPrev, v));
          const d0prev = _vec3Dot(_vec3Normalize(_vec3Sub(trimPts[0], v)), dirPrev);
          const d1prev = _vec3Dot(_vec3Normalize(_vec3Sub(trimPts[1], v)), dirPrev);

          if (d0prev > d1prev) {
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

  // Step 5: Build exact NURBS fillet surfaces for each edge data
  for (const data of edgeDataList) {
    // Build NURBS cylinder surface for the fillet strip
    const arcA = data.sharedTrimA || data.arcA;
    const arcB = data.sharedTrimB || data.arcB;
    if (!arcA || !arcB || arcA.length < 2 || arcB.length < 2) continue;

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
    const arcCurves = []; // [{startVK, endVK, points}]
    for (const di of cornerEdgeIndices) {
      const d = edgeDataList[di];
      const isA = _edgeVKey(d.edgeA) === vk;
      const arc = isA ? d.arcA : d.arcB;
      if (!arc || arc.length < 2) continue;
      const startVK = _edgeVKey(arc[0]);
      const endVK = _edgeVKey(arc[arc.length - 1]);
      arcCurves.push({ startVK, endVK, points: arc });
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
  if (!newTopoBody) {
    _debugBRepFillet('build-topobody-failed');
    return null;
  }

  const topoBoundaryEdges = countTopoBodyBoundaryEdges(newTopoBody);
  if (topoBoundaryEdges !== 0) {
    _debugBRepFillet('topo-boundary-edges', { topoBoundaryEdges });
    // For fillet, boundary edges are common due to complex corner geometry
    // Don't reject immediately — try tessellation anyway
  }

  // Step 7: Tessellate
  let mesh;
  try {
    mesh = tessellateBody(newTopoBody, {
      validate: false,
      incrementalCache: geometry && geometry._incrementalTessellationCache
        ? geometry._incrementalTessellationCache
        : null,
    });
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
  const preFixTopology = measureMeshTopology(mesh.faces);
  if (!bodyCurved &&
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
