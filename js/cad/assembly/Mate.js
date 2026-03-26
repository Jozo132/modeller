// js/cad/assembly/Mate.js — Assembly mate constraints
//
// Five mate types for the MVP:
//   coincident  – aligns a point or plane pair
//   concentric  – aligns two axes
//   distance    – sets offset between planes / points
//   angle       – sets angle between two planes
//   planar      – coplanar constraint on two planes
//
// Each mate references two PartInstances and two local-space features.
// A feature is one of: point, axis, plane.

import {
  transformPoint, transformDirection, identity,
  multiply, fromTranslation, fromAxisAngle,
  invertRigid, vec3Dot, vec3Cross, vec3Sub, vec3Add,
  vec3Scale, vec3Normalize, vec3Length, vec3Dist,
} from './Transform3D.js';

// ── Feature reference constructors ──────────────────────────────────

/**
 * @param {{x:number,y:number,z:number}} origin - point in part-local coords
 */
export function pointFeature(origin) {
  return { type: 'point', origin: { ...origin } };
}

/**
 * @param {{x:number,y:number,z:number}} origin
 * @param {{x:number,y:number,z:number}} direction - unit direction
 */
export function axisFeature(origin, direction) {
  return { type: 'axis', origin: { ...origin }, direction: vec3Normalize(direction) };
}

/**
 * @param {{x:number,y:number,z:number}} origin
 * @param {{x:number,y:number,z:number}} normal - unit normal
 */
export function planeFeature(origin, normal) {
  return { type: 'plane', origin: { ...origin }, normal: vec3Normalize(normal) };
}

// ── Mate type enum ──────────────────────────────────────────────────

export const MateType = Object.freeze({
  COINCIDENT: 'coincident',
  CONCENTRIC: 'concentric',
  DISTANCE:   'distance',
  ANGLE:      'angle',
  PLANAR:     'planar',
});

// ── DOF removed per mate type ───────────────────────────────────────

const DOF_TABLE = {
  coincident: 3,   // point-point: 3T; plane-plane: 1T+2R
  concentric: 4,   // 2T + 2R (free: 1T along axis + 1R about axis)
  distance:   1,   // 1T
  angle:      1,   // 1R
  planar:     3,   // 1T + 2R
};

let _mateIdCounter = 0;

// ── Mate class ──────────────────────────────────────────────────────

/**
 * Mate — a constraint between two PartInstances.
 */
export class Mate {
  /**
   * @param {Object} opts
   * @param {string} opts.type        - MateType value
   * @param {string} opts.instanceA   - ID of first instance
   * @param {string} opts.instanceB   - ID of second instance
   * @param {Object} opts.featureA    - Feature ref on instance A (local coords)
   * @param {Object} opts.featureB    - Feature ref on instance B (local coords)
   * @param {number} [opts.value=0]   - Scalar param (distance or angle in radians)
   */
  constructor(opts) {
    this.id = `mate_${++_mateIdCounter}`;
    this.type = opts.type;
    this.instanceA = opts.instanceA;
    this.instanceB = opts.instanceB;
    this.featureA = opts.featureA;
    this.featureB = opts.featureB;
    this.value = opts.value ?? 0;
  }

  /** DOF removed by this mate type. */
  get dofRemoved() {
    return DOF_TABLE[this.type] ?? 0;
  }

  serialize() {
    return {
      type: 'Mate',
      id: this.id,
      mateType: this.type,
      instanceA: this.instanceA,
      instanceB: this.instanceB,
      featureA: this.featureA,
      featureB: this.featureB,
      value: this.value,
    };
  }

  static deserialize(data) {
    const m = new Mate({
      type: data.mateType,
      instanceA: data.instanceA,
      instanceB: data.instanceB,
      featureA: data.featureA,
      featureB: data.featureB,
      value: data.value,
    });
    if (data.id) m.id = data.id;
    return m;
  }
}

/**
 * Reset mate ID counter (for tests).
 */
export function resetMateIds() {
  _mateIdCounter = 0;
}

// ── Per-mate solvers ────────────────────────────────────────────────
// Each returns the corrected world transform for instance B given
// the current transforms of A and B and the mate specification.

/**
 * Solve a single mate: compute the updated transform for instance B.
 *
 * @param {Mate}         mate
 * @param {Float64Array} tA - world transform of instance A
 * @param {Float64Array} tB - current world transform of instance B
 * @returns {Float64Array} corrected tB
 */
export function solveMate(mate, tA, tB) {
  switch (mate.type) {
    case MateType.COINCIDENT: return _solveCoincident(mate, tA, tB);
    case MateType.CONCENTRIC: return _solveConcentric(mate, tA, tB);
    case MateType.DISTANCE:   return _solveDistance(mate, tA, tB);
    case MateType.ANGLE:      return _solveAngle(mate, tA, tB);
    case MateType.PLANAR:     return _solvePlanar(mate, tA, tB);
    default: return new Float64Array(tB);
  }
}

// ── Coincident ──────────────────────────────────────────────────────
function _solveCoincident(mate, tA, tB) {
  const fA = mate.featureA;
  const fB = mate.featureB;

  if (fA.type === 'point' && fB.type === 'point') {
    // Point-point: translate B so that featureB world == featureA world
    const wA = transformPoint(tA, fA.origin);
    const wB = transformPoint(tB, fB.origin);
    const delta = vec3Sub(wA, wB);
    const shift = fromTranslation(delta.x, delta.y, delta.z);
    return multiply(shift, tB);
  }

  if (fA.type === 'plane' && fB.type === 'plane') {
    // Plane-plane: align normals (anti-parallel) then translate onto plane
    const nA = vec3Normalize(transformDirection(tA, fA.normal));
    const nB = vec3Normalize(transformDirection(tB, fB.normal));
    // Rotation to flip nB to -nA (face-to-face)
    const target = vec3Scale(nA, -1);
    const correctedTB = _alignDirection(tB, nB, target);
    // Now translate so origins are coplanar
    const oA = transformPoint(tA, fA.origin);
    const oB_new = transformPoint(correctedTB, fB.origin);
    const dist = vec3Dot(vec3Sub(oA, oB_new), nA);
    const shift = fromTranslation(nA.x * dist, nA.y * dist, nA.z * dist);
    return multiply(shift, correctedTB);
  }

  // Fallback: treat as point-point using origins
  const wA = transformPoint(tA, fA.origin);
  const wB = transformPoint(tB, fB.origin);
  const delta = vec3Sub(wA, wB);
  const shift = fromTranslation(delta.x, delta.y, delta.z);
  return multiply(shift, tB);
}

// ── Concentric ──────────────────────────────────────────────────────
function _solveConcentric(mate, tA, tB) {
  const fA = mate.featureA;
  const fB = mate.featureB;

  // Align axis directions
  const dA = vec3Normalize(transformDirection(tA, fA.direction));
  const dB = vec3Normalize(transformDirection(tB, fB.direction));
  let correctedTB = _alignDirection(tB, dB, dA);

  // Project origin of B's axis onto A's axis line
  const oA = transformPoint(tA, fA.origin);
  const oB = transformPoint(correctedTB, fB.origin);
  const diff = vec3Sub(oB, oA);
  const along = vec3Dot(diff, dA);
  const closest = vec3Add(oA, vec3Scale(dA, along));
  const lateral = vec3Sub(closest, oB);
  const shift = fromTranslation(lateral.x, lateral.y, lateral.z);
  return multiply(shift, correctedTB);
}

// ── Distance ────────────────────────────────────────────────────────
function _solveDistance(mate, tA, tB) {
  const fA = mate.featureA;
  const fB = mate.featureB;
  const target = mate.value;

  if (fA.type === 'plane' && fB.type === 'plane') {
    const nA = vec3Normalize(transformDirection(tA, fA.normal));
    const oA = transformPoint(tA, fA.origin);
    const oB = transformPoint(tB, fB.origin);
    const current = vec3Dot(vec3Sub(oB, oA), nA);
    const correction = target - current;
    const shift = fromTranslation(nA.x * correction, nA.y * correction, nA.z * correction);
    return multiply(shift, tB);
  }

  // Point-point distance
  const wA = transformPoint(tA, fA.origin);
  const wB = transformPoint(tB, fB.origin);
  const diff = vec3Sub(wB, wA);
  const dist = vec3Length(diff);
  if (dist < 1e-15) {
    // Degenerate — push along +X
    const shift = fromTranslation(target, 0, 0);
    return multiply(shift, tB);
  }
  const dir = vec3Scale(diff, 1 / dist);
  const correction = target - dist;
  const shift = fromTranslation(dir.x * correction, dir.y * correction, dir.z * correction);
  return multiply(shift, tB);
}

// ── Angle ───────────────────────────────────────────────────────────
function _solveAngle(mate, tA, tB) {
  const fA = mate.featureA;
  const fB = mate.featureB;
  const targetAngle = mate.value;

  const nA = vec3Normalize(transformDirection(tA, fA.normal));
  const nB = vec3Normalize(transformDirection(tB, fB.normal));
  const currentAngle = Math.acos(Math.max(-1, Math.min(1, vec3Dot(nA, nB))));
  const correction = targetAngle - currentAngle;

  if (Math.abs(correction) < 1e-12) return new Float64Array(tB);

  // Rotation axis: perpendicular to both normals
  let axis = vec3Cross(nB, nA);
  const axisLen = vec3Length(axis);
  if (axisLen < 1e-12) {
    // Normals are (anti-)parallel — pick arbitrary perpendicular
    axis = _arbitraryPerp(nA);
  } else {
    axis = vec3Scale(axis, 1 / axisLen);
  }

  const oB = transformPoint(tB, fB.origin);
  return _rotateAbout(tB, oB, axis, correction);
}

// ── Planar ──────────────────────────────────────────────────────────
function _solvePlanar(mate, tA, tB) {
  const fA = mate.featureA;
  const fB = mate.featureB;

  // Align normals (same direction for planar)
  const nA = vec3Normalize(transformDirection(tA, fA.normal));
  const nB = vec3Normalize(transformDirection(tB, fB.normal));
  let correctedTB = _alignDirection(tB, nB, nA);

  // Translate so B's plane origin sits on A's plane
  const oA = transformPoint(tA, fA.origin);
  const oB_new = transformPoint(correctedTB, fB.origin);
  const dist = vec3Dot(vec3Sub(oA, oB_new), nA);
  const shift = fromTranslation(nA.x * dist, nA.y * dist, nA.z * dist);
  return multiply(shift, correctedTB);
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Rotate transform tB so that direction `from` maps to direction `to`.
 * Pivot is at the world-space centroid of B's rotation center.
 */
function _alignDirection(tB, from, to) {
  const dot = Math.max(-1, Math.min(1, vec3Dot(from, to)));
  if (dot > 1 - 1e-12) return new Float64Array(tB); // already aligned

  let axis, angle;
  if (dot < -1 + 1e-12) {
    // 180° flip — use arbitrary perpendicular axis
    axis = _arbitraryPerp(from);
    angle = Math.PI;
  } else {
    axis = vec3Normalize(vec3Cross(from, to));
    angle = Math.acos(dot);
  }

  // Rotate about the origin of B (its position)
  const origin = { x: tB[3], y: tB[7], z: tB[11] };
  return _rotateAbout(tB, origin, axis, angle);
}

/**
 * Rotate a 4×4 transform about a world-space pivot point.
 */
function _rotateAbout(t, pivot, axis, angle) {
  const toOrigin  = fromTranslation(-pivot.x, -pivot.y, -pivot.z);
  const rot       = fromAxisAngle(axis, angle);
  const fromOrigin = fromTranslation(pivot.x, pivot.y, pivot.z);
  return multiply(fromOrigin, multiply(rot, multiply(toOrigin, t)));
}

/**
 * Return an arbitrary unit vector perpendicular to v.
 */
function _arbitraryPerp(v) {
  const abs = { x: Math.abs(v.x), y: Math.abs(v.y), z: Math.abs(v.z) };
  const candidate = abs.x < abs.y
    ? (abs.x < abs.z ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 })
    : (abs.y < abs.z ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 });
  return vec3Normalize(vec3Cross(v, candidate));
}

/**
 * Compute the residual error of a mate given current transforms.
 * Returns a non-negative scalar; 0 means perfectly satisfied.
 */
export function mateResidual(mate, tA, tB) {
  const fA = mate.featureA;
  const fB = mate.featureB;

  switch (mate.type) {
    case MateType.COINCIDENT: {
      if (fA.type === 'point' && fB.type === 'point') {
        return vec3Dist(transformPoint(tA, fA.origin), transformPoint(tB, fB.origin));
      }
      // Plane-plane: normal alignment + origin distance
      const nA = vec3Normalize(transformDirection(tA, fA.normal));
      const nB = vec3Normalize(transformDirection(tB, fB.normal));
      const dotErr = 1 - Math.abs(vec3Dot(nA, nB));
      const oA = transformPoint(tA, fA.origin);
      const oB = transformPoint(tB, fB.origin);
      const distErr = Math.abs(vec3Dot(vec3Sub(oB, oA), nA));
      return dotErr + distErr;
    }
    case MateType.CONCENTRIC: {
      const dA = vec3Normalize(transformDirection(tA, fA.direction));
      const dB = vec3Normalize(transformDirection(tB, fB.direction));
      const dotErr = 1 - Math.abs(vec3Dot(dA, dB));
      const oA = transformPoint(tA, fA.origin);
      const oB = transformPoint(tB, fB.origin);
      const diff = vec3Sub(oB, oA);
      const along = vec3Dot(diff, dA);
      const lateral = vec3Length(vec3Sub(diff, vec3Scale(dA, along)));
      return dotErr + lateral;
    }
    case MateType.DISTANCE: {
      if (fA.type === 'plane' && fB.type === 'plane') {
        const nA = vec3Normalize(transformDirection(tA, fA.normal));
        const oA = transformPoint(tA, fA.origin);
        const oB = transformPoint(tB, fB.origin);
        const current = vec3Dot(vec3Sub(oB, oA), nA);
        return Math.abs(current - mate.value);
      }
      const dist = vec3Dist(transformPoint(tA, fA.origin), transformPoint(tB, fB.origin));
      return Math.abs(dist - mate.value);
    }
    case MateType.ANGLE: {
      const nA = vec3Normalize(transformDirection(tA, fA.normal));
      const nB = vec3Normalize(transformDirection(tB, fB.normal));
      const current = Math.acos(Math.max(-1, Math.min(1, vec3Dot(nA, nB))));
      return Math.abs(current - mate.value);
    }
    case MateType.PLANAR: {
      const nA = vec3Normalize(transformDirection(tA, fA.normal));
      const nB = vec3Normalize(transformDirection(tB, fB.normal));
      const dotErr = 1 - vec3Dot(nA, nB); // must be same direction
      const oA = transformPoint(tA, fA.origin);
      const oB = transformPoint(tB, fB.origin);
      const distErr = Math.abs(vec3Dot(vec3Sub(oB, oA), nA));
      return dotErr + distErr;
    }
    default: return 0;
  }
}
