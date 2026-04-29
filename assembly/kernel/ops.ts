// kernel/ops — topology-driven boolean fragment classification
//
// This module provides the WASM-side logic for classifying mesh fragments
// during boolean operations (union, subtract, intersect). Instead of
// expensive ray-casting in floating-point, it anchors inside/outside
// decisions to topological entity indices (face ids, edge ids) and uses
// the octree for broadphase overlap detection.
//
// The JS BooleanKernel can delegate the classification + broadphase steps
// here while keeping the higher-level orchestration in JS.

import {
  faceGetGeomType, faceGetGeomOffset, faceGetOrient, faceGetCount,
  vertexGetX, vertexGetY, vertexGetZ, vertexGetCount,
  ORIENT_REVERSED,
  GEOM_PLANE, GEOM_CYLINDER, GEOM_CONE, GEOM_SPHERE, GEOM_TORUS,
  GEOM_NURBS_SURFACE,
} from './topology';

import { geomPoolRead } from './geometry';
import { octreeGetPairCount, getOctreePairsPtr } from './spatial';
import { tessTriVertComp, getTessOutTriCount } from './tessellation';

// ─── Classification result constants ─────────────────────────────────

export const CLASSIFY_OUTSIDE: u8 = 0;
export const CLASSIFY_INSIDE: u8 = 1;
export const CLASSIFY_ON_BOUNDARY: u8 = 2;
export const CLASSIFY_UNKNOWN: u8 = 3;

// ─── Face-face overlap pairs from octree ─────────────────────────────

/** Max candidate pairs from broadphase. */
const MAX_CLASSIFY_PAIRS: u32 = 65536;

/** Per-face classification result buffer. */
const faceClassification = new StaticArray<u8>(16384); // MAX_FACES

/** Per-face point-on-surface test: closest approach distance². */
const faceMinDist2 = new StaticArray<f64>(16384);

/** Plane/plane intersection output: point(3) + direction(3). */
const planePlaneOut = new StaticArray<f64>(6);

/** Plane/sphere intersection output: circleCenter(3) + circleNormal(3) + radius. */
const planeSphereOut = new StaticArray<f64>(7);

/**
 * Plane/cylinder intersection output.
 * Layout depends on the returned tag (see planeCylinderIntersect):
 *   tag=1 (circle): center(3) + normal(3) + radius(1)                  →  7 doubles
 *   tag=2 (tangent line): point(3) + direction(3)                       →  6 doubles
 *   tag=3 (two lines): point0(3) + dir0(3) + point1(3) + dir1(3)        → 12 doubles
 */
const planeCylinderOut = new StaticArray<f64>(12);

/** Cylinder/cylinder intersection output: up to two lines, point(3)+direction(3) each. */
const cylinderCylinderOut = new StaticArray<f64>(12);

// ─── Per-intersection error bound tracking ───────────────────────────

/** Max tracked intersections per boolean pass. */
const MAX_INTERSECTIONS: u32 = 65536;

/** Per-intersection error bound (distance residual). */
const isxErrorBound = new StaticArray<f64>(65536);

/** Per-intersection face-A id. */
const isxFaceA = new StaticArray<u32>(65536);

/** Per-intersection face-B id. */
const isxFaceB = new StaticArray<u32>(65536);

/** Per-intersection point X. */
const isxPointX = new StaticArray<f64>(65536);

/** Per-intersection point Y. */
const isxPointY = new StaticArray<f64>(65536);

/** Per-intersection point Z. */
const isxPointZ = new StaticArray<f64>(65536);

/** Number of recorded intersections. */
let isxCount: u32 = 0;

/** Machine epsilon for f64. */
const F64_EPS: f64 = 2.220446049250313e-16;

/**
 * Reset intersection tracking for a new boolean pass.
 */
export function isxReset(): void {
  isxCount = 0;
}

/**
 * Record a segment-face intersection with provable error bound.
 *
 * The error bound is computed from the condition number of the
 * intersection: the ratio of surface curvature to the dot product
 * between the ray direction and the surface normal at the hit point.
 * A near-tangent hit produces a large error bound, while a
 * perpendicular hit produces a bound close to machine epsilon.
 *
 * @param faceA - face from body A
 * @param faceB - face from body B
 * @param px,py,pz - intersection point
 * @param nx,ny,nz - surface normal at intersection
 * @param rdx,rdy,rdz - ray/segment direction (need not be unit)
 * @param curvature - local surface curvature (1/R), 0 for planar
 * @returns the index of the recorded intersection, or -1 if full
 */
export function isxRecord(
  faceA: u32, faceB: u32,
  px: f64, py: f64, pz: f64,
  nx: f64, ny: f64, nz: f64,
  rdx: f64, rdy: f64, rdz: f64,
  curvature: f64,
): i32 {
  if (isxCount >= MAX_INTERSECTIONS) return -1;

  const i = isxCount;

  // Dot product of ray direction with surface normal
  const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
  const rLen = Math.sqrt(rdx * rdx + rdy * rdy + rdz * rdz);
  let cosAngle: f64 = 1.0;
  if (nLen > F64_EPS && rLen > F64_EPS) {
    cosAngle = Math.abs(nx * rdx + ny * rdy + nz * rdz) / (nLen * rLen);
  }

  // Condition number: near-tangent hits amplify floating-point error
  // bound = (machineEps * pointMagnitude + curvature * machineEps) / |cos(angle)|
  const ptMag = Math.sqrt(px * px + py * py + pz * pz) + 1.0;
  const baseBound = F64_EPS * ptMag;
  const curvBound = curvature > 0.0 ? curvature * F64_EPS : 0.0;
  const safeAngle = cosAngle > 1e-10 ? cosAngle : 1e-10;
  const bound = (baseBound + curvBound) / safeAngle;

  unchecked(isxFaceA[i] = faceA);
  unchecked(isxFaceB[i] = faceB);
  unchecked(isxPointX[i] = px);
  unchecked(isxPointY[i] = py);
  unchecked(isxPointZ[i] = pz);
  unchecked(isxErrorBound[i] = bound);

  isxCount = i + 1;
  return <i32>i;
}

/**
 * Get the error bound for intersection i.
 */
export function isxGetErrorBound(i: u32): f64 {
  if (i >= isxCount) return -1.0;
  return unchecked(isxErrorBound[i]);
}

/**
 * Get intersection count.
 */
export function isxGetCount(): u32 {
  return isxCount;
}

/**
 * Get the maximum error bound across all recorded intersections.
 * Useful for determining whether any intersection is unreliable.
 */
export function isxGetMaxErrorBound(): f64 {
  let maxBound: f64 = 0.0;
  for (let i: u32 = 0; i < isxCount; i++) {
    const b = unchecked(isxErrorBound[i]);
    if (b > maxBound) maxBound = b;
  }
  return maxBound;
}

/**
 * Check if two intersections are provably distinct (non-overlapping
 * within their combined error bounds).
 * @returns true if the intersections are uniquely separated
 */
export function isxAreDistinct(a: u32, b: u32): bool {
  if (a >= isxCount || b >= isxCount) return false;
  const dx = unchecked(isxPointX[a]) - unchecked(isxPointX[b]);
  const dy = unchecked(isxPointY[a]) - unchecked(isxPointY[b]);
  const dz = unchecked(isxPointZ[a]) - unchecked(isxPointZ[b]);
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const combinedBound = unchecked(isxErrorBound[a]) + unchecked(isxErrorBound[b]);
  return dist > combinedBound;
}

/**
 * Perform a ray-face intersection against a specific face, computing
 * the error bound. Used for segment-face intersection with provable
 * uniqueness.
 *
 * @param faceId - face to test
 * @param ox,oy,oz - ray origin
 * @param dx,dy,dz - ray direction (need not be unit)
 * @returns parametric t of hit (>0 = in front), or -1.0 on miss.
 *          If hit, it is auto-recorded with error bounds.
 */
export function isxRayFace(
  faceId: u32, partnerFaceId: u32,
  ox: f64, oy: f64, oz: f64,
  dx: f64, dy: f64, dz: f64,
): f64 {
  const geomType = faceGetGeomType(faceId);
  const gOff = faceGetGeomOffset(faceId);
  const reversed = faceGetOrient(faceId) == ORIENT_REVERSED;

  if (geomType == GEOM_PLANE) {
    return _isxRayPlane(faceId, partnerFaceId, gOff, reversed, ox, oy, oz, dx, dy, dz);
  } else if (geomType == GEOM_SPHERE) {
    return _isxRaySphere(faceId, partnerFaceId, gOff, reversed, ox, oy, oz, dx, dy, dz);
  } else if (geomType == GEOM_CYLINDER) {
    return _isxRayCylinder(faceId, partnerFaceId, gOff, reversed, ox, oy, oz, dx, dy, dz);
  }
  return -1.0;
}

/**
 * Intersect two planes defined by point+normal.
 * Writes point(3)+unitDirection(3) to `planePlaneOut` and returns 1 on hit.
 * Returns 0 for parallel / coincident planes.
 */
export function planePlaneIntersect(
  pAx: f64, pAy: f64, pAz: f64,
  nAx: f64, nAy: f64, nAz: f64,
  pBx: f64, pBy: f64, pBz: f64,
  nBx: f64, nBy: f64, nBz: f64,
  angularTol: f64,
): u32 {
  const dx = nAy * nBz - nAz * nBy;
  const dy = nAz * nBx - nAx * nBz;
  const dz = nAx * nBy - nAy * nBx;
  const dirLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dirLen < angularTol) return 0;

  const dA = pAx * nAx + pAy * nAy + pAz * nAz;
  const dB = pBx * nBx + pBy * nBy + pBz * nBz;
  const mx = dA * nBx - dB * nAx;
  const my = dA * nBy - dB * nAy;
  const mz = dA * nBz - dB * nAz;
  const invDirLen2 = 1.0 / (dx * dx + dy * dy + dz * dz);

  unchecked(planePlaneOut[0] = (my * dz - mz * dy) * invDirLen2);
  unchecked(planePlaneOut[1] = (mz * dx - mx * dz) * invDirLen2);
  unchecked(planePlaneOut[2] = (mx * dy - my * dx) * invDirLen2);
  unchecked(planePlaneOut[3] = dx / dirLen);
  unchecked(planePlaneOut[4] = dy / dirLen);
  unchecked(planePlaneOut[5] = dz / dirLen);
  return 1;
}

export function getPlanePlaneIntersectPtr(): usize {
  return changetype<usize>(planePlaneOut);
}

/**
 * Intersect a plane (point+normal, normal assumed unit) with a sphere
 * (center+radius). Writes circleCenter(3)+circleNormal(3)+radius to
 * `planeSphereOut` and returns 1 on hit. Returns 0 when the plane misses
 * the sphere (|dist| > radius+distTol) or grazes it tangentially
 * (|radius - |dist|| < distTol), matching the JS fallback.
 */
export function planeSphereIntersect(
  pPx: f64, pPy: f64, pPz: f64,
  pNx: f64, pNy: f64, pNz: f64,
  sCx: f64, sCy: f64, sCz: f64,
  sR: f64,
  distTol: f64,
): u32 {
  const dist = (sCx - pPx) * pNx + (sCy - pPy) * pNy + (sCz - pPz) * pNz;
  const absDist = dist < 0 ? -dist : dist;
  if (absDist > sR + distTol) return 0;

  const r2 = sR * sR - dist * dist;
  if (r2 <= 0) return 0;
  const circleR = Math.sqrt(r2);
  if (circleR < distTol) return 0;

  unchecked(planeSphereOut[0] = sCx - dist * pNx);
  unchecked(planeSphereOut[1] = sCy - dist * pNy);
  unchecked(planeSphereOut[2] = sCz - dist * pNz);
  unchecked(planeSphereOut[3] = pNx);
  unchecked(planeSphereOut[4] = pNy);
  unchecked(planeSphereOut[5] = pNz);
  unchecked(planeSphereOut[6] = circleR);
  return 1;
}

export function getPlaneSphereIntersectPtr(): usize {
  return changetype<usize>(planeSphereOut);
}

/**
 * Intersect a plane (point+normal, normal assumed unit) with an infinite
 * cylinder (origin+axis+radius, axis assumed unit). Handles the two
 * analytic regimes and reports the general oblique case as unsupported
 * so the JS caller can fall back to the numeric marcher.
 *
 * Returns a tag:
 *   0   — no intersection (plane parallel to axis and outside cylinder, or tangent rejected)
 *   1   — circle (plane perpendicular to axis)
 *   2   — single tangent line (plane parallel to axis, touches cylinder)
 *   3   — two parallel lines (plane parallel to axis, cuts cylinder)
 *   255 — oblique case (ellipse); caller should fall back
 *
 * Output layout (in planeCylinderOut):
 *   tag=1: center(3) + normal(3) + radius(1)           → 7 doubles
 *   tag=2: point(3) + direction(3)                      → 6 doubles
 *   tag=3: point0(3) + dir0(3) + point1(3) + dir1(3)    → 12 doubles
 */
export function planeCylinderIntersect(
  pPx: f64, pPy: f64, pPz: f64,
  pNx: f64, pNy: f64, pNz: f64,
  cOx: f64, cOy: f64, cOz: f64,
  cAx: f64, cAy: f64, cAz: f64,
  cR: f64,
  angularTol: f64,
  distTol: f64,
): u32 {
  // Angle between plane normal and cylinder axis
  const cosTheta = pNx * cAx + pNy * cAy + pNz * cAz;
  const absCos = cosTheta < 0 ? -cosTheta : cosTheta;
  const sinTheta = Math.sqrt(Math.max(0.0, 1.0 - cosTheta * cosTheta));

  // Signed distance from cylinder origin to plane
  const d = (cOx - pPx) * pNx + (cOy - pPy) * pNy + (cOz - pPz) * pNz;

  // ── Regime 1: plane parallel to axis (0 / 1 / 2 parallel lines) ──
  if (absCos < angularTol) {
    // Project plane normal into the plane perpendicular to the axis
    const pNax = pNx - cosTheta * cAx;
    const pNay = pNy - cosTheta * cAy;
    const pNaz = pNz - cosTheta * cAz;
    const pNaLen = Math.sqrt(pNax * pNax + pNay * pNay + pNaz * pNaz);
    if (pNaLen < 1e-15) return 0;

    const invPNaLen = 1.0 / pNaLen;
    const distToAxis = (d < 0 ? -d : d) * invPNaLen;
    if (distToAxis > cR + distTol) return 0;

    // Foot of perpendicular from cylinder origin onto plane, projected
    // onto the plane perpendicular to the axis (which is where it
    // naturally lands in this regime).
    const fx = cOx - d * pNx;
    const fy = cOy - d * pNy;
    const fz = cOz - d * pNz;

    if (distToAxis > cR - distTol) {
      // Tangent — single line through foot, along cylinder axis
      unchecked(planeCylinderOut[0] = fx);
      unchecked(planeCylinderOut[1] = fy);
      unchecked(planeCylinderOut[2] = fz);
      unchecked(planeCylinderOut[3] = cAx);
      unchecked(planeCylinderOut[4] = cAy);
      unchecked(planeCylinderOut[5] = cAz);
      return 2;
    }

    // Two secant lines. Chord direction is (axis × planeNormal),
    // normalised. Length of half-chord is √(r² − distToAxis²).
    const halfChord = Math.sqrt(cR * cR - distToAxis * distToAxis);
    let tx = cAy * pNz - cAz * pNy;
    let ty = cAz * pNx - cAx * pNz;
    let tz = cAx * pNy - cAy * pNx;
    const tLen = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (tLen < 1e-15) return 0;
    const invT = 1.0 / tLen;
    tx *= invT; ty *= invT; tz *= invT;

    unchecked(planeCylinderOut[0] = fx - halfChord * tx);
    unchecked(planeCylinderOut[1] = fy - halfChord * ty);
    unchecked(planeCylinderOut[2] = fz - halfChord * tz);
    unchecked(planeCylinderOut[3] = cAx);
    unchecked(planeCylinderOut[4] = cAy);
    unchecked(planeCylinderOut[5] = cAz);
    unchecked(planeCylinderOut[6] = fx + halfChord * tx);
    unchecked(planeCylinderOut[7] = fy + halfChord * ty);
    unchecked(planeCylinderOut[8] = fz + halfChord * tz);
    unchecked(planeCylinderOut[9]  = cAx);
    unchecked(planeCylinderOut[10] = cAy);
    unchecked(planeCylinderOut[11] = cAz);
    return 3;
  }

  // ── Regime 2: plane perpendicular to axis (circle) ──
  if (sinTheta < angularTol) {
    // Move along the cylinder axis from the origin until we hit the plane.
    // The plane equation is (x − pP)·pN = 0, so t solves (cO + t·cA − pP)·pN = 0.
    const denom = cosTheta;
    if (denom == 0.0) return 0;
    const t = -d / denom;
    const cx = cOx + t * cAx;
    const cy = cOy + t * cAy;
    const cz = cOz + t * cAz;
    // Orient the circle normal along the cylinder axis (unit).
    unchecked(planeCylinderOut[0] = cx);
    unchecked(planeCylinderOut[1] = cy);
    unchecked(planeCylinderOut[2] = cz);
    unchecked(planeCylinderOut[3] = cAx);
    unchecked(planeCylinderOut[4] = cAy);
    unchecked(planeCylinderOut[5] = cAz);
    unchecked(planeCylinderOut[6] = cR);
    return 1;
  }

  // ── Regime 3: oblique (ellipse) — signal caller to fall back ──
  return 255;
}

export function getPlaneCylinderIntersectPtr(): usize {
  return changetype<usize>(planeCylinderOut);
}

/** Cylinder/plane arc sampling output: up to 257 xyz points. */
const cylinderPlaneArcOut = new StaticArray<f64>(257 * 3);

/**
 * Sample the finite arc of an infinite cylinder intersected by a plane.
 *
 * The cylinder is parameterized as:
 *   P(theta, t) = center + axis * t + radius*cos(theta)*ex + radius*sin(theta)*ey
 * where {ex, ey} are unit vectors perpendicular to axis.  The plane equation
 * solves a single t(theta), so the output points are exactly on both surfaces.
 *
 * Returns the number of xyz points written, or 0 on degeneracy.  `segments`
 * is clamped by the fixed output buffer to [1, 256].
 */
export function cylinderPlaneArcSample(
  cOx: f64, cOy: f64, cOz: f64,
  cAx: f64, cAy: f64, cAz: f64,
  cR: f64,
  exX: f64, exY: f64, exZ: f64,
  eyX: f64, eyY: f64, eyZ: f64,
  pPx: f64, pPy: f64, pPz: f64,
  pNx: f64, pNy: f64, pNz: f64,
  sX: f64, sY: f64, sZ: f64,
  eX: f64, eY: f64, eZ: f64,
  segments: i32,
  angularTol: f64,
): u32 {
  if (segments < 1) segments = 1;
  if (segments > 256) segments = 256;
  if (cR <= 0.0) return 0;

  const C = cAx * pNx + cAy * pNy + cAz * pNz;
  const absC = C < 0.0 ? -C : C;
  if (absC < angularTol) return 0;

  const K = (cOx - pPx) * pNx + (cOy - pPy) * pNy + (cOz - pPz) * pNz;
  const A = exX * pNx + exY * pNy + exZ * pNz;
  const B = eyX * pNx + eyY * pNy + eyZ * pNz;

  const rsX = sX - cOx;
  const rsY = sY - cOy;
  const rsZ = sZ - cOz;
  const reX = eX - cOx;
  const reY = eY - cOy;
  const reZ = eZ - cOz;
  const t0 = Math.atan2(rsX * eyX + rsY * eyY + rsZ * eyZ, rsX * exX + rsY * exY + rsZ * exZ);
  const t1 = Math.atan2(reX * eyX + reY * eyY + reZ * eyZ, reX * exX + reY * exY + reZ * exZ);

  let dt = t1 - t0;
  const twoPi = 2.0 * Math.PI;
  while (dt > Math.PI) dt -= twoPi;
  while (dt < -Math.PI) dt += twoPi;
  const absDt = dt < 0.0 ? -dt : dt;
  if (absDt < 1e-6) return 0;

  const count = segments + 1;
  for (let i = 0; i < count; i++) {
    const theta = t0 + dt * (<f64>i / <f64>segments);
    const ct = Math.cos(theta);
    const st = Math.sin(theta);
    const axisT = -(K + cR * ct * A + cR * st * B) / C;
    const base = i * 3;
    unchecked(cylinderPlaneArcOut[base] = cOx + cAx * axisT + exX * cR * ct + eyX * cR * st);
    unchecked(cylinderPlaneArcOut[base + 1] = cOy + cAy * axisT + exY * cR * ct + eyY * cR * st);
    unchecked(cylinderPlaneArcOut[base + 2] = cOz + cAz * axisT + exZ * cR * ct + eyZ * cR * st);
  }

  unchecked(cylinderPlaneArcOut[0] = sX);
  unchecked(cylinderPlaneArcOut[1] = sY);
  unchecked(cylinderPlaneArcOut[2] = sZ);
  const last = (count - 1) * 3;
  unchecked(cylinderPlaneArcOut[last] = eX);
  unchecked(cylinderPlaneArcOut[last + 1] = eY);
  unchecked(cylinderPlaneArcOut[last + 2] = eZ);
  return <u32>count;
}

export function getCylinderPlaneArcSamplePtr(): usize {
  return changetype<usize>(cylinderPlaneArcOut);
}

/** Plane/cone intersection output: circle center(3) + normal(3) + radius(1). */
const planeConeOut = new StaticArray<f64>(7);

/**
 * Intersect a plane with an infinite cone defined by
 *   apex  = origin + (-radius / tan(semiAngle)) * axis
 *   axis  = unit direction pointing toward growing radius
 *   radius = cone radius at `origin` along axis
 *   semiAngle = half-angle (radians; assumed > 0)
 *
 * Only the perpendicular-to-axis analytic regime is handled here:
 * plane normal parallel (or antiparallel) to cone axis → circle (or
 * apex / empty). All other regimes (oblique ellipse, parabola,
 * hyperbola, plane-through-apex line pair) return tag 255 so the JS
 * caller can fall back.
 *
 * Returns:
 *   0   — miss (plane perpendicular to axis on the "wrong" side of apex, or circle radius < distTol)
 *   1   — circle (writes center(3)+normal(3)+radius(1))
 *   255 — oblique regime, JS fallback
 */
export function planeConeIntersect(
  pPx: f64, pPy: f64, pPz: f64,
  pNx: f64, pNy: f64, pNz: f64,
  cOx: f64, cOy: f64, cOz: f64,
  cAx: f64, cAy: f64, cAz: f64,
  cR: f64, semiAngle: f64,
  angularTol: f64,
  distTol: f64,
): u32 {
  const cosTheta = pNx * cAx + pNy * cAy + pNz * cAz;
  const absCos = cosTheta < 0 ? -cosTheta : cosTheta;

  // Only handle the perpendicular-to-axis regime analytically.
  if (absCos < 1.0 - angularTol) return 255;

  // Compute apex: radius -> 0 requires moving along -axis by cR/tan(semiAngle).
  // Guard tan(semiAngle) → 0 (cylinder degenerate).
  const tanA = Math.tan(semiAngle);
  if (tanA < distTol && tanA > -distTol) return 255;

  const tApex = -cR / tanA;
  const apexX = cOx + tApex * cAx;
  const apexY = cOy + tApex * cAy;
  const apexZ = cOz + tApex * cAz;

  // Solve (apex + t*axis - planeP)·planeN = 0 for t.
  //   t*cosTheta = (planeP - apex)·planeN
  const rhs = (pPx - apexX) * pNx + (pPy - apexY) * pNy + (pPz - apexZ) * pNz;
  const t = rhs / cosTheta;

  // For a one-sided cone, t must be >= 0 (axis points toward growing radius).
  // STEP/cone surfaces are conventionally two-sided, but the trimming is
  // handled upstream — we emit the analytic circle regardless of sign so
  // both nappes are reachable.
  const circleR = t * tanA;
  const absR = circleR < 0 ? -circleR : circleR;
  if (absR < distTol) return 0; // plane passes through apex → fallback handles line pair

  // Circle center: project apex onto plane along axis.
  unchecked(planeConeOut[0] = apexX + t * cAx);
  unchecked(planeConeOut[1] = apexY + t * cAy);
  unchecked(planeConeOut[2] = apexZ + t * cAz);
  // Circle normal = plane normal (== ±cone axis in this regime).
  unchecked(planeConeOut[3] = pNx);
  unchecked(planeConeOut[4] = pNy);
  unchecked(planeConeOut[5] = pNz);
  unchecked(planeConeOut[6] = absR);
  return 1;
}

export function getPlaneConeIntersectPtr(): usize {
  return changetype<usize>(planeConeOut);
}

/**
 * Intersect two infinite cylinders for the parallel-axis analytic regime.
 *
 * Returns:
 *   0   — miss (parallel axes, cross-section circles do not cross)
 *   2   — tangent line (writes point(3) + direction(3))
 *   3   — two parallel secant lines (writes 2 · (point(3) + direction(3)))
 *   255 — non-parallel axes or coincident same-radius cylinders, JS fallback
 */
export function cylinderCylinderIntersect(
  aOx: f64, aOy: f64, aOz: f64,
  aAx0: f64, aAy0: f64, aAz0: f64,
  aR: f64,
  bOx: f64, bOy: f64, bOz: f64,
  bAx0: f64, bAy0: f64, bAz0: f64,
  bR: f64,
  angularTol: f64,
  distTol: f64,
): u32 {
  const aLen = Math.sqrt(aAx0 * aAx0 + aAy0 * aAy0 + aAz0 * aAz0);
  const bLen = Math.sqrt(bAx0 * bAx0 + bAy0 * bAy0 + bAz0 * bAz0);
  if (aLen < distTol || bLen < distTol) return 255;

  const aAx = aAx0 / aLen;
  const aAy = aAy0 / aLen;
  const aAz = aAz0 / aLen;
  const bAx = bAx0 / bLen;
  const bAy = bAy0 / bLen;
  const bAz = bAz0 / bLen;

  const cosAxes = aAx * bAx + aAy * bAy + aAz * bAz;
  const absCos = cosAxes < 0 ? -cosAxes : cosAxes;
  if (absCos < 1.0 - angularTol) return 255;

  const dx = bOx - aOx;
  const dy = bOy - aOy;
  const dz = bOz - aOz;
  const axial = dx * aAx + dy * aAy + dz * aAz;
  const perpX = dx - axial * aAx;
  const perpY = dy - axial * aAy;
  const perpZ = dz - axial * aAz;
  const d2 = perpX * perpX + perpY * perpY + perpZ * perpZ;
  const d = Math.sqrt(d2);

  if (d < distTol) {
    const rDiff = aR - bR;
    const absRDiff = rDiff < 0 ? -rDiff : rDiff;
    return absRDiff < distTol ? 255 : 0;
  }

  const rSum = aR + bR;
  const rDiffAB = aR > bR ? aR - bR : bR - aR;
  if (d > rSum + distTol) return 0;
  if (d < rDiffAB - distTol) return 0;

  const ex = perpX / d;
  const ey = perpY / d;
  const ez = perpZ / d;
  const along = (aR * aR - bR * bR + d2) / (2.0 * d);
  const h2 = aR * aR - along * along;
  if (h2 < -(distTol * distTol)) return 0;

  const baseX = aOx + along * ex;
  const baseY = aOy + along * ey;
  const baseZ = aOz + along * ez;
  const h = h2 <= 0 ? 0.0 : Math.sqrt(h2);

  if (h < distTol) {
    unchecked(cylinderCylinderOut[0] = baseX);
    unchecked(cylinderCylinderOut[1] = baseY);
    unchecked(cylinderCylinderOut[2] = baseZ);
    unchecked(cylinderCylinderOut[3] = aAx);
    unchecked(cylinderCylinderOut[4] = aAy);
    unchecked(cylinderCylinderOut[5] = aAz);
    return 2;
  }

  const tx = aAy * ez - aAz * ey;
  const ty = aAz * ex - aAx * ez;
  const tz = aAx * ey - aAy * ex;

  unchecked(cylinderCylinderOut[0] = baseX - h * tx);
  unchecked(cylinderCylinderOut[1] = baseY - h * ty);
  unchecked(cylinderCylinderOut[2] = baseZ - h * tz);
  unchecked(cylinderCylinderOut[3] = aAx);
  unchecked(cylinderCylinderOut[4] = aAy);
  unchecked(cylinderCylinderOut[5] = aAz);
  unchecked(cylinderCylinderOut[6] = baseX + h * tx);
  unchecked(cylinderCylinderOut[7] = baseY + h * ty);
  unchecked(cylinderCylinderOut[8] = baseZ + h * tz);
  unchecked(cylinderCylinderOut[9] = aAx);
  unchecked(cylinderCylinderOut[10] = aAy);
  unchecked(cylinderCylinderOut[11] = aAz);
  return 3;
}

export function getCylinderCylinderIntersectPtr(): usize {
  return changetype<usize>(cylinderCylinderOut);
}

/** Sphere/sphere intersection output: circle center(3) + normal(3) + radius(1). */
const sphereSphereOut = new StaticArray<f64>(7);

/**
 * Intersect two spheres (center+radius each).
 *
 * Returns:
 *   0   — miss (too far / one inside the other / tangent within distTol)
 *   1   — circle (writes center(3) + unit normal(3) + radius(1))
 *   255 — concentric (requires JS-level decision / fallback)
 */
export function sphereSphereIntersect(
  aCx: f64, aCy: f64, aCz: f64, aR: f64,
  bCx: f64, bCy: f64, bCz: f64, bR: f64,
  distTol: f64,
): u32 {
  const dx = bCx - aCx;
  const dy = bCy - aCy;
  const dz = bCz - aCz;
  const d2 = dx * dx + dy * dy + dz * dz;
  const d = Math.sqrt(d2);
  if (d < distTol) return 255; // concentric — JS fallback decides

  const rSum = aR + bR;
  const rDif = aR > bR ? aR - bR : bR - aR;
  if (d > rSum + distTol) return 0;        // too far apart
  if (d < rDif - distTol) return 0;        // one strictly inside the other
  // Tangent externally (d == rSum) or internally (d == rDif) → degenerate point circle
  const absExt = d - rSum;
  const absInt = d - rDif;
  if ((absExt < distTol && absExt > -distTol) || (absInt < distTol && absInt > -distTol)) return 0;

  // a = distance from aC to plane of intersection along (b - a)
  const a = (d2 + aR * aR - bR * bR) / (2.0 * d);
  const h2 = aR * aR - a * a;
  if (h2 <= 0) return 0;
  const h = Math.sqrt(h2);
  if (h < distTol) return 0;

  const invD = 1.0 / d;
  unchecked(sphereSphereOut[0] = aCx + a * dx * invD);
  unchecked(sphereSphereOut[1] = aCy + a * dy * invD);
  unchecked(sphereSphereOut[2] = aCz + a * dz * invD);
  unchecked(sphereSphereOut[3] = dx * invD);
  unchecked(sphereSphereOut[4] = dy * invD);
  unchecked(sphereSphereOut[5] = dz * invD);
  unchecked(sphereSphereOut[6] = h);
  return 1;
}

export function getSphereSphereIntersectPtr(): usize {
  return changetype<usize>(sphereSphereOut);
}

function _isxRayPlane(
  faceId: u32, partnerFaceId: u32,
  gOff: u32, reversed: bool,
  ox: f64, oy: f64, oz: f64,
  dx: f64, dy: f64, dz: f64,
): f64 {
  const pox = geomPoolRead(gOff);
  const poy = geomPoolRead(gOff + 1);
  const poz = geomPoolRead(gOff + 2);
  let nx = geomPoolRead(gOff + 3);
  let ny = geomPoolRead(gOff + 4);
  let nz = geomPoolRead(gOff + 5);
  if (reversed) { nx = -nx; ny = -ny; nz = -nz; }

  const denom = dx * nx + dy * ny + dz * nz;
  if (Math.abs(denom) < 1e-15) return -1.0;

  const t = ((pox - ox) * nx + (poy - oy) * ny + (poz - oz) * nz) / denom;
  if (t < 0.0) return -1.0;

  const hx = ox + t * dx;
  const hy = oy + t * dy;
  const hz = oz + t * dz;

  // Plane: curvature = 0, error bound is purely from angle
  isxRecord(faceId, partnerFaceId, hx, hy, hz, nx, ny, nz, dx, dy, dz, 0.0);
  return t;
}

function _isxRaySphere(
  faceId: u32, partnerFaceId: u32,
  gOff: u32, reversed: bool,
  ox: f64, oy: f64, oz: f64,
  rdx: f64, rdy: f64, rdz: f64,
): f64 {
  const cx = geomPoolRead(gOff);
  const cy = geomPoolRead(gOff + 1);
  const cz = geomPoolRead(gOff + 2);
  // Sphere layout: center(3) + axis(3) + refDir(3) + radius(1)
  const r = geomPoolRead(gOff + 9);

  const ex = ox - cx;
  const ey = oy - cy;
  const ez = oz - cz;

  const a = rdx * rdx + rdy * rdy + rdz * rdz;
  const b = ex * rdx + ey * rdy + ez * rdz;
  const c = ex * ex + ey * ey + ez * ez - r * r;
  const disc = b * b - a * c;
  if (disc < 0.0) return -1.0;

  const sqrtDisc = Math.sqrt(disc);
  let t = (-b - sqrtDisc) / a;
  if (t < 1e-12) t = (-b + sqrtDisc) / a;
  if (t < 1e-12) return -1.0;

  const hx = ox + t * rdx;
  const hy = oy + t * rdy;
  const hz = oz + t * rdz;

  // Normal at hit point
  let nx = (hx - cx) / r;
  let ny = (hy - cy) / r;
  let nz = (hz - cz) / r;
  if (reversed) { nx = -nx; ny = -ny; nz = -nz; }

  // Sphere curvature = 1/r
  isxRecord(faceId, partnerFaceId, hx, hy, hz, nx, ny, nz, rdx, rdy, rdz, 1.0 / r);
  return t;
}

function _isxRayCylinder(
  faceId: u32, partnerFaceId: u32,
  gOff: u32, reversed: bool,
  ox: f64, oy: f64, oz: f64,
  rdx: f64, rdy: f64, rdz: f64,
): f64 {
  const pox = geomPoolRead(gOff);
  const poy = geomPoolRead(gOff + 1);
  const poz = geomPoolRead(gOff + 2);
  const ax = geomPoolRead(gOff + 3);
  const ay = geomPoolRead(gOff + 4);
  const az = geomPoolRead(gOff + 5);
  const radius = geomPoolRead(gOff + 9);

  // Project ray onto plane perpendicular to cylinder axis
  const dDotA = rdx * ax + rdy * ay + rdz * az;
  const dpx = ox - pox;
  const dpy = oy - poy;
  const dpz = oz - poz;
  const dpDotA = dpx * ax + dpy * ay + dpz * az;

  // Ray direction projected out of axis
  const pdx = rdx - dDotA * ax;
  const pdy = rdy - dDotA * ay;
  const pdz = rdz - dDotA * az;

  // Origin projected out of axis
  const pex = dpx - dpDotA * ax;
  const pey = dpy - dpDotA * ay;
  const pez = dpz - dpDotA * az;

  const a = pdx * pdx + pdy * pdy + pdz * pdz;
  const b = pex * pdx + pey * pdy + pez * pdz;
  const c = pex * pex + pey * pey + pez * pez - radius * radius;

  const disc = b * b - a * c;
  if (disc < 0.0) return -1.0;

  const sqrtDisc = Math.sqrt(disc);
  let t = (-b - sqrtDisc) / a;
  if (t < 1e-12) t = (-b + sqrtDisc) / a;
  if (t < 1e-12) return -1.0;

  const hx = ox + t * rdx;
  const hy = oy + t * rdy;
  const hz = oz + t * rdz;

  // Normal: radial direction from axis at hit point
  const hpx = hx - pox;
  const hpy = hy - poy;
  const hpz = hz - poz;
  const hpDotA = hpx * ax + hpy * ay + hpz * az;
  let nx = (hpx - hpDotA * ax) / radius;
  let ny = (hpy - hpDotA * ay) / radius;
  let nz = (hpz - hpDotA * az) / radius;
  if (reversed) { nx = -nx; ny = -ny; nz = -nz; }

  // Cylinder curvature = 1/radius (in the radial direction)
  isxRecord(faceId, partnerFaceId, hx, hy, hz, nx, ny, nz, rdx, rdy, rdz, 1.0 / radius);
  return t;
}

// ─── Point containment test ──────────────────────────────────────────

/**
 * Test whether a point (px,py,pz) is inside a closed shell by
 * counting signed crossings against all faces. Uses the face normal
 * direction to determine crossing sign.
 *
 * This is a topological variant: it iterates faces by index, reads
 * the geometry type and offset, and evaluates containment analytically
 * for each surface type. No floating-point tolerance is needed for
 * the crossing count — only the sign of the dot product matters.
 *
 * @returns CLASSIFY_INSIDE if inside, CLASSIFY_OUTSIDE if outside
 */
export function classifyPointVsShell(
  px: f64, py: f64, pz: f64,
  faceStart: u32, faceEnd: u32,
): u8 {
  // Ray-casting along +X axis for simplicity
  let crossings: i32 = 0;

  for (let f = faceStart; f < faceEnd; f++) {
    const geomType = faceGetGeomType(f);
    const gOff = faceGetGeomOffset(f);
    const reversed = faceGetOrient(f) == ORIENT_REVERSED;

    if (geomType == GEOM_PLANE) {
      // Plane: origin(3), normal(3)
      const ox = geomPoolRead(gOff);
      const oy = geomPoolRead(gOff + 1);
      const oz = geomPoolRead(gOff + 2);
      let nx = geomPoolRead(gOff + 3);
      let ny = geomPoolRead(gOff + 4);
      let nz = geomPoolRead(gOff + 5);
      if (reversed) { nx = -nx; ny = -ny; nz = -nz; }

      // Signed distance from point to plane
      const dist = (px - ox) * nx + (py - oy) * ny + (pz - oz) * nz;
      // Ray along +X: hits plane if nx != 0 and intersection is in front
      if (Math.abs(nx) > 1e-12) {
        const t = -dist / nx;
        if (t > 0) crossings++;
      }
    } else if (geomType == GEOM_SPHERE) {
      // Sphere: center(3) + axis(3) + refDir(3) + radius(1)
      const cx = geomPoolRead(gOff);
      const cy = geomPoolRead(gOff + 1);
      const cz = geomPoolRead(gOff + 2);
      const r = geomPoolRead(gOff + 9);

      // Ray origin relative to sphere center
      const dx = px - cx;
      const dy = py - cy;
      const dz = pz - cz;

      // Ray direction = (1,0,0)
      // Quadratic: t² + 2*dx*t + (dx²+dy²+dz²-r²) = 0
      const b = dx; // half-b
      const c = dx * dx + dy * dy + dz * dz - r * r;
      const disc = b * b - c;
      if (disc > 0) {
        const sqrtDisc = Math.sqrt(disc);
        const t1 = -b - sqrtDisc;
        const t2 = -b + sqrtDisc;
        if (t1 > 0) crossings++;
        if (t2 > 0) crossings++;
      }
    } else if (geomType == GEOM_CYLINDER) {
      // Cylinder: origin(3) + axis(3) + refDir(3) + radius(1)
      // Layout: gOff+0..2 = origin, gOff+3..5 = axis (unit), gOff+9 = radius
      const ox = geomPoolRead(gOff);
      const oy = geomPoolRead(gOff + 1);
      const oz = geomPoolRead(gOff + 2);
      const ax = geomPoolRead(gOff + 3);
      const ay = geomPoolRead(gOff + 4);
      const az = geomPoolRead(gOff + 5);
      const radius = geomPoolRead(gOff + 9);

      // Translate ray origin relative to cylinder origin
      const dx = px - ox;
      const dy = py - oy;
      const dz = pz - oz;

      // Ray direction d = (1,0,0)
      // Project out the axis component for the perpendicular quadratic
      // (d - (d·a)a) and (p - (p·a)a) in the plane perpendicular to axis
      const dDotA = ax; // d=(1,0,0) => d·a = ax
      const pDotA = dx * ax + dy * ay + dz * az;

      // Perpendicular components
      const rpx = dx - pDotA * ax; // ray origin perp component
      const rpy = dy - pDotA * ay;
      const rpz = dz - pDotA * az;
      const rdx = 1.0 - dDotA * ax; // ray direction perp component
      const rdy = -dDotA * ay;
      const rdz = -dDotA * az;

      // Quadratic: |rp + t*rd|² = radius²
      const A = rdx * rdx + rdy * rdy + rdz * rdz;
      if (A < 1e-24) continue; // ray is parallel to cylinder axis — no crossing
      const B = 2.0 * (rpx * rdx + rpy * rdy + rpz * rdz);
      const C = rpx * rpx + rpy * rpy + rpz * rpz - radius * radius;
      const disc = B * B - 4.0 * A * C;
      if (disc > 0) {
        const sqrtDisc = Math.sqrt(disc);
        const t1 = (-B - sqrtDisc) / (2.0 * A);
        const t2 = (-B + sqrtDisc) / (2.0 * A);
        if (t1 > 0) crossings++;
        if (t2 > 0) crossings++;
      }
    } else {
      // Cone, torus, NURBS: cannot reliably ray-cast analytically here.
      // Return CLASSIFY_UNKNOWN so the JS side can handle it.
      return CLASSIFY_UNKNOWN;
    }
  }

  return (crossings & 1) ? CLASSIFY_INSIDE : CLASSIFY_OUTSIDE;
}

// ─── Trimmed-face containment via tessellated triangle buffer ────────

/**
 * Test whether a point (px,py,pz) is inside a closed solid by counting
 * ray-triangle crossings against the tessellated triangle buffer that is
 * already populated by `tessBuildAllFaces`.
 *
 * This is the trimmed-face variant of classifyPointVsShell — the tessellator
 * already respects face boundaries (cylinders cut at loop edges, planes
 * clipped to their polygon, NURBS surfaces trimmed by coedges), so the
 * triangles form a true closed manifold for the bounded solid. Ray-casting
 * against triangles therefore produces correct inside/outside for any body
 * the tessellator can handle, including non-convex solids where the analytic
 * classifyPointVsShell fails on extended infinite surfaces.
 *
 * Ray direction: +X (1,0,0). A tiny perturbation in Y/Z is used internally
 * to reduce the chance of hitting triangle edges exactly. Degenerate hits
 * are counted once via half-open interval on one vertex.
 *
 * Uses Möller-Trumbore with hard float tolerance. The tessellation's own
 * tolerance dominates near boundaries; callers needing 1e-9 accuracy must
 * fall back to the GWN path.
 *
 * Pre-condition: `tessBuildAllFaces` must have been called so tessOutIndices
 * and tessOutVerts contain the triangle soup for the target body.
 *
 * @returns CLASSIFY_INSIDE / CLASSIFY_OUTSIDE
 */
export function classifyPointVsTriangles(px: f64, py: f64, pz: f64): u8 {
  const nTris: u32 = getTessOutTriCount();
  if (nTris == 0) return CLASSIFY_UNKNOWN;

  // Ray direction (1, ey, ez) with small epsilon to avoid axis-aligned ties.
  // Using an irrational-ish perturbation is standard practice for robust ray
  // parity tests — it prevents the ray from grazing along a triangle edge.
  const ey: f64 = 7.7192e-7;
  const ez: f64 = 1.3471e-7;
  const dx: f64 = 1.0;
  const dy: f64 = ey;
  const dz: f64 = ez;

  let crossings: i32 = 0;

  for (let t: u32 = 0; t < nTris; t++) {
    // Fetch triangle vertices.
    const ax = tessTriVertComp(t, 0, 0);
    const ay = tessTriVertComp(t, 0, 1);
    const az = tessTriVertComp(t, 0, 2);
    const bx = tessTriVertComp(t, 1, 0);
    const by = tessTriVertComp(t, 1, 1);
    const bz = tessTriVertComp(t, 1, 2);
    const cx = tessTriVertComp(t, 2, 0);
    const cy = tessTriVertComp(t, 2, 1);
    const cz = tessTriVertComp(t, 2, 2);

    // Edge vectors
    const e1x = bx - ax;
    const e1y = by - ay;
    const e1z = bz - az;
    const e2x = cx - ax;
    const e2y = cy - ay;
    const e2z = cz - az;

    // h = d × e2
    const hx = dy * e2z - dz * e2y;
    const hy = dz * e2x - dx * e2z;
    const hz = dx * e2y - dy * e2x;

    // a = e1 · h
    const a = e1x * hx + e1y * hy + e1z * hz;
    if (Math.abs(a) < 1e-20) continue; // ray parallel to triangle plane

    const invA = 1.0 / a;

    // s = origin - vertex0
    const sx = px - ax;
    const sy = py - ay;
    const sz = pz - az;

    // u = (s · h) / a, with half-open [0, 1) on the upper bound
    const u = (sx * hx + sy * hy + sz * hz) * invA;
    if (u < 0.0 || u >= 1.0) continue;

    // q = s × e1
    const qx = sy * e1z - sz * e1y;
    const qy = sz * e1x - sx * e1z;
    const qz = sx * e1y - sy * e1x;

    // v = (d · q) / a
    const v = (dx * qx + dy * qy + dz * qz) * invA;
    if (v < 0.0 || u + v >= 1.0) continue;

    // t-parameter: only count hits in front of the ray origin
    const tParam = (e2x * qx + e2y * qy + e2z * qz) * invA;
    if (tParam > 0.0) crossings++;
  }

  return (crossings & 1) ? CLASSIFY_INSIDE : CLASSIFY_OUTSIDE;
}

// ─── Face AABB overlap using octree ──────────────────────────────────

/**
 * Classify all faces [faceStartA..faceEndA) of body A against
 * body B's faces [faceStartB..faceEndB).
 *
 * Pre-condition: octree must be built with faces from both bodies.
 * Pairs from octreeQueryPairs are read to determine overlapping faces.
 *
 * Sets per-face classification in faceClassification[] for body A faces.
 *
 * @returns number of A-faces that could be classified
 */
export function classifyFacesViaOctree(
  faceStartA: u32, faceEndA: u32,
  faceStartB: u32, faceEndB: u32,
): u32 {
  // Reset classification
  for (let f = faceStartA; f < faceEndA; f++) {
    unchecked(faceClassification[f] = CLASSIFY_UNKNOWN);
  }

  const nPairs = octreeGetPairCount();
  const pairsPtr = getOctreePairsPtr();
  let classified: u32 = 0;

  for (let i: u32 = 0; i < nPairs; i++) {
    const fA = load<u32>(pairsPtr + (<usize>(i * 2) << 2));
    const fB = load<u32>(pairsPtr + (<usize>(i * 2 + 1) << 2));

    // Only process pairs where fA is in A and fB is in B
    if (fA >= faceStartA && fA < faceEndA && fB >= faceStartB && fB < faceEndB) {
      if (unchecked(faceClassification[fA]) == CLASSIFY_UNKNOWN) {
        unchecked(faceClassification[fA] = CLASSIFY_ON_BOUNDARY);
        classified++;
      }
    }
    // Also handle the symmetric case
    if (fB >= faceStartA && fB < faceEndA && fA >= faceStartB && fA < faceEndB) {
      if (unchecked(faceClassification[fB]) == CLASSIFY_UNKNOWN) {
        unchecked(faceClassification[fB] = CLASSIFY_ON_BOUNDARY);
        classified++;
      }
    }
  }

  return classified;
}

/**
 * Read the classification for a face.
 */
export function getFaceClassification(faceId: u32): u8 {
  if (faceId >= 16384) return CLASSIFY_UNKNOWN;
  return unchecked(faceClassification[faceId]);
}

/**
 * Set the classification for a face (from JS side).
 */
export function setFaceClassification(faceId: u32, cls: u8): void {
  if (faceId < 16384) {
    unchecked(faceClassification[faceId] = cls);
  }
}

// ─── Distance helpers ────────────────────────────────────────────────

/**
 * Compute signed distance from point to plane surface.
 * @returns signed distance (positive = same side as normal)
 */
export function pointToPlaneDistance(
  px: f64, py: f64, pz: f64,
  gOff: u32, reversed: bool,
): f64 {
  const ox = geomPoolRead(gOff);
  const oy = geomPoolRead(gOff + 1);
  const oz = geomPoolRead(gOff + 2);
  let nx = geomPoolRead(gOff + 3);
  let ny = geomPoolRead(gOff + 4);
  let nz = geomPoolRead(gOff + 5);
  if (reversed) { nx = -nx; ny = -ny; nz = -nz; }
  return (px - ox) * nx + (py - oy) * ny + (pz - oz) * nz;
}

/**
 * Compute distance from point to sphere surface.
 * @returns signed distance (positive = outside)
 */
export function pointToSphereDistance(
  px: f64, py: f64, pz: f64,
  gOff: u32,
): f64 {
  const cx = geomPoolRead(gOff);
  const cy = geomPoolRead(gOff + 1);
  const cz = geomPoolRead(gOff + 2);
  // Sphere layout: center(3) + axis(3) + refDir(3) + radius(1)
  const r = geomPoolRead(gOff + 9);
  const dx = px - cx;
  const dy = py - cy;
  const dz = pz - cz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
}

/**
 * Compute distance from point to cylinder axis (unsigned).
 * @returns distance from point to the cylinder surface
 */
export function pointToCylinderDistance(
  px: f64, py: f64, pz: f64,
  gOff: u32,
): f64 {
  const ox = geomPoolRead(gOff);
  const oy = geomPoolRead(gOff + 1);
  const oz = geomPoolRead(gOff + 2);
  const ax = geomPoolRead(gOff + 3);
  const ay = geomPoolRead(gOff + 4);
  const az = geomPoolRead(gOff + 5);
  const radius = geomPoolRead(gOff + 9);

  // Project point onto axis
  const dx = px - ox;
  const dy = py - oy;
  const dz = pz - oz;
  const t = dx * ax + dy * ay + dz * az;

  // Perpendicular distance
  const perpX = dx - t * ax;
  const perpY = dy - t * ay;
  const perpZ = dz - t * az;
  const perpDist = Math.sqrt(perpX * perpX + perpY * perpY + perpZ * perpZ);

  return perpDist - radius;
}

// ─── Output accessors ────────────────────────────────────────────────

export function getFaceClassificationPtr(): usize {
  return changetype<usize>(faceClassification);
}
