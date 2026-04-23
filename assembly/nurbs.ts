// assembly/nurbs.ts — NURBS curve and surface evaluation for WebAssembly
//
// High-performance NURBS evaluation using typed arrays and direct memory access.
// Implements Cox-de Boor B-spline basis functions, NURBS curve evaluation,
// NURBS surface evaluation, and surface normal computation.
//
// Data flow: JS writes inputs to WASM memory via __lowerTypedArray, WASM writes
// outputs to pre-allocated internal buffers, JS reads outputs via exported pointers.

// ─── Internal scratch buffers ────────────────────────────────────────

// Pre-allocated scratch arrays for basis function computation.
// Max supported degree = 15 (more than enough for CAD; typical is 2-3).
const MAX_DEGREE: i32 = 15;
const basisN: StaticArray<f64> = new StaticArray<f64>(MAX_DEGREE + 1);
const basisLeft: StaticArray<f64> = new StaticArray<f64>(MAX_DEGREE + 1);
const basisRight: StaticArray<f64> = new StaticArray<f64>(MAX_DEGREE + 1);

// Scratch arrays for basis function derivative computation (Algorithm A2.3).
const _ndu: StaticArray<f64> = new StaticArray<f64>((MAX_DEGREE + 1) * (MAX_DEGREE + 1));
const _a: StaticArray<f64> = new StaticArray<f64>(2 * (MAX_DEGREE + 1));
// Derivative output for u- and v-directions: up to 2nd derivative × (degree+1)
const _dersU: StaticArray<f64> = new StaticArray<f64>(3 * (MAX_DEGREE + 1));
const _dersV: StaticArray<f64> = new StaticArray<f64>(3 * (MAX_DEGREE + 1));

// ─── Output buffers ──────────────────────────────────────────────────
// Pre-allocated output buffers in WASM memory. JS reads from these via pointers.

// Small result buffer for single-point evaluations: [x, y, z, nx, ny, nz]
const resultBuf: StaticArray<f64> = new StaticArray<f64>(6);

// Derivative result buffer for single-point derivative evaluations:
//   curve:   [px,py,pz, d1x,d1y,d1z, d2x,d2y,d2z] = 9 f64
//   surface: [px,py,pz, dux,duy,duz, dvx,dvy,dvz,
//             duux,duuy,duuz, duvx,duvy,duvz, dvvx,dvvy,dvvz,
//             nx,ny,nz] = 21 f64
const derivBuf: StaticArray<f64> = new StaticArray<f64>(21);

// Dynamic batch output buffer — allocated on demand by batch functions.
let batchBuf: StaticArray<f64> | null = null;
let batchBufLen: i32 = 0;

// Large output buffer for tessellation results.
// Max capacity: 128×128 grid = 16384 verts × 3 = 49152 f64 for verts,
// same for normals, plus 128×128×2×3 = 98304 indices (as u32).
// Total allocation: 256K f64 ≈ 2 MB — allocated on demand.
const MAX_TESS_VERTS: i32 = 16641;   // (128+1)² = 16641
const MAX_TESS_TRIS: i32 = 32768;    // 128×128×2 = 32768

const tessVertsOut: StaticArray<f64> = new StaticArray<f64>(MAX_TESS_VERTS * 3);
const tessNormalsOut: StaticArray<f64> = new StaticArray<f64>(MAX_TESS_VERTS * 3);
const tessFacesOut: StaticArray<u32> = new StaticArray<u32>(MAX_TESS_TRIS * 3);

  // Curve output buffer: max 1024 segments + 1 points × 3 = 3075 f64
const MAX_CURVE_SEGS: i32 = 1024;
const MAX_CURVE_PTS: i32 = MAX_CURVE_SEGS + 1;
const curvePtsOut: StaticArray<f64> = new StaticArray<f64>(MAX_CURVE_PTS * 3);

/** Get pointer to the 6-element result buffer (for single-point evaluations). */
export function getResultPtr(): usize {
  return changetype<usize>(resultBuf);
}

/** Get pointer to the tessellation vertex output buffer. */
export function getTessVertsPtr(): usize {
  return changetype<usize>(tessVertsOut);
}

/** Get pointer to the tessellation normals output buffer. */
export function getTessNormalsPtr(): usize {
  return changetype<usize>(tessNormalsOut);
}

/** Get pointer to the tessellation faces (indices) output buffer. */
export function getTessFacesPtr(): usize {
  return changetype<usize>(tessFacesOut);
}

/** Get pointer to the curve points output buffer. */
export function getCurvePtsPtr(): usize {
  return changetype<usize>(curvePtsOut);
}

/** Get pointer to the 21-element derivative result buffer. */
export function getDerivBufPtr(): usize {
  return changetype<usize>(derivBuf);
}

/** Get pointer to the dynamically-allocated batch output buffer. */
export function getBatchBufPtr(): usize {
  return batchBuf ? changetype<usize>(batchBuf!) : 0;
}

/** Get the current batch buffer length (number of f64 elements). */
export function getBatchBufLen(): i32 {
  return batchBufLen;
}

/** Get the maximum tessellation segments per direction (buffer limit). */
export function getMaxTessSegs(): i32 {
  return 128;
}

/** Get the maximum curve tessellation segments (buffer limit). */
export function getMaxCurveSegs(): i32 {
  return MAX_CURVE_SEGS;
}

/** Ensure the batch buffer has at least `minLen` f64 capacity. */
function ensureBatchBuf(minLen: i32): void {
  if (batchBuf === null || batchBufLen < minLen) {
    batchBuf = new StaticArray<f64>(minLen);
    batchBufLen = minLen;
  }
}

// ─── B-spline basis functions (Cox-de Boor) ──────────────────────────

/**
 * Find the knot span index for parameter t.
 * Returns i such that knots[i] <= t < knots[i+1].
 */
function findSpan(t: f64, degree: i32, nCtrl: i32, knots: Float64Array, kOff: i32): i32 {
  const n: i32 = nCtrl - 1;
  if (t >= unchecked(knots[kOff + n + 1])) return n;

  let low: i32 = degree;
  let high: i32 = n + 1;
  let mid: i32 = (low + high) >> 1;

  while (t < unchecked(knots[kOff + mid]) || t >= unchecked(knots[kOff + mid + 1])) {
    if (t < unchecked(knots[kOff + mid])) {
      high = mid;
    } else {
      low = mid;
    }
    mid = (low + high) >> 1;
  }
  return mid;
}

/**
 * Compute the non-vanishing B-spline basis functions at parameter t.
 * Result stored in global basisN[] array, indices [0..degree].
 * Uses Piegl & Tiller's Algorithm A2.2 (The NURBS Book).
 */
function computeBasis(span: i32, t: f64, degree: i32, knots: Float64Array, kOff: i32): void {
  unchecked(basisN[0] = 1.0);

  for (let j: i32 = 1; j <= degree; j++) {
    unchecked(basisLeft[j] = t - knots[kOff + span + 1 - j]);
    unchecked(basisRight[j] = knots[kOff + span + j] - t);
    let saved: f64 = 0.0;

    for (let r: i32 = 0; r < j; r++) {
      const denom: f64 = unchecked(basisRight[r + 1]) + unchecked(basisLeft[j - r]);
      if (abs<f64>(denom) < 1e-14) {
        unchecked(basisN[r] = saved);
        saved = 0.0;
      } else {
        const temp: f64 = unchecked(basisN[r]) / denom;
        unchecked(basisN[r] = saved + unchecked(basisRight[r + 1]) * temp);
        saved = unchecked(basisLeft[j - r]) * temp;
      }
    }
    unchecked(basisN[j] = saved);
  }
}

/**
 * Compute B-spline basis functions and their derivatives up to order nDerivs.
 * Implements Piegl & Tiller Algorithm A2.3 (The NURBS Book).
 *
 * Output: dersOut[k * (degree+1) + j] = d^k/du^k N_{span-degree+j, degree}(u)
 * for k = 0..nDerivs, j = 0..degree.
 *
 * The left/right scratch arrays are passed explicitly so that u- and v-direction
 * computations can use separate scratch space.
 */
function computeBasisDerivs(
  span: i32, u: f64, degree: i32,
  knots: Float64Array, kOff: i32,
  nDerivs: i32,
  left: StaticArray<f64>, right: StaticArray<f64>,
  dersOut: StaticArray<f64>
): void {
  const p: i32 = degree;
  const P1: i32 = p + 1;

  // Step 1: Build ndu table
  // ndu[r * P1 + j] — upper triangle stores basis values, lower triangle stores knot diffs
  unchecked(_ndu[0] = 1.0);

  for (let j: i32 = 1; j <= p; j++) {
    unchecked(left[j] = u - knots[kOff + span + 1 - j]);
    unchecked(right[j] = knots[kOff + span + j] - u);
    let saved: f64 = 0.0;

    for (let r: i32 = 0; r < j; r++) {
      // Lower triangle: ndu[j][r] = knot difference
      const denom: f64 = unchecked(right[r + 1]) + unchecked(left[j - r]);
      unchecked(_ndu[j * P1 + r] = denom);

      let temp: f64;
      if (abs<f64>(denom) < 1e-14) {
        temp = 0.0;
      } else {
        temp = unchecked(_ndu[r * P1 + (j - 1)]) / denom;
      }

      // Upper triangle: ndu[r][j] = basis function value
      unchecked(_ndu[r * P1 + j] = saved + unchecked(right[r + 1]) * temp);
      saved = unchecked(left[j - r]) * temp;
    }
    unchecked(_ndu[j * P1 + j] = saved);
  }

  // Step 2: Load 0th-derivative values (basis functions) from row of ndu
  for (let j: i32 = 0; j <= p; j++) {
    unchecked(dersOut[j] = _ndu[j * P1 + p]);
  }

  // Step 3: Compute higher derivatives using the a[][] alternating rows
  for (let r: i32 = 0; r <= p; r++) {
    let s1: i32 = 0, s2: i32 = 1;
    unchecked(_a[0] = 1.0);

    for (let k: i32 = 1; k <= nDerivs; k++) {
      let d: f64 = 0.0;
      const rk: i32 = r - k;
      const pk: i32 = p - k;

      if (r >= k) {
        const denom: f64 = unchecked(_ndu[(pk + 1) * P1 + rk]);
        if (abs<f64>(denom) < 1e-14) {
          unchecked(_a[s2 * P1 + 0] = 0.0);
        } else {
          unchecked(_a[s2 * P1 + 0] = unchecked(_a[s1 * P1 + 0]) / denom);
        }
        d = unchecked(_a[s2 * P1 + 0]) * unchecked(_ndu[rk * P1 + pk]);
      }

      const j1: i32 = rk >= -1 ? 1 : -rk;
      const j2: i32 = (r - 1) <= pk ? k - 1 : p - r;

      for (let j: i32 = j1; j <= j2; j++) {
        const denom: f64 = unchecked(_ndu[(pk + 1) * P1 + (rk + j)]);
        if (abs<f64>(denom) < 1e-14) {
          unchecked(_a[s2 * P1 + j] = 0.0);
        } else {
          unchecked(_a[s2 * P1 + j] = (unchecked(_a[s1 * P1 + j]) - unchecked(_a[s1 * P1 + (j - 1)])) / denom);
        }
        d += unchecked(_a[s2 * P1 + j]) * unchecked(_ndu[(rk + j) * P1 + pk]);
      }

      if (r <= pk) {
        const denom: f64 = unchecked(_ndu[(pk + 1) * P1 + r]);
        if (abs<f64>(denom) < 1e-14) {
          unchecked(_a[s2 * P1 + k] = 0.0);
        } else {
          unchecked(_a[s2 * P1 + k] = -unchecked(_a[s1 * P1 + (k - 1)]) / denom);
        }
        d += unchecked(_a[s2 * P1 + k]) * unchecked(_ndu[r * P1 + pk]);
      }

      unchecked(dersOut[k * P1 + r] = d);

      // Swap alternating rows
      const tmp: i32 = s1; s1 = s2; s2 = tmp;
    }
  }

  // Step 4: Multiply by correct factors: p! / (p-k)!
  let fac: f64 = <f64>p;
  for (let k: i32 = 1; k <= nDerivs; k++) {
    for (let j: i32 = 0; j <= p; j++) {
      unchecked(dersOut[k * P1 + j] *= fac);
    }
    fac *= <f64>(p - k);
  }
}

// ─── NURBS Curve Evaluation ──────────────────────────────────────────

/**
 * Evaluate a NURBS curve at parameter t.
 * Result stored in resultBuf[0..2] = {x, y, z}.
 */
export function nurbsCurveEvaluate(
  degree: i32,
  nCtrl: i32,
  ctrlPts: Float64Array,
  knots: Float64Array,
  weights: Float64Array,
  t: f64
): void {
  const tMin: f64 = unchecked(knots[degree]);
  const tMax: f64 = unchecked(knots[nCtrl]);
  t = max<f64>(tMin, min<f64>(tMax, t));

  const span: i32 = findSpan(t, degree, nCtrl, knots, 0);
  computeBasis(span, t, degree, knots, 0);

  let wx: f64 = 0, wy: f64 = 0, wz: f64 = 0, wSum: f64 = 0;
  for (let i: i32 = 0; i <= degree; i++) {
    const idx: i32 = span - degree + i;
    const ci: i32 = idx * 3;
    const w: f64 = unchecked(weights[idx]);
    const Nw: f64 = unchecked(basisN[i]) * w;
    wx += Nw * unchecked(ctrlPts[ci]);
    wy += Nw * unchecked(ctrlPts[ci + 1]);
    wz += Nw * unchecked(ctrlPts[ci + 2]);
    wSum += Nw;
  }

  if (abs<f64>(wSum) < 1e-14) {
    unchecked(resultBuf[0] = 0);
    unchecked(resultBuf[1] = 0);
    unchecked(resultBuf[2] = 0);
  } else {
    const invW: f64 = 1.0 / wSum;
    unchecked(resultBuf[0] = wx * invW);
    unchecked(resultBuf[1] = wy * invW);
    unchecked(resultBuf[2] = wz * invW);
  }
}

/**
 * Internal curve evaluation that writes to resultBuf (same as nurbsCurveEvaluate
 * but takes raw typed arrays that are already in WASM memory).
 */
function _evalCurve(
  degree: i32, nCtrl: i32,
  ctrlPts: Float64Array, knots: Float64Array, weights: Float64Array,
  t: f64
): void {
  const tMin: f64 = unchecked(knots[degree]);
  const tMax: f64 = unchecked(knots[nCtrl]);
  t = max<f64>(tMin, min<f64>(tMax, t));

  const span: i32 = findSpan(t, degree, nCtrl, knots, 0);
  computeBasis(span, t, degree, knots, 0);

  let wx: f64 = 0, wy: f64 = 0, wz: f64 = 0, wSum: f64 = 0;
  for (let i: i32 = 0; i <= degree; i++) {
    const idx: i32 = span - degree + i;
    const ci: i32 = idx * 3;
    const w: f64 = unchecked(weights[idx]);
    const Nw: f64 = unchecked(basisN[i]) * w;
    wx += Nw * unchecked(ctrlPts[ci]);
    wy += Nw * unchecked(ctrlPts[ci + 1]);
    wz += Nw * unchecked(ctrlPts[ci + 2]);
    wSum += Nw;
  }

  if (abs<f64>(wSum) < 1e-14) {
    unchecked(resultBuf[0] = 0);
    unchecked(resultBuf[1] = 0);
    unchecked(resultBuf[2] = 0);
  } else {
    const invW: f64 = 1.0 / wSum;
    unchecked(resultBuf[0] = wx * invW);
    unchecked(resultBuf[1] = wy * invW);
    unchecked(resultBuf[2] = wz * invW);
  }
}

/**
 * Tessellate a NURBS curve into a polyline.
 * Output written to curvePtsOut buffer. Read via getCurvePtsPtr().
 * Returns -1 if the requested segments exceed the static buffer capacity (1024).
 * @returns number of points written (segments + 1), or -1 if buffer exceeded
 */
export function nurbsCurveTessellate(
  degree: i32,
  nCtrl: i32,
  ctrlPts: Float64Array,
  knots: Float64Array,
  weights: Float64Array,
  segments: i32
): i32 {
  // Return error instead of silently clamping
  if (segments > MAX_CURVE_SEGS) return -1;

  const tMin: f64 = unchecked(knots[degree]);
  const tMax: f64 = unchecked(knots[nCtrl]);
  const range: f64 = tMax - tMin;
  const nPts: i32 = segments + 1;

  for (let i: i32 = 0; i < nPts; i++) {
    const frac: f64 = <f64>i / <f64>segments;
    const t: f64 = tMin + frac * range;

    _evalCurve(degree, nCtrl, ctrlPts, knots, weights, t);

    const oi: i32 = i * 3;
    unchecked(curvePtsOut[oi] = resultBuf[0]);
    unchecked(curvePtsOut[oi + 1] = resultBuf[1]);
    unchecked(curvePtsOut[oi + 2] = resultBuf[2]);
  }

  return nPts;
}

/**
 * Evaluate a NURBS curve at parameter t with first and second derivatives.
 * Uses analytical basis function derivatives (Algorithm A2.3).
 *
 * Result stored in derivBuf:
 *   [0..2] = point {x, y, z}
 *   [3..5] = first derivative {d1x, d1y, d1z}
 *   [6..8] = second derivative {d2x, d2y, d2z}
 *
 * For rational curves C(t) = A(t)/w(t):
 *   C'  = (A' - w'·C) / w
 *   C'' = (A'' - 2·w'·C' - w''·C) / w
 */
export function nurbsCurveDerivEval(
  degree: i32,
  nCtrl: i32,
  ctrlPts: Float64Array,
  knots: Float64Array,
  weights: Float64Array,
  t: f64
): void {
  const tMin: f64 = unchecked(knots[degree]);
  const tMax: f64 = unchecked(knots[nCtrl]);
  t = max<f64>(tMin, min<f64>(tMax, t));

  const span: i32 = findSpan(t, degree, nCtrl, knots, 0);
  computeBasisDerivs(span, t, degree, knots, 0, 2, basisLeft, basisRight, _dersU);

  const P1: i32 = degree + 1;

  // Accumulate weighted sums for derivative orders 0, 1, 2
  let Ax: f64 = 0, Ay: f64 = 0, Az: f64 = 0, w0: f64 = 0;
  let A1x: f64 = 0, A1y: f64 = 0, A1z: f64 = 0, w1: f64 = 0;
  let A2x: f64 = 0, A2y: f64 = 0, A2z: f64 = 0, w2: f64 = 0;

  for (let i: i32 = 0; i <= degree; i++) {
    const idx: i32 = span - degree + i;
    const ci: i32 = idx * 3;
    const w: f64 = unchecked(weights[idx]);
    const px: f64 = unchecked(ctrlPts[ci]);
    const py: f64 = unchecked(ctrlPts[ci + 1]);
    const pz: f64 = unchecked(ctrlPts[ci + 2]);

    const N0: f64 = unchecked(_dersU[i]) * w;
    Ax += N0 * px; Ay += N0 * py; Az += N0 * pz; w0 += N0;

    const N1: f64 = unchecked(_dersU[P1 + i]) * w;
    A1x += N1 * px; A1y += N1 * py; A1z += N1 * pz; w1 += N1;

    const N2: f64 = unchecked(_dersU[2 * P1 + i]) * w;
    A2x += N2 * px; A2y += N2 * py; A2z += N2 * pz; w2 += N2;
  }

  if (abs<f64>(w0) < 1e-14) {
    for (let k: i32 = 0; k < 9; k++) unchecked(derivBuf[k] = 0);
    return;
  }

  const invW: f64 = 1.0 / w0;

  // C(t) = A(t) / w(t)
  const cx: f64 = Ax * invW;
  const cy: f64 = Ay * invW;
  const cz: f64 = Az * invW;

  // C'(t) = (A' - w'·C) / w
  const d1x: f64 = (A1x - w1 * cx) * invW;
  const d1y: f64 = (A1y - w1 * cy) * invW;
  const d1z: f64 = (A1z - w1 * cz) * invW;

  // C''(t) = (A'' - 2·w'·C' - w''·C) / w
  const d2x: f64 = (A2x - 2.0 * w1 * d1x - w2 * cx) * invW;
  const d2y: f64 = (A2y - 2.0 * w1 * d1y - w2 * cy) * invW;
  const d2z: f64 = (A2z - 2.0 * w1 * d1z - w2 * cz) * invW;

  unchecked(derivBuf[0] = cx);
  unchecked(derivBuf[1] = cy);
  unchecked(derivBuf[2] = cz);
  unchecked(derivBuf[3] = d1x);
  unchecked(derivBuf[4] = d1y);
  unchecked(derivBuf[5] = d1z);
  unchecked(derivBuf[6] = d2x);
  unchecked(derivBuf[7] = d2y);
  unchecked(derivBuf[8] = d2z);
}

/**
 * Batch evaluate a NURBS curve with derivatives at multiple parameter values.
 * Output written to dynamic batch buffer: batchBuf[i*9 + 0..8].
 * Read via getBatchBufPtr().
 *
 * @param params - Float64Array of t values (length >= count)
 * @param count - number of parameter values to evaluate
 * @returns count on success
 */
export function nurbsCurveBatchDerivEval(
  degree: i32, nCtrl: i32,
  ctrlPts: Float64Array, knots: Float64Array, weights: Float64Array,
  params: Float64Array, count: i32
): i32 {
  ensureBatchBuf(count * 9);

  for (let k: i32 = 0; k < count; k++) {
    const t: f64 = unchecked(params[k]);
    nurbsCurveDerivEval(degree, nCtrl, ctrlPts, knots, weights, t);
    const off: i32 = k * 9;
    for (let j: i32 = 0; j < 9; j++) {
      unchecked(batchBuf![off + j] = derivBuf[j]);
    }
  }

  return count;
}

// ─── NURBS Surface Evaluation ────────────────────────────────────────

// Second set of basis scratch arrays for v-direction
const basisNv: StaticArray<f64> = new StaticArray<f64>(MAX_DEGREE + 1);
const basisLeftV: StaticArray<f64> = new StaticArray<f64>(MAX_DEGREE + 1);
const basisRightV: StaticArray<f64> = new StaticArray<f64>(MAX_DEGREE + 1);

function computeBasisV(span: i32, t: f64, degree: i32, knots: Float64Array, kOff: i32): void {
  unchecked(basisNv[0] = 1.0);

  for (let j: i32 = 1; j <= degree; j++) {
    unchecked(basisLeftV[j] = t - knots[kOff + span + 1 - j]);
    unchecked(basisRightV[j] = knots[kOff + span + j] - t);
    let saved: f64 = 0.0;

    for (let r: i32 = 0; r < j; r++) {
      const denom: f64 = unchecked(basisRightV[r + 1]) + unchecked(basisLeftV[j - r]);
      if (abs<f64>(denom) < 1e-14) {
        unchecked(basisNv[r] = saved);
        saved = 0.0;
      } else {
        const temp: f64 = unchecked(basisNv[r]) / denom;
        unchecked(basisNv[r] = saved + unchecked(basisRightV[r + 1]) * temp);
        saved = unchecked(basisLeftV[j - r]) * temp;
      }
    }
    unchecked(basisNv[j] = saved);
  }
}

/**
 * Evaluate a NURBS surface at parameters (u, v).
 * Result stored in resultBuf[0..2] = {x, y, z}.
 */
export function nurbsSurfaceEvaluate(
  degU: i32, degV: i32,
  nRowsU: i32, nColsV: i32,
  ctrlPts: Float64Array,
  knotsU: Float64Array, knotsV: Float64Array,
  weights: Float64Array,
  u: f64, v: f64
): void {
  const uMin: f64 = unchecked(knotsU[degU]);
  const uMax: f64 = unchecked(knotsU[nRowsU]);
  const vMin: f64 = unchecked(knotsV[degV]);
  const vMax: f64 = unchecked(knotsV[nColsV]);
  u = max<f64>(uMin, min<f64>(uMax, u));
  v = max<f64>(vMin, min<f64>(vMax, v));

  const spanU: i32 = findSpan(u, degU, nRowsU, knotsU, 0);
  const spanV: i32 = findSpan(v, degV, nColsV, knotsV, 0);
  computeBasis(spanU, u, degU, knotsU, 0);
  computeBasisV(spanV, v, degV, knotsV, 0);

  let wx: f64 = 0, wy: f64 = 0, wz: f64 = 0, wSum: f64 = 0;

  for (let i: i32 = 0; i <= degU; i++) {
    const rowIdx: i32 = spanU - degU + i;
    const Nu: f64 = unchecked(basisN[i]);
    for (let j: i32 = 0; j <= degV; j++) {
      const colIdx: i32 = spanV - degV + j;
      const cpIdx: i32 = rowIdx * nColsV + colIdx;
      const ci: i32 = cpIdx * 3;
      const w: f64 = unchecked(weights[cpIdx]);
      const basis: f64 = Nu * unchecked(basisNv[j]) * w;

      wx += basis * unchecked(ctrlPts[ci]);
      wy += basis * unchecked(ctrlPts[ci + 1]);
      wz += basis * unchecked(ctrlPts[ci + 2]);
      wSum += basis;
    }
  }

  if (abs<f64>(wSum) < 1e-14) {
    unchecked(resultBuf[0] = 0);
    unchecked(resultBuf[1] = 0);
    unchecked(resultBuf[2] = 0);
  } else {
    const invW: f64 = 1.0 / wSum;
    unchecked(resultBuf[0] = wx * invW);
    unchecked(resultBuf[1] = wy * invW);
    unchecked(resultBuf[2] = wz * invW);
  }
}

/** Internal surface evaluate helper. */
function _evalSurf(
  degU: i32, degV: i32, nRowsU: i32, nColsV: i32,
  ctrlPts: Float64Array, knotsU: Float64Array, knotsV: Float64Array,
  weights: Float64Array, u: f64, v: f64
): void {
  const uMin: f64 = unchecked(knotsU[degU]);
  const uMax: f64 = unchecked(knotsU[nRowsU]);
  const vMin: f64 = unchecked(knotsV[degV]);
  const vMax: f64 = unchecked(knotsV[nColsV]);
  u = max<f64>(uMin, min<f64>(uMax, u));
  v = max<f64>(vMin, min<f64>(vMax, v));

  const spanU: i32 = findSpan(u, degU, nRowsU, knotsU, 0);
  const spanV: i32 = findSpan(v, degV, nColsV, knotsV, 0);
  computeBasis(spanU, u, degU, knotsU, 0);
  computeBasisV(spanV, v, degV, knotsV, 0);

  let wx: f64 = 0, wy: f64 = 0, wz: f64 = 0, wSum: f64 = 0;
  for (let i: i32 = 0; i <= degU; i++) {
    const rowIdx: i32 = spanU - degU + i;
    const Nu: f64 = unchecked(basisN[i]);
    for (let j: i32 = 0; j <= degV; j++) {
      const colIdx: i32 = spanV - degV + j;
      const cpIdx: i32 = rowIdx * nColsV + colIdx;
      const ci: i32 = cpIdx * 3;
      const w: f64 = unchecked(weights[cpIdx]);
      const basis: f64 = Nu * unchecked(basisNv[j]) * w;
      wx += basis * unchecked(ctrlPts[ci]);
      wy += basis * unchecked(ctrlPts[ci + 1]);
      wz += basis * unchecked(ctrlPts[ci + 2]);
      wSum += basis;
    }
  }

  if (abs<f64>(wSum) < 1e-14) {
    unchecked(resultBuf[0] = 0);
    unchecked(resultBuf[1] = 0);
    unchecked(resultBuf[2] = 0);
  } else {
    const invW: f64 = 1.0 / wSum;
    unchecked(resultBuf[0] = wx * invW);
    unchecked(resultBuf[1] = wy * invW);
    unchecked(resultBuf[2] = wz * invW);
  }
}

/**
 * Compute surface normal at (u, v) via analytical basis function derivatives.
 * Result: resultBuf[0..2] = point {x,y,z}, resultBuf[3..5] = normal {nx,ny,nz}.
 *
 * This replaces the former finite-difference implementation with exact
 * derivative-based normals: n = normalize(∂S/∂u × ∂S/∂v).
 * Falls back to z-up in degenerate cases (zero cross product).
 */
export function nurbsSurfaceNormal(
  degU: i32, degV: i32,
  nRowsU: i32, nColsV: i32,
  ctrlPts: Float64Array,
  knotsU: Float64Array, knotsV: Float64Array,
  weights: Float64Array,
  u: f64, v: f64
): void {
  // Delegate to the full derivative evaluator
  nurbsSurfaceDerivEval(degU, degV, nRowsU, nColsV, ctrlPts, knotsU, knotsV, weights, u, v);
  // Copy point and normal to resultBuf for backward compatibility
  unchecked(resultBuf[0] = derivBuf[0]);
  unchecked(resultBuf[1] = derivBuf[1]);
  unchecked(resultBuf[2] = derivBuf[2]);
  unchecked(resultBuf[3] = derivBuf[18]);
  unchecked(resultBuf[4] = derivBuf[19]);
  unchecked(resultBuf[5] = derivBuf[20]);
}

/**
 * Evaluate a NURBS surface at (u, v) with first and second partial derivatives.
 * Uses analytical basis function derivatives (Algorithm A2.3 tensor product).
 *
 * Result stored in derivBuf:
 *   [0..2]   = point S(u,v)
 *   [3..5]   = ∂S/∂u
 *   [6..8]   = ∂S/∂v
 *   [9..11]  = ∂²S/∂u²
 *   [12..14] = ∂²S/∂u∂v
 *   [15..17] = ∂²S/∂v²
 *   [18..20] = unit normal n = normalize(∂S/∂u × ∂S/∂v)
 *
 * Rational surface derivative formulas:
 *   S    = A^{00} / w^{00}
 *   S_u  = (A^{10} - w^{10}·S) / w^{00}
 *   S_v  = (A^{01} - w^{01}·S) / w^{00}
 *   S_uu = (A^{20} - 2·w^{10}·S_u - w^{20}·S) / w^{00}
 *   S_uv = (A^{11} - w^{10}·S_v - w^{01}·S_u - w^{11}·S) / w^{00}
 *   S_vv = (A^{02} - 2·w^{01}·S_v - w^{02}·S) / w^{00}
 */
export function nurbsSurfaceDerivEval(
  degU: i32, degV: i32,
  nRowsU: i32, nColsV: i32,
  ctrlPts: Float64Array,
  knotsU: Float64Array, knotsV: Float64Array,
  weights: Float64Array,
  u: f64, v: f64
): void {
  const uMin: f64 = unchecked(knotsU[degU]);
  const uMax: f64 = unchecked(knotsU[nRowsU]);
  const vMin: f64 = unchecked(knotsV[degV]);
  const vMax: f64 = unchecked(knotsV[nColsV]);
  u = max<f64>(uMin, min<f64>(uMax, u));
  v = max<f64>(vMin, min<f64>(vMax, v));

  const spanU: i32 = findSpan(u, degU, nRowsU, knotsU, 0);
  computeBasisDerivs(spanU, u, degU, knotsU, 0, 2, basisLeft, basisRight, _dersU);

  const spanV: i32 = findSpan(v, degV, nColsV, knotsV, 0);
  computeBasisDerivs(spanV, v, degV, knotsV, 0, 2, basisLeftV, basisRightV, _dersV);

  const PU1: i32 = degU + 1;
  const PV1: i32 = degV + 1;

  // Accumulate tensor product sums A^{(k,l)} and w^{(k,l)}
  let A00x: f64 = 0, A00y: f64 = 0, A00z: f64 = 0, w00: f64 = 0;
  let A10x: f64 = 0, A10y: f64 = 0, A10z: f64 = 0, w10: f64 = 0;
  let A01x: f64 = 0, A01y: f64 = 0, A01z: f64 = 0, w01: f64 = 0;
  let A20x: f64 = 0, A20y: f64 = 0, A20z: f64 = 0, w20: f64 = 0;
  let A11x: f64 = 0, A11y: f64 = 0, A11z: f64 = 0, w11: f64 = 0;
  let A02x: f64 = 0, A02y: f64 = 0, A02z: f64 = 0, w02: f64 = 0;

  for (let i: i32 = 0; i <= degU; i++) {
    const rowIdx: i32 = spanU - degU + i;
    const Nu0: f64 = unchecked(_dersU[i]);
    const Nu1: f64 = unchecked(_dersU[PU1 + i]);
    const Nu2: f64 = unchecked(_dersU[2 * PU1 + i]);

    for (let j: i32 = 0; j <= degV; j++) {
      const colIdx: i32 = spanV - degV + j;
      const cpIdx: i32 = rowIdx * nColsV + colIdx;
      const ci: i32 = cpIdx * 3;
      const w: f64 = unchecked(weights[cpIdx]);
      const px: f64 = unchecked(ctrlPts[ci]);
      const py: f64 = unchecked(ctrlPts[ci + 1]);
      const pz: f64 = unchecked(ctrlPts[ci + 2]);

      const Nv0: f64 = unchecked(_dersV[j]);
      const Nv1: f64 = unchecked(_dersV[PV1 + j]);
      const Nv2: f64 = unchecked(_dersV[2 * PV1 + j]);

      const b00: f64 = Nu0 * Nv0 * w;
      A00x += b00 * px; A00y += b00 * py; A00z += b00 * pz; w00 += b00;

      const b10: f64 = Nu1 * Nv0 * w;
      A10x += b10 * px; A10y += b10 * py; A10z += b10 * pz; w10 += b10;

      const b01: f64 = Nu0 * Nv1 * w;
      A01x += b01 * px; A01y += b01 * py; A01z += b01 * pz; w01 += b01;

      const b20: f64 = Nu2 * Nv0 * w;
      A20x += b20 * px; A20y += b20 * py; A20z += b20 * pz; w20 += b20;

      const b11: f64 = Nu1 * Nv1 * w;
      A11x += b11 * px; A11y += b11 * py; A11z += b11 * pz; w11 += b11;

      const b02: f64 = Nu0 * Nv2 * w;
      A02x += b02 * px; A02y += b02 * py; A02z += b02 * pz; w02 += b02;
    }
  }

  if (abs<f64>(w00) < 1e-14) {
    for (let k: i32 = 0; k < 21; k++) unchecked(derivBuf[k] = 0);
    unchecked(derivBuf[20] = 1.0); // fallback normal z=1
    return;
  }

  const invW: f64 = 1.0 / w00;

  // S(u,v) = A^{00} / w^{00}
  const sx: f64 = A00x * invW;
  const sy: f64 = A00y * invW;
  const sz: f64 = A00z * invW;

  // S_u = (A^{10} - w^{10}·S) / w^{00}
  const sux: f64 = (A10x - w10 * sx) * invW;
  const suy: f64 = (A10y - w10 * sy) * invW;
  const suz: f64 = (A10z - w10 * sz) * invW;

  // S_v = (A^{01} - w^{01}·S) / w^{00}
  const svx: f64 = (A01x - w01 * sx) * invW;
  const svy: f64 = (A01y - w01 * sy) * invW;
  const svz: f64 = (A01z - w01 * sz) * invW;

  // S_uu = (A^{20} - 2·w^{10}·S_u - w^{20}·S) / w^{00}
  const suux: f64 = (A20x - 2.0 * w10 * sux - w20 * sx) * invW;
  const suuy: f64 = (A20y - 2.0 * w10 * suy - w20 * sy) * invW;
  const suuz: f64 = (A20z - 2.0 * w10 * suz - w20 * sz) * invW;

  // S_uv = (A^{11} - w^{10}·S_v - w^{01}·S_u - w^{11}·S) / w^{00}
  const suvx: f64 = (A11x - w10 * svx - w01 * sux - w11 * sx) * invW;
  const suvy: f64 = (A11y - w10 * svy - w01 * suy - w11 * sy) * invW;
  const suvz: f64 = (A11z - w10 * svz - w01 * suz - w11 * sz) * invW;

  // S_vv = (A^{02} - 2·w^{01}·S_v - w^{02}·S) / w^{00}
  const svvx: f64 = (A02x - 2.0 * w01 * svx - w02 * sx) * invW;
  const svvy: f64 = (A02y - 2.0 * w01 * svy - w02 * sy) * invW;
  const svvz: f64 = (A02z - 2.0 * w01 * svz - w02 * sz) * invW;

  // Normal = normalize(S_u × S_v)
  const nx: f64 = suy * svz - suz * svy;
  const ny: f64 = suz * svx - sux * svz;
  const nz: f64 = sux * svy - suy * svx;
  const nLen: f64 = sqrt(nx * nx + ny * ny + nz * nz);

  unchecked(derivBuf[0] = sx);
  unchecked(derivBuf[1] = sy);
  unchecked(derivBuf[2] = sz);
  unchecked(derivBuf[3] = sux);
  unchecked(derivBuf[4] = suy);
  unchecked(derivBuf[5] = suz);
  unchecked(derivBuf[6] = svx);
  unchecked(derivBuf[7] = svy);
  unchecked(derivBuf[8] = svz);
  unchecked(derivBuf[9] = suux);
  unchecked(derivBuf[10] = suuy);
  unchecked(derivBuf[11] = suuz);
  unchecked(derivBuf[12] = suvx);
  unchecked(derivBuf[13] = suvy);
  unchecked(derivBuf[14] = suvz);
  unchecked(derivBuf[15] = svvx);
  unchecked(derivBuf[16] = svvy);
  unchecked(derivBuf[17] = svvz);

  if (nLen < 1e-14) {
    unchecked(derivBuf[18] = 0);
    unchecked(derivBuf[19] = 0);
    unchecked(derivBuf[20] = 1);
  } else {
    const invNLen: f64 = 1.0 / nLen;
    unchecked(derivBuf[18] = nx * invNLen);
    unchecked(derivBuf[19] = ny * invNLen);
    unchecked(derivBuf[20] = nz * invNLen);
  }
}

/**
 * Batch evaluate a NURBS surface with derivatives at multiple (u,v) pairs.
 * Output written to dynamic batch buffer: batchBuf[i*21 + 0..20].
 * Read via getBatchBufPtr().
 *
 * @param params - Float64Array of interleaved [u0,v0, u1,v1, ...] (length >= count*2)
 * @param count - number of (u,v) pairs to evaluate
 * @returns count on success
 */
export function nurbsSurfaceBatchDerivEval(
  degU: i32, degV: i32,
  nRowsU: i32, nColsV: i32,
  ctrlPts: Float64Array,
  knotsU: Float64Array, knotsV: Float64Array,
  weights: Float64Array,
  params: Float64Array, count: i32
): i32 {
  ensureBatchBuf(count * 21);

  for (let k: i32 = 0; k < count; k++) {
    const u: f64 = unchecked(params[k * 2]);
    const v: f64 = unchecked(params[k * 2 + 1]);
    nurbsSurfaceDerivEval(degU, degV, nRowsU, nColsV, ctrlPts, knotsU, knotsV, weights, u, v);
    const off: i32 = k * 21;
    for (let j: i32 = 0; j < 21; j++) {
      unchecked(batchBuf![off + j] = derivBuf[j]);
    }
  }

  return count;
}

// ─── Surface Grid Tessellation ───────────────────────────────────────

/**
 * Tessellate a NURBS surface into a triangle mesh.
 * Output written to tessVertsOut, tessNormalsOut, tessFacesOut.
 * Read via getTessVertsPtr(), getTessNormalsPtr(), getTessFacesPtr().
 *
 * Normals are computed via analytical derivatives (not finite differences).
 * Returns -1 if the requested segments exceed the static buffer capacity
 * (128 per direction). The JS side should fall back to JS tessellation
 * or chunk the work when -1 is returned.
 *
 * @returns number of triangles written, or -1 if buffer capacity exceeded
 */
export function nurbsSurfaceTessellate(
  degU: i32, degV: i32,
  nRowsU: i32, nColsV: i32,
  ctrlPts: Float64Array,
  knotsU: Float64Array, knotsV: Float64Array,
  weights: Float64Array,
  segsU: i32, segsV: i32
): i32 {
  // Return error instead of silently clamping
  if (segsU > 128 || segsV > 128) return -1;

  const uMin: f64 = unchecked(knotsU[degU]);
  const uMax: f64 = unchecked(knotsU[nRowsU]);
  const vMin: f64 = unchecked(knotsV[degV]);
  const vMax: f64 = unchecked(knotsV[nColsV]);
  const uRange: f64 = uMax - uMin;
  const vRange: f64 = vMax - vMin;

  // Evaluate grid of points + normals using analytical derivatives
  for (let i: i32 = 0; i <= segsU; i++) {
    const u: f64 = uMin + (<f64>i / <f64>segsU) * uRange;
    for (let j: i32 = 0; j <= segsV; j++) {
      const v: f64 = vMin + (<f64>j / <f64>segsV) * vRange;
      const vi: i32 = (i * (segsV + 1) + j) * 3;

      // Use analytical derivative evaluation — computes point + normal in one pass
      nurbsSurfaceDerivEval(degU, degV, nRowsU, nColsV, ctrlPts, knotsU, knotsV, weights, u, v);

      unchecked(tessVertsOut[vi] = derivBuf[0]);
      unchecked(tessVertsOut[vi + 1] = derivBuf[1]);
      unchecked(tessVertsOut[vi + 2] = derivBuf[2]);
      unchecked(tessNormalsOut[vi] = derivBuf[18]);
      unchecked(tessNormalsOut[vi + 1] = derivBuf[19]);
      unchecked(tessNormalsOut[vi + 2] = derivBuf[20]);
    }
  }

  // Generate triangle indices
  let fi: i32 = 0;
  for (let i: i32 = 0; i < segsU; i++) {
    for (let j: i32 = 0; j < segsV; j++) {
      const i00: u32 = <u32>(i * (segsV + 1) + j);
      const i10: u32 = <u32>((i + 1) * (segsV + 1) + j);
      const i11: u32 = <u32>((i + 1) * (segsV + 1) + j + 1);
      const i01: u32 = <u32>(i * (segsV + 1) + j + 1);

      unchecked(tessFacesOut[fi] = i00);
      unchecked(tessFacesOut[fi + 1] = i10);
      unchecked(tessFacesOut[fi + 2] = i11);
      fi += 3;

      unchecked(tessFacesOut[fi] = i00);
      unchecked(tessFacesOut[fi + 1] = i11);
      unchecked(tessFacesOut[fi + 2] = i01);
      fi += 3;
    }
  }

  return segsU * segsV * 2;
}

// ─── Surface/Surface Intersection: Newton refiner & seed finder ──────
//
// Generic NURBS-NURBS intersection support used by the JS marcher in
// SurfaceSurfaceIntersect.js. JS loads two surfaces into slots A and B
// via ssxSetSurfaceA/B, then repeatedly calls ssxRefinePair (the hot
// inner loop of the marcher) and ssxFindSeeds (grid search for seeds
// where surfaces are close) without re-transferring surface data across
// the JS↔WASM boundary. The outer marching/tracing logic stays in JS;
// the hot arithmetic runs here.

// --- Surface slot A ---
let ssxSADegU: i32 = 0;
let ssxSADegV: i32 = 0;
let ssxSANRowsU: i32 = 0;
let ssxSANColsV: i32 = 0;
let ssxSAKnotsU: Float64Array | null = null;
let ssxSAKnotsV: Float64Array | null = null;
let ssxSACtrlPts: Float64Array | null = null;
let ssxSAWeights: Float64Array | null = null;

// --- Surface slot B ---
let ssxSBDegU: i32 = 0;
let ssxSBDegV: i32 = 0;
let ssxSBNRowsU: i32 = 0;
let ssxSBNColsV: i32 = 0;
let ssxSBKnotsU: Float64Array | null = null;
let ssxSBKnotsV: Float64Array | null = null;
let ssxSBCtrlPts: Float64Array | null = null;
let ssxSBWeights: Float64Array | null = null;

/** Output buffer for ssxRefinePair: [uA, vA, uB, vB, residualDist]. */
const ssxRefineOut: StaticArray<f64> = new StaticArray<f64>(5);

/**
 * Output buffer for ssxFindSeeds: up to MAX_SSX_SEEDS entries of
 * [uA, vA, uB, vB, dist] = 5 f64. The actual seed count is returned.
 */
const MAX_SSX_SEEDS: i32 = 256;
const ssxSeedsOut: StaticArray<f64> = new StaticArray<f64>(MAX_SSX_SEEDS * 5);

export function ssxSetSurfaceA(
  degU: i32, degV: i32, nRowsU: i32, nColsV: i32,
  knotsU: Float64Array, knotsV: Float64Array,
  ctrlPts: Float64Array, weights: Float64Array
): void {
  ssxSADegU = degU;
  ssxSADegV = degV;
  ssxSANRowsU = nRowsU;
  ssxSANColsV = nColsV;
  ssxSAKnotsU = knotsU;
  ssxSAKnotsV = knotsV;
  ssxSACtrlPts = ctrlPts;
  ssxSAWeights = weights;
}

export function ssxSetSurfaceB(
  degU: i32, degV: i32, nRowsU: i32, nColsV: i32,
  knotsU: Float64Array, knotsV: Float64Array,
  ctrlPts: Float64Array, weights: Float64Array
): void {
  ssxSBDegU = degU;
  ssxSBDegV = degV;
  ssxSBNRowsU = nRowsU;
  ssxSBNColsV = nColsV;
  ssxSBKnotsU = knotsU;
  ssxSBKnotsV = knotsV;
  ssxSBCtrlPts = ctrlPts;
  ssxSBWeights = weights;
}

export function getSsxRefineOutPtr(): usize {
  return changetype<usize>(ssxRefineOut);
}

export function getSsxSeedsOutPtr(): usize {
  return changetype<usize>(ssxSeedsOut);
}

export function getSsxMaxSeeds(): i32 {
  return MAX_SSX_SEEDS;
}

/**
 * Refine a candidate intersection point using the balanced tangent-plane
 * iteration: each surface moves halfway toward the other, projecting the
 * 3D displacement into its local tangent plane via the 2×2 normal-equations
 * system. Terminates when ||SA - SB|| < eps or maxIter is reached.
 *
 * Writes the refined [uA, vA, uB, vB, finalResidual] to ssxRefineOut.
 * Returns 1 if converged within eps, else 0.
 */
export function ssxRefinePair(
  uA0: f64, vA0: f64, uB0: f64, vB0: f64,
  maxIter: i32, eps: f64
): u32 {
  if (ssxSAKnotsU == null || ssxSBKnotsU == null ||
      ssxSAKnotsV == null || ssxSBKnotsV == null ||
      ssxSACtrlPts == null || ssxSBCtrlPts == null ||
      ssxSAWeights == null || ssxSBWeights == null) return 0;

  const kAU: Float64Array = ssxSAKnotsU!;
  const kAV: Float64Array = ssxSAKnotsV!;
  const kBU: Float64Array = ssxSBKnotsU!;
  const kBV: Float64Array = ssxSBKnotsV!;

  const uAMin: f64 = unchecked(kAU[ssxSADegU]);
  const uAMax: f64 = unchecked(kAU[ssxSANRowsU]);
  const vAMin: f64 = unchecked(kAV[ssxSADegV]);
  const vAMax: f64 = unchecked(kAV[ssxSANColsV]);
  const uBMin: f64 = unchecked(kBU[ssxSBDegU]);
  const uBMax: f64 = unchecked(kBU[ssxSBNRowsU]);
  const vBMin: f64 = unchecked(kBV[ssxSBDegV]);
  const vBMax: f64 = unchecked(kBV[ssxSBNColsV]);

  let uA: f64 = uA0, vA: f64 = vA0;
  let uB: f64 = uB0, vB: f64 = vB0;

  const eps2: f64 = eps * eps;
  let lastDist2: f64 = 0;

  for (let iter: i32 = 0; iter < maxIter; iter++) {
    // Evaluate surface A (writes derivBuf: S, Su, Sv at slots 0..8)
    nurbsSurfaceDerivEval(
      ssxSADegU, ssxSADegV, ssxSANRowsU, ssxSANColsV,
      ssxSACtrlPts!, kAU, kAV, ssxSAWeights!, uA, vA,
    );
    const SAx: f64 = unchecked(derivBuf[0]);
    const SAy: f64 = unchecked(derivBuf[1]);
    const SAz: f64 = unchecked(derivBuf[2]);
    const SuAx: f64 = unchecked(derivBuf[3]);
    const SuAy: f64 = unchecked(derivBuf[4]);
    const SuAz: f64 = unchecked(derivBuf[5]);
    const SvAx: f64 = unchecked(derivBuf[6]);
    const SvAy: f64 = unchecked(derivBuf[7]);
    const SvAz: f64 = unchecked(derivBuf[8]);

    // Evaluate surface B (overwrites derivBuf)
    nurbsSurfaceDerivEval(
      ssxSBDegU, ssxSBDegV, ssxSBNRowsU, ssxSBNColsV,
      ssxSBCtrlPts!, kBU, kBV, ssxSBWeights!, uB, vB,
    );
    const SBx: f64 = unchecked(derivBuf[0]);
    const SBy: f64 = unchecked(derivBuf[1]);
    const SBz: f64 = unchecked(derivBuf[2]);
    const SuBx: f64 = unchecked(derivBuf[3]);
    const SuBy: f64 = unchecked(derivBuf[4]);
    const SuBz: f64 = unchecked(derivBuf[5]);
    const SvBx: f64 = unchecked(derivBuf[6]);
    const SvBy: f64 = unchecked(derivBuf[7]);
    const SvBz: f64 = unchecked(derivBuf[8]);

    const dx: f64 = SAx - SBx;
    const dy: f64 = SAy - SBy;
    const dz: f64 = SAz - SBz;
    lastDist2 = dx * dx + dy * dy + dz * dz;
    if (lastDist2 < eps2) {
      unchecked(ssxRefineOut[0] = uA);
      unchecked(ssxRefineOut[1] = vA);
      unchecked(ssxRefineOut[2] = uB);
      unchecked(ssxRefineOut[3] = vB);
      unchecked(ssxRefineOut[4] = sqrt(lastDist2));
      return 1;
    }

    const halfX: f64 = dx * 0.5;
    const halfY: f64 = dy * 0.5;
    const halfZ: f64 = dz * 0.5;

    // Solve 2×2 for A: move A by -(halfX,halfY,halfZ) in its tangent plane.
    //   [Su·Su  Su·Sv] [ΔuA]   [Su·(-half)]
    //   [Su·Sv  Sv·Sv] [ΔvA] = [Sv·(-half)]
    {
      const a: f64 = SuAx * SuAx + SuAy * SuAy + SuAz * SuAz;
      const b: f64 = SuAx * SvAx + SuAy * SvAy + SuAz * SvAz;
      const c: f64 = SvAx * SvAx + SvAy * SvAy + SvAz * SvAz;
      const rU: f64 = -(SuAx * halfX + SuAy * halfY + SuAz * halfZ);
      const rV: f64 = -(SvAx * halfX + SvAy * halfY + SvAz * halfZ);
      const det: f64 = a * c - b * b;
      if (det > 1e-20) {
        const invDet: f64 = 1.0 / det;
        const dU: f64 = (c * rU - b * rV) * invDet;
        const dV: f64 = (a * rV - b * rU) * invDet;
        uA += dU;
        vA += dV;
      }
    }

    // Same for B: target displacement is +half.
    {
      const a: f64 = SuBx * SuBx + SuBy * SuBy + SuBz * SuBz;
      const b: f64 = SuBx * SvBx + SuBy * SvBy + SuBz * SvBz;
      const c: f64 = SvBx * SvBx + SvBy * SvBy + SvBz * SvBz;
      const rU: f64 = (SuBx * halfX + SuBy * halfY + SuBz * halfZ);
      const rV: f64 = (SvBx * halfX + SvBy * halfY + SvBz * halfZ);
      const det: f64 = a * c - b * b;
      if (det > 1e-20) {
        const invDet: f64 = 1.0 / det;
        const dU: f64 = (c * rU - b * rV) * invDet;
        const dV: f64 = (a * rV - b * rU) * invDet;
        uB += dU;
        vB += dV;
      }
    }

    // Clamp to parameter domains.
    if (uA < uAMin) uA = uAMin; else if (uA > uAMax) uA = uAMax;
    if (vA < vAMin) vA = vAMin; else if (vA > vAMax) vA = vAMax;
    if (uB < uBMin) uB = uBMin; else if (uB > uBMax) uB = uBMax;
    if (vB < vBMin) vB = vBMin; else if (vB > vBMax) vB = vBMax;
  }

  unchecked(ssxRefineOut[0] = uA);
  unchecked(ssxRefineOut[1] = vA);
  unchecked(ssxRefineOut[2] = uB);
  unchecked(ssxRefineOut[3] = vB);
  unchecked(ssxRefineOut[4] = sqrt(lastDist2));
  return 0;
}

/**
 * Grid-sample slot-A, for each sample find the closest point on slot-B
 * by a second nested grid sweep, and record candidate seeds where the
 * 3D distance is below `threshold`. Seeds are sorted ascending by dist
 * (insertion-sort while inserting into `ssxSeedsOut`) and capped at
 * `maxSeeds` (≤ MAX_SSX_SEEDS).
 *
 * Returns the number of seeds written (≤ maxSeeds). The outer marcher
 * in JS consumes the seed list and calls ssxRefinePair per seed.
 */
export function ssxFindSeeds(
  samplesA: i32, samplesB: i32, threshold: f64, maxSeeds: i32,
): i32 {
  if (ssxSAKnotsU == null || ssxSBKnotsU == null) return 0;
  if (maxSeeds > MAX_SSX_SEEDS) maxSeeds = MAX_SSX_SEEDS;
  if (maxSeeds <= 0) return 0;

  const kAU: Float64Array = ssxSAKnotsU!;
  const kAV: Float64Array = ssxSAKnotsV!;
  const kBU: Float64Array = ssxSBKnotsU!;
  const kBV: Float64Array = ssxSBKnotsV!;
  const uAMin: f64 = unchecked(kAU[ssxSADegU]);
  const uAMax: f64 = unchecked(kAU[ssxSANRowsU]);
  const vAMin: f64 = unchecked(kAV[ssxSADegV]);
  const vAMax: f64 = unchecked(kAV[ssxSANColsV]);
  const uBMin: f64 = unchecked(kBU[ssxSBDegU]);
  const uBMax: f64 = unchecked(kBU[ssxSBNRowsU]);
  const vBMin: f64 = unchecked(kBV[ssxSBDegV]);
  const vBMax: f64 = unchecked(kBV[ssxSBNColsV]);

  const dUA: f64 = (uAMax - uAMin) / <f64>samplesA;
  const dVA: f64 = (vAMax - vAMin) / <f64>samplesA;
  const dUB: f64 = (uBMax - uBMin) / <f64>samplesB;
  const dVB: f64 = (vBMax - vBMin) / <f64>samplesB;

  const thr2: f64 = threshold * threshold;
  let written: i32 = 0;

  for (let i: i32 = 0; i <= samplesA; i++) {
    const uA: f64 = uAMin + <f64>i * dUA;
    for (let j: i32 = 0; j <= samplesA; j++) {
      const vA: f64 = vAMin + <f64>j * dVA;

      nurbsSurfaceDerivEval(
        ssxSADegU, ssxSADegV, ssxSANRowsU, ssxSANColsV,
        ssxSACtrlPts!, kAU, kAV, ssxSAWeights!, uA, vA,
      );
      const pAx: f64 = unchecked(derivBuf[0]);
      const pAy: f64 = unchecked(derivBuf[1]);
      const pAz: f64 = unchecked(derivBuf[2]);

      let bestD2: f64 = 1e300;
      let bestUB: f64 = uBMin;
      let bestVB: f64 = vBMin;
      for (let ii: i32 = 0; ii <= samplesB; ii++) {
        const uB: f64 = uBMin + <f64>ii * dUB;
        for (let jj: i32 = 0; jj <= samplesB; jj++) {
          const vB: f64 = vBMin + <f64>jj * dVB;
          nurbsSurfaceDerivEval(
            ssxSBDegU, ssxSBDegV, ssxSBNRowsU, ssxSBNColsV,
            ssxSBCtrlPts!, kBU, kBV, ssxSBWeights!, uB, vB,
          );
          const dx: f64 = pAx - unchecked(derivBuf[0]);
          const dy: f64 = pAy - unchecked(derivBuf[1]);
          const dz: f64 = pAz - unchecked(derivBuf[2]);
          const d2: f64 = dx * dx + dy * dy + dz * dz;
          if (d2 < bestD2) {
            bestD2 = d2;
            bestUB = uB;
            bestVB = vB;
          }
        }
      }

      if (bestD2 > thr2) continue;

      // Insertion-sort into ssxSeedsOut by distance.
      const dist: f64 = sqrt(bestD2);
      let insertAt: i32 = written;
      while (insertAt > 0) {
        const prevD: f64 = unchecked(ssxSeedsOut[(insertAt - 1) * 5 + 4]);
        if (prevD <= dist) break;
        // Shift right
        const srcBase: i32 = (insertAt - 1) * 5;
        const dstBase: i32 = insertAt * 5;
        if (insertAt < maxSeeds) {
          for (let k: i32 = 0; k < 5; k++) {
            unchecked(ssxSeedsOut[dstBase + k] = ssxSeedsOut[srcBase + k]);
          }
        }
        insertAt--;
      }
      if (insertAt < maxSeeds) {
        const base: i32 = insertAt * 5;
        unchecked(ssxSeedsOut[base + 0] = uA);
        unchecked(ssxSeedsOut[base + 1] = vA);
        unchecked(ssxSeedsOut[base + 2] = bestUB);
        unchecked(ssxSeedsOut[base + 3] = bestVB);
        unchecked(ssxSeedsOut[base + 4] = dist);
        if (written < maxSeeds) written++;
      }
    }
  }

  return written;
}

