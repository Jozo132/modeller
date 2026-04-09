// js/cad/NurbsCurve.js — Non-Uniform Rational B-Spline (NURBS) Curve
//
// Provides a mathematically exact curve representation for CAD edges.
// Supports rational (weighted) curves which can exactly represent conics
// (circles, ellipses, parabolas, hyperbolas) as well as free-form curves.
//
// References:
//   - "The NURBS Book" (Piegl & Tiller, 1997)
//   - ISO 10303-42 (STEP geometry)

import { wasmTessellation } from './WasmTessellation.js';
import { GeometryEvaluator } from './GeometryEvaluator.js';

let _loggedCurveTessBackend = false;

/**
 * NURBS Curve class.
 *
 * A NURBS curve C(u) of degree p is defined by:
 *   C(u) = Σ Ni,p(u) * wi * Pi  /  Σ Ni,p(u) * wi
 *
 * where:
 *   Pi  = control points (3D)
 *   wi  = weights (positive reals)
 *   Ni,p = B-spline basis functions of degree p
 *   u   = parameter in [knots[p], knots[n+1]]
 *
 * The knot vector is non-decreasing: [u0, u1, ..., u_{n+p+1}]
 * where n+1 = number of control points.
 */
export class NurbsCurve {
  /**
   * @param {number} degree - Polynomial degree (1=linear, 2=quadratic, 3=cubic)
   * @param {Array<{x:number, y:number, z:number}>} controlPoints - Control points
   * @param {number[]} knots - Knot vector (length = controlPoints.length + degree + 1)
   * @param {number[]} [weights] - Weights (default: all 1.0 = non-rational)
   */
  constructor(degree, controlPoints, knots, weights = null) {
    if (degree < 1) throw new Error('NURBS degree must be >= 1');
    if (controlPoints.length < degree + 1) {
      throw new Error(`Need at least ${degree + 1} control points for degree ${degree}`);
    }
    const expectedKnots = controlPoints.length + degree + 1;
    if (knots.length !== expectedKnots) {
      throw new Error(`Knot vector length ${knots.length} != expected ${expectedKnots}`);
    }

    this.degree = degree;
    this.controlPoints = controlPoints.map(p => ({ x: p.x, y: p.y, z: p.z }));
    this.knots = [...knots];
    this.weights = weights ? [...weights] : controlPoints.map(() => 1.0);

    // Parameter domain
    this.uMin = this.knots[this.degree];
    this.uMax = this.knots[this.controlPoints.length];
  }

  /**
   * Find the knot span index for parameter u.
   * Returns i such that knots[i] <= u < knots[i+1], with special handling
   * for the upper bound.
   */
  _findSpan(u) {
    const n = this.controlPoints.length - 1;
    const p = this.degree;

    // Special case: u at upper bound
    if (u >= this.knots[n + 1]) return n;

    // Binary search
    let low = p;
    let high = n + 1;
    let mid = (low + high) >>> 1;

    while (u < this.knots[mid] || u >= this.knots[mid + 1]) {
      if (u < this.knots[mid]) {
        high = mid;
      } else {
        low = mid;
      }
      mid = (low + high) >>> 1;
    }
    return mid;
  }

  /**
   * Compute the non-vanishing B-spline basis functions at parameter u.
   * Returns array N[0..degree] where N[j] = N_{span-degree+j, degree}(u).
   * Uses the Cox–de Boor recurrence with Piegl & Tiller's Algorithm A2.2.
   */
  _basisFunctions(span, u) {
    const p = this.degree;
    const N = new Array(p + 1);
    const left = new Array(p + 1);
    const right = new Array(p + 1);

    N[0] = 1.0;

    for (let j = 1; j <= p; j++) {
      left[j] = u - this.knots[span + 1 - j];
      right[j] = this.knots[span + j] - u;
      let saved = 0.0;

      for (let r = 0; r < j; r++) {
        const denom = right[r + 1] + left[j - r];
        if (Math.abs(denom) < 1e-14) {
          N[r] = saved;
          saved = 0.0;
        } else {
          const temp = N[r] / denom;
          N[r] = saved + right[r + 1] * temp;
          saved = left[j - r] * temp;
        }
      }
      N[j] = saved;
    }

    return N;
  }

  /**
   * Evaluate the curve point at parameter u.
   * @param {number} u - Parameter value in [uMin, uMax]
   * @returns {{x: number, y: number, z: number}}
   */
  evaluate(u) {
    u = Math.max(this.uMin, Math.min(this.uMax, u));
    const span = this._findSpan(u);
    const N = this._basisFunctions(span, u);
    const p = this.degree;

    let wx = 0, wy = 0, wz = 0, wSum = 0;
    for (let i = 0; i <= p; i++) {
      const idx = span - p + i;
      const cp = this.controlPoints[idx];
      const w = this.weights[idx];
      const Nw = N[i] * w;
      wx += Nw * cp.x;
      wy += Nw * cp.y;
      wz += Nw * cp.z;
      wSum += Nw;
    }

    if (Math.abs(wSum) < 1e-14) return { x: 0, y: 0, z: 0 };
    return { x: wx / wSum, y: wy / wSum, z: wz / wSum };
  }

  /**
   * Evaluate the first derivative (tangent) at parameter u using analytical
   * basis function derivatives (Piegl & Tiller Algorithm A2.3). For rational
   * curves, applies the quotient rule for the first derivative.
   *
   * @param {number} u - Parameter value
   * @returns {{x: number, y: number, z: number}} Tangent vector (not normalized)
   */
  derivative(u) {
    const result = GeometryEvaluator.evalCurve(this, u);
    return result.d1;
  }

  /**
   * Tessellate the curve into a polyline with the given number of segments.
   * Uses WASM acceleration when available, falls back to JS evaluation.
   * @param {number} [segments=32] - Number of line segments
   * @returns {Array<{x: number, y: number, z: number}>} Array of points
   */
  tessellate(segments = 32) {
    if (wasmTessellation.isAvailable()) {
      const result = wasmTessellation.tessellateCurve(this, segments);
      if (result) {
        if (!_loggedCurveTessBackend) { _loggedCurveTessBackend = true; console.log('[NurbsCurve.tessellate] using WASM'); }
        return result;
      }
    }
    if (!_loggedCurveTessBackend) { _loggedCurveTessBackend = true; console.log('[NurbsCurve.tessellate] using JS fallback'); }
    const points = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const u = this.uMin + t * (this.uMax - this.uMin);
      points.push(GeometryEvaluator.evalCurve(this, u).p);
    }
    return points;
  }

  /**
   * Compute approximate arc length using Gauss quadrature.
   * @param {number} [samples=64] - Number of sample points
   * @returns {number}
   */
  arcLength(samples = 64) {
    let length = 0;
    let prev = this.evaluate(this.uMin);
    for (let i = 1; i <= samples; i++) {
      const t = i / samples;
      const u = this.uMin + t * (this.uMax - this.uMin);
      const curr = this.evaluate(u);
      const dx = curr.x - prev.x;
      const dy = curr.y - prev.y;
      const dz = curr.z - prev.z;
      length += Math.sqrt(dx * dx + dy * dy + dz * dz);
      prev = curr;
    }
    return length;
  }

  /**
   * Clone this curve.
   * @returns {NurbsCurve}
   */
  clone() {
    return new NurbsCurve(this.degree, this.controlPoints, this.knots, this.weights);
  }

  /**
   * Return this curve with reversed parameter direction.
   * The geometry is unchanged; only the start/end orientation flips.
   *
   * @returns {NurbsCurve}
   */
  reversed() {
    const u0 = this.knots[0];
    const u1 = this.knots[this.knots.length - 1];
    const reversedKnots = this.knots
      .map((k) => u0 + u1 - k)
      .reverse();
    return new NurbsCurve(
      this.degree,
      [...this.controlPoints].reverse(),
      reversedKnots,
      [...this.weights].reverse(),
    );
  }

  /**
   * Split this curve at parameter `u` into two sub-curves.
   * Uses repeated knot insertion (Boehm's algorithm) until the knot
   * has multiplicity equal to the curve degree, then extracts two
   * independent sub-curves that together represent the original curve.
   *
   * @param {number} u - Split parameter (must be within the domain)
   * @returns {[NurbsCurve, NurbsCurve]} [left, right] sub-curves
   */
  splitAt(u) {
    const p = this.degree;

    // Clamp u within the curve domain
    if (u <= this.uMin || u >= this.uMax) return null;

    // Build a working copy of CPs, weights, knots
    let cps = this.controlPoints.map(pt => ({ x: pt.x, y: pt.y, z: pt.z }));
    let wts = [...this.weights];
    let kts = [...this.knots];

    // Count existing multiplicity of u in the knot vector
    const EPS = 1e-12;
    let mult = 0;
    for (const k of kts) { if (Math.abs(k - u) < EPS) mult++; }

    // Insert knot until multiplicity === degree
    const insertionsNeeded = p - mult;
    for (let ins = 0; ins < insertionsNeeded; ins++) {
      // Find span: knots[k] <= u < knots[k+1]
      let k = -1;
      for (let i = 0; i < kts.length - 1; i++) {
        if (kts[i] <= u + EPS && u < kts[i + 1] + EPS && kts[i] < kts[i + 1]) { k = i; break; }
      }
      if (k < 0) break;

      // Boehm knot insertion: insert u between knots[k] and knots[k+1]
      const newCps = [];
      const newWts = [];
      for (let i = 0; i <= k - p; i++) {
        newCps.push(cps[i]);
        newWts.push(wts[i]);
      }
      for (let i = k - p + 1; i <= k; i++) {
        const alpha = (u - kts[i]) / (kts[i + p] - kts[i]);
        const w0 = wts[i - 1], w1 = wts[i];
        const wa = (1 - alpha) * w0 + alpha * w1;
        newCps.push({
          x: ((1 - alpha) * cps[i - 1].x * w0 + alpha * cps[i].x * w1) / wa,
          y: ((1 - alpha) * cps[i - 1].y * w0 + alpha * cps[i].y * w1) / wa,
          z: ((1 - alpha) * cps[i - 1].z * w0 + alpha * cps[i].z * w1) / wa,
        });
        newWts.push(wa);
      }
      for (let i = k; i < cps.length; i++) {
        newCps.push(cps[i]);
        newWts.push(wts[i]);
      }

      const newKts = [...kts.slice(0, k + 1), u, ...kts.slice(k + 1)];
      cps = newCps;
      wts = newWts;
      kts = newKts;
    }

    // Now u has multiplicity === p in kts.
    // Find the first index where knots[i] == u.
    let splitKnotIdx = -1;
    for (let i = 0; i < kts.length; i++) {
      if (Math.abs(kts[i] - u) < EPS) { splitKnotIdx = i; break; }
    }
    if (splitKnotIdx < 0) return null;

    // The shared control point is at index (splitKnotIdx - 1): it is the
    // last CP of the left sub-curve and the first CP of the right sub-curve.
    const splitCpIdx = splitKnotIdx - 1;

    // Find last occurrence of u in the refined knots
    let lastUIdx = splitKnotIdx;
    while (lastUIdx + 1 < kts.length && Math.abs(kts[lastUIdx + 1] - u) < EPS) lastUIdx++;

    // Left sub-curve: CPs [0 .. splitCpIdx], clamped knots ending with p+1 copies of u
    const leftCps = cps.slice(0, splitCpIdx + 1);
    const leftWts = wts.slice(0, splitCpIdx + 1);
    const leftKnots = [...kts.slice(0, splitKnotIdx)];
    for (let i = 0; i <= p; i++) leftKnots.push(u);

    // Right sub-curve: CPs [splitCpIdx .. end], clamped knots starting with p+1 copies of u
    const rightCps = cps.slice(splitCpIdx);
    const rightWts = wts.slice(splitCpIdx);
    const rightKnots = [];
    for (let i = 0; i <= p; i++) rightKnots.push(u);
    rightKnots.push(...kts.slice(lastUIdx + 1));

    try {
      const left = new NurbsCurve(p, leftCps, leftKnots, leftWts);
      const right = new NurbsCurve(p, rightCps, rightKnots, rightWts);
      return [left, right];
    } catch {
      return null;
    }
  }

  /**
   * Split this curve into N sub-curves at uniformly spaced parameters.
   *
   * @param {number} nParts - Number of parts to split into (must be >= 2)
   * @returns {NurbsCurve[]|null} Array of sub-curves, or null on failure
   */
  splitUniform(nParts) {
    if (nParts < 2) return null;
    const parts = [];
    let remaining = this;
    const du = (this.uMax - this.uMin) / nParts;
    for (let i = 1; i < nParts; i++) {
      const u = this.uMin + i * du;
      // Re-map u into the remaining curve's parameter domain
      const tNorm = (u - this.uMin) / (this.uMax - this.uMin);
      const uLocal = remaining.uMin + tNorm * (remaining.uMax - remaining.uMin);
      // For the split parameter within 'remaining', we need to compute
      // the fraction of the remaining curve to split at
      const totalRemaining = this.uMax - (this.uMin + (i - 1) * du);
      const splitFrac = du / totalRemaining;
      const uSplit = remaining.uMin + splitFrac * (remaining.uMax - remaining.uMin);
      const result = remaining.splitAt(uSplit);
      if (!result) return null;
      parts.push(result[0]);
      remaining = result[1];
    }
    parts.push(remaining);
    return parts;
  }

  /**
   * Serialize to a plain object.
   */
  serialize() {
    return {
      type: 'NurbsCurve',
      degree: this.degree,
      controlPoints: this.controlPoints.map(p => ({ x: p.x, y: p.y, z: p.z })),
      knots: [...this.knots],
      weights: [...this.weights],
    };
  }

  /**
   * Deserialize from a plain object.
   * @param {Object} data
   * @returns {NurbsCurve}
   */
  static deserialize(data) {
    return new NurbsCurve(data.degree, data.controlPoints, data.knots, data.weights);
  }

  // -------------------------------------------------------------------
  // Factory methods for common curve types
  // -------------------------------------------------------------------

  /**
   * Create a NURBS line segment (degree 1).
   * @param {{x,y,z}} p0 - Start point
   * @param {{x,y,z}} p1 - End point
   * @returns {NurbsCurve}
   */
  static createLine(p0, p1) {
    return new NurbsCurve(1, [p0, p1], [0, 0, 1, 1]);
  }

  /**
   * Create a degree-1 NURBS polyline through a sequence of points.
   * Useful for representing sampled curves (e.g. ellipse arcs).
   *
   * @param {Array<{x:number, y:number, z:number}>} points - Ordered points (at least 2)
   * @returns {NurbsCurve}
   */
  static createPolyline(points) {
    if (!points || points.length < 2) {
      throw new Error('createPolyline requires at least 2 points');
    }
    const n = points.length;
    // Degree-1 clamped B-spline: needs n+2 knots = [0, 0, 1, 2, ..., n-2, n-1, n-1]
    const knots = [0]; // first clamped knot
    for (let i = 0; i < n; i++) knots.push(i);
    knots.push(n - 1); // last clamped knot
    return new NurbsCurve(1, points, knots);
  }

  /**
   * Create a NURBS circular arc.
   *
   * Uses the standard rational quadratic representation. The arc is defined
   * by center, radius, start/end angles, and a normal direction for the plane.
   *
   * For arcs > 90°, the arc is split into multiple quadratic segments.
   *
   * @param {{x,y,z}} center - Arc center
   * @param {number} radius - Arc radius
   * @param {{x,y,z}} xAxis - Unit X direction in arc plane
   * @param {{x,y,z}} yAxis - Unit Y direction in arc plane
   * @param {number} startAngle - Start angle in radians
   * @param {number} sweepAngle - Sweep angle in radians (positive = CCW)
   * @returns {NurbsCurve}
   */
  static createArc(center, radius, xAxis, yAxis, startAngle, sweepAngle) {
    // Determine number of arc segments (each ≤ 90°)
    const absSweep = Math.abs(sweepAngle);
    const nArcs = absSweep <= Math.PI / 2 + 1e-10 ? 1
      : absSweep <= Math.PI + 1e-10 ? 2
        : absSweep <= 3 * Math.PI / 2 + 1e-10 ? 3
          : 4;

    const dTheta = sweepAngle / nArcs;
    const w1 = Math.cos(dTheta / 2); // weight for midpoint control points

    const controlPoints = [];
    const weights = [];
    const knots = [];

    let angle = startAngle;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);

    // Start point
    controlPoints.push({
      x: center.x + radius * (cosA * xAxis.x + sinA * yAxis.x),
      y: center.y + radius * (cosA * xAxis.y + sinA * yAxis.y),
      z: center.z + radius * (cosA * xAxis.z + sinA * yAxis.z),
    });
    weights.push(1.0);

    // Initial knots
    knots.push(0, 0, 0);

    for (let i = 0; i < nArcs; i++) {
      const angleMid = angle + dTheta / 2;
      const angleEnd = angle + dTheta;

      const cosMid = Math.cos(angleMid);
      const sinMid = Math.sin(angleMid);
      const cosEnd = Math.cos(angleEnd);
      const sinEnd = Math.sin(angleEnd);

      // Midpoint control point (on tangent line intersection, weighted)
      controlPoints.push({
        x: center.x + (radius / w1) * (cosMid * xAxis.x + sinMid * yAxis.x),
        y: center.y + (radius / w1) * (cosMid * xAxis.y + sinMid * yAxis.y),
        z: center.z + (radius / w1) * (cosMid * xAxis.z + sinMid * yAxis.z),
      });
      weights.push(w1);

      // End point of this segment
      controlPoints.push({
        x: center.x + radius * (cosEnd * xAxis.x + sinEnd * yAxis.x),
        y: center.y + radius * (cosEnd * xAxis.y + sinEnd * yAxis.y),
        z: center.z + radius * (cosEnd * xAxis.z + sinEnd * yAxis.z),
      });
      weights.push(1.0);

      // Knots for this segment
      const knotVal = (i + 1) / nArcs;
      if (i < nArcs - 1) {
        knots.push(knotVal, knotVal);
      }

      angle = angleEnd;
    }

    // Final knots
    knots.push(1, 1, 1);

    return new NurbsCurve(2, controlPoints, knots, weights);
  }

  /**
   * Create an exact NURBS ellipse arc.
   *
   * This is the affine image of the rational quadratic circle representation,
   * so it stays mathematically exact for downstream B-Rep operations.
   *
   * @param {{x:number,y:number,z:number}} center
   * @param {number} radiusX
   * @param {number} radiusY
   * @param {{x:number,y:number,z:number}} xAxis
   * @param {{x:number,y:number,z:number}} yAxis
   * @param {number} startAngle
   * @param {number} sweepAngle
   * @returns {NurbsCurve}
   */
  static createEllipseArc(center, radiusX, radiusY, xAxis, yAxis, startAngle, sweepAngle) {
    const absSweep = Math.abs(sweepAngle);
    const nArcs = absSweep <= Math.PI / 2 + 1e-10 ? 1
      : absSweep <= Math.PI + 1e-10 ? 2
        : absSweep <= 3 * Math.PI / 2 + 1e-10 ? 3
          : 4;

    const dTheta = sweepAngle / nArcs;
    const w1 = Math.cos(dTheta / 2);

    const controlPoints = [];
    const weights = [];
    const knots = [];

    let angle = startAngle;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);

    controlPoints.push({
      x: center.x + radiusX * cosA * xAxis.x + radiusY * sinA * yAxis.x,
      y: center.y + radiusX * cosA * xAxis.y + radiusY * sinA * yAxis.y,
      z: center.z + radiusX * cosA * xAxis.z + radiusY * sinA * yAxis.z,
    });
    weights.push(1.0);
    knots.push(0, 0, 0);

    for (let i = 0; i < nArcs; i++) {
      const angleMid = angle + dTheta / 2;
      const angleEnd = angle + dTheta;

      const cosMid = Math.cos(angleMid);
      const sinMid = Math.sin(angleMid);
      const cosEnd = Math.cos(angleEnd);
      const sinEnd = Math.sin(angleEnd);

      controlPoints.push({
        x: center.x + (radiusX / w1) * cosMid * xAxis.x + (radiusY / w1) * sinMid * yAxis.x,
        y: center.y + (radiusX / w1) * cosMid * xAxis.y + (radiusY / w1) * sinMid * yAxis.y,
        z: center.z + (radiusX / w1) * cosMid * xAxis.z + (radiusY / w1) * sinMid * yAxis.z,
      });
      weights.push(w1);

      controlPoints.push({
        x: center.x + radiusX * cosEnd * xAxis.x + radiusY * sinEnd * yAxis.x,
        y: center.y + radiusX * cosEnd * xAxis.y + radiusY * sinEnd * yAxis.y,
        z: center.z + radiusX * cosEnd * xAxis.z + radiusY * sinEnd * yAxis.z,
      });
      weights.push(1.0);

      const knotVal = (i + 1) / nArcs;
      if (i < nArcs - 1) {
        knots.push(knotVal, knotVal);
      }

      angle = angleEnd;
    }

    knots.push(1, 1, 1);
    return new NurbsCurve(2, controlPoints, knots, weights);
  }

  /**
   * Create a full NURBS circle.
   *
   * @param {{x,y,z}} center - Circle center
   * @param {number} radius - Circle radius
   * @param {{x,y,z}} xAxis - Unit X direction in circle plane
   * @param {{x,y,z}} yAxis - Unit Y direction in circle plane
   * @returns {NurbsCurve}
   */
  static createCircle(center, radius, xAxis, yAxis) {
    return NurbsCurve.createArc(center, radius, xAxis, yAxis, 0, 2 * Math.PI);
  }

  // -------------------------------------------------------------------
  // STEP import factory methods
  // -------------------------------------------------------------------

  /**
   * Create a NurbsCurve from STEP B_SPLINE_CURVE_WITH_KNOTS data.
   *
   * @param {number} degree - Polynomial degree
   * @param {Array<{x:number,y:number,z:number}>} controlPoints - 3D control points
   * @param {number[]} knotMultiplicities - Knot multiplicities
   * @param {number[]} knotValues - Distinct knot values
   * @param {number[]|null} [weights=null] - Weights (null = non-rational)
   * @returns {NurbsCurve}
   */
  static fromStepBSpline(degree, controlPoints, knotMultiplicities, knotValues, weights = null) {
    // Expand knot multiplicities into full knot vector
    const knots = [];
    for (let i = 0; i < knotValues.length; i++) {
      const val = knotValues[i];
      const mult = knotMultiplicities[i] || 1;
      for (let m = 0; m < mult; m++) {
        knots.push(val);
      }
    }
    return new NurbsCurve(degree, controlPoints, knots, weights);
  }
}
