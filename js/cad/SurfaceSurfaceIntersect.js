// js/cad/SurfaceSurfaceIntersect.js — Surface/surface intersection
//
// Computes intersection curves between two NURBS surfaces.
// Implements:
//   - Analytic solutions for plane/plane, plane/cylinder, etc.
//   - Numeric marching for general NURBS/NURBS pairs
//
// References:
//   - "The NURBS Book" (Piegl & Tiller, 1997) Ch. 6
//   - "Geometric Modeling" (Farin, 2002)

import { NurbsCurve } from './NurbsCurve.js';
import { DEFAULT_TOLERANCE } from './Tolerance.js';
import { SurfaceType } from './BRepTopology.js';
import { GeometryEvaluator } from './GeometryEvaluator.js';

/**
 * Compute intersection curve(s) between two surfaces.
 *
 * @param {import('./NurbsSurface.js').NurbsSurface} surfA
 * @param {string} typeA - Surface type (SurfaceType constant)
 * @param {import('./NurbsSurface.js').NurbsSurface} surfB
 * @param {string} typeB - Surface type (SurfaceType constant)
 * @param {import('./Tolerance.js').Tolerance} [tol]
 * @returns {Array<{curve: NurbsCurve, paramsA: Array<{u,v}>, paramsB: Array<{u,v}>}>}
 *   Each result contains a 3D intersection curve and corresponding parameter traces on both surfaces.
 */
export function surfaceSurfaceIntersect(surfA, typeA, surfB, typeB, tol = DEFAULT_TOLERANCE) {
  // Try analytic methods first
  if (typeA === SurfaceType.PLANE && typeB === SurfaceType.PLANE) {
    return _planePlane(surfA, surfB, tol);
  }
  if (typeA === SurfaceType.PLANE && typeB === SurfaceType.CYLINDER) {
    return _planeCylinder(surfA, surfB, tol);
  }
  if (typeA === SurfaceType.CYLINDER && typeB === SurfaceType.PLANE) {
    return _planeCylinder(surfB, surfA, tol).map(r => ({
      curve: r.curve,
      paramsA: r.paramsB,
      paramsB: r.paramsA,
    }));
  }
  if (typeA === SurfaceType.PLANE && typeB === SurfaceType.SPHERE) {
    return _planeSphere(surfA, surfB, tol);
  }
  if (typeA === SurfaceType.SPHERE && typeB === SurfaceType.PLANE) {
    return _planeSphere(surfB, surfA, tol).map(r => ({
      curve: r.curve,
      paramsA: r.paramsB,
      paramsB: r.paramsA,
    }));
  }
  if (typeA === SurfaceType.CYLINDER && typeB === SurfaceType.CYLINDER) {
    return _cylinderCylinder(surfA, surfB, tol);
  }

  // Fallback: numeric marching for general surfaces
  return _numericMarch(surfA, surfB, tol);
}

// -----------------------------------------------------------------------
// Analytic: plane/plane intersection
// -----------------------------------------------------------------------

function _planePlane(planeA, planeB, tol) {
  // Evaluate normals from the planar surfaces
  const nA = GeometryEvaluator.evalSurface(planeA, 0.5, 0.5).n;
  const nB = GeometryEvaluator.evalSurface(planeB, 0.5, 0.5).n;

  // Cross product = line direction
  const dx = nA.y * nB.z - nA.z * nB.y;
  const dy = nA.z * nB.x - nA.x * nB.z;
  const dz = nA.x * nB.y - nA.y * nB.x;
  const dLen = Math.sqrt(dx * dx + dy * dy + dz * dz);

  if (dLen < tol.angularParallelism) {
    // Parallel or coincident planes
    return [];
  }

  const dir = { x: dx / dLen, y: dy / dLen, z: dz / dLen };

  // Find a point on the intersection line
  // Use the average of surface origins as a starting guess
  const pA = GeometryEvaluator.evalSurface(planeA, 0.5, 0.5).p;
  const pB = GeometryEvaluator.evalSurface(planeB, 0.5, 0.5).p;
  const origin = {
    x: (pA.x + pB.x) / 2,
    y: (pA.y + pB.y) / 2,
    z: (pA.z + pB.z) / 2,
  };

  // Project origin onto both planes and average
  const distA = nA.x * (origin.x - pA.x) + nA.y * (origin.y - pA.y) + nA.z * (origin.z - pA.z);
  const distB = nB.x * (origin.x - pB.x) + nB.y * (origin.y - pB.y) + nB.z * (origin.z - pB.z);

  // Use the cross of normals with normals to find a point
  const pt = {
    x: origin.x - distA * nA.x - distB * nB.x,
    y: origin.y - distA * nA.y - distB * nB.y,
    z: origin.z - distA * nA.z - distB * nB.z,
  };

  // Create a line as a NURBS curve (degree 1)
  // Extend the line a reasonable distance
  const extent = 1000;
  const p0 = { x: pt.x - dir.x * extent, y: pt.y - dir.y * extent, z: pt.z - dir.z * extent };
  const p1 = { x: pt.x + dir.x * extent, y: pt.y + dir.y * extent, z: pt.z + dir.z * extent };

  const curve = NurbsCurve.createLine(p0, p1);

  // Compute proper UV parameters on both surfaces for the line endpoints.
  // For NurbsSurface.createPlane(origin, uDir, vDir) the parameterization is
  // S(u,v) = origin + u*uDir + v*vDir, so we solve for (u,v) analytically.
  const paramsA = [_computePlaneUV(planeA, p0), _computePlaneUV(planeA, p1)];
  const paramsB = [_computePlaneUV(planeB, p0), _computePlaneUV(planeB, p1)];

  return [{
    curve,
    paramsA,
    paramsB,
  }];
}

/**
 * Compute (u,v) parameters on a planar NurbsSurface for a given 3D point.
 *
 * For a surface created via NurbsSurface.createPlane(origin, uDir, vDir),
 * the control points are [origin, origin+vDir, origin+uDir, origin+uDir+vDir]
 * giving S(u,v) = origin + u*uDir + v*vDir.
 *
 * We solve (p - origin) = u*uDir + v*vDir via a 2×2 linear system.
 */
function _computePlaneUV(planeSurface, point3D) {
  const cp = planeSurface.controlPoints;
  if (!cp || cp.length < 4) return { u: 0, v: 0 };

  // Extract basis: CP layout is [origin, origin+vDir, origin+uDir, origin+uDir+vDir]
  const orig = cp[0];
  const uDir = { x: cp[2].x - cp[0].x, y: cp[2].y - cp[0].y, z: cp[2].z - cp[0].z };
  const vDir = { x: cp[1].x - cp[0].x, y: cp[1].y - cp[0].y, z: cp[1].z - cp[0].z };
  const dp = { x: point3D.x - orig.x, y: point3D.y - orig.y, z: point3D.z - orig.z };

  // Gram matrix entries
  const uu = uDir.x * uDir.x + uDir.y * uDir.y + uDir.z * uDir.z;
  const uv = uDir.x * vDir.x + uDir.y * vDir.y + uDir.z * vDir.z;
  const vv = vDir.x * vDir.x + vDir.y * vDir.y + vDir.z * vDir.z;
  const up = uDir.x * dp.x + uDir.y * dp.y + uDir.z * dp.z;
  const vp = vDir.x * dp.x + vDir.y * dp.y + vDir.z * dp.z;

  const det = uu * vv - uv * uv;
  if (Math.abs(det) < 1e-20) return { u: 0, v: 0 };

  return {
    u: (vv * up - uv * vp) / det,
    v: (uu * vp - uv * up) / det,
  };
}

// -----------------------------------------------------------------------
// Analytic: plane/cylinder intersection
// -----------------------------------------------------------------------

/**
 * Plane/cylinder intersection.
 * - Plane perpendicular to axis → circle
 * - Plane parallel to axis → 0 or 2 lines
 * - Plane oblique to axis → ellipse
 *
 * The cylinder surface is described by its origin, axis, and radius.
 * We extract these from the NurbsSurface's surfaceInfo or control points.
 */
function _planeCylinder(plane, cylinder, tol) {
  // Extract plane geometry
  const planeEval = GeometryEvaluator.evalSurface(plane, 0.5, 0.5);
  const planeN = planeEval.n;
  const planeP = planeEval.p;

  // Extract cylinder geometry from the surface's analytic parameters
  const cylInfo = _extractCylinderInfo(cylinder);
  if (!cylInfo) return _numericMarch(plane, cylinder, tol);

  const { origin: cylO, axis: cylA, radius: cylR } = cylInfo;

  // cos(angle) between plane normal and cylinder axis
  const cosTheta = planeN.x * cylA.x + planeN.y * cylA.y + planeN.z * cylA.z;
  const sinTheta = Math.sqrt(1 - cosTheta * cosTheta);

  // Signed distance from cylinder origin to plane
  const d = (cylO.x - planeP.x) * planeN.x +
            (cylO.y - planeP.y) * planeN.y +
            (cylO.z - planeP.z) * planeN.z;

  if (Math.abs(cosTheta) < tol.angularParallelism) {
    // Plane is parallel (or nearly) to the cylinder axis → 0 or 2 lines
    // Distance from axis to plane
    // Project plane normal onto plane perpendicular to axis
    const pNx = planeN.x - cosTheta * cylA.x;
    const pNy = planeN.y - cosTheta * cylA.y;
    const pNz = planeN.z - cosTheta * cylA.z;
    const pNlen = Math.sqrt(pNx * pNx + pNy * pNy + pNz * pNz);
    if (pNlen < 1e-15) return [];

    const distToAxis = Math.abs(d) / pNlen;
    if (distToAxis > cylR + tol.distance) return [];
    if (Math.abs(distToAxis - cylR) < tol.distance) {
      // Tangent: single line
      const tangentPt = {
        x: cylO.x - (d / pNlen) * (pNx / pNlen),
        y: cylO.y - (d / pNlen) * (pNy / pNlen),
        z: cylO.z - (d / pNlen) * (pNz / pNlen),
      };
      const extent = 1000;
      const p0 = { x: tangentPt.x - cylA.x * extent, y: tangentPt.y - cylA.y * extent, z: tangentPt.z - cylA.z * extent };
      const p1 = { x: tangentPt.x + cylA.x * extent, y: tangentPt.y + cylA.y * extent, z: tangentPt.z + cylA.z * extent };
      return [{ curve: NurbsCurve.createLine(p0, p1), paramsA: [], paramsB: [] }];
    }

    // Two secant lines
    const halfChord = Math.sqrt(cylR * cylR - distToAxis * distToAxis);
    // Direction perpendicular to both axis and plane normal
    const crossX = cylA.y * pNz / pNlen - cylA.z * pNy / pNlen;
    const crossY = cylA.z * pNx / pNlen - cylA.x * pNz / pNlen;
    const crossZ = cylA.x * pNy / pNlen - cylA.y * pNx / pNlen;
    const basePt = {
      x: cylO.x - (d / pNlen) * (pNx / pNlen),
      y: cylO.y - (d / pNlen) * (pNy / pNlen),
      z: cylO.z - (d / pNlen) * (pNz / pNlen),
    };
    const results = [];
    for (const sign of [-1, 1]) {
      const linePt = {
        x: basePt.x + sign * halfChord * crossX,
        y: basePt.y + sign * halfChord * crossY,
        z: basePt.z + sign * halfChord * crossZ,
      };
      const extent = 1000;
      const p0 = { x: linePt.x - cylA.x * extent, y: linePt.y - cylA.y * extent, z: linePt.z - cylA.z * extent };
      const p1 = { x: linePt.x + cylA.x * extent, y: linePt.y + cylA.y * extent, z: linePt.z + cylA.z * extent };
      results.push({ curve: NurbsCurve.createLine(p0, p1), paramsA: [], paramsB: [] });
    }
    return results;
  }

  if (sinTheta < tol.angularParallelism) {
    // Plane is perpendicular to axis → circle
    // Find the center: project cylinder origin onto the plane
    const t = -d / (cosTheta || 1);
    const center = {
      x: cylO.x + t * cylA.x,
      y: cylO.y + t * cylA.y,
      z: cylO.z + t * cylA.z,
    };
    const curve = _createCircleCurve(center, planeN, cylR);
    return [{ curve, paramsA: [], paramsB: [] }];
  }

  // General oblique case → ellipse
  // Approximate with a NURBS curve through sampled points
  // The intersection is an ellipse with semi-major a = r/sin(theta)
  // and semi-minor b = r
  return _numericMarch(plane, cylinder, tol);
}

// -----------------------------------------------------------------------
// Analytic: plane/sphere intersection
// -----------------------------------------------------------------------

/**
 * Plane/sphere intersection → circle or empty.
 */
function _planeSphere(plane, sphere, tol) {
  const planeEval = GeometryEvaluator.evalSurface(plane, 0.5, 0.5);
  const planeN = planeEval.n;
  const planeP = planeEval.p;

  const sphInfo = _extractSphereInfo(sphere);
  if (!sphInfo) return _numericMarch(plane, sphere, tol);

  const { center: sphC, radius: sphR } = sphInfo;

  // Signed distance from sphere center to plane
  const dist = (sphC.x - planeP.x) * planeN.x +
               (sphC.y - planeP.y) * planeN.y +
               (sphC.z - planeP.z) * planeN.z;

  if (Math.abs(dist) > sphR + tol.distance) return []; // no intersection

  const circleR = Math.sqrt(Math.max(0, sphR * sphR - dist * dist));
  if (circleR < tol.distance) return []; // tangent point, skip

  // Circle center: project sphere center onto plane
  const center = {
    x: sphC.x - dist * planeN.x,
    y: sphC.y - dist * planeN.y,
    z: sphC.z - dist * planeN.z,
  };

  const curve = _createCircleCurve(center, planeN, circleR);
  return [{ curve, paramsA: [], paramsB: [] }];
}

// -----------------------------------------------------------------------
// Analytic: cylinder/cylinder intersection
// -----------------------------------------------------------------------

/**
 * Cylinder/cylinder intersection.
 * Concentric coaxial → 0 or 2 circles. Otherwise → numeric march.
 */
function _cylinderCylinder(cylA, cylB, tol) {
  const infoA = _extractCylinderInfo(cylA);
  const infoB = _extractCylinderInfo(cylB);
  if (!infoA || !infoB) return _numericMarch(cylA, cylB, tol);

  // Check if axes are parallel and coincident (same axis)
  const dot = infoA.axis.x * infoB.axis.x +
              infoA.axis.y * infoB.axis.y +
              infoA.axis.z * infoB.axis.z;

  if (Math.abs(Math.abs(dot) - 1) < tol.angularParallelism) {
    // Parallel axes — check distance between axes
    const dp = {
      x: infoB.origin.x - infoA.origin.x,
      y: infoB.origin.y - infoA.origin.y,
      z: infoB.origin.z - infoA.origin.z,
    };
    const projLen = dp.x * infoA.axis.x + dp.y * infoA.axis.y + dp.z * infoA.axis.z;
    const perpX = dp.x - projLen * infoA.axis.x;
    const perpY = dp.y - projLen * infoA.axis.y;
    const perpZ = dp.z - projLen * infoA.axis.z;
    const axisDist = Math.sqrt(perpX * perpX + perpY * perpY + perpZ * perpZ);

    if (axisDist < tol.distance && Math.abs(infoA.radius - infoB.radius) < tol.distance) {
      // Coincident cylinders — no intersection curves (identical surfaces)
      return [];
    }
    // Parallel but offset — at most 2 circles at specific heights, but
    // that requires knowing the trim bounds. Fall to numeric march.
  }

  // General case: non-parallel or non-concentric → numeric march
  return _numericMarch(cylA, cylB, tol);
}

// -----------------------------------------------------------------------
// Helpers for extracting analytic geometry from NurbsSurface
// -----------------------------------------------------------------------

function _extractCylinderInfo(surface) {
  // Try surfaceInfo first (set by STEP import for analytic surfaces)
  if (surface._analyticParams && surface._analyticParams.type === 'cylinder') {
    return surface._analyticParams;
  }
  // Try surfaceInfo on the surface object
  if (surface.surfaceInfo && surface.surfaceInfo.type === 'cylinder') {
    return surface.surfaceInfo;
  }
  // Fall back to evaluating the surface at parameter midpoints
  // and inferring geometry from derivatives
  try {
    const cp = surface.controlPoints;
    if (!cp || cp.length < 4) return null;
    // For a cylindrical surface, evaluate at a grid and fit
    // This is expensive — return null to trigger numeric march
    return null;
  } catch { return null; }
}

function _extractSphereInfo(surface) {
  if (surface._analyticParams && surface._analyticParams.type === 'sphere') {
    return surface._analyticParams;
  }
  if (surface.surfaceInfo && surface.surfaceInfo.type === 'sphere') {
    return surface.surfaceInfo;
  }
  return null;
}

/**
 * Create a degree-2 rational NURBS circle curve.
 * Uses 9-point rational representation with weights.
 */
function _createCircleCurve(center, normal, radius) {
  // Build a local frame on the plane
  let uDir;
  if (Math.abs(normal.y) < 0.9) {
    uDir = { x: -normal.z, y: 0, z: normal.x };
  } else {
    uDir = { x: 0, y: normal.z, z: -normal.y };
  }
  const uLen = Math.sqrt(uDir.x * uDir.x + uDir.y * uDir.y + uDir.z * uDir.z);
  uDir = { x: uDir.x / uLen, y: uDir.y / uLen, z: uDir.z / uLen };
  const vDir = {
    x: normal.y * uDir.z - normal.z * uDir.y,
    y: normal.z * uDir.x - normal.x * uDir.z,
    z: normal.x * uDir.y - normal.y * uDir.x,
  };

  // 9-point rational circle (degree 2)
  const w = Math.SQRT1_2; // weight for corner control points
  const cp = [];
  const weights = [];
  for (let i = 0; i < 9; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const isCorner = (i % 2) === 1;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    cp.push({
      x: center.x + radius * (cos * uDir.x + sin * vDir.x),
      y: center.y + radius * (cos * uDir.y + sin * vDir.y),
      z: center.z + radius * (cos * uDir.z + sin * vDir.z),
    });
    weights.push(isCorner ? w : 1.0);
  }

  return new NurbsCurve(2, [0, 0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 1], cp, weights);
}

// -----------------------------------------------------------------------
// Numeric marching for general surface/surface intersection
// -----------------------------------------------------------------------

/**
 * Numeric marching intersection for general NURBS surfaces.
 * Samples a grid on each surface, finds seed points where surfaces
 * are close, then traces intersection curves.
 */
function _numericMarch(surfA, surfB, tol) {
  const eps = tol.intersection;
  const seedSamples = 16;
  const results = [];

  // Find seed points by sampling
  const seeds = _findSeeds(surfA, surfB, seedSamples, eps);

  if (seeds.length === 0) return results;

  // Trace curves from seed points
  const usedSeeds = new Set();
  for (const seed of seeds) {
    const key = `${seed.uA.toFixed(4)},${seed.vA.toFixed(4)}`;
    if (usedSeeds.has(key)) continue;
    usedSeeds.add(key);

    const trace = _traceIntersection(surfA, surfB, seed, eps);
    if (trace.points.length >= 2) {
      // Fit a NURBS curve through the traced points
      const curve = _fitCurveThroughPoints(trace.points);
      results.push({
        curve,
        paramsA: trace.paramsA,
        paramsB: trace.paramsB,
      });
    }
  }

  return results;
}

/**
 * Find seed points where two surfaces are close.
 */
function _findSeeds(surfA, surfB, samples, eps) {
  const seeds = [];
  const threshold = eps * 1000;

  for (let i = 0; i <= samples; i++) {
    const uA = surfA.uMin + (i / samples) * (surfA.uMax - surfA.uMin);
    for (let j = 0; j <= samples; j++) {
      const vA = surfA.vMin + (j / samples) * (surfA.vMax - surfA.vMin);
      const pA = GeometryEvaluator.evalSurface(surfA, uA, vA).p;

      // Find closest point on surfB
      let bestDist = Infinity;
      let bestUB = surfB.uMin, bestVB = surfB.vMin;

      for (let ii = 0; ii <= samples; ii++) {
        const uB = surfB.uMin + (ii / samples) * (surfB.uMax - surfB.uMin);
        for (let jj = 0; jj <= samples; jj++) {
          const vB = surfB.vMin + (jj / samples) * (surfB.vMax - surfB.vMin);
          const pB = GeometryEvaluator.evalSurface(surfB, uB, vB).p;
          const dx = pA.x - pB.x, dy = pA.y - pB.y, dz = pA.z - pB.z;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (dist < bestDist) {
            bestDist = dist;
            bestUB = uB;
            bestVB = vB;
          }
        }
      }

      if (bestDist < threshold) {
        seeds.push({ uA, vA, uB: bestUB, vB: bestVB, dist: bestDist });
      }
    }
  }

  // Sort by distance and keep best
  seeds.sort((a, b) => a.dist - b.dist);
  return seeds.slice(0, 20);
}

/**
 * Trace an intersection curve from a seed point.
 */
function _traceIntersection(surfA, surfB, seed, eps) {
  const points = [];
  const paramsA = [];
  const paramsB = [];
  const maxSteps = 200;
  const stepSize = 0.02;

  // Refine seed first
  let { uA, vA, uB, vB } = seed;
  const refined = _refinePoint(surfA, uA, vA, surfB, uB, vB, eps);
  uA = refined.uA; vA = refined.vA; uB = refined.uB; vB = refined.vB;

  // March in both directions from the seed
  for (const dir of [1, -1]) {
    let curUA = uA, curVA = vA, curUB = uB, curVB = vB;

    for (let step = 0; step < maxSteps; step++) {
      const pA = GeometryEvaluator.evalSurface(surfA, curUA, curVA).p;
      const pB = GeometryEvaluator.evalSurface(surfB, curUB, curVB).p;
      const midPt = {
        x: (pA.x + pB.x) / 2,
        y: (pA.y + pB.y) / 2,
        z: (pA.z + pB.z) / 2,
      };

      if (dir === 1) {
        points.push(midPt);
        paramsA.push({ u: curUA, v: curVA });
        paramsB.push({ u: curUB, v: curVB });
      } else {
        points.unshift(midPt);
        paramsA.unshift({ u: curUA, v: curVA });
        paramsB.unshift({ u: curUB, v: curVB });
      }

      // Compute marching direction using surface normals
      const nA = GeometryEvaluator.evalSurface(surfA, curUA, curVA).n;
      const nB = GeometryEvaluator.evalSurface(surfB, curUB, curVB).n;

      // Cross product of normals gives tangent to intersection curve
      const tx = nA.y * nB.z - nA.z * nB.y;
      const ty = nA.z * nB.x - nA.x * nB.z;
      const tz = nA.x * nB.y - nA.y * nB.x;
      const tLen = Math.sqrt(tx * tx + ty * ty + tz * tz);

      if (tLen < 1e-10) break;

      // Step along the tangent
      const tDir = { x: dir * tx / tLen, y: dir * ty / tLen, z: dir * tz / tLen };
      const nextPt = {
        x: midPt.x + tDir.x * stepSize,
        y: midPt.y + tDir.y * stepSize,
        z: midPt.z + tDir.z * stepSize,
      };

      // Project next point back onto both surfaces (approximate)
      const projA = _projectOntoSurface(surfA, curUA, curVA, nextPt, eps);
      const projB = _projectOntoSurface(surfB, curUB, curVB, nextPt, eps);

      // Check if we're still in parameter domain
      if (projA.u < surfA.uMin || projA.u > surfA.uMax ||
          projA.v < surfA.vMin || projA.v > surfA.vMax ||
          projB.u < surfB.uMin || projB.u > surfB.uMax ||
          projB.v < surfB.vMin || projB.v > surfB.vMax) {
        break;
      }

      // Refine
      const ref = _refinePoint(surfA, projA.u, projA.v, surfB, projB.u, projB.v, eps);
      curUA = ref.uA; curVA = ref.vA; curUB = ref.uB; curVB = ref.vB;
    }
  }

  return { points, paramsA, paramsB };
}

/**
 * Refine an intersection point using Newton iteration.
 */
function _refinePoint(surfA, uA, vA, surfB, uB, vB, eps) {
  for (let iter = 0; iter < 10; iter++) {
    const rA = GeometryEvaluator.evalSurface(surfA, uA, vA);
    const rB = GeometryEvaluator.evalSurface(surfB, uB, vB);
    const pA = rA.p;
    const pB = rB.p;
    const dx = pA.x - pB.x, dy = pA.y - pB.y, dz = pA.z - pB.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < eps) break;

    // Simple steepest descent toward the other surface
    const nA = rA.n;
    const nB = rB.n;

    // Move uA,vA along -distance*nA (projected to surface)
    const dotA = dx * nA.x + dy * nA.y + dz * nA.z;
    const dotB = dx * nB.x + dy * nB.y + dz * nB.z;

    uA -= dotA * 0.1 * (surfA.uMax - surfA.uMin);
    vA -= dotA * 0.1 * (surfA.vMax - surfA.vMin);
    uB += dotB * 0.1 * (surfB.uMax - surfB.uMin);
    vB += dotB * 0.1 * (surfB.vMax - surfB.vMin);

    uA = Math.max(surfA.uMin, Math.min(surfA.uMax, uA));
    vA = Math.max(surfA.vMin, Math.min(surfA.vMax, vA));
    uB = Math.max(surfB.uMin, Math.min(surfB.uMax, uB));
    vB = Math.max(surfB.vMin, Math.min(surfB.vMax, vB));
  }

  return { uA, vA, uB, vB };
}

/**
 * Project a 3D point onto a surface near a starting parameter.
 */
function _projectOntoSurface(surface, u0, v0, point, eps) {
  let u = u0, v = v0;

  for (let iter = 0; iter < 10; iter++) {
    const r = GeometryEvaluator.evalSurface(surface, u, v);
    const p = r.p;
    const dx = point.x - p.x, dy = point.y - p.y, dz = point.z - p.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < eps) break;

    const n = r.n;
    const dot = dx * n.x + dy * n.y + dz * n.z;

    // Simple step in UV space
    u += dot * 0.1;
    v += dot * 0.1;
    u = Math.max(surface.uMin, Math.min(surface.uMax, u));
    v = Math.max(surface.vMin, Math.min(surface.vMax, v));
  }

  return { u, v };
}

/**
 * Fit a NURBS curve through a sequence of 3D points.
 * Creates an interpolating cubic B-spline.
 *
 * @param {Array<{x,y,z}>} points
 * @returns {NurbsCurve}
 */
function _fitCurveThroughPoints(points) {
  if (points.length <= 2) {
    return NurbsCurve.createLine(points[0], points[points.length - 1]);
  }

  // For simplicity, create a degree-1 polyline NURBS
  // (exact interpolation through all points)
  const n = points.length;
  const knots = [0];
  for (let i = 0; i < n; i++) {
    knots.push(i / (n - 1));
  }
  knots.push(1);

  return new NurbsCurve(1, points, knots);
}
