// js/cad/Tessellator2/Refinement.js — Adaptive refinement hooks
//
// Provides chordal-error and angular-error based refinement for
// tessellation results. Structured so stricter intersection-free
// refinement can be added without redesigning the pipeline.

import { GeometryEvaluator } from '../GeometryEvaluator.js';

/**
 * Compute the chordal error between a straight edge (p0→p1) and the
 * midpoint of the underlying curve at parameter tMid.
 *
 * @param {{x:number,y:number,z:number}} p0
 * @param {{x:number,y:number,z:number}} p1
 * @param {{x:number,y:number,z:number}} curveMid - Actual curve midpoint
 * @returns {number} Maximum distance from the line segment to the curve midpoint
 */
export function chordalError(p0, p1, curveMid) {
  // Midpoint of the straight edge
  const mx = (p0.x + p1.x) * 0.5;
  const my = (p0.y + p1.y) * 0.5;
  const mz = (p0.z + p1.z) * 0.5;
  const dx = curveMid.x - mx;
  const dy = curveMid.y - my;
  const dz = curveMid.z - mz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Compute the angular error between two consecutive normal vectors.
 *
 * @param {{x:number,y:number,z:number}} n0
 * @param {{x:number,y:number,z:number}} n1
 * @returns {number} Angle in degrees between n0 and n1
 */
export function angularError(n0, n1) {
  const dot = n0.x * n1.x + n0.y * n1.y + n0.z * n1.z;
  const clamped = Math.max(-1, Math.min(1, dot));
  return Math.acos(clamped) * (180 / Math.PI);
}

/**
 * Determine the recommended edge segment count based on chordal tolerance.
 *
 * Samples the edge curve at several parameters and checks whether the
 * straight-line approximation exceeds the tolerance. Returns a segment
 * count that keeps the chordal error below the threshold.
 *
 * @param {import('../GeometryEvaluator.js').GeometryEvaluator} evaluator - GeometryEvaluator instance (unused — evaluation delegated internally)
 * @param {import('../NurbsCurve.js').NurbsCurve} curve
 * @param {number} baseSegments - Initial segment count
 * @param {number} [maxSegments=256] - Upper limit
 * @param {number} [chordalTolerance=0.01] - Max acceptable chordal deviation
 * @returns {number} Recommended segment count
 */
export function recommendEdgeSegments(evaluator, curve, baseSegments, maxSegments = 256, chordalTolerance = 0.01) {
  if (!curve) return baseSegments;

  let segments = baseSegments;
  const uMin = curve.knots[0];
  const uMax = curve.knots[curve.knots.length - 1];

  // Check chordal error with current segment count
  while (segments < maxSegments) {
    let maxError = 0;
    for (let i = 0; i < segments; i++) {
      const t0 = i / segments;
      const t1 = (i + 1) / segments;
      const tMid = (t0 + t1) * 0.5;

      const u0 = uMin + t0 * (uMax - uMin);
      const u1 = uMin + t1 * (uMax - uMin);
      const uMid = uMin + tMid * (uMax - uMin);

      const p0 = GeometryEvaluator.evalCurve(curve, u0).p;
      const p1 = GeometryEvaluator.evalCurve(curve, u1).p;
      const pMid = GeometryEvaluator.evalCurve(curve, uMid).p;

      const err = chordalError(p0, p1, pMid);
      if (err > maxError) maxError = err;
    }

    if (maxError <= chordalTolerance) break;
    segments = Math.min(segments * 2, maxSegments);
  }

  return segments;
}

/**
 * Placeholder hook for critical-region detection.
 *
 * Future refinement passes can detect regions of high curvature,
 * near-tangent intersections, or other geometric features that
 * require denser tessellation.
 *
 * @param {import('../BRepTopology.js').TopoFace} _face
 * @param {number} _surfaceSegments
 * @returns {{ uSegments: number, vSegments: number }} Recommended segments per direction
 */
export function detectCriticalRegions(_face, _surfaceSegments) {
  // Placeholder — returns uniform segments for now.
  // Future: analyze curvature maps, trim proximity, etc.
  return { uSegments: _surfaceSegments, vSegments: _surfaceSegments };
}
