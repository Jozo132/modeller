// js/cad/GeometryEvaluator.js — Authoritative NURBS curve/surface evaluator
//
// Single entrypoint for exact geometry evaluation with first and second
// derivatives. Prefers WASM-backed evaluation when available; falls back
// to a pure JS implementation when WASM is not loaded or fails.
//
// Normals are derivative-based: n = normalize(cross(du, dv)).
// Finite-difference normals are only used as a last resort in degenerate cases.
//
// References:
//   - Piegl & Tiller, "The NURBS Book" (1997), Algorithms A2.2, A2.3, A3.2, A4.4
//   - ISO 10303-42 (STEP geometry)

import { loadReleaseWasmModule } from '../load-release-wasm.js';

// ─── Tolerances ──────────────────────────────────────────────────────
// Centralized tolerance constants used throughout evaluation, tessellation,
// and intersection code. Changing these affects degenerate-case detection
// across the entire evaluator stack.

/** Tolerance for zero-weight sums and near-zero denominators. */
const WEIGHT_ZERO_TOL = 1e-14;

/** Tolerance for degenerate normal vectors (|cross| < this → degenerate). */
const NORMAL_ZERO_TOL = 1e-14;

/** Default fallback normal when the cross product is degenerate. */
const FALLBACK_NORMAL = { x: 0, y: 0, z: 1 };

// ─── WASM module reference ──────────────────────────────────────────

let _wasm = null;
let _wasmMem = null;
let _wasmInitPromise = null;

/**
 * Initialize the WASM backend. Safe to call multiple times.
 * @returns {Promise<boolean>} true if WASM loaded successfully
 */
async function initWasm() {
  if (_wasm) return true;
  if (_wasmInitPromise) return _wasmInitPromise;
  _wasmInitPromise = loadReleaseWasmModule()
    .then((mod) => {
      _wasm = mod;
      _wasmMem = mod.memory;
      return true;
    })
    .catch(() => false);
  return _wasmInitPromise;
}

/** Check if WASM backend is available. */
function isWasmAvailable() {
  return _wasm !== null;
}

// Start loading the evaluator backend eagerly so hot paths are less likely to
// observe the JS compatibility lane during normal OCCT-driven execution.
initWasm().catch(() => {});

// ─── JS-side B-spline basis functions ────────────────────────────────

/**
 * Find the knot span index for parameter t.
 * Returns i such that knots[i] <= t < knots[i+1].
 */
function _findSpan(t, degree, numCtrl, knots) {
  const n = numCtrl - 1;
  if (t >= knots[n + 1]) return n;

  let low = degree;
  let high = n + 1;
  let mid = (low + high) >>> 1;

  while (t < knots[mid] || t >= knots[mid + 1]) {
    if (t < knots[mid]) {
      high = mid;
    } else {
      low = mid;
    }
    mid = (low + high) >>> 1;
  }
  return mid;
}

// ─── Scratch buffers for _basisDerivsInto ───────────────────────────
// Module-scope typed-array scratch pools, grown on demand. These are
// single-threaded scratch space used inside a single _basisDerivsInto
// invocation; callers must consume the output before the next call.
// (Both _jsEvalCurve and _jsEvalSurface do.)

const _BD_MAX_DEG = 16; // generous; STEP typically has degree ≤ 3
let _bdNdu   = new Float64Array((_BD_MAX_DEG + 1) * (_BD_MAX_DEG + 1));
let _bdLeft  = new Float64Array(_BD_MAX_DEG + 1);
let _bdRight = new Float64Array(_BD_MAX_DEG + 1);
let _bdA0    = new Float64Array(_BD_MAX_DEG + 1);
let _bdA1    = new Float64Array(_BD_MAX_DEG + 1);

function _ensureBdScratch(P1) {
  if (_bdNdu.length < P1 * P1) _bdNdu = new Float64Array(P1 * P1);
  if (_bdLeft.length  < P1) _bdLeft  = new Float64Array(P1);
  if (_bdRight.length < P1) _bdRight = new Float64Array(P1);
  if (_bdA0.length    < P1) _bdA0    = new Float64Array(P1);
  if (_bdA1.length    < P1) _bdA1    = new Float64Array(P1);
}

/**
 * Compute B-spline basis functions and their derivatives up to order nDerivs.
 * Implements Piegl & Tiller Algorithm A2.3.
 *
 * Writes the (nDerivs+1) × (degree+1) derivative table into `out` in row-major
 * order: out[k * P1 + j] = d^k/du^k N_{span-degree+j, degree}(u). Zero
 * allocations on the hot path — scratch space comes from module-level
 * Float64Array pools. The tables overwrite on each call, so callers must
 * consume the result before issuing another basis-derivative call.
 *
 * @param {number} span - Knot span index
 * @param {number} u - Parameter value
 * @param {number} degree - Polynomial degree
 * @param {ArrayLike<number>} knots - Knot vector
 * @param {number} nDerivs - Maximum derivative order (typically 2)
 * @param {Float64Array} out - Output buffer, length ≥ (nDerivs+1)*(degree+1)
 */
function _basisDerivsInto(span, u, degree, knots, nDerivs, out) {
  const p = degree;
  const P1 = p + 1;
  _ensureBdScratch(P1);
  const ndu = _bdNdu;
  const left = _bdLeft;
  const right = _bdRight;

  ndu[0] = 1.0;

  for (let j = 1; j <= p; j++) {
    left[j] = u - knots[span + 1 - j];
    right[j] = knots[span + j] - u;
    let saved = 0.0;

    for (let r = 0; r < j; r++) {
      const denom = right[r + 1] + left[j - r];
      ndu[j * P1 + r] = denom;

      let temp;
      if (denom < WEIGHT_ZERO_TOL && denom > -WEIGHT_ZERO_TOL) {
        temp = 0.0;
      } else {
        temp = ndu[r * P1 + (j - 1)] / denom;
      }

      ndu[r * P1 + j] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    ndu[j * P1 + j] = saved;
  }

  // Zero the output table.
  const outLen = (nDerivs + 1) * P1;
  for (let i = 0; i < outLen; i++) out[i] = 0;

  // 0th derivative = basis function values
  for (let j = 0; j <= p; j++) {
    out[j] = ndu[j * P1 + p];
  }

  // Compute higher derivatives (Piegl & Tiller A2.3).
  // Ping-pong between _bdA0 and _bdA1 as the two "a[s1]" / "a[s2]" rows.
  const a0 = _bdA0;
  const a1 = _bdA1;

  for (let r = 0; r <= p; r++) {
    let useA1 = true; // which of (a0, a1) is "s2"
    a0[0] = 1.0;

    for (let k = 1; k <= nDerivs; k++) {
      const s1 = useA1 ? a0 : a1;
      const s2 = useA1 ? a1 : a0;

      let d = 0.0;
      const rk = r - k;
      const pk = p - k;

      if (r >= k) {
        const denom = ndu[(pk + 1) * P1 + rk];
        if (denom < WEIGHT_ZERO_TOL && denom > -WEIGHT_ZERO_TOL) {
          s2[0] = 0.0;
        } else {
          s2[0] = s1[0] / denom;
        }
        d = s2[0] * ndu[rk * P1 + pk];
      }

      const j1 = rk >= -1 ? 1 : -rk;
      const j2 = (r - 1) <= pk ? k - 1 : p - r;

      for (let j = j1; j <= j2; j++) {
        const denom = ndu[(pk + 1) * P1 + (rk + j)];
        if (denom < WEIGHT_ZERO_TOL && denom > -WEIGHT_ZERO_TOL) {
          s2[j] = 0.0;
        } else {
          s2[j] = (s1[j] - s1[j - 1]) / denom;
        }
        d += s2[j] * ndu[(rk + j) * P1 + pk];
      }

      if (r <= pk) {
        const denom = ndu[(pk + 1) * P1 + r];
        if (denom < WEIGHT_ZERO_TOL && denom > -WEIGHT_ZERO_TOL) {
          s2[k] = 0.0;
        } else {
          s2[k] = -s1[k - 1] / denom;
        }
        d += s2[k] * ndu[r * P1 + pk];
      }

      out[k * P1 + r] = d;
      useA1 = !useA1;
    }
  }

  // Multiply by correct factors: p! / (p-k)!
  let fac = p;
  for (let k = 1; k <= nDerivs; k++) {
    const base = k * P1;
    for (let j = 0; j <= p; j++) {
      out[base + j] *= fac;
    }
    fac *= (p - k);
  }
}

// ─── Pure JS evaluators ─────────────────────────────────────────────
// Pre-allocated derivative tables for the curve and surface evaluators.
// Size = (nDerivs+1) * (maxDegree+1); grown on demand.
let _curveDers = new Float64Array(3 * (_BD_MAX_DEG + 1));
let _surfDersU = new Float64Array(3 * (_BD_MAX_DEG + 1));
let _surfDersV = new Float64Array(3 * (_BD_MAX_DEG + 1));
function _ensureDerBuf(buf, P1, nDerivs) {
  const need = (nDerivs + 1) * P1;
  return buf.length >= need ? buf : new Float64Array(need);
}

/**
 * Evaluate a NURBS curve with derivatives (pure JS).
 *
 * For rational curve C(t) = A(t)/w(t):
 *   C'  = (A' - w'·C) / w
 *   C'' = (A'' - 2·w'·C' - w''·C) / w
 *
 * @param {Object} curve - { degree, controlPoints, knots, weights, uMin, uMax }
 * @param {number} t - Parameter value
 * @returns {{ p: {x,y,z}, d1: {x,y,z}, d2: {x,y,z} }}
 */
function _jsEvalCurve(curve, t) {
  const { degree, controlPoints, knots, weights } = curve;
  const uMin = knots[degree];
  const uMax = knots[controlPoints.length];
  t = Math.max(uMin, Math.min(uMax, t));

  const span = _findSpan(t, degree, controlPoints.length, knots);
  const P1 = degree + 1;
  _curveDers = _ensureDerBuf(_curveDers, P1, 2);
  _basisDerivsInto(span, t, degree, knots, 2, _curveDers);
  const ders = _curveDers;

  // Accumulate weighted control point sums
  let Ax = 0, Ay = 0, Az = 0, w0 = 0;
  let A1x = 0, A1y = 0, A1z = 0, w1 = 0;
  let A2x = 0, A2y = 0, A2z = 0, w2 = 0;

  for (let i = 0; i <= degree; i++) {
    const idx = span - degree + i;
    const cp = controlPoints[idx];
    const w = weights[idx];

    const N0 = ders[i] * w;
    Ax += N0 * cp.x; Ay += N0 * cp.y; Az += N0 * cp.z; w0 += N0;

    const N1 = ders[P1 + i] * w;
    A1x += N1 * cp.x; A1y += N1 * cp.y; A1z += N1 * cp.z; w1 += N1;

    const N2 = ders[2 * P1 + i] * w;
    A2x += N2 * cp.x; A2y += N2 * cp.y; A2z += N2 * cp.z; w2 += N2;
  }

  if (Math.abs(w0) < WEIGHT_ZERO_TOL) {
    return {
      p: { x: 0, y: 0, z: 0 },
      d1: { x: 0, y: 0, z: 0 },
      d2: { x: 0, y: 0, z: 0 },
    };
  }

  const invW = 1.0 / w0;

  const cx = Ax * invW, cy = Ay * invW, cz = Az * invW;
  const d1x = (A1x - w1 * cx) * invW;
  const d1y = (A1y - w1 * cy) * invW;
  const d1z = (A1z - w1 * cz) * invW;
  const d2x = (A2x - 2.0 * w1 * d1x - w2 * cx) * invW;
  const d2y = (A2y - 2.0 * w1 * d1y - w2 * cy) * invW;
  const d2z = (A2z - 2.0 * w1 * d1z - w2 * cz) * invW;

  return {
    p: { x: cx, y: cy, z: cz },
    d1: { x: d1x, y: d1y, z: d1z },
    d2: { x: d2x, y: d2y, z: d2z },
  };
}

/**
 * Evaluate a NURBS surface with derivatives (pure JS).
 *
 * Rational surface derivative formulas:
 *   S    = A^{00} / w^{00}
 *   S_u  = (A^{10} - w^{10}·S) / w^{00}
 *   S_v  = (A^{01} - w^{01}·S) / w^{00}
 *   S_uu = (A^{20} - 2·w^{10}·S_u - w^{20}·S) / w^{00}
 *   S_uv = (A^{11} - w^{10}·S_v - w^{01}·S_u - w^{11}·S) / w^{00}
 *   S_vv = (A^{02} - 2·w^{01}·S_v - w^{02}·S) / w^{00}
 *   n    = normalize(S_u × S_v)
 *
 * @param {Object} surface - NurbsSurface-like object
 * @param {number} u
 * @param {number} v
 * @returns {{ p, du, dv, duu, duv, dvv, n }}
 */
function _jsEvalSurface(surface, u, v) {
  const { degreeU, degreeV, numRowsU, numColsV, controlPoints, knotsU, knotsV, weights } = surface;
  const uMin = knotsU[degreeU];
  const uMax = knotsU[numRowsU];
  const vMin = knotsV[degreeV];
  const vMax = knotsV[numColsV];
  u = Math.max(uMin, Math.min(uMax, u));
  v = Math.max(vMin, Math.min(vMax, v));

  const spanU = _findSpan(u, degreeU, numRowsU, knotsU);
  const PU1 = degreeU + 1;
  _surfDersU = _ensureDerBuf(_surfDersU, PU1, 2);
  _basisDerivsInto(spanU, u, degreeU, knotsU, 2, _surfDersU);
  const dersU = _surfDersU;

  const spanV = _findSpan(v, degreeV, numColsV, knotsV);
  const PV1 = degreeV + 1;
  _surfDersV = _ensureDerBuf(_surfDersV, PV1, 2);
  _basisDerivsInto(spanV, v, degreeV, knotsV, 2, _surfDersV);
  const dersV = _surfDersV;

  // Accumulate tensor product sums
  let A00x = 0, A00y = 0, A00z = 0, w00 = 0;
  let A10x = 0, A10y = 0, A10z = 0, w10 = 0;
  let A01x = 0, A01y = 0, A01z = 0, w01 = 0;
  let A20x = 0, A20y = 0, A20z = 0, w20 = 0;
  let A11x = 0, A11y = 0, A11z = 0, w11 = 0;
  let A02x = 0, A02y = 0, A02z = 0, w02 = 0;

  for (let i = 0; i <= degreeU; i++) {
    const rowIdx = spanU - degreeU + i;
    const Nu0 = dersU[i];
    const Nu1 = dersU[PU1 + i];
    const Nu2 = dersU[2 * PU1 + i];

    for (let j = 0; j <= degreeV; j++) {
      const colIdx = spanV - degreeV + j;
      const cpIdx = rowIdx * numColsV + colIdx;
      const cp = controlPoints[cpIdx];
      const w = weights[cpIdx];
      const px = cp.x, py = cp.y, pz = cp.z;

      const Nv0 = dersV[j];
      const Nv1 = dersV[PV1 + j];
      const Nv2 = dersV[2 * PV1 + j];

      const b00 = Nu0 * Nv0 * w;
      A00x += b00 * px; A00y += b00 * py; A00z += b00 * pz; w00 += b00;

      const b10 = Nu1 * Nv0 * w;
      A10x += b10 * px; A10y += b10 * py; A10z += b10 * pz; w10 += b10;

      const b01 = Nu0 * Nv1 * w;
      A01x += b01 * px; A01y += b01 * py; A01z += b01 * pz; w01 += b01;

      const b20 = Nu2 * Nv0 * w;
      A20x += b20 * px; A20y += b20 * py; A20z += b20 * pz; w20 += b20;

      const b11 = Nu1 * Nv1 * w;
      A11x += b11 * px; A11y += b11 * py; A11z += b11 * pz; w11 += b11;

      const b02 = Nu0 * Nv2 * w;
      A02x += b02 * px; A02y += b02 * py; A02z += b02 * pz; w02 += b02;
    }
  }

  if (Math.abs(w00) < WEIGHT_ZERO_TOL) {
    const z = { x: 0, y: 0, z: 0 };
    return { p: z, du: z, dv: z, duu: z, duv: z, dvv: z, n: { ...FALLBACK_NORMAL } };
  }

  const invW = 1.0 / w00;

  const sx = A00x * invW, sy = A00y * invW, sz = A00z * invW;
  const sux = (A10x - w10 * sx) * invW;
  const suy = (A10y - w10 * sy) * invW;
  const suz = (A10z - w10 * sz) * invW;
  const svx = (A01x - w01 * sx) * invW;
  const svy = (A01y - w01 * sy) * invW;
  const svz = (A01z - w01 * sz) * invW;
  const suux = (A20x - 2.0 * w10 * sux - w20 * sx) * invW;
  const suuy = (A20y - 2.0 * w10 * suy - w20 * sy) * invW;
  const suuz = (A20z - 2.0 * w10 * suz - w20 * sz) * invW;
  const suvx = (A11x - w10 * svx - w01 * sux - w11 * sx) * invW;
  const suvy = (A11y - w10 * svy - w01 * suy - w11 * sy) * invW;
  const suvz = (A11z - w10 * svz - w01 * suz - w11 * sz) * invW;
  const svvx = (A02x - 2.0 * w01 * svx - w02 * sx) * invW;
  const svvy = (A02y - 2.0 * w01 * svy - w02 * sy) * invW;
  const svvz = (A02z - 2.0 * w01 * svz - w02 * sz) * invW;

  // Normal = normalize(du × dv)
  const nx = suy * svz - suz * svy;
  const ny = suz * svx - sux * svz;
  const nz = sux * svy - suy * svx;
  const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);

  let n;
  if (nLen < NORMAL_ZERO_TOL) {
    n = { ...FALLBACK_NORMAL };
  } else {
    const inv = 1.0 / nLen;
    n = { x: nx * inv, y: ny * inv, z: nz * inv };
  }

  return {
    p: { x: sx, y: sy, z: sz },
    du: { x: sux, y: suy, z: suz },
    dv: { x: svx, y: svy, z: svz },
    duu: { x: suux, y: suuy, z: suuz },
    duv: { x: suvx, y: suvy, z: suvz },
    dvv: { x: svvx, y: svvy, z: svvz },
    n,
  };
}

// ─── WASM-backed evaluators ─────────────────────────────────────────

/**
 * Flatten control points [{x,y,z}, ...] into a Float64Array [x,y,z, x,y,z, ...].
 */
function _flattenCtrlPts(controlPoints) {
  const n = controlPoints.length;
  const arr = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const cp = controlPoints[i];
    arr[i * 3] = cp.x;
    arr[i * 3 + 1] = cp.y;
    arr[i * 3 + 2] = cp.z;
  }
  return arr;
}

/**
 * Evaluate a NURBS curve with derivatives via WASM.
 * Returns null if WASM is unavailable.
 */
function _wasmEvalCurve(curve, t) {
  if (!_wasm) return null;

  const ctrlFlat = _flattenCtrlPts(curve.controlPoints);
  const knotsArr = new Float64Array(curve.knots);
  const weightsArr = new Float64Array(curve.weights);

  _wasm.nurbsCurveDerivEval(
    curve.degree, curve.controlPoints.length,
    ctrlFlat, knotsArr, weightsArr, t
  );

  const ptr = _wasm.getDerivBufPtr();
  const buf = new Float64Array(_wasmMem.buffer, ptr, 9);
  return {
    p: { x: buf[0], y: buf[1], z: buf[2] },
    d1: { x: buf[3], y: buf[4], z: buf[5] },
    d2: { x: buf[6], y: buf[7], z: buf[8] },
  };
}

/**
 * Evaluate a NURBS surface with derivatives via WASM.
 * Returns null if WASM is unavailable.
 */
function _wasmEvalSurface(surface, u, v) {
  if (!_wasm) return null;

  const ctrlFlat = _flattenCtrlPts(surface.controlPoints);
  const knotsU = new Float64Array(surface.knotsU);
  const knotsV = new Float64Array(surface.knotsV);
  const weights = new Float64Array(surface.weights);

  _wasm.nurbsSurfaceDerivEval(
    surface.degreeU, surface.degreeV,
    surface.numRowsU, surface.numColsV,
    ctrlFlat, knotsU, knotsV, weights, u, v
  );

  const ptr = _wasm.getDerivBufPtr();
  const buf = new Float64Array(_wasmMem.buffer, ptr, 21);
  return {
    p: { x: buf[0], y: buf[1], z: buf[2] },
    du: { x: buf[3], y: buf[4], z: buf[5] },
    dv: { x: buf[6], y: buf[7], z: buf[8] },
    duu: { x: buf[9], y: buf[10], z: buf[11] },
    duv: { x: buf[12], y: buf[13], z: buf[14] },
    dvv: { x: buf[15], y: buf[16], z: buf[17] },
    n: { x: buf[18], y: buf[19], z: buf[20] },
  };
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Evaluate a NURBS curve at parameter t with first and second derivatives.
 *
 * Prefers WASM; falls back to pure JS if WASM is unavailable.
 *
 * @param {Object} curve - NurbsCurve instance or compatible plain object
 * @param {number} t - Parameter value
 * @param {Object} [opts] - Options (reserved for future use)
 * @returns {{ p: {x,y,z}, d1: {x,y,z}, d2: {x,y,z} }}
 */
function evalCurve(curve, t, opts) {
  if (_wasm) {
    const result = _wasmEvalCurve(curve, t);
    if (result) return result;
  }
  return _jsEvalCurve(curve, t);
}

/**
 * Evaluate a NURBS surface at (u, v) with first/second partial derivatives and normal.
 *
 * Prefers WASM; falls back to pure JS if WASM is unavailable.
 *
 * @param {Object} surface - NurbsSurface instance or compatible plain object
 * @param {number} u
 * @param {number} v
 * @param {Object} [opts] - Options (reserved for future use)
 * @returns {{ p: {x,y,z}, du: {x,y,z}, dv: {x,y,z},
 *             duu: {x,y,z}, duv: {x,y,z}, dvv: {x,y,z},
 *             n: {x,y,z} }}
 */
function evalSurface(surface, u, v, opts) {
  if (_wasm) {
    const result = _wasmEvalSurface(surface, u, v);
    if (result) return result;
  }
  return _jsEvalSurface(surface, u, v);
}

/**
 * Batch evaluate a NURBS curve with derivatives at multiple parameter values.
 *
 * Returns a Float64Array with stride 9: [px,py,pz, d1x,d1y,d1z, d2x,d2y,d2z, ...].
 * Each entry at offset i*9 corresponds to params[i].
 *
 * Uses WASM batch evaluation when available for better throughput.
 *
 * @param {Object} curve - NurbsCurve instance
 * @param {number[]|Float64Array} params - Array of parameter values
 * @param {Object} [opts] - Options (reserved for future use)
 * @returns {Float64Array} Flat result array with stride 9
 */
function evalCurveBatch(curve, params, opts) {
  const count = params.length;
  const result = new Float64Array(count * 9);

  if (_wasm) {
    const ctrlFlat = _flattenCtrlPts(curve.controlPoints);
    const knotsArr = new Float64Array(curve.knots);
    const weightsArr = new Float64Array(curve.weights);
    const paramsArr = params instanceof Float64Array ? params : new Float64Array(params);

    const n = _wasm.nurbsCurveBatchDerivEval(
      curve.degree, curve.controlPoints.length,
      ctrlFlat, knotsArr, weightsArr,
      paramsArr, count
    );

    if (n > 0) {
      const ptr = _wasm.getBatchBufPtr();
      const buf = new Float64Array(_wasmMem.buffer, ptr, n * 9);
      result.set(buf);
      return result;
    }
  }

  // JS fallback
  for (let i = 0; i < count; i++) {
    const r = _jsEvalCurve(curve, params[i]);
    const off = i * 9;
    result[off] = r.p.x; result[off + 1] = r.p.y; result[off + 2] = r.p.z;
    result[off + 3] = r.d1.x; result[off + 4] = r.d1.y; result[off + 5] = r.d1.z;
    result[off + 6] = r.d2.x; result[off + 7] = r.d2.y; result[off + 8] = r.d2.z;
  }
  return result;
}

/**
 * Batch evaluate a NURBS surface with derivatives at multiple (u,v) pairs.
 *
 * Returns a Float64Array with stride 21:
 *   [px,py,pz, dux,duy,duz, dvx,dvy,dvz,
 *    duux,duuy,duuz, duvx,duvy,duvz, dvvx,dvvy,dvvz,
 *    nx,ny,nz, ...]
 *
 * @param {Object} surface - NurbsSurface instance
 * @param {number[]|Float64Array} params - Interleaved [u0,v0, u1,v1, ...]
 * @param {Object} [opts] - Options (reserved for future use)
 * @returns {Float64Array} Flat result array with stride 21
 */
function evalSurfaceBatch(surface, params, opts) {
  const count = (params.length / 2) | 0;
  const result = new Float64Array(count * 21);

  if (_wasm) {
    const ctrlFlat = _flattenCtrlPts(surface.controlPoints);
    const knotsU = new Float64Array(surface.knotsU);
    const knotsV = new Float64Array(surface.knotsV);
    const weights = new Float64Array(surface.weights);
    const paramsArr = params instanceof Float64Array ? params : new Float64Array(params);

    const n = _wasm.nurbsSurfaceBatchDerivEval(
      surface.degreeU, surface.degreeV,
      surface.numRowsU, surface.numColsV,
      ctrlFlat, knotsU, knotsV, weights,
      paramsArr, count
    );

    if (n > 0) {
      const ptr = _wasm.getBatchBufPtr();
      const buf = new Float64Array(_wasmMem.buffer, ptr, n * 21);
      result.set(buf);
      return result;
    }
  }

  // JS fallback
  for (let i = 0; i < count; i++) {
    const u = params[i * 2];
    const v = params[i * 2 + 1];
    const r = _jsEvalSurface(surface, u, v);
    const off = i * 21;
    result[off] = r.p.x; result[off + 1] = r.p.y; result[off + 2] = r.p.z;
    result[off + 3] = r.du.x; result[off + 4] = r.du.y; result[off + 5] = r.du.z;
    result[off + 6] = r.dv.x; result[off + 7] = r.dv.y; result[off + 8] = r.dv.z;
    result[off + 9] = r.duu.x; result[off + 10] = r.duu.y; result[off + 11] = r.duu.z;
    result[off + 12] = r.duv.x; result[off + 13] = r.duv.y; result[off + 14] = r.duv.z;
    result[off + 15] = r.dvv.x; result[off + 16] = r.dvv.y; result[off + 17] = r.dvv.z;
    result[off + 18] = r.n.x; result[off + 19] = r.n.y; result[off + 20] = r.n.z;
  }
  return result;
}

// ─── Exported module ────────────────────────────────────────────────

export const GeometryEvaluator = {
  initWasm,
  isWasmAvailable,
  evalCurve,
  evalSurface,
  evalCurveBatch,
  evalSurfaceBatch,
  // Expose tolerances for callers that need consistent thresholds
  WEIGHT_ZERO_TOL,
  NORMAL_ZERO_TOL,
  FALLBACK_NORMAL,
  // Exposed for parity testing — force a specific backend
  _jsEvalCurve,
  _jsEvalSurface,
  _wasmEvalCurve,
  _wasmEvalSurface,
};
