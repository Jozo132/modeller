// js/cad/FaceSplitter.js — Face splitting by intersection curves
//
// Splits exact B-Rep faces by intersection trim curves in parameter space.
// Handles:
//   - Split analytic faces by exact trim curves
//   - Classify loop orientation in face UV space
//   - Rebuild trimmed face fragments

import { NurbsCurve } from './NurbsCurve.js';
import { TopoFace, TopoLoop, TopoCoEdge, TopoEdge, TopoVertex, SurfaceType } from './BRepTopology.js';
import { DEFAULT_TOLERANCE } from './Tolerance.js';
import { classifyFragment as _containmentClassifyFragment } from './Containment.js';
import { GeometryEvaluator } from './GeometryEvaluator.js';

/**
 * Split a face by a set of intersection curves.
 *
 * Each curve is assumed to cross the face, splitting it into fragments.
 * Returns the resulting face fragments.
 *
 * @param {import('./BRepTopology.js').TopoFace} face
 * @param {Array<{curve: NurbsCurve, paramsOnFace: Array<{u,v}>}>} splitCurves
 * @param {import('./Tolerance.js').Tolerance} [tol]
 * @returns {import('./BRepTopology.js').TopoFace[]} Face fragments
 */
export function splitFace(face, splitCurves, tol = DEFAULT_TOLERANCE) {
  if (!splitCurves || splitCurves.length === 0) return [face];
  if (!face.surface) return [face];

  let fragments = [face];
  for (const sc of splitCurves) {
    if (!sc.curve || !sc.paramsOnFace || sc.paramsOnFace.length < 2) continue;
    const nextFragments = [];
    for (const fragment of fragments) {
      nextFragments.push(..._splitFaceByOneCurve(fragment, sc.curve, sc.paramsOnFace, tol));
    }
    fragments = nextFragments;
  }

  return fragments;
}

/**
 * Split a face by a single curve.
 */
function _splitFaceByOneCurve(face, curve, paramsOnFace, tol) {
  if (face.surfaceType === SurfaceType.PLANE && face.outerLoop) {
    return _splitPlanarFaceByCurve(face, curve, tol);
  }

  // Sample the curve to find entry/exit points on the face boundary
  const entryExit = _findBoundaryIntersections(face, curve, paramsOnFace, tol);

  if (entryExit.length < 2) {
    // Curve doesn't properly cross the face
    return [face];
  }

  // Create new vertices at boundary intersections
  const newVerts = entryExit.map(pt => new TopoVertex(pt.point, tol.pointCoincidence));

  // Create the splitting edge
  const splitEdge = new TopoEdge(newVerts[0], newVerts[newVerts.length - 1], curve, tol.edgeOverlap);

  // Build two face fragments from the split
  const fragment1 = _buildFragment(face, splitEdge, true, tol);
  const fragment2 = _buildFragment(face, splitEdge, false, tol);

  if (fragment1 && fragment2) {
    return [fragment1, fragment2];
  }

  return [face];
}

function _splitPlanarFaceByCurve(face, curve, tol) {
  const boundary3D = face.outerLoop?.points() || [];
  if (boundary3D.length < 3) return [face];

  const planeNormal = _faceNormal(face);
  const lineStart = GeometryEvaluator.evalCurve(curve, curve.uMin).p;
  const lineEnd = GeometryEvaluator.evalCurve(curve, curve.uMax).p;
  const projected = _project3Dto2D(boundary3D, lineStart, planeNormal, lineEnd);
  const polygon2D = projected.pts2D;
  const line2D0 = projected.pt2D;
  const line2D1 = projected.line2D;

  const intersections = [];
  for (let i = 0; i < polygon2D.length; i++) {
    const a2 = polygon2D[i];
    const b2 = polygon2D[(i + 1) % polygon2D.length];
    const hit = _intersectInfiniteLineWithSegment2D(line2D0, line2D1, a2, b2, tol);
    if (!hit) continue;

    const a3 = boundary3D[i];
    const b3 = boundary3D[(i + 1) % boundary3D.length];
    const point3D = {
      x: a3.x + (b3.x - a3.x) * hit.segT,
      y: a3.y + (b3.y - a3.y) * hit.segT,
      z: a3.z + (b3.z - a3.z) * hit.segT,
    };
    _pushUniqueIntersection(intersections, {
      edgeIndex: i,
      edgeT: hit.segT,
      lineT: hit.lineT,
      point3D,
      point2D: hit.point,
    }, tol);
  }

  if (intersections.length < 2) return [face];
  intersections.sort((a, b) => a.lineT - b.lineT);
  const first = intersections[0];
  const last = intersections[intersections.length - 1];
  if (_pointsCoincident3D(first.point3D, last.point3D, tol)) return [face];

  const inserted = _insertSplitPoints(boundary3D, first, last, tol);
  if (!inserted) return [face];

  const fragA = _buildPolygonFromSplit(inserted.points, inserted.firstIndex, inserted.secondIndex, true);
  const fragB = _buildPolygonFromSplit(inserted.points, inserted.firstIndex, inserted.secondIndex, false);
  if (fragA.length < 3 || fragB.length < 3) return [face];

  const faceNormal = _loopNormal(boundary3D);
  const fragAFixed = _orientFragmentLikeFace(fragA, faceNormal);
  const fragBFixed = _orientFragmentLikeFace(fragB, faceNormal);

  return [
    _buildPlanarFragment(face, fragAFixed, tol),
    _buildPlanarFragment(face, fragBFixed, tol),
  ];
}

/**
 * Find where a curve intersects the face boundary.
 */
function _findBoundaryIntersections(face, curve, paramsOnFace, tol) {
  const results = [];

  // Check if start/end of curve are on the face boundary
  const startPt = GeometryEvaluator.evalCurve(curve, curve.uMin).p;
  const endPt = GeometryEvaluator.evalCurve(curve, curve.uMax).p;

  results.push({ point: startPt, param: curve.uMin });
  results.push({ point: endPt, param: curve.uMax });

  return results;
}

/**
 * Build a face fragment from one side of a split.
 */
function _buildFragment(face, splitEdge, side, tol) {
  // Create a new face with the same surface
  const fragment = new TopoFace(
    face.surface ? face.surface.clone() : null,
    face.surfaceType,
    face.sameSense,
  );
  fragment.shared = face.shared ? { ...face.shared } : null;
  fragment.tolerance = face.tolerance;

  // For now, the outer loop includes the original edges plus the split edge
  // This is a simplified version; full implementation would trace the loops
  if (face.outerLoop) {
    const coedges = face.outerLoop.coedges.map(ce => ce.clone());
    // Add the split edge
    const splitCoEdge = new TopoCoEdge(splitEdge, side, null);
    coedges.push(splitCoEdge);
    const loop = new TopoLoop(coedges);
    fragment.setOuterLoop(loop);
  }

  return fragment;
}

function _buildPlanarFragment(face, polygon, tol) {
  const fragment = new TopoFace(
    face.surface ? face.surface.clone() : null,
    face.surfaceType,
    face.sameSense,
  );
  fragment.shared = face.shared ? { ...face.shared } : null;
  fragment.tolerance = face.tolerance;

  const vertices = polygon.map(pt => new TopoVertex(pt, tol.pointCoincidence));
  const coedges = [];
  for (let i = 0; i < vertices.length; i++) {
    const v0 = vertices[i];
    const v1 = vertices[(i + 1) % vertices.length];
    const edge = new TopoEdge(v0, v1, NurbsCurve.createLine(v0.point, v1.point), tol.edgeOverlap);
    coedges.push(new TopoCoEdge(edge, true, null));
  }
  fragment.setOuterLoop(new TopoLoop(coedges));
  return fragment;
}

/**
 * Classify a point relative to a face (inside/outside/on-boundary).
 *
 * Uses a ray-casting approach in the face's parameter space if p-curves
 * are available, otherwise falls back to 3D point-in-polygon test.
 *
 * @param {{x:number,y:number,z:number}} point
 * @param {import('./BRepTopology.js').TopoFace} face
 * @param {import('./Tolerance.js').Tolerance} [tol]
 * @returns {'inside'|'outside'|'on'}
 */
export function classifyPointOnFace(point, face, tol = DEFAULT_TOLERANCE) {
  if (!face.outerLoop) return 'outside';

  // Get boundary polygon
  const boundary = face.outerLoop.points();
  if (boundary.length < 3) return 'outside';

  // Check if point is on boundary
  for (const bp of boundary) {
    if (tol.pointsCoincident(point, bp)) return 'on';
  }

  // Get face normal
  const normal = face.surface
    ? GeometryEvaluator.evalSurface(face.surface, 0.5, 0.5).n
    : _polyNormal(boundary);

  // Project to 2D and use ray casting
  const { pts2D, pt2D } = _project3Dto2D(boundary, point, normal);
  const inside = _pointInPolygon2D(pt2D, pts2D);

  return inside ? 'inside' : 'outside';
}

/**
 * Classify a face fragment as inside, outside, or coincident
 * relative to a solid body.
 *
 * Delegates to the authoritative Containment engine.
 *
 * @param {import('./BRepTopology.js').TopoFace} fragment
 * @param {import('./BRepTopology.js').TopoBody} body
 * @param {import('./Tolerance.js').Tolerance} [tol]
 * @returns {'inside'|'outside'|'coincident'}
 */
export function classifyFragment(fragment, body, tol = DEFAULT_TOLERANCE) {
  const result = _containmentClassifyFragment(body, fragment, { tolerance: tol });

  // Map the Containment result states back to the legacy string API
  switch (result.state) {
    case 'inside': return 'inside';
    case 'outside': return 'outside';
    case 'on': return 'coincident';
    case 'uncertain':
      // For uncertain cases, fall back to legacy ray-cast to preserve
      // existing behavior while the robust path matures
      return _legacyRayCastClassify(fragment, body, tol);
    default: return 'outside';
  }
}

/**
 * Legacy ray-cast fallback for uncertain Containment results.
 * Preserves prior behavior: single +Z ray, parity-based.
 */
function _legacyRayCastClassify(fragment, body, tol) {
  const testPoint = _sampleInteriorPoint(fragment);
  if (!testPoint) return 'outside';
  return _rayCastClassify(testPoint, body, tol);
}

/**
 * Sample an interior point of a face.
 */
function _sampleInteriorPoint(face) {
  if (face.outerLoop) {
    const pts = face.outerLoop.points();
    if (pts.length >= 3) {
      const centroid = {
        x: (pts[0].x + pts[1].x + pts[2].x) / 3,
        y: (pts[0].y + pts[1].y + pts[2].y) / 3,
        z: (pts[0].z + pts[1].z + pts[2].z) / 3,
      };
      const n = _faceNormal(face);
      return {
        x: centroid.x + n.x * 1e-5,
        y: centroid.y + n.y * 1e-5,
        z: centroid.z + n.z * 1e-5,
      };
    }
  }

  if (face.surface) {
    const uMid = (face.surface.uMin + face.surface.uMax) / 2;
    const vMid = (face.surface.vMin + face.surface.vMax) / 2;
    const point = GeometryEvaluator.evalSurface(face.surface, uMid, vMid).p;
    const n = _faceNormal(face);
    return {
      x: point.x + n.x * 1e-5,
      y: point.y + n.y * 1e-5,
      z: point.z + n.z * 1e-5,
    };
  }

  return null;
}

/**
 * Ray-cast classification of a point against a body.
 */
function _rayCastClassify(point, body, tol) {
  // Cast a ray in +Z direction and count crossings
  let crossings = 0;
  const rayDir = { x: 0, y: 0, z: 1 };

  for (const shell of body.shells) {
    for (const face of shell.faces) {
      if (!face.outerLoop) continue;
      const pts = face.outerLoop.points();
      if (pts.length < 3) continue;

      // Simplified: check each triangle of the face
      for (let i = 1; i < pts.length - 1; i++) {
        if (_rayTriangleIntersect(point, rayDir, pts[0], pts[i], pts[i + 1], tol)) {
          crossings++;
        }
      }
    }
  }

  // Odd crossings = inside
  return crossings % 2 === 1 ? 'inside' : 'outside';
}

/**
 * Möller–Trumbore ray-triangle intersection.
 */
function _rayTriangleIntersect(origin, dir, v0, v1, v2, tol) {
  const eps = tol.modelingEpsilon;

  const e1 = { x: v1.x - v0.x, y: v1.y - v0.y, z: v1.z - v0.z };
  const e2 = { x: v2.x - v0.x, y: v2.y - v0.y, z: v2.z - v0.z };

  const h = {
    x: dir.y * e2.z - dir.z * e2.y,
    y: dir.z * e2.x - dir.x * e2.z,
    z: dir.x * e2.y - dir.y * e2.x,
  };

  const a = e1.x * h.x + e1.y * h.y + e1.z * h.z;
  if (Math.abs(a) < eps) return false;

  const f = 1.0 / a;
  const s = { x: origin.x - v0.x, y: origin.y - v0.y, z: origin.z - v0.z };
  const u = f * (s.x * h.x + s.y * h.y + s.z * h.z);
  if (u < -eps || u > 1.0 + eps) return false;

  const q = {
    x: s.y * e1.z - s.z * e1.y,
    y: s.z * e1.x - s.x * e1.z,
    z: s.x * e1.y - s.y * e1.x,
  };
  const v = f * (dir.x * q.x + dir.y * q.y + dir.z * q.z);
  if (v < -eps || u + v > 1.0 + eps) return false;

  const t = f * (e2.x * q.x + e2.y * q.y + e2.z * q.z);
  return t > eps;
}

/**
 * Project 3D points to 2D along a normal.
 */
function _project3Dto2D(pts3D, point3D, normal, linePoint3D = null) {
  // Choose projection axes perpendicular to normal
  const ax = Math.abs(normal.x);
  const ay = Math.abs(normal.y);
  const az = Math.abs(normal.z);

  let u, v;
  if (az >= ax && az >= ay) {
    // Project to XY
    u = (p) => p.x;
    v = (p) => p.y;
  } else if (ay >= ax) {
    // Project to XZ
    u = (p) => p.x;
    v = (p) => p.z;
  } else {
    // Project to YZ
    u = (p) => p.y;
    v = (p) => p.z;
  }

  return {
    pts2D: pts3D.map(p => ({ u: u(p), v: v(p) })),
    pt2D: { u: u(point3D), v: v(point3D) },
    line2D: linePoint3D ? { u: u(linePoint3D), v: v(linePoint3D) } : null,
  };
}

/**
 * 2D point-in-polygon using ray casting.
 */
function _pointInPolygon2D(pt, polygon) {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const pi = polygon[i], pj = polygon[j];
    if ((pi.v > pt.v) !== (pj.v > pt.v) &&
        pt.u < (pj.u - pi.u) * (pt.v - pi.v) / (pj.v - pi.v) + pi.u) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Compute polygon normal from first 3 points.
 */
function _polyNormal(pts) {
  if (pts.length < 3) return { x: 0, y: 0, z: 1 };
  const v1 = { x: pts[1].x - pts[0].x, y: pts[1].y - pts[0].y, z: pts[1].z - pts[0].z };
  const v2 = { x: pts[2].x - pts[0].x, y: pts[2].y - pts[0].y, z: pts[2].z - pts[0].z };
  const nx = v1.y * v2.z - v1.z * v2.y;
  const ny = v1.z * v2.x - v1.x * v2.z;
  const nz = v1.x * v2.y - v1.y * v2.x;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 1e-14) return { x: 0, y: 0, z: 1 };
  return { x: nx / len, y: ny / len, z: nz / len };
}

function _intersectInfiniteLineWithSegment2D(lineA, lineB, segA, segB, tol) {
  const r = { u: lineB.u - lineA.u, v: lineB.v - lineA.v };
  const s = { u: segB.u - segA.u, v: segB.v - segA.v };
  const denom = r.u * s.v - r.v * s.u;
  if (Math.abs(denom) < tol.intersection) return null;

  const qp = { u: segA.u - lineA.u, v: segA.v - lineA.v };
  const lineT = (qp.u * s.v - qp.v * s.u) / denom;
  const segT = (qp.u * r.v - qp.v * r.u) / denom;
  if (segT < -tol.intersection || segT > 1 + tol.intersection) return null;

  return {
    lineT,
    segT: Math.max(0, Math.min(1, segT)),
    point: {
      u: lineA.u + lineT * r.u,
      v: lineA.v + lineT * r.v,
    },
  };
}

function _pushUniqueIntersection(intersections, candidate, tol) {
  for (const hit of intersections) {
    if (_pointsCoincident3D(hit.point3D, candidate.point3D, tol)) return;
  }
  intersections.push(candidate);
}

function _pointsCoincident3D(a, b, tol) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) <= tol.pointCoincidence * 10;
}

function _insertSplitPoints(boundary3D, first, second, tol) {
  const points = [];
  let firstIndex = -1;
  let secondIndex = -1;
  const ordered = [first, second].sort((a, b) => {
    if (a.edgeIndex !== b.edgeIndex) return a.edgeIndex - b.edgeIndex;
    return a.edgeT - b.edgeT;
  });
  const hitMap = new Map();
  for (const hit of ordered) {
    if (!hitMap.has(hit.edgeIndex)) hitMap.set(hit.edgeIndex, []);
    hitMap.get(hit.edgeIndex).push(hit);
  }

  for (let i = 0; i < boundary3D.length; i++) {
    points.push({ ...boundary3D[i] });
    const idx = points.length - 1;
    if (_pointsCoincident3D(points[idx], first.point3D, tol) && firstIndex < 0) firstIndex = idx;
    if (_pointsCoincident3D(points[idx], second.point3D, tol) && secondIndex < 0) secondIndex = idx;

    const hits = hitMap.get(i) || [];
    for (const hit of hits) {
      if (_pointsCoincident3D(boundary3D[i], hit.point3D, tol) ||
          _pointsCoincident3D(boundary3D[(i + 1) % boundary3D.length], hit.point3D, tol)) {
        continue;
      }
      points.push({ ...hit.point3D });
      const insertedIdx = points.length - 1;
      if (hit === first) firstIndex = insertedIdx;
      if (hit === second) secondIndex = insertedIdx;
    }
  }

  if (firstIndex < 0 || secondIndex < 0) return null;
  return { points, firstIndex, secondIndex };
}

function _buildPolygonFromSplit(points, firstIndex, secondIndex, forward) {
  const polygon = [];
  const start = forward ? firstIndex : secondIndex;
  const end = forward ? secondIndex : firstIndex;
  polygon.push({ ...points[start] });
  let i = start;
  while (i !== end) {
    i = (i + 1) % points.length;
    polygon.push({ ...points[i] });
  }
  return _deduplicatePolygon3D(polygon);
}

function _deduplicatePolygon3D(points) {
  const out = [];
  for (const point of points) {
    if (out.length === 0 || !_pointsCoincident3D(out[out.length - 1], point, DEFAULT_TOLERANCE)) {
      out.push(point);
    }
  }
  if (out.length > 1 && _pointsCoincident3D(out[0], out[out.length - 1], DEFAULT_TOLERANCE)) {
    out.pop();
  }
  return out;
}

function _loopNormal(points) {
  return _polyNormal(points);
}

function _orientFragmentLikeFace(points, targetNormal) {
  const n = _loopNormal(points);
  const dot = n.x * targetNormal.x + n.y * targetNormal.y + n.z * targetNormal.z;
  return dot >= 0 ? points : [...points].reverse();
}

function _faceNormal(face) {
  let n = null;
  if (face.outerLoop) {
    const pts = face.outerLoop.points();
    if (pts.length >= 3) n = _polyNormal(pts);
  }
  if (!n && face.surface) {
    n = GeometryEvaluator.evalSurface(face.surface,
      (face.surface.uMin + face.surface.uMax) / 2,
      (face.surface.vMin + face.surface.vMax) / 2,
    ).n;
  }
  if (!n) n = { x: 0, y: 0, z: 1 };
  if (face.sameSense === false) {
    return { x: -n.x, y: -n.y, z: -n.z };
  }
  return n;
}
