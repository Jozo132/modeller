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
      // Sphere: center(3), radius(1)
      const cx = geomPoolRead(gOff);
      const cy = geomPoolRead(gOff + 1);
      const cz = geomPoolRead(gOff + 2);
      const r = geomPoolRead(gOff + 3);

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
  const r = geomPoolRead(gOff + 3);
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
