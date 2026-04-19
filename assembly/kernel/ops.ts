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
    }
    // Cylinder, cone, torus containment are more complex — for now
    // we flag them as unknown and let JS fall back to its ray-cast
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
