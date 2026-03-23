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
   * Compute the surface normal at parameters (u, v) via finite differences.
   * Normal = normalize(dS/du × dS/dv)
   *
   * @param {number} u
   * @param {number} v
   * @returns {{x: number, y: number, z: number}} Unit normal
   */
  normal(u, v) {
    const eps = 1e-6;
    const uRange = this.uMax - this.uMin;
    const vRange = this.vMax - this.vMin;

    // Partial derivative in u via central differences
    const uLo = Math.max(this.uMin, u - eps * uRange);
    const uHi = Math.min(this.uMax, u + eps * uRange);
    const pULo = this.evaluate(uLo, v);
    const pUHi = this.evaluate(uHi, v);
    const du = { x: pUHi.x - pULo.x, y: pUHi.y - pULo.y, z: pUHi.z - pULo.z };

    // Partial derivative in v via central differences
    const vLo = Math.max(this.vMin, v - eps * vRange);
    const vHi = Math.min(this.vMax, v + eps * vRange);
    const pVLo = this.evaluate(u, vLo);
    const pVHi = this.evaluate(u, vHi);
    const dv = { x: pVHi.x - pVLo.x, y: pVHi.y - pVLo.y, z: pVHi.z - pVLo.z };

    // Cross product du × dv
    const nx = du.y * dv.z - du.z * dv.y;
    const ny = du.z * dv.x - du.x * dv.z;
    const nz = du.x * dv.y - du.y * dv.x;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);

    if (len < 1e-14) return { x: 0, y: 0, z: 1 };
    return { x: nx / len, y: ny / len, z: nz / len };
  }

  /**
   * Tessellate the surface into a mesh of triangles.
   *
   * @param {number} [segmentsU=8] - Subdivisions in u-direction
   * @param {number} [segmentsV=8] - Subdivisions in v-direction
   * @returns {{ vertices: Array<{x,y,z}>, faces: Array<{vertices: Array<{x,y,z}>, normal: {x,y,z}}> }}
   */
  tessellate(segmentsU = 8, segmentsV = 8) {
    // Build grid of evaluated points and normals
    const grid = [];
    const normals = [];
    for (let i = 0; i <= segmentsU; i++) {
      const row = [];
      const normRow = [];
      const u = this.uMin + (i / segmentsU) * (this.uMax - this.uMin);
      for (let j = 0; j <= segmentsV; j++) {
        const v = this.vMin + (j / segmentsV) * (this.vMax - this.vMin);
        row.push(this.evaluate(u, v));
        normRow.push(this.normal(u, v));
      }
      grid.push(row);
      normals.push(normRow);
    }

    // Generate quad faces (each split into 2 triangles for mesh compatibility)
    const vertices = [];
    const faces = [];

    for (let i = 0; i < segmentsU; i++) {
      for (let j = 0; j < segmentsV; j++) {
        const p00 = grid[i][j];
        const p10 = grid[i + 1][j];
        const p11 = grid[i + 1][j + 1];
        const p01 = grid[i][j + 1];

        // Quad face (consistent with existing geometry format)
        const faceNormal = normals[i][j];
        faces.push({
          vertices: [
            { ...p00 }, { ...p10 }, { ...p11 }, { ...p01 }
          ],
          normal: { ...faceNormal },
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
    const knotsU = [];
    for (let i = 0; i <= numRows - 1 + 1; i++) {
      knotsU.push(i === 0 ? 0 : i >= numRows ? 1 : (i - 1) / (numRows - 1));
    }
    // Clamp: need numRows + 1 + 1 = numRows + 2 knots for degree 1
    // Actually: knotsU length = numRows + degreeU + 1 = numRows + 2
    const knotsUClamped = [0];
    for (let i = 0; i < numRows; i++) {
      knotsUClamped.push(i / (numRows - 1 || 1));
    }
    knotsUClamped.push(1);
    // That gives numRows + 2 knots for degree 1. Let's verify:
    // Expected: numRows + 1 + 1 = numRows + 2. ✓

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
}
