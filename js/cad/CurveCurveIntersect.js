// js/cad/CurveCurveIntersect.js — Curve/curve intersection
//
// Computes intersections between two NURBS curves in 3D space.
// Uses a subdivision approach: bisect parameter intervals and check
// bounding-box overlap, then Newton–Raphson refinement.

import { DEFAULT_TOLERANCE } from './Tolerance.js';

/**
 * Compute intersections between two NURBS curves.
 *
 * @param {import('./NurbsCurve.js').NurbsCurve} curveA
 * @param {import('./NurbsCurve.js').NurbsCurve} curveB
 * @param {import('./Tolerance.js').Tolerance} [tol]
 * @returns {Array<{paramA: number, paramB: number, point: {x,y,z}}>}
 */
export function curveCurveIntersect(curveA, curveB, tol = DEFAULT_TOLERANCE) {
  const results = [];
  const eps = tol.intersection;

  // Subdivision approach
  _subdivideCurveCurve(
    curveA, curveA.uMin, curveA.uMax,
    curveB, curveB.uMin, curveB.uMax,
    eps, results, 0,
  );

  // Deduplicate
  return _deduplicateIntersections(results, tol);
}

/**
 * Recursive subdivision for curve/curve intersection.
 */
function _subdivideCurveCurve(cA, aMin, aMax, cB, bMin, bMax, eps, results, depth) {
  if (depth > 50) return;

  // Compute bounding boxes of both curve segments
  const bbA = _curveBBox(cA, aMin, aMax, 8);
  const bbB = _curveBBox(cB, bMin, bMax, 8);

  // If bounding boxes don't overlap, no intersection
  if (!_bboxOverlap(bbA, bbB, eps)) return;

  // If both intervals are small enough, try Newton refinement
  const aLen = aMax - aMin;
  const bLen = bMax - bMin;

  if (aLen < eps && bLen < eps) {
    // Midpoint approximation
    const uA = (aMin + aMax) / 2;
    const uB = (bMin + bMax) / 2;
    const pA = cA.evaluate(uA);
    const pB = cB.evaluate(uB);
    const dx = pA.x - pB.x, dy = pA.y - pB.y, dz = pA.z - pB.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < eps * 1000) {
      // Refine with Newton
      const refined = _newtonRefine(cA, uA, cB, uB, eps);
      results.push({
        paramA: refined.uA,
        paramB: refined.uB,
        point: cA.evaluate(refined.uA),
      });
    }
    return;
  }

  // Subdivide the larger interval
  if (aLen >= bLen) {
    const aMid = (aMin + aMax) / 2;
    _subdivideCurveCurve(cA, aMin, aMid, cB, bMin, bMax, eps, results, depth + 1);
    _subdivideCurveCurve(cA, aMid, aMax, cB, bMin, bMax, eps, results, depth + 1);
  } else {
    const bMid = (bMin + bMax) / 2;
    _subdivideCurveCurve(cA, aMin, aMax, cB, bMin, bMid, eps, results, depth + 1);
    _subdivideCurveCurve(cA, aMin, aMax, cB, bMid, bMax, eps, results, depth + 1);
  }
}

/**
 * Newton-Raphson refinement for curve/curve intersection.
 */
function _newtonRefine(cA, uA, cB, uB, eps) {
  for (let iter = 0; iter < 20; iter++) {
    const pA = cA.evaluate(uA);
    const pB = cB.evaluate(uB);
    const diff = { x: pA.x - pB.x, y: pA.y - pB.y, z: pA.z - pB.z };

    const dist = Math.sqrt(diff.x * diff.x + diff.y * diff.y + diff.z * diff.z);
    if (dist < eps) break;

    const dA = cA.derivative(uA);
    const dB = cB.derivative(uB);

    // Solve 2x2 least-squares: dA * duA - dB * duB ≈ -(pA - pB)
    const a11 = dA.x * dA.x + dA.y * dA.y + dA.z * dA.z;
    const a12 = -(dA.x * dB.x + dA.y * dB.y + dA.z * dB.z);
    const a22 = dB.x * dB.x + dB.y * dB.y + dB.z * dB.z;
    const b1 = -(diff.x * dA.x + diff.y * dA.y + diff.z * dA.z);
    const b2 = diff.x * dB.x + diff.y * dB.y + diff.z * dB.z;

    const det = a11 * a22 - a12 * a12;
    if (Math.abs(det) < 1e-20) break;

    const duA = (a22 * b1 - a12 * b2) / det;
    const duB = (-a12 * b1 + a11 * b2) / det;

    uA = Math.max(cA.uMin, Math.min(cA.uMax, uA + duA));
    uB = Math.max(cB.uMin, Math.min(cB.uMax, uB + duB));
  }

  return { uA, uB };
}

/**
 * Compute bounding box of a curve segment.
 */
function _curveBBox(curve, uMin, uMax, samples) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const u = uMin + t * (uMax - uMin);
    const p = curve.evaluate(u);
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.z < minZ) minZ = p.z;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
    if (p.z > maxZ) maxZ = p.z;
  }

  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
}

/**
 * Check if two bounding boxes overlap.
 */
function _bboxOverlap(a, b, margin = 0) {
  return a.min.x - margin <= b.max.x && a.max.x + margin >= b.min.x &&
         a.min.y - margin <= b.max.y && a.max.y + margin >= b.min.y &&
         a.min.z - margin <= b.max.z && a.max.z + margin >= b.min.z;
}

/**
 * Deduplicate intersection results.
 */
function _deduplicateIntersections(results, tol) {
  const unique = [];
  for (const r of results) {
    let isDup = false;
    for (const u of unique) {
      if (Math.abs(r.paramA - u.paramA) < tol.intersection * 10 &&
          Math.abs(r.paramB - u.paramB) < tol.intersection * 10) {
        isDup = true;
        break;
      }
    }
    if (!isDup) unique.push(r);
  }
  return unique;
}
