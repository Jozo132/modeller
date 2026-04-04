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

  const t0a = _vec3Add(edgeA, _vec3Scale(offsDir0, tangentDist));
  const t0b = _vec3Add(edgeB, _vec3Scale(offsDir0, tangentDist));
  const t1a = _vec3Add(edgeA, _vec3Scale(offsDir1, tangentDist));
  const t1b = _vec3Add(edgeB, _vec3Scale(offsDir1, tangentDist));

  function computeArc(vertex) {
    const center = _vec3Add(vertex, _vec3Scale(bisector, centerDist));
    const t0 = _vec3Add(vertex, _vec3Scale(offsDir0, tangentDist));
    const e0 = _vec3Normalize(_vec3Sub(t0, center));
    const t1 = _vec3Add(vertex, _vec3Scale(offsDir1, tangentDist));
    // Use NURBS arc tessellation to match EdgeSampler's parameterization.
    // This ensures polygon arc boundaries align exactly with NURBS edge samples.
    try {
      const nurbsArc = NurbsCurve.createArc(center, radius, e0, _vec3Cross(edgeDir, e0), 0, sweep);
      const tessPoints = nurbsArc.tessellate(segments);
      return tessPoints.map(p => ({ x: p.x, y: p.y, z: p.z }));
    } catch (e) {
      // Fallback to simple theta-based sampling if NURBS fails
      const e1 = _vec3Normalize(_vec3Sub(t1, center));
      const cosSweep = Math.cos(sweep);
      const sinSweep = Math.sin(sweep);
      const perp = sinSweep > 1e-10
        ? _vec3Scale(_vec3Sub(e1, _vec3Scale(e0, cosSweep)), 1 / sinSweep)
        : e1;
      const points = [];
      for (let s = 0; s <= segments; s++) {
        const theta = (s / segments) * sweep;
        points.push(_vec3Add(center, _vec3Add(
          _vec3Scale(e0, radius * Math.cos(theta)),
          _vec3Scale(perp, radius * Math.sin(theta))
        )));
      }
      return points;
    }
  }

  const arcA = computeArc(edgeA);
  const arcB = computeArc(edgeB);

  // p0a/p0b/p1a/p1b for trim compatibility with batch helpers
  return {
    edgeKey, fi0, fi1, edgeA, edgeB,
    face0Keys, face1Keys,
    p0a: t0a, p0b: t0b, p1a: t1a, p1b: t1b,
    arcA, arcB,
    isConcave,
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

    // Linear merged trim vertices are correct for chamfers and can help the
    // 2-edge fillet case, but they are wrong for a 3-edge rolling-ball
    // corner: they create fake planar points like (9,9,10) that leave a
    // residual loop later healed into sliver faces. Let the trihedron be
    // bounded only by the strip arcs in that case.
    const hasFillet = edgeIndices.some((di) => !!edgeDataList[di].arcA);
    if (hasFillet && edgeIndices.length >= 3) continue;

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
    while (seg < lengths.length && lengths[seg] < target) seg++;
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
  for (const [vk, edgeIndices] of vertexEdgeMap) {
    if (edgeIndices.length !== 2) continue;

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
        while (angle - prevAngle > Math.PI) angle -= 2 * Math.PI;
        while (angle - prevAngle < -Math.PI) angle += 2 * Math.PI;
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

  const denseBoundary = [
    ...trimA.map((point) => ({ ...point })),
    ...[...trimB].reverse().map((point) => ({ ...point })),
  ];

  let vertices = [
    { ...trimA[0] },
    { ...trimA[trimA.length - 1] },
    { ...trimB[trimB.length - 1] },
    { ...trimB[0] },
  ];

  // Build edge curves for the fillet face.
  // Edges 0 and 2 are the arc cross-section boundaries (A and B sides).
  // Edges 1 and 3 are straight-line connections between the rails.
  //
  // When the fillet is used in a BRep context (only 4 corner vertices),
  // the side boundary edges (edges 0 and 2) must use straight lines so
  // they can be shared with adjacent planar faces via buildTopoBody's
  // edge deduplication. The NURBS surface itself provides the actual arc
  // geometry; the edge curves just define the topological boundary.
  const useSimpleSideEdges = data._brepSideEdges !== false;
  let edgeCurves;
  if (useSimpleSideEdges) {
    // Use straight lines for side edges to match adjacent planar faces
    edgeCurves = [
      NurbsCurve.createLine(trimA[0], trimA[trimA.length - 1]),
      NurbsCurve.createLine(trimA[trimA.length - 1], trimB[trimB.length - 1]),
      NurbsCurve.createLine(trimB[trimB.length - 1], trimB[0]),
      NurbsCurve.createLine(trimB[0], trimA[0]),
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
  const edgeCurves = [
    NurbsCurve.createLine(triVerts[0], triVerts[1]),
    NurbsCurve.createLine(triVerts[1], triVerts[2]),
    NurbsCurve.createLine(triVerts[2], triVerts[0]),
  ];

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
    surfaceType: surface ? SurfaceType.SPHERE : SurfaceType.PLANE,
    vertices,
    edgeCurves,
    sameSense,
    shared: cornerGroup[0].shared ? { ...cornerGroup[0].shared, isCorner: true } : { isCorner: true },
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
// Main entry point
// -----------------------------------------------------------------------

function _buildExactFilletTopoBody(faces, edgeDataList) {
  if (!faces || !Array.isArray(faces) || !edgeDataList || edgeDataList.length === 0) return null;

  const faceDescs = [];

  for (const face of faces) {
    if (!face || face.isFillet || face.isCorner) continue;
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
  return buildTopoBody(faceDescs);
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
  _applyTwoEdgeFilletSharedTrims(edgeDataList, faces, vertexEdgeMap);

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
        // Insert both trim points (p0 and p1 side) in the correct order
        // to maintain consistent face boundary winding.
        const vNext = origVerts[(vi + 1) % n];
        const vPrev = origVerts[(vi - 1 + n) % n];

        // Collect trim points from all fillet edges at this vertex
        const trimPts = [];
        for (const entry of filletEntries) {
          const p0 = entry.isEdgeA ? entry.data.p0a : entry.data.p0b;
          const p1 = entry.isEdgeA ? entry.data.p1a : entry.data.p1b;
          trimPts.push(p0, p1);
        }

        if (trimPts.length === 2) {
          // Single fillet at this vertex: insert both trim points.
          // Order by proximity to incoming edge direction: the trim point
          // closer to vPrev should come first in the boundary walk.
          const dirPrev = _vec3Normalize(_vec3Sub(vPrev, v));
          const d0prev = _vec3Dot(_vec3Normalize(_vec3Sub(trimPts[0], v)), dirPrev);
          const d1prev = _vec3Dot(_vec3Normalize(_vec3Sub(trimPts[1], v)), dirPrev);

          if (d0prev > d1prev) {
            newVerts.push({ ...trimPts[0] }, { ...trimPts[1] });
          } else {
            newVerts.push({ ...trimPts[1] }, { ...trimPts[0] });
          }
          modified = true;
        } else {
          // Multiple fillets at vertex — fallback: keep original
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

  // Step 5: Build exact NURBS fillet surfaces for each edge data
  for (const data of edgeDataList) {
    // Build NURBS cylinder surface for the fillet strip
    const arcA = data.sharedTrimA || data.arcA;
    const arcB = data.sharedTrimB || data.arcB;
    if (!arcA || !arcB || arcA.length < 2 || arcB.length < 2) continue;

    // The fillet surface is a cylinder ruled between arcA and arcB
    // Compute center line for the fillet
    const edgeDir = _vec3Normalize(_vec3Sub(data.edgeB, data.edgeA));
    const edgeLen = _vec3Len(_vec3Sub(data.edgeB, data.edgeA));

    // Compute rail curves and center points for NurbsSurface.createFilletSurface
    const nPts = Math.min(arcA.length, arcB.length);
    const rail0 = [];
    const rail1 = [];
    const centers = [];

    for (let i = 0; i < nPts; i++) {
      rail0.push({ ...arcA[i] });
      rail1.push({ ...arcB[i] });
      // Center for each cross-section = midpoint of edge projected at this arc param
      const t = nPts > 1 ? i / (nPts - 1) : 0;
      const edgePt = _vec3Lerp(data.edgeA, data.edgeB, t);
      // The rolling-ball center is at the edge point offset along the bisector
      const { offsDir0, offsDir1 } = _computeOffsetDirs(
        faces[data.fi0], faces[data.fi1], data.edgeA, data.edgeB
      );
      const alpha = Math.acos(Math.max(-1, Math.min(1, _vec3Dot(offsDir0, offsDir1))));
      const centerDist = alpha > 1e-6 ? radius / Math.sin(alpha / 2) : radius;
      const bisector = _vec3Normalize(_vec3Add(offsDir0, offsDir1));
      centers.push(_vec3Add(edgePt, _vec3Scale(bisector, centerDist)));
    }

    try {
      const surface = NurbsSurface.createFilletSurface(rail0, rail1, centers, radius, edgeDir);
      data._exactSurface = surface;
      data._exactAxisStart = { ...data.edgeA };
      data._exactAxisEnd = { ...data.edgeB };
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

  // Step 6: Build the exact fillet TopoBody
  // Mark fillet faces in trimmed faces
  for (const data of edgeDataList) {
    // The fillet strip face will be added by _buildExactFilletTopoBody
    // Ensure the trimmed faces are tagged for _buildExactFilletTopoBody
  }

  // _buildExactFilletTopoBody expects trimmed faces and edgeDataList
  const newTopoBody = _buildExactFilletTopoBody(trimmedFaces, edgeDataList);
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
    mesh = tessellateBody(newTopoBody, { validate: false });
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
