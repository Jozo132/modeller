// js/cad/assembly/Transform3D.js — 4×4 homogeneous transform utilities
//
// Row-major 4×4 matrices stored as Float64Array(16):
//   [ r00 r01 r02 tx ]
//   [ r10 r11 r12 ty ]
//   [ r20 r21 r22 tz ]
//   [  0   0   0   1 ]
//
// All functions are pure — they return new arrays, never mutate inputs.

/**
 * Create a 4×4 identity matrix.
 * @returns {Float64Array}
 */
export function identity() {
  const m = new Float64Array(16);
  m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
  return m;
}

/**
 * Create a translation matrix.
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {Float64Array}
 */
export function fromTranslation(x, y, z) {
  const m = identity();
  m[3] = x; m[7] = y; m[11] = z;
  return m;
}

/**
 * Create a rotation matrix about the X axis.
 * @param {number} angle - radians
 * @returns {Float64Array}
 */
export function fromRotationX(angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const m = identity();
  m[5] = c; m[6] = -s;
  m[9] = s; m[10] = c;
  return m;
}

/**
 * Create a rotation matrix about the Y axis.
 * @param {number} angle - radians
 * @returns {Float64Array}
 */
export function fromRotationY(angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const m = identity();
  m[0] = c; m[2] = s;
  m[8] = -s; m[10] = c;
  return m;
}

/**
 * Create a rotation matrix about the Z axis.
 * @param {number} angle - radians
 * @returns {Float64Array}
 */
export function fromRotationZ(angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const m = identity();
  m[0] = c; m[1] = -s;
  m[4] = s; m[5] = c;
  return m;
}

/**
 * Create a rotation matrix from an axis-angle representation.
 * @param {{x:number,y:number,z:number}} axis - unit axis
 * @param {number} angle - radians
 * @returns {Float64Array}
 */
export function fromAxisAngle(axis, angle) {
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  const { x, y, z } = axis;
  const m = identity();
  m[0] = t * x * x + c;       m[1] = t * x * y - s * z;   m[2] = t * x * z + s * y;
  m[4] = t * x * y + s * z;   m[5] = t * y * y + c;       m[6] = t * y * z - s * x;
  m[8] = t * x * z - s * y;   m[9] = t * y * z + s * x;   m[10] = t * z * z + c;
  return m;
}

/**
 * Compose a transform from position + rotation matrix (3×3 upper-left).
 * @param {{x:number,y:number,z:number}} pos
 * @param {Float64Array} rot - 4×4 matrix whose rotation part is used
 * @returns {Float64Array}
 */
export function compose(pos, rot) {
  const m = new Float64Array(rot);
  m[3] = pos.x; m[7] = pos.y; m[11] = pos.z;
  m[12] = 0; m[13] = 0; m[14] = 0; m[15] = 1;
  return m;
}

/**
 * Multiply two 4×4 matrices: result = a * b.
 * @param {Float64Array} a
 * @param {Float64Array} b
 * @returns {Float64Array}
 */
export function multiply(a, b) {
  const r = new Float64Array(16);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += a[row * 4 + k] * b[k * 4 + col];
      }
      r[row * 4 + col] = sum;
    }
  }
  return r;
}

/**
 * Invert a 4×4 rigid-body transform (rotation + translation).
 * For rigid transforms: R^-1 = R^T, t^-1 = -R^T * t
 * @param {Float64Array} m
 * @returns {Float64Array}
 */
export function invertRigid(m) {
  const r = identity();
  // Transpose 3×3 rotation
  r[0] = m[0]; r[1] = m[4]; r[2] = m[8];
  r[4] = m[1]; r[5] = m[5]; r[6] = m[9];
  r[8] = m[2]; r[9] = m[6]; r[10] = m[10];
  // -R^T * t
  const tx = m[3], ty = m[7], tz = m[11];
  r[3]  = -(r[0] * tx + r[1] * ty + r[2] * tz);
  r[7]  = -(r[4] * tx + r[5] * ty + r[6] * tz);
  r[11] = -(r[8] * tx + r[9] * ty + r[10] * tz);
  return r;
}

/**
 * Transform a 3D point by a 4×4 matrix.
 * @param {Float64Array} m
 * @param {{x:number,y:number,z:number}} p
 * @returns {{x:number,y:number,z:number}}
 */
export function transformPoint(m, p) {
  return {
    x: m[0] * p.x + m[1] * p.y + m[2] * p.z + m[3],
    y: m[4] * p.x + m[5] * p.y + m[6] * p.z + m[7],
    z: m[8] * p.x + m[9] * p.y + m[10] * p.z + m[11],
  };
}

/**
 * Transform a direction vector by the rotation part of a 4×4 matrix (no translation).
 * @param {Float64Array} m
 * @param {{x:number,y:number,z:number}} d
 * @returns {{x:number,y:number,z:number}}
 */
export function transformDirection(m, d) {
  return {
    x: m[0] * d.x + m[1] * d.y + m[2] * d.z,
    y: m[4] * d.x + m[5] * d.y + m[6] * d.z,
    z: m[8] * d.x + m[9] * d.y + m[10] * d.z,
  };
}

/**
 * Extract position from a 4×4 matrix.
 * @param {Float64Array} m
 * @returns {{x:number,y:number,z:number}}
 */
export function extractPosition(m) {
  return { x: m[3], y: m[7], z: m[11] };
}

/**
 * Check if two transforms are approximately equal within tolerance.
 * @param {Float64Array} a
 * @param {Float64Array} b
 * @param {number} [tol=1e-9]
 * @returns {boolean}
 */
export function transformsEqual(a, b, tol = 1e-9) {
  for (let i = 0; i < 16; i++) {
    if (Math.abs(a[i] - b[i]) > tol) return false;
  }
  return true;
}

// ── Vector helpers ──────────────────────────────────────────────────

export function vec3Dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function vec3Cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function vec3Length(v) {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

export function vec3Normalize(v) {
  const len = vec3Length(v);
  if (len < 1e-15) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

export function vec3Sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function vec3Add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function vec3Scale(v, s) {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

export function vec3Dist(a, b) {
  return vec3Length(vec3Sub(a, b));
}
