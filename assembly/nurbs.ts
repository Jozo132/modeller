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

// ─── Output buffers ──────────────────────────────────────────────────
// Pre-allocated output buffers in WASM memory. JS reads from these via pointers.

// Small result buffer for single-point evaluations: [x, y, z, nx, ny, nz]
const resultBuf: StaticArray<f64> = new StaticArray<f64>(6);

// Large output buffer for tessellation results.
// Max capacity: 128×128 grid = 16384 verts × 3 = 49152 f64 for verts,
// same for normals, plus 128×128×2×3 = 98304 indices (as u32).
// Total allocation: 256K f64 ≈ 2 MB — allocated on demand.
const MAX_TESS_VERTS: i32 = 16641;   // (128+1)² = 16641
const MAX_TESS_TRIS: i32 = 32768;    // 128×128×2 = 32768

const tessVertsOut: StaticArray<f64> = new StaticArray<f64>(MAX_TESS_VERTS * 3);
const tessNormalsOut: StaticArray<f64> = new StaticArray<f64>(MAX_TESS_VERTS * 3);
const tessFacesOut: StaticArray<u32> = new StaticArray<u32>(MAX_TESS_TRIS * 3);

// Curve output buffer: max 1024 points × 3 = 3072 f64
const MAX_CURVE_PTS: i32 = 1025; // segments + 1, max 1024 segments
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
 * @returns number of points written (segments + 1)
 */
export function nurbsCurveTessellate(
  degree: i32,
  nCtrl: i32,
  ctrlPts: Float64Array,
  knots: Float64Array,
  weights: Float64Array,
  segments: i32
): i32 {
  const tMin: f64 = unchecked(knots[degree]);
  const tMax: f64 = unchecked(knots[nCtrl]);
  const range: f64 = tMax - tMin;
  const nPts: i32 = min<i32>(segments + 1, MAX_CURVE_PTS);

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
 * Compute surface normal at (u, v) via central finite differences.
 * Result: resultBuf[0..2] = point {x,y,z}, resultBuf[3..5] = normal {nx,ny,nz}.
 */
export function nurbsSurfaceNormal(
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

  const eps: f64 = 1e-6;
  const uRange: f64 = uMax - uMin;
  const vRange: f64 = vMax - vMin;

  // Evaluate point at (u, v)
  _evalSurf(degU, degV, nRowsU, nColsV, ctrlPts, knotsU, knotsV, weights, u, v);
  const px: f64 = unchecked(resultBuf[0]);
  const py: f64 = unchecked(resultBuf[1]);
  const pz: f64 = unchecked(resultBuf[2]);

  // dS/du via central differences
  const uLo: f64 = max<f64>(uMin, u - eps * uRange);
  const uHi: f64 = min<f64>(uMax, u + eps * uRange);
  _evalSurf(degU, degV, nRowsU, nColsV, ctrlPts, knotsU, knotsV, weights, uLo, v);
  const uLoX: f64 = unchecked(resultBuf[0]);
  const uLoY: f64 = unchecked(resultBuf[1]);
  const uLoZ: f64 = unchecked(resultBuf[2]);
  _evalSurf(degU, degV, nRowsU, nColsV, ctrlPts, knotsU, knotsV, weights, uHi, v);
  const duX: f64 = unchecked(resultBuf[0]) - uLoX;
  const duY: f64 = unchecked(resultBuf[1]) - uLoY;
  const duZ: f64 = unchecked(resultBuf[2]) - uLoZ;

  // dS/dv via central differences
  const vLo: f64 = max<f64>(vMin, v - eps * vRange);
  const vHi: f64 = min<f64>(vMax, v + eps * vRange);
  _evalSurf(degU, degV, nRowsU, nColsV, ctrlPts, knotsU, knotsV, weights, u, vLo);
  const vLoX: f64 = unchecked(resultBuf[0]);
  const vLoY: f64 = unchecked(resultBuf[1]);
  const vLoZ: f64 = unchecked(resultBuf[2]);
  _evalSurf(degU, degV, nRowsU, nColsV, ctrlPts, knotsU, knotsV, weights, u, vHi);
  const dvX: f64 = unchecked(resultBuf[0]) - vLoX;
  const dvY: f64 = unchecked(resultBuf[1]) - vLoY;
  const dvZ: f64 = unchecked(resultBuf[2]) - vLoZ;

  // Cross product du × dv
  const nx: f64 = duY * dvZ - duZ * dvY;
  const ny: f64 = duZ * dvX - duX * dvZ;
  const nz: f64 = duX * dvY - duY * dvX;
  const len: f64 = sqrt(nx * nx + ny * ny + nz * nz);

  unchecked(resultBuf[0] = px);
  unchecked(resultBuf[1] = py);
  unchecked(resultBuf[2] = pz);
  if (len < 1e-14) {
    unchecked(resultBuf[3] = 0);
    unchecked(resultBuf[4] = 0);
    unchecked(resultBuf[5] = 1);
  } else {
    const invLen: f64 = 1.0 / len;
    unchecked(resultBuf[3] = nx * invLen);
    unchecked(resultBuf[4] = ny * invLen);
    unchecked(resultBuf[5] = nz * invLen);
  }
}

// ─── Surface Grid Tessellation ───────────────────────────────────────

/**
 * Tessellate a NURBS surface into a triangle mesh.
 * Output written to tessVertsOut, tessNormalsOut, tessFacesOut.
 * Read via getTessVertsPtr(), getTessNormalsPtr(), getTessFacesPtr().
 *
 * @returns number of triangles written
 */
export function nurbsSurfaceTessellate(
  degU: i32, degV: i32,
  nRowsU: i32, nColsV: i32,
  ctrlPts: Float64Array,
  knotsU: Float64Array, knotsV: Float64Array,
  weights: Float64Array,
  segsU: i32, segsV: i32
): i32 {
  // Clamp to max buffer capacity
  segsU = min<i32>(segsU, 128);
  segsV = min<i32>(segsV, 128);

  const uMin: f64 = unchecked(knotsU[degU]);
  const uMax: f64 = unchecked(knotsU[nRowsU]);
  const vMin: f64 = unchecked(knotsV[degV]);
  const vMax: f64 = unchecked(knotsV[nColsV]);
  const uRange: f64 = uMax - uMin;
  const vRange: f64 = vMax - vMin;

  const eps: f64 = 1e-6;

  // Evaluate grid of points + normals
  for (let i: i32 = 0; i <= segsU; i++) {
    const u: f64 = uMin + (<f64>i / <f64>segsU) * uRange;
    for (let j: i32 = 0; j <= segsV; j++) {
      const v: f64 = vMin + (<f64>j / <f64>segsV) * vRange;
      const vi: i32 = (i * (segsV + 1) + j) * 3;

      // Evaluate point
      _evalSurf(degU, degV, nRowsU, nColsV, ctrlPts, knotsU, knotsV, weights, u, v);
      unchecked(tessVertsOut[vi] = resultBuf[0]);
      unchecked(tessVertsOut[vi + 1] = resultBuf[1]);
      unchecked(tessVertsOut[vi + 2] = resultBuf[2]);

      // Compute normal via central differences
      const uLo: f64 = max<f64>(uMin, u - eps * uRange);
      const uHi: f64 = min<f64>(uMax, u + eps * uRange);
      _evalSurf(degU, degV, nRowsU, nColsV, ctrlPts, knotsU, knotsV, weights, uLo, v);
      const uLoX: f64 = unchecked(resultBuf[0]);
      const uLoY: f64 = unchecked(resultBuf[1]);
      const uLoZ: f64 = unchecked(resultBuf[2]);
      _evalSurf(degU, degV, nRowsU, nColsV, ctrlPts, knotsU, knotsV, weights, uHi, v);
      const duX: f64 = unchecked(resultBuf[0]) - uLoX;
      const duY: f64 = unchecked(resultBuf[1]) - uLoY;
      const duZ: f64 = unchecked(resultBuf[2]) - uLoZ;

      const vLo: f64 = max<f64>(vMin, v - eps * vRange);
      const vHi: f64 = min<f64>(vMax, v + eps * vRange);
      _evalSurf(degU, degV, nRowsU, nColsV, ctrlPts, knotsU, knotsV, weights, u, vLo);
      const vLoX: f64 = unchecked(resultBuf[0]);
      const vLoY: f64 = unchecked(resultBuf[1]);
      const vLoZ: f64 = unchecked(resultBuf[2]);
      _evalSurf(degU, degV, nRowsU, nColsV, ctrlPts, knotsU, knotsV, weights, u, vHi);
      const dvX: f64 = unchecked(resultBuf[0]) - vLoX;
      const dvY: f64 = unchecked(resultBuf[1]) - vLoY;
      const dvZ: f64 = unchecked(resultBuf[2]) - vLoZ;

      const nx: f64 = duY * dvZ - duZ * dvY;
      const ny: f64 = duZ * dvX - duX * dvZ;
      const nz: f64 = duX * dvY - duY * dvX;
      const nLen: f64 = sqrt(nx * nx + ny * ny + nz * nz);

      if (nLen < 1e-14) {
        unchecked(tessNormalsOut[vi] = 0);
        unchecked(tessNormalsOut[vi + 1] = 0);
        unchecked(tessNormalsOut[vi + 2] = 1);
      } else {
        const invNLen: f64 = 1.0 / nLen;
        unchecked(tessNormalsOut[vi] = nx * invNLen);
        unchecked(tessNormalsOut[vi + 1] = ny * invNLen);
        unchecked(tessNormalsOut[vi + 2] = nz * invNLen);
      }
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
