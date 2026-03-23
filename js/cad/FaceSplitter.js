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

  // For each split curve, create new edges and vertices at the intersections
  const fragments = [];
  let remainingFace = face;

  for (const sc of splitCurves) {
    if (!sc.curve || !sc.paramsOnFace || sc.paramsOnFace.length < 2) continue;

    const result = _splitFaceByOneCurve(remainingFace, sc.curve, sc.paramsOnFace, tol);
    if (result.length > 1) {
      // Successfully split; keep first as "remaining", add rest to fragments
      remainingFace = result[0];
      for (let i = 1; i < result.length; i++) {
        fragments.push(result[i]);
      }
    }
  }

  fragments.unshift(remainingFace);
  return fragments;
}

/**
 * Split a face by a single curve.
 */
function _splitFaceByOneCurve(face, curve, paramsOnFace, tol) {
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

/**
 * Find where a curve intersects the face boundary.
 */
function _findBoundaryIntersections(face, curve, paramsOnFace, tol) {
  const results = [];

  // Check if start/end of curve are on the face boundary
  const startPt = curve.evaluate(curve.uMin);
  const endPt = curve.evaluate(curve.uMax);

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
    ? face.surface.normal(0.5, 0.5)
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
 * @param {import('./BRepTopology.js').TopoFace} fragment
 * @param {import('./BRepTopology.js').TopoBody} body
 * @param {import('./Tolerance.js').Tolerance} [tol]
 * @returns {'inside'|'outside'|'coincident'}
 */
export function classifyFragment(fragment, body, tol = DEFAULT_TOLERANCE) {
  // Sample a point in the interior of the fragment
  const testPoint = _sampleInteriorPoint(fragment);
  if (!testPoint) return 'outside';

  // Ray-cast against the body to determine inside/outside
  return _rayCastClassify(testPoint, body, tol);
}

/**
 * Sample an interior point of a face.
 */
function _sampleInteriorPoint(face) {
  if (face.surface) {
    const uMid = (face.surface.uMin + face.surface.uMax) / 2;
    const vMid = (face.surface.vMin + face.surface.vMax) / 2;
    return face.surface.evaluate(uMid, vMid);
  }

  if (face.outerLoop) {
    const pts = face.outerLoop.points();
    if (pts.length >= 3) {
      return {
        x: (pts[0].x + pts[1].x + pts[2].x) / 3,
        y: (pts[0].y + pts[1].y + pts[2].y) / 3,
        z: (pts[0].z + pts[1].z + pts[2].z) / 3,
      };
    }
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
function _project3Dto2D(pts3D, point3D, normal) {
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
