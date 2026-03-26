// js/cad/CurveSurfaceIntersect.js — Curve/surface intersection
//
// Computes intersections between a NURBS curve and a NURBS surface.
// Uses a marching approach with Newton–Raphson refinement.
//
// All evaluation goes through GeometryEvaluator for WASM/JS parity.

import { DEFAULT_TOLERANCE } from './Tolerance.js';
import { GeometryEvaluator } from './GeometryEvaluator.js';

/**
 * Compute intersections between a NURBS curve and a NURBS surface.
 *
 * @param {import('./NurbsCurve.js').NurbsCurve} curve
 * @param {import('./NurbsSurface.js').NurbsSurface} surface
 * @param {import('./Tolerance.js').Tolerance} [tol]
 * @returns {Array<{paramT: number, paramU: number, paramV: number, point: {x,y,z}}>}
 */
export function curveSurfaceIntersect(curve, surface, tol = DEFAULT_TOLERANCE) {
  const results = [];
  const eps = tol.intersection;

  // Sample the curve and check distance to surface
  const numSamples = 64;
  const candidates = [];

  for (let i = 0; i <= numSamples; i++) {
    const t = curve.uMin + (i / numSamples) * (curve.uMax - curve.uMin);
    const pt = GeometryEvaluator.evalCurve(curve, t).p;

    // Find closest point on surface by sampling
    const { u, v, dist } = _closestSurfacePoint(surface, pt, 16);
    if (dist < eps * 1000) {
      candidates.push({ t, u, v });
    }
  }

  // Refine each candidate with Newton
  for (const cand of candidates) {
    const refined = _newtonCurveSurface(curve, cand.t, surface, cand.u, cand.v, eps);
    if (refined) {
      const pt = GeometryEvaluator.evalCurve(curve, refined.t).p;
      const sp = GeometryEvaluator.evalSurface(surface, refined.u, refined.v).p;
      const dx = pt.x - sp.x, dy = pt.y - sp.y, dz = pt.z - sp.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < eps * 100) {
        results.push({
          paramT: refined.t,
          paramU: refined.u,
          paramV: refined.v,
          point: pt,
        });
      }
    }
  }

  return _deduplicateCSResults(results, tol);
}

/**
 * Find the closest point on a surface to a given point by sampling.
 */
function _closestSurfacePoint(surface, point, samples) {
  let bestU = surface.uMin, bestV = surface.vMin;
  let bestDist = Infinity;

  for (let i = 0; i <= samples; i++) {
    const u = surface.uMin + (i / samples) * (surface.uMax - surface.uMin);
    for (let j = 0; j <= samples; j++) {
      const v = surface.vMin + (j / samples) * (surface.vMax - surface.vMin);
      const sp = GeometryEvaluator.evalSurface(surface, u, v).p;
      const dx = sp.x - point.x, dy = sp.y - point.y, dz = sp.z - point.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < bestDist) {
        bestDist = dist;
        bestU = u;
        bestV = v;
      }
    }
  }

  return { u: bestU, v: bestV, dist: bestDist };
}

/**
 * Newton–Raphson refinement for curve/surface intersection.
 * Solves: curve(t) = surface(u,v)
 */
function _newtonCurveSurface(curve, t, surface, u, v, eps) {
  for (let iter = 0; iter < 30; iter++) {
    const rC = GeometryEvaluator.evalCurve(curve, t);
    const rS = GeometryEvaluator.evalSurface(surface, u, v);
    const pc = rC.p;
    const ps = rS.p;
    const diff = { x: pc.x - ps.x, y: pc.y - ps.y, z: pc.z - ps.z };
    const dist = Math.sqrt(diff.x * diff.x + diff.y * diff.y + diff.z * diff.z);
    if (dist < eps) return { t, u, v };

    // Analytical derivatives from GeometryEvaluator
    const dCdt = rC.d1;
    const dSdu = rS.du;
    const dSdv = rS.dv;

    // Solve 3x3: [dCdt | -dSdu | -dSdv] * [dt, du, dv]^T = -diff
    // Using least-squares 3x3 approach
    const A = [
      [dCdt.x, -dSdu.x, -dSdv.x],
      [dCdt.y, -dSdu.y, -dSdv.y],
      [dCdt.z, -dSdu.z, -dSdv.z],
    ];
    const b = [-diff.x, -diff.y, -diff.z];

    const sol = _solve3x3(A, b);
    if (!sol) return { t, u, v };

    t = Math.max(curve.uMin, Math.min(curve.uMax, t + sol[0]));
    u = Math.max(surface.uMin, Math.min(surface.uMax, u + sol[1]));
    v = Math.max(surface.vMin, Math.min(surface.vMax, v + sol[2]));
  }

  return { t, u, v };
}

/**
 * Solve a 3x3 linear system Ax = b using Cramer's rule.
 */
function _solve3x3(A, b) {
  const det = A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1])
            - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0])
            + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);

  if (Math.abs(det) < 1e-20) return null;

  const x0 = (b[0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1])
             - A[0][1] * (b[1] * A[2][2] - A[1][2] * b[2])
             + A[0][2] * (b[1] * A[2][1] - A[1][1] * b[2])) / det;

  const x1 = (A[0][0] * (b[1] * A[2][2] - A[1][2] * b[2])
             - b[0] * (A[1][0] * A[2][2] - A[1][2] * A[2][0])
             + A[0][2] * (A[1][0] * b[2] - b[1] * A[2][0])) / det;

  const x2 = (A[0][0] * (A[1][1] * b[2] - b[1] * A[2][1])
             - A[0][1] * (A[1][0] * b[2] - b[1] * A[2][0])
             + b[0] * (A[1][0] * A[2][1] - A[1][1] * A[2][0])) / det;

  return [x0, x1, x2];
}

/**
 * Deduplicate curve/surface intersection results.
 */
function _deduplicateCSResults(results, tol) {
  const unique = [];
  for (const r of results) {
    let isDup = false;
    for (const u of unique) {
      if (Math.abs(r.paramT - u.paramT) < tol.intersection * 10) {
        isDup = true;
        break;
      }
    }
    if (!isDup) unique.push(r);
  }
  return unique;
}
