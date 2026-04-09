// js/cad/NurbsSurface.js — Non-Uniform Rational B-Spline (NURBS) Surface
//
// Provides a mathematically exact surface representation for CAD faces.
// Supports rational (weighted) surfaces that can exactly represent quadrics
// (cylinders, cones, spheres, tori) as well as free-form surfaces.
//
// References:
//   - "The NURBS Book" (Piegl & Tiller, 1997)
//   - ISO 10303-42 (STEP geometry)

import { NurbsCurve } from './NurbsCurve.js';
import { wasmTessellation } from './WasmTessellation.js';
import { GeometryEvaluator } from './GeometryEvaluator.js';

let _loggedSurfaceTessBackend = false;

/**
 * NURBS Surface class.
 *
 * A NURBS surface S(u,v) of degrees (p,q) is defined by:
 *   S(u,v) = ΣΣ Ni,p(u) * Nj,q(v) * wij * Pij  /  ΣΣ Ni,p(u) * Nj,q(v) * wij
 *
 * where:
 *   Pij = control point grid (rows × cols in 3D)
 *   wij = weights grid
 *   Ni,p / Nj,q = B-spline basis functions
 *   u, v = parameters
 *
 * Control points are stored as a flat array in row-major order:
 *   index(i,j) = i * numCols + j
 *
 * where i indexes the u-direction (rows) and j indexes the v-direction (cols).
 */
export class NurbsSurface {
  /**
   * @param {number} degreeU - Degree in u-direction
   * @param {number} degreeV - Degree in v-direction
   * @param {number} numRowsU - Number of control point rows (u-direction)
   * @param {number} numColsV - Number of control point columns (v-direction)
   * @param {Array<{x:number, y:number, z:number}>} controlPoints - Row-major control points
   * @param {number[]} knotsU - Knot vector in u-direction
   * @param {number[]} knotsV - Knot vector in v-direction
   * @param {number[]} [weights] - Weights (flat, row-major; default: all 1.0)
   */
  constructor(degreeU, degreeV, numRowsU, numColsV, controlPoints, knotsU, knotsV, weights = null) {
    if (degreeU < 1 || degreeV < 1) {
      throw new Error('NURBS surface degrees must be >= 1');
    }
    if (controlPoints.length !== numRowsU * numColsV) {
      throw new Error(`Control point count ${controlPoints.length} != ${numRowsU}x${numColsV}`);
    }
    const expectedKnotsU = numRowsU + degreeU + 1;
    const expectedKnotsV = numColsV + degreeV + 1;
    if (knotsU.length !== expectedKnotsU) {
      throw new Error(`knotsU length ${knotsU.length} != expected ${expectedKnotsU}`);
    }
    if (knotsV.length !== expectedKnotsV) {
      throw new Error(`knotsV length ${knotsV.length} != expected ${expectedKnotsV}`);
    }

    this.degreeU = degreeU;
    this.degreeV = degreeV;
    this.numRowsU = numRowsU;
    this.numColsV = numColsV;
    this.controlPoints = controlPoints.map(p => ({ x: p.x, y: p.y, z: p.z }));
    this.knotsU = [...knotsU];
    this.knotsV = [...knotsV];
    this.weights = weights ? [...weights] : controlPoints.map(() => 1.0);

    this.uMin = this.knotsU[this.degreeU];
    this.uMax = this.knotsU[this.numRowsU];
    this.vMin = this.knotsV[this.degreeV];
    this.vMax = this.knotsV[this.numColsV];
  }

  /** Find knot span for u-direction */
  _findSpanU(u) {
    return this._findSpan(u, this.degreeU, this.numRowsU, this.knotsU);
  }

  /** Find knot span for v-direction */
  _findSpanV(v) {
    return this._findSpan(v, this.degreeV, this.numColsV, this.knotsV);
  }

  _findSpan(t, degree, numCtrl, knots) {
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

  _basisFunctions(span, t, degree, knots) {
    const p = degree;
    const N = new Array(p + 1);
    const left = new Array(p + 1);
    const right = new Array(p + 1);

    N[0] = 1.0;
    for (let j = 1; j <= p; j++) {
      left[j] = t - knots[span + 1 - j];
      right[j] = knots[span + j] - t;
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
   * Evaluate the surface point at parameters (u, v).
   * @param {number} u
   * @param {number} v
   * @returns {{x: number, y: number, z: number}}
   */
  evaluate(u, v) {
    u = Math.max(this.uMin, Math.min(this.uMax, u));
    v = Math.max(this.vMin, Math.min(this.vMax, v));

    const spanU = this._findSpanU(u);
    const spanV = this._findSpanV(v);
    const Nu = this._basisFunctions(spanU, u, this.degreeU, this.knotsU);
    const Nv = this._basisFunctions(spanV, v, this.degreeV, this.knotsV);

    let wx = 0, wy = 0, wz = 0, wSum = 0;

    for (let i = 0; i <= this.degreeU; i++) {
      const rowIdx = spanU - this.degreeU + i;
      for (let j = 0; j <= this.degreeV; j++) {
        const colIdx = spanV - this.degreeV + j;
        const cpIdx = rowIdx * this.numColsV + colIdx;
        const cp = this.controlPoints[cpIdx];
        const w = this.weights[cpIdx];
        const basis = Nu[i] * Nv[j] * w;

        wx += basis * cp.x;
        wy += basis * cp.y;
        wz += basis * cp.z;
        wSum += basis;
      }
    }

    if (Math.abs(wSum) < 1e-14) return { x: 0, y: 0, z: 0 };
    return { x: wx / wSum, y: wy / wSum, z: wz / wSum };
  }

  /**
   * Compute the surface normal at parameters (u, v) via analytical derivatives.
   * Normal = normalize(∂S/∂u × ∂S/∂v)
   *
   * Uses the GeometryEvaluator which provides exact basis function derivatives
   * (Piegl & Tiller Algorithm A2.3) instead of finite differences. Falls back
   * to z-up in degenerate cases where the cross product is near-zero.
   *
   * @param {number} u
   * @param {number} v
   * @returns {{x: number, y: number, z: number}} Unit normal
   */
  normal(u, v) {
    const result = GeometryEvaluator.evalSurface(this, u, v);
    return result.n;
  }

  /**
   * Find the closest parametric coordinates (u, v) for a given 3D point.
   *
   * Uses a coarse grid search followed by Newton-Raphson refinement to
   * minimise |S(u,v) - P|².  The target point is assumed to lie on or
   * very close to the surface.
   *
   * @param {{x:number, y:number, z:number}} point - Target 3D point
   * @param {number} [gridRes=16] - Coarse search grid resolution
   * @returns {{u: number, v: number}}
   */
  closestPointUV(point, gridRes = 16, uvHint = null) {
    const px = point.x, py = point.y, pz = point.z;

    let bestU, bestV;

    if (uvHint) {
      // Skip grid search — use the provided hint directly
      bestU = Math.max(this.uMin, Math.min(this.uMax, uvHint.u));
      bestV = Math.max(this.vMin, Math.min(this.vMax, uvHint.v));
    } else {
      // Coarse grid search
      bestU = (this.uMin + this.uMax) / 2;
      bestV = (this.vMin + this.vMax) / 2;
      let bestDist2 = Infinity;

      for (let i = 0; i <= gridRes; i++) {
        const u = this.uMin + (i / gridRes) * (this.uMax - this.uMin);
        for (let j = 0; j <= gridRes; j++) {
          const v = this.vMin + (j / gridRes) * (this.vMax - this.vMin);
          const p = GeometryEvaluator.evalSurface(this, u, v).p;
          const dx = p.x - px, dy = p.y - py, dz = p.z - pz;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < bestDist2) {
            bestDist2 = d2;
            bestU = u;
            bestV = v;
          }
        }
      }
    }

    // Newton-Raphson refinement using analytical derivatives from GeometryEvaluator
    const CONVERGE_TOL2 = 1e-24;  // squared distance convergence threshold
    const SINGULAR_TOL = 1e-30;   // Jacobian determinant singularity threshold

    for (let iter = 0; iter < 10; iter++) {
      const r = GeometryEvaluator.evalSurface(this, bestU, bestV);
      const s = r.p;
      const rx = s.x - px, ry = s.y - py, rz = s.z - pz;

      if (rx * rx + ry * ry + rz * rz < CONVERGE_TOL2) break;

      // Analytical partial derivatives from GeometryEvaluator
      const Su = r.du;
      const Sv = r.dv;

      // Jacobian entries:  J = [[Su·Su, Su·Sv], [Su·Sv, Sv·Sv]]
      // RHS:                r = [Su·R,  Sv·R]
      const a = Su.x * Su.x + Su.y * Su.y + Su.z * Su.z;
      const b = Su.x * Sv.x + Su.y * Sv.y + Su.z * Sv.z;
      const d = Sv.x * Sv.x + Sv.y * Sv.y + Sv.z * Sv.z;
      const ru = Su.x * rx + Su.y * ry + Su.z * rz;
      const rv = Sv.x * rx + Sv.y * ry + Sv.z * rz;

      const det = a * d - b * b;
      if (Math.abs(det) < SINGULAR_TOL) break;

      const du = -(d * ru - b * rv) / det;
      const dv = -(a * rv - b * ru) / det;

      bestU = Math.max(this.uMin, Math.min(this.uMax, bestU + du));
      bestV = Math.max(this.vMin, Math.min(this.vMax, bestV + dv));
    }

    return { u: bestU, v: bestV };
  }

  /**
   * Tessellate the surface into a mesh of triangles.
   * Uses WASM acceleration when available, falls back to JS evaluation.
   *
   * @param {number} [segmentsU=8] - Subdivisions in u-direction
   * @param {number} [segmentsV=8] - Subdivisions in v-direction
   * @returns {{ vertices: Array<{x,y,z}>, faces: Array<{vertices: Array<{x,y,z}>, normal: {x,y,z}}> }}
   */
  tessellate(segmentsU = 8, segmentsV = 8) {
    if (wasmTessellation.isAvailable()) {
      const result = wasmTessellation.tessellateSurface(this, segmentsU, segmentsV);
      if (result) {
        if (!_loggedSurfaceTessBackend) { _loggedSurfaceTessBackend = true; console.log('[NurbsSurface.tessellate] using WASM'); }
        return result;
      }
    }
    if (!_loggedSurfaceTessBackend) { _loggedSurfaceTessBackend = true; console.log('[NurbsSurface.tessellate] using JS fallback'); }
    // JS fallback: build grid of evaluated points and normals via GeometryEvaluator
    const grid = [];
    const normals = [];
    for (let i = 0; i <= segmentsU; i++) {
      const row = [];
      const normRow = [];
      const u = this.uMin + (i / segmentsU) * (this.uMax - this.uMin);
      for (let j = 0; j <= segmentsV; j++) {
        const v = this.vMin + (j / segmentsV) * (this.vMax - this.vMin);
        const r = GeometryEvaluator.evalSurface(this, u, v);
        row.push(r.p);
        normRow.push(r.n);
      }
      grid.push(row);
      normals.push(normRow);
    }

    // Generate triangle faces — split each quad into 2 triangles with
    // averaged normals so smooth shading works correctly.
    const vertices = [];
    const faces = [];

    for (let i = 0; i < segmentsU; i++) {
      for (let j = 0; j < segmentsV; j++) {
        const p00 = grid[i][j];
        const p10 = grid[i + 1][j];
        const p11 = grid[i + 1][j + 1];
        const p01 = grid[i][j + 1];

        const n00 = normals[i][j];
        const n10 = normals[i + 1][j];
        const n11 = normals[i + 1][j + 1];
        const n01 = normals[i][j + 1];

        // Triangle 1: p00, p10, p11
        const avg1 = _avgNormal(n00, n10, n11);
        faces.push({
          vertices: [{ ...p00 }, { ...p10 }, { ...p11 }],
          normal: avg1,
        });

        // Triangle 2: p00, p11, p01
        const avg2 = _avgNormal(n00, n11, n01);
        faces.push({
          vertices: [{ ...p00 }, { ...p11 }, { ...p01 }],
          normal: avg2,
        });
      }
    }

    // Collect unique vertices
    for (const row of grid) {
      for (const p of row) {
        vertices.push({ ...p });
      }
    }

    return { vertices, faces };
  }

  /**
   * Clone this surface.
   * @returns {NurbsSurface}
   */
  clone() {
    return new NurbsSurface(
      this.degreeU, this.degreeV,
      this.numRowsU, this.numColsV,
      this.controlPoints, this.knotsU, this.knotsV, this.weights
    );
  }

  /**
   * Serialize to a plain object.
   */
  serialize() {
    return {
      type: 'NurbsSurface',
      degreeU: this.degreeU,
      degreeV: this.degreeV,
      numRowsU: this.numRowsU,
      numColsV: this.numColsV,
      controlPoints: this.controlPoints.map(p => ({ x: p.x, y: p.y, z: p.z })),
      knotsU: [...this.knotsU],
      knotsV: [...this.knotsV],
      weights: [...this.weights],
    };
  }

  /**
   * Deserialize from a plain object.
   * @param {Object} data
   * @returns {NurbsSurface}
   */
  static deserialize(data) {
    return new NurbsSurface(
      data.degreeU, data.degreeV,
      data.numRowsU, data.numColsV,
      data.controlPoints, data.knotsU, data.knotsV, data.weights
    );
  }

  // -------------------------------------------------------------------
  // Factory methods for common CAD surface types
  // -------------------------------------------------------------------

  /**
   * Create a planar NURBS surface (bilinear patch).
   *
   * @param {{x,y,z}} origin - Corner point
   * @param {{x,y,z}} uDir - Direction and length in u
   * @param {{x,y,z}} vDir - Direction and length in v
   * @returns {NurbsSurface}
   */
  static createPlane(origin, uDir, vDir) {
    const cp = [
      { x: origin.x, y: origin.y, z: origin.z },
      { x: origin.x + vDir.x, y: origin.y + vDir.y, z: origin.z + vDir.z },
      { x: origin.x + uDir.x, y: origin.y + uDir.y, z: origin.z + uDir.z },
      { x: origin.x + uDir.x + vDir.x, y: origin.y + uDir.y + vDir.y, z: origin.z + uDir.z + vDir.z },
    ];
    return new NurbsSurface(
      1, 1, 2, 2, cp,
      [0, 0, 1, 1],
      [0, 0, 1, 1]
    );
  }

  /**
   * Create a cylindrical NURBS surface.
   *
   * The cylinder axis goes from `origin` in the direction `axis` for length `height`.
   * The cross-section is a circular arc of given `radius` and `sweepAngle`.
   *
   * @param {{x,y,z}} origin - Center of the bottom circle
   * @param {{x,y,z}} axis - Cylinder axis direction (will be normalized, length = height)
   * @param {number} radius - Cylinder radius
   * @param {number} height - Cylinder height along axis
   * @param {{x,y,z}} xAxis - Reference X direction in the cross-section plane
   * @param {{x,y,z}} yAxis - Reference Y direction in the cross-section plane
   * @param {number} [startAngle=0] - Start angle
   * @param {number} [sweepAngle=2*Math.PI] - Sweep angle
   * @returns {NurbsSurface}
   */
  static createCylinder(origin, axis, radius, height, xAxis, yAxis, startAngle = 0, sweepAngle = 2 * Math.PI) {
    // Create cross-section arc curve
    const arcCurve = NurbsCurve.createArc(
      { x: 0, y: 0, z: 0 }, radius, // centered at origin for now
      { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 },
      startAngle, sweepAngle
    );

    const numCols = arcCurve.controlPoints.length;
    const numRows = 2; // linear in axis direction

    const controlPoints = [];
    const weights = [];

    // Axis direction (normalized)
    const axLen = Math.sqrt(axis.x * axis.x + axis.y * axis.y + axis.z * axis.z);
    const axNorm = axLen > 1e-14
      ? { x: axis.x / axLen, y: axis.y / axLen, z: axis.z / axLen }
      : { x: 0, y: 0, z: 1 };

    // Build control point rows (bottom and top)
    for (let row = 0; row < numRows; row++) {
      const offset = row * height; // 0 or height
      for (let col = 0; col < numCols; col++) {
        const cp2D = arcCurve.controlPoints[col];
        const w = arcCurve.weights[col];

        // Transform from 2D arc to 3D cylinder surface
        controlPoints.push({
          x: origin.x + cp2D.x * xAxis.x + cp2D.y * yAxis.x + offset * axNorm.x,
          y: origin.y + cp2D.x * xAxis.y + cp2D.y * yAxis.y + offset * axNorm.y,
          z: origin.z + cp2D.x * xAxis.z + cp2D.y * yAxis.z + offset * axNorm.z,
        });
        weights.push(w);
      }
    }

    const knotsU = [0, 0, 1, 1]; // Linear in axis direction

    return new NurbsSurface(
      1, arcCurve.degree,
      numRows, numCols,
      controlPoints,
      knotsU,
      arcCurve.knots,
      weights
    );
  }

  /**
   * Create a NURBS surface by extruding (translating) a cross-section curve
   * linearly along a direction.  The result is a ruled surface whose
   * v-direction follows the input curve and whose u-direction is linear
   * (degree 1) along the extrusion.
   *
   * This is the general counterpart of `createCylinder` — it works for
   * arbitrary NURBS profile curves (splines, beziers, etc.).
   *
   * @param {NurbsCurve} crossSection - Profile curve (bottom)
   * @param {{x:number,y:number,z:number}} direction - Extrusion direction (unit vector)
   * @param {number} height - Extrusion distance along `direction`
   * @returns {NurbsSurface}
   */
  static createExtrudedSurface(crossSection, direction, height) {
    const numCols = crossSection.controlPoints.length;
    const numRows = 2; // linear in extrusion direction
    const controlPoints = [];
    const weights = [];

    for (let row = 0; row < numRows; row++) {
      const offset = row * height;
      for (let col = 0; col < numCols; col++) {
        const cp = crossSection.controlPoints[col];
        const w = crossSection.weights[col];
        controlPoints.push({
          x: cp.x + offset * direction.x,
          y: cp.y + offset * direction.y,
          z: cp.z + offset * direction.z,
        });
        weights.push(w);
      }
    }

    const knotsU = [0, 0, 1, 1]; // linear in extrusion direction

    return new NurbsSurface(
      1, crossSection.degree,
      numRows, numCols,
      controlPoints,
      knotsU,
      crossSection.knots,
      weights
    );
  }

  /**
   * Create a NURBS surface representing a fillet rolling-ball blend.
   *
   * The surface is defined by two rail curves (the trim lines on each face)
   * with a circular cross-section arc between them. This is the standard
   * CAD representation for a constant-radius fillet.
   *
   * @param {Array<{x,y,z}>} rail0 - Points along face0 trim curve
   * @param {Array<{x,y,z}>} rail1 - Points along face1 trim curve
   * @param {Array<{x,y,z}>} centers - Arc center points along the edge
   * @param {number} radius - Fillet radius
   * @param {{x,y,z}} edgeDir - Edge direction (for cross-section orientation)
   * @returns {NurbsSurface}
   */
  static createFilletSurface(rail0, rail1, centers, radius, edgeDir) {
    // The fillet surface is constructed as a ruled surface between the two
    // rail curves, with each cross-section being a circular arc.
    //
    // For a degree (1, 2) surface:
    //   - u-direction: linear along the edge (degree 1)
    //   - v-direction: quadratic arc across the fillet (degree 2)

    const nRailPts = rail0.length;
    if (nRailPts < 2) {
      throw new Error('Need at least 2 rail points for fillet surface');
    }

    // For each position along the edge, compute the 3 control points of
    // the quadratic arc cross-section: start, weighted midpoint, end
    const numCols = 3; // quadratic arc = 3 control points
    const numRows = nRailPts;
    const controlPoints = [];
    const weights = [];

    for (let i = 0; i < nRailPts; i++) {
      const p0 = rail0[i];
      const p1 = rail1[i];
      const center = centers[i];

      // Compute the angle between the two radii
      const r0 = { x: p0.x - center.x, y: p0.y - center.y, z: p0.z - center.z };
      const r1 = { x: p1.x - center.x, y: p1.y - center.y, z: p1.z - center.z };
      const len0 = Math.sqrt(r0.x * r0.x + r0.y * r0.y + r0.z * r0.z);
      const len1 = Math.sqrt(r1.x * r1.x + r1.y * r1.y + r1.z * r1.z);

      let cosA = 0;
      if (len0 > 1e-10 && len1 > 1e-10) {
        cosA = (r0.x * r1.x + r0.y * r1.y + r0.z * r1.z) / (len0 * len1);
        cosA = Math.max(-1, Math.min(1, cosA));
      }
      const halfAngle = Math.acos(cosA) / 2;
      const w1 = Math.cos(halfAngle);

      // Midpoint control point: intersection of tangent lines at p0 and p1
      // For a circular arc, this is at center + (radius/cos(halfAngle)) * bisectorDir
      const bisector = {
        x: r0.x / (len0 || 1) + r1.x / (len1 || 1),
        y: r0.y / (len0 || 1) + r1.y / (len1 || 1),
        z: r0.z / (len0 || 1) + r1.z / (len1 || 1),
      };
      const bisLen = Math.sqrt(bisector.x * bisector.x + bisector.y * bisector.y + bisector.z * bisector.z);
      const midDist = bisLen > 1e-10 ? radius / (w1 || 1) : radius;
      const midPt = bisLen > 1e-10 ? {
        x: center.x + (bisector.x / bisLen) * midDist,
        y: center.y + (bisector.y / bisLen) * midDist,
        z: center.z + (bisector.z / bisLen) * midDist,
      } : {
        x: (p0.x + p1.x) / 2,
        y: (p0.y + p1.y) / 2,
        z: (p0.z + p1.z) / 2,
      };

      // Control points for this cross-section: p0, midPt (weighted), p1
      controlPoints.push({ x: p0.x, y: p0.y, z: p0.z });
      controlPoints.push({ x: midPt.x, y: midPt.y, z: midPt.z });
      controlPoints.push({ x: p1.x, y: p1.y, z: p1.z });

      weights.push(1.0, w1, 1.0);
    }

    // Knots: linear in u (along edge), quadratic arc in v (across fillet)
    // Clamped knot vector: need numRows + 2 knots for degree 1
    const knotsUClamped = [0];
    for (let i = 0; i < numRows; i++) {
      knotsUClamped.push(i / (numRows - 1 || 1));
    }
    knotsUClamped.push(1);

    const knotsV = [0, 0, 0, 1, 1, 1]; // Quadratic, clamped

    return new NurbsSurface(
      1, 2,
      numRows, numCols,
      controlPoints,
      knotsUClamped,
      knotsV,
      weights
    );
  }

  /**
   * Create a NURBS surface representing a chamfer bevel plane.
   *
   * @param {{x,y,z}} p0a - Start point on face0 side
   * @param {{x,y,z}} p0b - End point on face0 side
   * @param {{x,y,z}} p1a - Start point on face1 side
   * @param {{x,y,z}} p1b - End point on face1 side
   * @returns {NurbsSurface}
   */
  static createChamferSurface(p0a, p0b, p1a, p1b) {
    // Bilinear patch (degree 1×1)
    const controlPoints = [
      { x: p0a.x, y: p0a.y, z: p0a.z },
      { x: p1a.x, y: p1a.y, z: p1a.z },
      { x: p0b.x, y: p0b.y, z: p0b.z },
      { x: p1b.x, y: p1b.y, z: p1b.z },
    ];
    return new NurbsSurface(
      1, 1, 2, 2,
      controlPoints,
      [0, 0, 1, 1],
      [0, 0, 1, 1]
    );
  }

  static createCornerBlendPatch(top0, top1, side0Mid, side1Mid, apex, centerPoint = null, topMidPoint = null) {
    const lerp = (a, b, t) => ({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
    });
    const solveMidCtrl = (p0, pm, p2) => ({
      x: 2 * pm.x - 0.5 * (p0.x + p2.x),
      y: 2 * pm.y - 0.5 * (p0.y + p2.y),
      z: 2 * pm.z - 0.5 * (p0.z + p2.z),
    });

    const topMid = topMidPoint ? { ...topMidPoint } : lerp(top0, top1, 0.5);
    const leftCtrl = solveMidCtrl(top0, side0Mid, apex);
    const rightCtrl = solveMidCtrl(top1, side1Mid, apex);
    const target = centerPoint || {
      x: (topMid.x + side0Mid.x + side1Mid.x + apex.x) / 4,
      y: (topMid.y + side0Mid.y + side1Mid.y + apex.y) / 4,
      z: (topMid.z + side0Mid.z + side1Mid.z + apex.z) / 4,
    };

    const controlPoints = [
      { ...top0 },
      { ...topMid },
      { ...top1 },
      { ...leftCtrl },
      { x: 0, y: 0, z: 0 },
      { ...rightCtrl },
      { ...apex },
      { ...apex },
      { ...apex },
    ];

    const bern = [1 / 16, 1 / 8, 1 / 16, 1 / 8, 1 / 4, 1 / 8, 1 / 16, 1 / 8, 1 / 16];
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    for (let i = 0; i < controlPoints.length; i++) {
      if (i === 4) continue;
      sumX += bern[i] * controlPoints[i].x;
      sumY += bern[i] * controlPoints[i].y;
      sumZ += bern[i] * controlPoints[i].z;
    }
    controlPoints[4] = {
      x: (target.x - sumX) / bern[4],
      y: (target.y - sumY) / bern[4],
      z: (target.z - sumZ) / bern[4],
    };

    return new NurbsSurface(
      2, 2, 3, 3,
      controlPoints,
      [0, 0, 0, 1, 1, 1],
      [0, 0, 0, 1, 1, 1]
    );
  }

  /**
   * Create a degree (2,2) rational Bézier surface representing a spherical
   * triangle patch between three points on a sphere.
   *
   * Uses the Cobb octant construction: a degenerate tensor-product patch
   * where one parametric edge (u = 0) collapses to a single pole vertex.
   * The three boundary arcs are mathematically exact circular arcs on the
   * sphere; the interior is exact when all inter-vertex angles are 90° and
   * a very close rational approximation otherwise.
   *
   * References:
   *   - Cobb, "Tiling the Sphere with Rational Bezier Patches" (1988)
   *   - Piegl & Tiller, "The NURBS Book", Example 8.5 (1997)
   *
   * @param {{x:number,y:number,z:number}} center - Sphere center
   * @param {number} radius - Sphere radius
   * @param {{x:number,y:number,z:number}} v0 - First vertex on sphere
   * @param {{x:number,y:number,z:number}} v1 - Second vertex on sphere
   * @param {{x:number,y:number,z:number}} v2 - Third vertex / pole
   * @returns {NurbsSurface}
   */
  static createSphericalPatch(center, radius, v0, v1, v2) {
    const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
    const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
    const scl = (v, s) => ({ x: v.x * s, y: v.y * s, z: v.z * s });
    const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
    const len = v => Math.sqrt(dot(v, v));
    const nrm = v => { const l = len(v); return l > 1e-15 ? scl(v, 1 / l) : v; };

    // Unit direction vectors from center to each vertex
    const d0 = nrm(sub(v0, center));
    const d1 = nrm(sub(v1, center));
    const d2 = nrm(sub(v2, center));

    // Cosines of inter-vertex angles
    const cos01 = Math.max(-1, Math.min(1, dot(d0, d1)));
    const cos02 = Math.max(-1, Math.min(1, dot(d0, d2)));
    const cos12 = Math.max(-1, Math.min(1, dot(d1, d2)));

    // Half-angle weights for the three boundary arcs
    const w01 = Math.cos(Math.acos(cos01) / 2);
    const w02 = Math.cos(Math.acos(cos02) / 2);
    const w12 = Math.cos(Math.acos(cos12) / 2);

    // Tangent intersection scale: R / (1 + cos α) for arc mid-control points.
    // Each boundary arc A→B has its middle Bézier CP at distance R/cos(α/2)
    // from center, along the bisector of dA and dB.
    const f01 = radius / Math.max(1e-10, 1 + cos01);
    const f02 = radius / Math.max(1e-10, 1 + cos02);
    const f12 = radius / Math.max(1e-10, 1 + cos12);

    // 3×3 control point grid (row-major, 3 rows u × 3 cols v):
    //   Row 0 (u=0): degenerate pole — all three CPs equal to v2
    //   Row 1 (u=½): tangent-intersection ring
    //   Row 2 (u=1): bottom boundary arc v0 → v1
    const controlPoints = [
      // Row 0: pole
      { ...v2 },
      { ...v2 },
      { ...v2 },
      // Row 1: tangent intersection points
      add(center, scl(add(d0, d2), f02)),                // P10: arc v0↔v2 tangent
      { ...center },                                      // P11: placeholder, solved below
      add(center, scl(add(d1, d2), f12)),                // P12: arc v1↔v2 tangent
      // Row 2: bottom arc
      { ...v0 },                                          // P20
      add(center, scl(add(d0, d1), f01)),                // P21: arc v0↔v1 tangent
      { ...v1 },                                          // P22
    ];

    // Weights: tensor product of per-arc half-angle cosines.
    //   Corner CPs (on sphere) get weight 1.
    //   Edge-mid CPs get the half-angle cosine of that boundary arc.
    //   Center CP gets the product of the two parametric-direction weights.
    const weights = [
      1,    w12,        1,
      w02,  w02 * w12,  w12,
      1,    w01,        1,
    ];

    // Solve for the center CP P[1][1] = center + λ·D where D = d0+d1+d2,
    // such that the surface at (u=½, v=½) lies exactly on the sphere.
    // The rational surface S(u,v) = Σ Bᵢⱼ wᵢⱼ Pᵢⱼ / Σ Bᵢⱼ wᵢⱼ.
    // At (½,½) with quadratic Bernstein: B = [[1/16,1/8,1/16],[1/8,1/4,1/8],[1/16,1/8,1/16]].
    // Setting |S(½,½) - center|² = R² gives a quadratic in λ.
    const D = add(add(d0, d1), d2);
    const Bern = [1 / 16, 1 / 8, 1 / 16, 1 / 8, 1 / 4, 1 / 8, 1 / 16, 1 / 8, 1 / 16];
    const w11 = weights[4];

    // Total weight sum (fixed, independent of P11 position)
    let Wsum = 0;
    for (let k = 0; k < 9; k++) Wsum += Bern[k] * weights[k];

    // Weighted displacement sum excluding P11: A = Σ_{k≠4} Bₖ wₖ (Pₖ − center)
    let Ax = 0, Ay = 0, Az = 0;
    for (let k = 0; k < 9; k++) {
      if (k === 4) continue;
      const bw = Bern[k] * weights[k];
      Ax += bw * (controlPoints[k].x - center.x);
      Ay += bw * (controlPoints[k].y - center.y);
      Az += bw * (controlPoints[k].z - center.z);
    }

    // Quadratic: α²|D|²λ² + 2α(A·D)λ + (|A|² − R²W²) = 0
    const alpha = Bern[4] * w11;
    const DD = dot(D, D);
    const AD = Ax * D.x + Ay * D.y + Az * D.z;
    const AA = Ax * Ax + Ay * Ay + Az * Az;

    const qa = alpha * alpha * DD;
    const qb = 2 * alpha * AD;
    const qc = AA - radius * radius * Wsum * Wsum;

    const disc = qb * qb - 4 * qa * qc;
    let lambda;
    if (disc >= 0 && qa > 1e-20) {
      const sqrtD = Math.sqrt(disc);
      const l1 = (-qb + sqrtD) / (2 * qa);
      const l2 = (-qb - sqrtD) / (2 * qa);
      lambda = l1 > 0 ? l1 : l2;
    } else {
      lambda = radius; // fallback to octant formula
    }

    controlPoints[4] = add(center, scl(D, lambda));

    const knots = [0, 0, 0, 1, 1, 1]; // Bézier (no interior knots)
    return new NurbsSurface(2, 2, 3, 3, controlPoints, knots, knots, weights);
  }

  // -------------------------------------------------------------------
  // STEP import factory methods
  // -------------------------------------------------------------------

  /**
   * Create a NurbsSurface from STEP B_SPLINE_SURFACE_WITH_KNOTS data.
   *
   * STEP stores control points as a nested list: ((row0_cp0, row0_cp1, ...),
   * (row1_cp0, ...), ...). The u-direction corresponds to rows and
   * v-direction to columns.
   *
   * @param {number} degreeU - Degree in u-direction
   * @param {number} degreeV - Degree in v-direction
   * @param {Array<Array<{x:number,y:number,z:number}>>} controlPointGrid - Nested [rows][cols] grid
   * @param {number[]} knotMultsU - Knot multiplicities in u
   * @param {number[]} knotValsU - Distinct knot values in u
   * @param {number[]} knotMultsV - Knot multiplicities in v
   * @param {number[]} knotValsV - Distinct knot values in v
   * @param {Array<Array<number>>|null} [weightsGrid=null] - Nested [rows][cols] weights (null = non-rational)
   * @returns {NurbsSurface}
   */
  static fromStepBSpline(degreeU, degreeV, controlPointGrid, knotMultsU, knotValsU, knotMultsV, knotValsV, weightsGrid = null) {
    const numRowsU = controlPointGrid.length;
    const numColsV = controlPointGrid[0].length;

    // Flatten control points (row-major)
    const controlPoints = [];
    for (let i = 0; i < numRowsU; i++) {
      for (let j = 0; j < numColsV; j++) {
        const cp = controlPointGrid[i][j];
        controlPoints.push({ x: cp.x, y: cp.y, z: cp.z });
      }
    }

    // Flatten weights if provided
    let weights = null;
    if (weightsGrid) {
      weights = [];
      for (let i = 0; i < numRowsU; i++) {
        for (let j = 0; j < numColsV; j++) {
          weights.push(weightsGrid[i][j]);
        }
      }
    }

    // Expand knot multiplicities into full knot vectors
    const knotsU = [];
    for (let i = 0; i < knotValsU.length; i++) {
      const val = knotValsU[i];
      const mult = knotMultsU[i] || 1;
      for (let m = 0; m < mult; m++) knotsU.push(val);
    }

    const knotsV = [];
    for (let i = 0; i < knotValsV.length; i++) {
      const val = knotValsV[i];
      const mult = knotMultsV[i] || 1;
      for (let m = 0; m < mult; m++) knotsV.push(val);
    }

    return new NurbsSurface(degreeU, degreeV, numRowsU, numColsV, controlPoints, knotsU, knotsV, weights);
  }
}

/** Average three unit normals and normalize the result. */
function _avgNormal(a, b, c) {
  const x = a.x + b.x + c.x;
  const y = a.y + b.y + c.y;
  const z = a.z + b.z + c.z;
  const len = Math.sqrt(x * x + y * y + z * z);
  if (len < 1e-14) return { x: 0, y: 0, z: 1 };
  return { x: x / len, y: y / len, z: z / len };
}
